const HISTORY_INDEX_KEY = "traffic:busan:history:index";
const DEFAULT_SAMPLE_LIMIT = 7;
const MIN_BASELINE_SAMPLES = 3;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

function getKoreaHour(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    hour12: false
  }).formatToParts(date);

  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return Number.isInteger(hour) ? hour : null;
}

function getKoreaDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function getPeriod(hour) {
  if (hour >= 7 && hour < 10) {
    return {
      key: "morning",
      label: "아침 출근",
      startHour: 7,
      endHour: 10
    };
  }

  if (hour >= 17 && hour < 20) {
    return {
      key: "evening",
      label: "저녁 퇴근",
      startHour: 17,
      endHour: 20
    };
  }

  return null;
}

function median(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!sorted.length) return null;

  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(1))
    : Number(sorted[middle].toFixed(1));
}

function average(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  if (!valid.length) return null;
  return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(1));
}

function buildComparison(period, entries) {
  const candidates = entries
    .filter((entry) => {
      const hour = getKoreaHour(entry?.fetchedAt);
      if (hour === null) return false;
      const entryPeriod = getPeriod(hour);
      return entryPeriod?.key === period.key;
    })
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt));

  if (!candidates.length) {
    return {
      key: period.key,
      label: period.label,
      available: false,
      message: "해당 시간대의 완성된 교통 이력이 아직 없습니다."
    };
  }

  const latest = candidates[0];
  const previous = candidates.slice(1, DEFAULT_SAMPLE_LIMIT + 1);

  if (previous.length < MIN_BASELINE_SAMPLES) {
    return {
      key: period.key,
      label: period.label,
      available: false,
      message: "같은 시간대의 과거 데이터가 아직 충분하지 않습니다.",
      latest: {
        fetchedAt: latest.fetchedAt,
        averageSpeed: Number(latest.averageSpeed),
        trafficIndex: Number(latest.trafficIndex),
        congestedRatio: Number(latest.congestedRatio)
      },
      baseline: {
        sampleCount: previous.length,
        requiredSamples: MIN_BASELINE_SAMPLES
      }
    };
  }

  const baselineSpeed = median(previous.map((entry) => entry?.averageSpeed));
  const baselineIndex = median(previous.map((entry) => entry?.trafficIndex));
  const baselineCongestedRatio = median(previous.map((entry) => entry?.congestedRatio));

  const currentSpeed = Number(latest.averageSpeed);
  const currentIndex = Number(latest.trafficIndex);
  const currentCongestedRatio = Number(latest.congestedRatio);

  const speedDelta = Number.isFinite(baselineSpeed) && Number.isFinite(currentSpeed)
    ? Number((currentSpeed - baselineSpeed).toFixed(1))
    : null;

  const indexDelta = Number.isFinite(baselineIndex) && Number.isFinite(currentIndex)
    ? Number((currentIndex - baselineIndex).toFixed(1))
    : null;

  const congestionDelta = Number.isFinite(baselineCongestedRatio) && Number.isFinite(currentCongestedRatio)
    ? Number((currentCongestedRatio - baselineCongestedRatio).toFixed(1))
    : null;

  let status = "유지";
  if (indexDelta !== null) {
    if (indexDelta <= -8) status = "악화";
    else if (indexDelta >= 8) status = "개선";
    else if (indexDelta <= -3) status = "다소 악화";
    else if (indexDelta >= 3) status = "다소 개선";
  }

  return {
    key: period.key,
    label: period.label,
    available: true,
    status,
    latest: {
      fetchedAt: latest.fetchedAt,
      averageSpeed: currentSpeed,
      trafficIndex: currentIndex,
      congestedRatio: currentCongestedRatio
    },
    baseline: {
      sampleCount: previous.length,
      averageSpeed: baselineSpeed,
      trafficIndex: baselineIndex,
      congestedRatio: baselineCongestedRatio
    },
    delta: {
      averageSpeed: speedDelta,
      trafficIndex: indexDelta,
      congestedRatio: congestionDelta
    },
    sampleDates: previous.map((entry) => getKoreaDateKey(entry.fetchedAt)).filter(Boolean)
  };
}

export async function onRequestGet(context) {
  const startedAt = Date.now();

  try {
    if (!context.env?.TRAFFIC_CACHE) {
      return json({
        ok: false,
        error: "교통 시계열 저장소가 연결되지 않았습니다.",
        diagnostics: {
          code: "TRAFFIC_COMMUTE_CACHE_NOT_CONFIGURED"
        }
      }, 503);
    }

    const index = await context.env.TRAFFIC_CACHE.get(HISTORY_INDEX_KEY, "json");
    const entries = Array.isArray(index) ? index : [];

    const morning = buildComparison(
      { key: "morning", label: "아침 출근", startHour: 7, endHour: 10 },
      entries
    );

    const evening = buildComparison(
      { key: "evening", label: "저녁 퇴근", startHour: 17, endHour: 20 },
      entries
    );

    return json({
      ok: true,
      source: "부산광역시 링크소통정보",
      periods: {
        morning,
        evening
      },
      note: "각 시간대의 최근 완성 스냅샷을 같은 시간대의 과거 최대 7개 샘플 중앙값과 비교합니다. 비교에는 최소 3개의 과거 샘플이 필요합니다.",
      timing: {
        totalMs: Date.now() - startedAt
      }
    }, 200, {
      "cache-control": "public, max-age=0, s-maxage=30",
      "X-Traffic-Commute": "HISTORY"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({
      ok: false,
      error: message,
      diagnostics: {
        code: "TRAFFIC_COMMUTE_INTERNAL_ERROR",
        detail: message,
        name: error?.name || "UnknownError",
        hasKvBinding: Boolean(context.env?.TRAFFIC_CACHE)
      }
    }, 500);
  }
}
