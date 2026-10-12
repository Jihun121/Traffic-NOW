import { normalizeTrafficPayload } from "../../functions/lib/normalizeTraffic.js";

const BUSAN_API_URL = "https://apis.data.go.kr/6260000/BusanITSLINKTraffic/LINKTrafficList";
const ITS_API_URL = "https://openapi.its.go.kr:9443/trafficInfo";
const SNAPSHOT_KEY = "traffic:busan:latest";
const SNAPSHOT_ANALYSIS_KEY = "traffic:busan:latest-analysis";
const COLLECTOR_STATE_KEY = "traffic:busan:collector-state";
const COLLECTOR_ACCUMULATOR_KEY = "traffic:busan:collector-accumulator";
const PAGE_SIZE = 100;
const PAGES_PER_RUN = 3;
const REQUEST_TIMEOUT_MS = 60000;
const LATEST_SNAPSHOT_TTL = 60 * 60 * 12;
const COLLECTION_TTL = 60 * 60 * 8;
const HISTORY_INDEX_KEY = "traffic:busan:history:index";
const HISTORY_KEY_PREFIX = "traffic:busan:history:";
const HISTORY_RETENTION_DAYS = 14;
const HISTORY_RETENTION_TTL = 60 * 60 * 24 * HISTORY_RETENTION_DAYS;
const HISTORY_MAX_ENTRIES = 96;
// 시간대별 기준값을 별도 KV에 저장해 한 번의 실행에서 전체 시간대 데이터를 재직렬화하지 않는다.
const BASELINE_KEY_PREFIX = "traffic:busan:baseline-by-timeband:v4:";
const BASELINE_VERSION = 4;
const BASELINE_SHARD_COUNT = 12;
const BASELINE_SHARDS_PER_RUN = 4;
const BASELINE_SAMPLE_SIZE = 6;
const SUDDEN_CONGESTION_MIN_SAMPLES = 3;
const SUDDEN_CONGESTION_MIN_DROP_KMH = 10;
const SUDDEN_CONGESTION_MIN_DROP_RATIO = 0.25;
const SUDDEN_CONGESTION_MAX_RESULTS = 20;

function getApiKey(rawKey) {
  const raw = String(rawKey || "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sanitizeUrlForDiagnostics(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("serviceKey");
    url.searchParams.delete("apiKey");
    return url.toString();
  } catch {
    return String(value);
  }
}

function getBusanApiError(payload) {
  const header = payload?.OpenAPI_ServiceResponse?.cmmMsgHeader || {};
  const resultCode = String(
    payload?.resultCode ??
    payload?.result?.resultCode ??
    header.returnReasonCode ??
    ""
  ).trim();

  const resultMsg = String(
    payload?.resultMsg ??
    payload?.result?.resultMsg ??
    header.errMsg ??
    ""
  ).trim();

  const returnAuthMsg = String(
    payload?.returnAuthMsg ??
    payload?.result?.returnAuthMsg ??
    header.returnAuthMsg ??
    ""
  ).trim();

  return {
    resultCode,
    resultMsg,
    returnAuthMsg,
    hasError: Boolean(
      resultCode &&
      !["00", "0"].includes(resultCode)
    )
  };
}

// 도로 위계별 속도 기준
const SPEED_CRITERIA = {
  EXPRESSWAY: { categoryName: "도시고속/자동차전용도로", smooth: 50, slow: 30 },
  MAJOR_ARTERIAL: { categoryName: "주요 간선대로", smooth: 35, slow: 20 },
  URBAN_ROAD: { categoryName: "일반 시내도로", smooth: 25, slow: 15 }
};

const EXPRESSWAY_KEYWORDS = [
  "고속", "번영로", "동서고가", "동서로", "광안대교", "남항대교",
  "부산항대교", "을숙도대교", "신호대교", "거가대로", "강변대로",
  "관문대로", "정관로", "산성터널", "만덕터널", "백양터널", "수영강변대로"
];

const ARTERIAL_KEYWORDS = [
  "대로", "중앙대로", "가야대로", "수영로", "낙동대로", "만덕대로",
  "백양대로", "충렬대로", "해운대로", "사상로", "구포대교", "낙동남로"
];

function getRoadCategory(roadName) {
  const name = String(roadName || "").trim();
  if (!name) return "URBAN_ROAD";
  for (const kw of EXPRESSWAY_KEYWORDS) {
    if (name.includes(kw)) return "EXPRESSWAY";
  }
  for (const kw of ARTERIAL_KEYWORDS) {
    if (name.includes(kw)) return "MAJOR_ARTERIAL";
  }
  return "URBAN_ROAD";
}

function evaluateTrafficStatus(speed, roadCategory = "URBAN_ROAD") {
  const spd = Number(speed);
  if (!Number.isFinite(spd) || spd < 0) {
    return { status: "UNKNOWN", statusText: "정보 없음", color: "#94a3b8" };
  }
  const criteria = SPEED_CRITERIA[roadCategory] || SPEED_CRITERIA.URBAN_ROAD;
  if (spd >= criteria.smooth) {
    return { status: "SMOOTH", statusText: "원활", color: "#10b981" };
  } else if (spd >= criteria.slow) {
    return { status: "SLOW", statusText: "서행", color: "#f59e0b" };
  } else {
    return { status: "CONGESTED", statusText: "정체", color: "#ef4444" };
  }
}

function calculateBusanAnalysis(rows, includeTop10 = true) {
  let totalCount = 0;
  let totalSpeed = 0;
  let smoothCount = 0;
  let slowCount = 0;
  let congestedCount = 0;
  let slowestRow = null;
  let slowestSpeed = Infinity;
  const topCandidates = [];

  const comparePriority = (statusA, speedA, statusB, speedB) => {
    if (statusA === "CONGESTED" && statusB !== "CONGESTED") return -1;
    if (statusA !== "CONGESTED" && statusB === "CONGESTED") return 1;
    return Number(speedA) - Number(speedB);
  };

  // 통계와 TOP 10을 한 번의 순회에서 계산해 불필요한 전체 배열 정렬을 피한다.
  for (const row of rows) {
    const speed = Number(row.speed);
    if (!Number.isFinite(speed) || speed < 0) continue;

    totalCount += 1;
    totalSpeed += speed;

    const category = row.category || getRoadCategory(row.roadName);
    const evaluation = evaluateTrafficStatus(speed, category);
    if (evaluation.status === "SMOOTH") smoothCount += 1;
    else if (evaluation.status === "SLOW") slowCount += 1;
    else if (evaluation.status === "CONGESTED") congestedCount += 1;

    if (speed < slowestSpeed) {
      slowestSpeed = speed;
      slowestRow = row;
    }

    if (includeTop10) {
      const sectionKey = `${row.roadName}-${row.startName}-${row.endName}`;
      const duplicateIndex = topCandidates.findIndex((candidate) => candidate.sectionKey === sectionKey);
      if (duplicateIndex >= 0) {
        const duplicate = topCandidates[duplicateIndex];
        if (comparePriority(evaluation.status, speed, duplicate.status, duplicate.speed) >= 0) continue;
        topCandidates.splice(duplicateIndex, 1);
      }

      let insertAt = topCandidates.findIndex((candidate) =>
        comparePriority(evaluation.status, speed, candidate.status, candidate.speed) < 0
      );
      if (insertAt < 0) insertAt = topCandidates.length;

      if (insertAt < 10) {
        topCandidates.splice(insertAt, 0, {
          row,
          sectionKey,
          speed,
          categoryName: SPEED_CRITERIA[category]?.categoryName || "일반도로",
          status: evaluation.status,
          statusText: evaluation.statusText,
          statusColor: evaluation.color
        });
        if (topCandidates.length > 10) topCandidates.pop();
      }
    }
  }

  let stats;
  if (totalCount === 0) {
    stats = {
      totalCount: 0,
      averageSpeed: 0,
      trafficIndex: 0,
      trafficIndexGrade: "데이터 없음",
      statusCounts: { smooth: 0, slow: 0, congested: 0 },
      statusRatios: { smooth: 0, slow: 0, congested: 0 },
      congestionLevel: "데이터 없음",
      slowestRoad: null
    };
  } else {
    const averageSpeed = Number((totalSpeed / totalCount).toFixed(1));
    const smoothRatio = Number(((smoothCount / totalCount) * 100).toFixed(1));
    const slowRatio = Number(((slowCount / totalCount) * 100).toFixed(1));
    const congestedRatio = Number(((congestedCount / totalCount) * 100).toFixed(1));

    // 부산 교통지수: 원활=1.0, 서행=0.5, 정체=0.0 가중치의 0~100 점수.
    const trafficIndex = Number(
      Math.max(0, Math.min(100, smoothRatio + (slowRatio * 0.5))).toFixed(1)
    );

    let trafficIndexGrade = "매우 혼잡";
    if (trafficIndex >= 80) trafficIndexGrade = "매우 원활";
    else if (trafficIndex >= 65) trafficIndexGrade = "원활";
    else if (trafficIndex >= 50) trafficIndexGrade = "보통";
    else if (trafficIndex >= 35) trafficIndexGrade = "혼잡";

    let congestionLevel = "원활";
    if (congestedRatio >= 25) congestionLevel = "매우 혼잡";
    else if (congestedRatio >= 15) congestionLevel = "혼잡";
    else if (congestedRatio >= 8 || slowRatio >= 30) congestionLevel = "다소 혼잡";

    stats = {
      totalCount,
      averageSpeed,
      trafficIndex,
      trafficIndexGrade,
      statusCounts: { smooth: smoothCount, slow: slowCount, congested: congestedCount },
      statusRatios: { smooth: smoothRatio, slow: slowRatio, congested: congestedRatio },
      congestionLevel,
      slowestRoad: slowestRow ? {
        roadName: slowestRow.roadName || "무명도로",
        section: `${slowestRow.startName || ""} → ${slowestRow.endName || ""}`.trim(),
        speed: Number(slowestRow.speed)
      } : null
    };
  }

  const top10 = includeTop10 ? topCandidates.map((candidate, index) => ({
    rank: index + 1,
    linkId: candidate.row.linkId,
    roadName: candidate.row.roadName || "도로명 없음",
    startName: candidate.row.startName || "-",
    endName: candidate.row.endName || "-",
    speed: candidate.speed,
    categoryName: candidate.categoryName,
    status: candidate.status,
    statusText: candidate.statusText,
    statusColor: candidate.statusColor,
    updatedAt: candidate.row.updatedAt || ""
  })) : [];

  return { stats, top10 };
}

function calculateBusanStats(rows) {
  return calculateBusanAnalysis(rows, false).stats;
}

function calculateTop10(rows) {
  return calculateBusanAnalysis(rows).top10;
}

function getTrafficRowKey(row) {
  if (row.linkId) return `link:${row.linkId}`;
  return `section:${row.roadName || ""}|${row.sectionName || ""}|${row.startName || ""}|${row.endName || ""}`;
}

function getBaselineShardIndex(row) {
  const value = String(row?.linkId || getTrafficRowKey(row));
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % BASELINE_SHARD_COUNT;
}

function mergeSuddenCongestionAlerts(existing, incoming) {
  const compare = (a, b) => {
    if (b.dropRatio !== a.dropRatio) return b.dropRatio - a.dropRatio;
    return b.dropKmh - a.dropKmh;
  };
  return [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]
    .sort(compare)
    .slice(0, SUDDEN_CONGESTION_MAX_RESULTS);
}

function getKoreaHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    hour12: false
  }).formatToParts(date);

  const hourPart = parts.find((part) => part.type === "hour")?.value;
  const hour = Number(hourPart);

  return Number.isInteger(hour) ? hour : new Date(date).getUTCHours() + 9;
}

function getTimeBand(hour) {
  const normalizedHour = ((Number(hour) % 24) + 24) % 24;
  const index = Math.floor(normalizedHour / 3);
  const startHour = index * 3;
  const endHour = (startHour + 3) % 24;

  return {
    key: `band-${index}`,
    index,
    startHour,
    endHour
  };
}

function median(values) {
  const sorted = values
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(1))
    : Number(sorted[middle].toFixed(1));
}

async function calculateAndUpdateSuddenCongestion(env, rows, sampleId = "", timeBandOverride = null, shardId = 0) {
  const now = new Date();
  const stableSampleId = String(sampleId || now.toISOString());
  const timeBand = timeBandOverride || getTimeBand(getKoreaHour(now));
  const baselineKey = BASELINE_KEY_PREFIX + timeBand.key + ":shard-" + shardId;

  // 이전에는 8개 시간대의 모든 기준값을 한 KV 객체에 담아 매번 전부 읽고 썼다.
  // 현재 시간대의 기준값만 읽고 갱신한다. v2 단일 객체는 사용하지 않고 새 기준을 쌓는다.
  const baseline = (await env.TRAFFIC_CACHE.get(baselineKey, "json")) || {};
  const currentBucket =
    baseline?.version === BASELINE_VERSION &&
    baseline?.bucket &&
    typeof baseline.bucket === "object" &&
    !Array.isArray(baseline.bucket)
      ? baseline.bucket
      : {};

  const alerts = [];
  let detectedCount = 0;
  const compareAlerts = (a, b) => {
    if (b.dropRatio !== a.dropRatio) return b.dropRatio - a.dropRatio;
    return b.dropKmh - a.dropKmh;
  };

  // TOP 20만 유지해 감지된 모든 구간을 정렬하지 않는다.
  for (const row of rows) {
    if (row?.source === "ITS") continue;
    const speed = Number(row.speed);
    if (!Number.isFinite(speed) || speed < 0) continue;

    const key = getTrafficRowKey(row);
    const previous = currentBucket[key];
    const storedSamples = Array.isArray(previous?.samples)
      ? previous.samples.map(Number).filter(Number.isFinite).slice(-BASELINE_SAMPLE_SIZE)
      : [];
    // 동일한 COMPLETE 스냅샷을 재시도할 때 이미 추가된 마지막 표본은 비교 기준에서 제외한다.
    const samples = previous?.lastSampleId === stableSampleId
      ? storedSamples.slice(0, -1)
      : storedSamples;

    if (samples.length < SUDDEN_CONGESTION_MIN_SAMPLES) continue;

    const baselineSpeed = median(samples);
    const dropKmh = Number((baselineSpeed - speed).toFixed(1));
    const dropRatio = baselineSpeed > 0
      ? Number(((dropKmh / baselineSpeed) * 100).toFixed(1))
      : 0;

    if (
      dropKmh < SUDDEN_CONGESTION_MIN_DROP_KMH ||
      dropRatio < SUDDEN_CONGESTION_MIN_DROP_RATIO * 100
    ) continue;

    detectedCount += 1;
    const alert = {
      linkId: row.linkId || "",
      roadName: row.roadName || "도로명 없음",
      startName: row.startName || "-",
      endName: row.endName || "-",
      currentSpeed: speed,
      baselineSpeed,
      dropKmh,
      dropRatio,
      status: row.status || "UNKNOWN",
      statusText: row.statusText || "정보 없음"
    };

    let insertAt = alerts.findIndex((candidate) => compareAlerts(alert, candidate) < 0);
    if (insertAt < 0) insertAt = alerts.length;
    if (insertAt < SUDDEN_CONGESTION_MAX_RESULTS) {
      alerts.splice(insertAt, 0, alert);
      if (alerts.length > SUDDEN_CONGESTION_MAX_RESULTS) alerts.pop();
    }
  }

  const nextBucket = { ...currentBucket };
  const updatedAt = now.toISOString();

  for (const row of rows) {
    if (row?.source === "ITS") continue;
    const speed = Number(row.speed);
    if (!Number.isFinite(speed) || speed < 0) continue;

    const key = getTrafficRowKey(row);
    const previousEntry = nextBucket[key];
    if (previousEntry?.lastSampleId === stableSampleId) continue;

    const previousSamples = Array.isArray(previousEntry?.samples)
      ? previousEntry.samples.map(Number).filter(Number.isFinite).slice(-BASELINE_SAMPLE_SIZE + 1)
      : [];

    nextBucket[key] = {
      linkId: row.linkId || "",
      roadName: row.roadName || "",
      samples: [...previousSamples, speed],
      lastSampleId: stableSampleId,
      updatedAt
    };
  }

  await env.TRAFFIC_CACHE.put(
    baselineKey,
    JSON.stringify({
      version: BASELINE_VERSION,
      updatedAt,
      currentTimeBand: timeBand,
      bucket: nextBucket
    }),
    { expirationTtl: HISTORY_RETENTION_TTL }
  );

  return {
    detectedCount,
    items: alerts,
    baselineSampleSize: BASELINE_SAMPLE_SIZE,
    minimumSamples: SUDDEN_CONGESTION_MIN_SAMPLES,
    mode: "same-timeband-baseline",
    timeBand,
    thresholds: {
      minimumDropKmh: SUDDEN_CONGESTION_MIN_DROP_KMH,
      minimumDropRatio: SUDDEN_CONGESTION_MIN_DROP_RATIO
    }
  };
}

function buildTrafficBriefing(stats, previousEntry, suddenCongestion, top10) {
  const previousSpeed = Number(previousEntry?.averageSpeed);
  const previousCongested = Number(previousEntry?.congestedRatio);
  const previousIndex = Number(previousEntry?.trafficIndex);

  const currentSpeed = Number(stats?.averageSpeed || 0);
  const currentCongested = Number(stats?.statusRatios?.congested || 0);
  const currentIndex = Number(stats?.trafficIndex || 0);

  const speedDelta = Number.isFinite(previousSpeed)
    ? Number((currentSpeed - previousSpeed).toFixed(1))
    : null;
  const congestionDelta = Number.isFinite(previousCongested)
    ? Number((currentCongested - previousCongested).toFixed(1))
    : null;
  const indexDelta = Number.isFinite(previousIndex)
    ? Number((currentIndex - previousIndex).toFixed(1))
    : null;

  let trend = "유지";
  if (indexDelta !== null) {
    if (indexDelta <= -8) trend = "악화";
    else if (indexDelta >= 8) trend = "개선";
    else if (indexDelta <= -3) trend = "다소 악화";
    else if (indexDelta >= 3) trend = "다소 개선";
  }

  const sentences = [];

  if (indexDelta === null) {
    sentences.push(`현재 부산 교통지수는 ${currentIndex.toFixed(1)}점으로 ${stats.trafficIndexGrade || stats.congestionLevel || "현재 상태"}입니다.`);
  } else {
    const direction = indexDelta > 0 ? "개선" : indexDelta < 0 ? "악화" : "변화 없음";
    sentences.push(
      `현재 부산 교통지수는 ${currentIndex.toFixed(1)}점으로 직전 완성 수집 사이클 대비 ${Math.abs(indexDelta).toFixed(1)}점 ${direction}했습니다.`
    );
  }

  if (speedDelta !== null) {
    if (speedDelta < -3) {
      sentences.push(`부산 평균속도는 ${Math.abs(speedDelta).toFixed(1)}km/h 낮아졌습니다.`);
    } else if (speedDelta > 3) {
      sentences.push(`부산 평균속도는 ${speedDelta.toFixed(1)}km/h 높아졌습니다.`);
    } else {
      sentences.push("부산 평균속도는 직전 사이클과 큰 차이가 없습니다.");
    }
  }

  if (congestionDelta !== null) {
    if (congestionDelta >= 5) {
      sentences.push(`정체 비율이 ${congestionDelta.toFixed(1)}%p 증가했습니다.`);
    } else if (congestionDelta <= -5) {
      sentences.push(`정체 비율이 ${Math.abs(congestionDelta).toFixed(1)}%p 감소했습니다.`);
    }
  }

  const suddenCount = Number(suddenCongestion?.detectedCount || 0);
  if (suddenCount > 0) {
    sentences.push(`평소보다 급격히 느려진 도로 ${suddenCount}개 구간이 감지되었습니다.`);
  } else {
    sentences.push("현재 기준에서 급격한 속도 저하가 감지된 주요 구간은 없습니다.");
  }

  const bottleneck = top10?.[0];
  if (bottleneck?.roadName) {
    sentences.push(
      `현재 가장 느린 주요 구간은 ${bottleneck.roadName} ${bottleneck.startName || ""} → ${bottleneck.endName || ""}이며 ${Number(bottleneck.speed).toFixed(1)}km/h입니다.`
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    trend,
    headline:
      trend === "악화"
        ? "부산 교통 흐름이 직전 사이클보다 악화되었습니다."
        : trend === "개선"
          ? "부산 교통 흐름이 직전 사이클보다 개선되었습니다."
          : "부산 교통 흐름은 직전 사이클과 비교해 큰 변화가 없습니다.",
    summary: sentences.join(" "),
    metrics: {
      currentTrafficIndex: currentIndex,
      previousTrafficIndex: Number.isFinite(previousIndex) ? previousIndex : null,
      trafficIndexDelta: indexDelta,
      currentAverageSpeed: currentSpeed,
      averageSpeedDelta: speedDelta,
      currentCongestedRatio: currentCongested,
      congestedRatioDelta: congestionDelta,
      suddenCongestionCount: suddenCount
    }
  };
}

async function archiveHistoricalSnapshot(env, snapshot, busanRows) {
  const fetchedAt = snapshot.fetchedAt || new Date().toISOString();
  const cycleId = fetchedAt.replace(/[-:.TZ]/g, "");
  const historyKey = `${HISTORY_KEY_PREFIX}${cycleId}`;

  // 시계열 분석에 필요한 핵심 필드만 저장해 현재 latest 스냅샷의 중복을 최소화한다.
  const historyRows = busanRows.map((row) => ({
    linkId: row.linkId || "",
    roadName: row.roadName || "",
    startName: row.startName || "",
    endName: row.endName || "",
    speed: Number(row.speed),
    status: row.status || "UNKNOWN",
    category: row.category || "",
    latitude: Number.isFinite(Number(row.latitude)) ? Number(row.latitude) : null,
    longitude: Number.isFinite(Number(row.longitude)) ? Number(row.longitude) : null,
    startLatitude: Number.isFinite(Number(row.startLatitude)) ? Number(row.startLatitude) : null,
    startLongitude: Number.isFinite(Number(row.startLongitude)) ? Number(row.startLongitude) : null,
    endLatitude: Number.isFinite(Number(row.endLatitude)) ? Number(row.endLatitude) : null,
    endLongitude: Number.isFinite(Number(row.endLongitude)) ? Number(row.endLongitude) : null
  }));

  const historyEntry = {
    version: 1,
    fetchedAt,
    source: "부산광역시 링크소통정보",
    totalCount: historyRows.length,
    reportedTotalCount: Number(snapshot.collection?.reportedTotalCount || historyRows.length),
    totalPages: Number(snapshot.collection?.totalPages || 0),
    stats: calculateBusanStats(historyRows),
    suddenCongestion: snapshot.suddenCongestion || null,
    trafficBriefing: snapshot.trafficBriefing || null,
    rows: historyRows
  };

  await env.TRAFFIC_CACHE.put(
    historyKey,
    JSON.stringify(historyEntry),
    { expirationTtl: HISTORY_RETENTION_TTL }
  );

  const existingIndex = (await env.TRAFFIC_CACHE.get(HISTORY_INDEX_KEY, "json")) || [];
  const indexEntries = Array.isArray(existingIndex) ? existingIndex : [];
  const cutoff = Date.now() - HISTORY_RETENTION_TTL * 1000;

  const nextIndex = [
    ...indexEntries.filter((entry) => {
      const timestamp = Date.parse(entry?.fetchedAt || "");
      return (
        Number.isFinite(timestamp) &&
        timestamp >= cutoff &&
        entry?.fetchedAt !== fetchedAt &&
        entry?.key !== historyKey
      );
    }),
    {
      key: historyKey,
      fetchedAt,
      totalCount: historyRows.length,
      averageSpeed: historyEntry.stats.averageSpeed,
      trafficIndex: historyEntry.stats.trafficIndex,
      congestedRatio: historyEntry.stats.statusRatios.congested
    }
  ]
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))
    .slice(0, HISTORY_MAX_ENTRIES);

  await env.TRAFFIC_CACHE.put(
    HISTORY_INDEX_KEY,
    JSON.stringify(nextIndex),
    { expirationTtl: HISTORY_RETENTION_TTL }
  );

  return {
    historyKey,
    historyEntries: nextIndex.length,
    historyRows: historyRows.length
  };
}

async function fetchBusanPage(apiKey, pageNo) {
  const url = new URL(BUSAN_API_URL);
  url.searchParams.set("serviceKey", apiKey);
  url.searchParams.set("resultType", "json");
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", String(PAGE_SIZE));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);

    const payload = JSON.parse(text);
    const apiError = getBusanApiError(payload);

    if (apiError.hasError) {
      const safeUrl = sanitizeUrlForDiagnostics(url.toString());
      throw new Error(
        `BUSAN_TRAFFIC_API_ERROR: code=${apiError.resultCode}, message=${apiError.resultMsg || apiError.returnAuthMsg || "unknown"}, endpoint=${safeUrl}, response=${JSON.stringify(payload).slice(0, 1200)}`
      );
    }

    return payload;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchItsData(itsApiKey) {
  if (!itsApiKey) return [];
  const url = new URL(ITS_API_URL);
  url.searchParams.set("apiKey", itsApiKey);
  url.searchParams.set("type", "all");
  url.searchParams.set("getType", "json");
  url.searchParams.set("minX", "128.75");
  url.searchParams.set("maxX", "129.35");
  url.searchParams.set("minY", "34.98");
  url.searchParams.set("maxY", "35.40");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const data = await response.json();
    const rawItems = data?.body?.items || data?.response?.body?.items || [];
    const list = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);

    return list.map((item) => ({
      linkId: String(item.linkId || item.roadSectionId || "").trim(),
      roadName: String(item.roadName || item.routeName || "").trim(),
      startName: String(item.startNodeName || "").trim(),
      endName: String(item.endNodeName || "").trim(),
      speed: Number(item.speed || item.travelSpeed || 0),
      source: "ITS"
    })).filter((row) => row.roadName && Number.isFinite(row.speed) && row.speed > 0);
  } catch (e) {
    console.warn("ITS API fetch failed in collector:", e);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeBusanItems(payload, normalizedPayload = null) {
  const normalized = normalizedPayload || normalizeTrafficPayload(payload);

  return normalized.rows.map((row) => {
    const roadName = String(row.roadName || "").trim();
    const speed = Number(row.speed);
    const category = getRoadCategory(roadName);
    const evalResult = evaluateTrafficStatus(speed, category);

    return {
      ...row,
      roadName,
      speed,
      volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : null,
      category,
      categoryName: SPEED_CRITERIA[category]?.categoryName || "일반도로",
      status: evalResult.status,
      statusText: evalResult.statusText,
      statusColor: evalResult.color
    };
  }).filter((row) =>
    (row.linkId || row.roadName || row.startName || row.endName) &&
    Number.isFinite(row.speed) &&
    row.speed >= 0 &&
    row.speed <= 160
  );
}

export default {
  async scheduled(controller, env) {
    const startedAt = Date.now();
    console.log({ event: "collector-start", scheduledTime: controller?.scheduledTime });

    try {
      const busanApiKey = getApiKey(env.BUSAN_TRAFFIC_API_KEY || env.BUSAN_API_KEY);
      const itsApiKey = getApiKey(env.ITS_API_KEY);

      if (!busanApiKey) throw new Error("BUSAN_TRAFFIC_API_KEY is not configured.");
      if (!env.TRAFFIC_CACHE) throw new Error("TRAFFIC_CACHE KV binding is not configured.");

      // 1. 부산 데이터 수집
      // Workers Free의 invocation당 subrequest 제한을 피하기 위해
      // 매 10분마다 3페이지씩 순환 수집한다.
      // 각 배치가 끝날 때마다 갱신된 링크를 latest에 즉시 반영하고,
      // 전체 사이클이 완료되면 오래된 링크를 정리한 완성 스냅샷으로 교체한다.
      let state = await env.TRAFFIC_CACHE.get(COLLECTOR_STATE_KEY, "json");

      // 최신 스냅샷이 수집 누적 데이터의 단일 원본이다.
      // 이전 구조는 latest와 accumulator에 같은 9천여 행을 중복 저장/파싱했다.
      // v2 상태는 한 번 새 사이클을 시작하면서 v3의 경량 상태로 전환한다.
      const incrementalCollectorEnabled = Number(state?.collectorVersion || 0) === 3;
      const cycleInProgress = incrementalCollectorEnabled && state?.inProgress === true;
      let previousSnapshot = null;

      // Briefing 단계에는 latest의 대형 rows 배열이 필요하지 않으므로 작은 분석 키만 사용한다.
      if (incrementalCollectorEnabled && state?.phase === "briefing-pending") {
        const analysis = await env.TRAFFIC_CACHE.get(SNAPSHOT_ANALYSIS_KEY, "json");
        if (!analysis || analysis.fetchedAt !== state?.pendingSnapshotFetchedAt || !analysis.suddenCongestion) {
          throw new Error("TRAFFIC_BRIEFING_PENDING_ANALYSIS_MISSING");
        }

        if (!analysis.trafficBriefing) {
          const historyIndex = (await env.TRAFFIC_CACHE.get(HISTORY_INDEX_KEY, "json")) || [];
          const previousHistoryEntry = Array.isArray(historyIndex)
            ? historyIndex
                .filter((entry) => Number.isFinite(Date.parse(entry?.fetchedAt || "")))
                .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0]
            : null;

          analysis.trafficBriefing = buildTrafficBriefing(
            analysis.stats,
            previousHistoryEntry,
            analysis.suddenCongestion,
            analysis.top10
          );
          analysis.updatedAt = new Date().toISOString();
          await env.TRAFFIC_CACHE.put(
            SNAPSHOT_ANALYSIS_KEY,
            JSON.stringify(analysis),
            { expirationTtl: LATEST_SNAPSHOT_TTL }
          );
        }

        await env.TRAFFIC_CACHE.put(
          COLLECTOR_STATE_KEY,
          JSON.stringify({
            collectorVersion: 3,
            inProgress: false,
            phase: "history-pending",
            currentPage: 1,
            totalPages: Number(analysis.totalPages || 0),
            reportedTotalCount: Number(analysis.reportedTotalCount || 0),
            pendingSnapshotFetchedAt: analysis.fetchedAt,
            completedPages: [],
            failedPages: [],
            cycleStartedAt: null,
            refreshedLinks: 0,
            updatedAt: new Date().toISOString()
          }),
          { expirationTtl: COLLECTION_TTL }
        );
        console.log({
          event: "collector-briefing-complete",
          fetchedAt: analysis.fetchedAt,
          trend: analysis.trafficBriefing?.trend || null
        });
        return;
      }

      previousSnapshot =
        (await env.TRAFFIC_CACHE.get(SNAPSHOT_KEY, "json")) || null;

      // 급격한 정체 기준 갱신은 12개 shard로 나눠 4개씩 처리해 CPU/직렬화량을 제한한다.
      if (incrementalCollectorEnabled && state?.phase === "sudden-pending") {
        if (!previousSnapshot || !Array.isArray(previousSnapshot.rows)) {
          throw new Error("TRAFFIC_SUDDEN_PENDING_SNAPSHOT_MISSING");
        }
        if (previousSnapshot.fetchedAt !== state?.pendingSnapshotFetchedAt) {
          throw new Error("TRAFFIC_SUDDEN_PENDING_SNAPSHOT_MISMATCH");
        }

        let analysis = await env.TRAFFIC_CACHE.get(SNAPSHOT_ANALYSIS_KEY, "json");
        if (analysis?.fetchedAt === previousSnapshot.fetchedAt && analysis.suddenCongestion) {
          await env.TRAFFIC_CACHE.put(
            COLLECTOR_STATE_KEY,
            JSON.stringify({
              collectorVersion: 3,
              inProgress: false,
              phase: "briefing-pending",
              currentPage: 1,
              totalPages: Number(previousSnapshot.collection?.totalPages || 0),
              reportedTotalCount: Number(previousSnapshot.collection?.reportedTotalCount || 0),
              pendingSnapshotFetchedAt: previousSnapshot.fetchedAt,
              completedPages: [],
              failedPages: [],
              cycleStartedAt: null,
              refreshedLinks: 0,
              updatedAt: new Date().toISOString()
            }),
            { expirationTtl: COLLECTION_TTL }
          );
          return;
        }

        const cursor = Math.max(
          0,
          Math.min(BASELINE_SHARD_COUNT, Number(state?.baselineShardCursor || 0))
        );
        const shardIds = [];
        for (
          let shardId = cursor;
          shardId < Math.min(BASELINE_SHARD_COUNT, cursor + BASELINE_SHARDS_PER_RUN);
          shardId += 1
        ) {
          shardIds.push(shardId);
        }

        const targetShards = new Set(shardIds);
        const rowsByShard = new Map(shardIds.map((shardId) => [shardId, []]));
        for (const row of previousSnapshot.rows) {
          if (row?.source === "ITS") continue;
          const shardId = getBaselineShardIndex(row);
          if (targetShards.has(shardId)) rowsByShard.get(shardId).push(row);
        }

        const timeBand = state?.pendingTimeBand ||
          getTimeBand(getKoreaHour(new Date(previousSnapshot.fetchedAt)));
        let pendingAlerts = Array.isArray(state?.pendingAlerts) ? state.pendingAlerts : [];
        let pendingDetectedCount = Number(state?.pendingDetectedCount || 0);

        for (const shardId of shardIds) {
          const shardResult = await calculateAndUpdateSuddenCongestion(
            env,
            rowsByShard.get(shardId),
            previousSnapshot.fetchedAt,
            timeBand,
            shardId
          );
          pendingDetectedCount += Number(shardResult.detectedCount || 0);
          pendingAlerts = mergeSuddenCongestionAlerts(pendingAlerts, shardResult.items);
        }

        const nextCursor = cursor + shardIds.length;
        const stateBase = {
          collectorVersion: 3,
          inProgress: false,
          currentPage: 1,
          totalPages: Number(previousSnapshot.collection?.totalPages || 0),
          reportedTotalCount: Number(previousSnapshot.collection?.reportedTotalCount || 0),
          pendingSnapshotFetchedAt: previousSnapshot.fetchedAt,
          completedPages: [],
          failedPages: [],
          cycleStartedAt: null,
          refreshedLinks: 0,
          updatedAt: new Date().toISOString()
        };

        if (nextCursor >= BASELINE_SHARD_COUNT) {
          analysis = {
            fetchedAt: previousSnapshot.fetchedAt,
            totalPages: stateBase.totalPages,
            reportedTotalCount: stateBase.reportedTotalCount,
            stats: previousSnapshot.stats || null,
            top10: Array.isArray(previousSnapshot.top10) ? previousSnapshot.top10 : [],
            suddenCongestion: {
              detectedCount: pendingDetectedCount,
              items: pendingAlerts,
              baselineSampleSize: BASELINE_SAMPLE_SIZE,
              minimumSamples: SUDDEN_CONGESTION_MIN_SAMPLES,
              mode: "same-timeband-baseline",
              timeBand,
              thresholds: {
                minimumDropKmh: SUDDEN_CONGESTION_MIN_DROP_KMH,
                minimumDropRatio: SUDDEN_CONGESTION_MIN_DROP_RATIO
              }
            },
            trafficBriefing: null,
            updatedAt: new Date().toISOString()
          };
          await env.TRAFFIC_CACHE.put(
            SNAPSHOT_ANALYSIS_KEY,
            JSON.stringify(analysis),
            { expirationTtl: LATEST_SNAPSHOT_TTL }
          );
          await env.TRAFFIC_CACHE.put(
            COLLECTOR_STATE_KEY,
            JSON.stringify({ ...stateBase, phase: "briefing-pending" }),
            { expirationTtl: COLLECTION_TTL }
          );
          console.log({
            event: "collector-sudden-analysis-complete",
            fetchedAt: analysis.fetchedAt,
            baselineShards: BASELINE_SHARD_COUNT,
            detectedCount: pendingDetectedCount
          });
        } else {
          await env.TRAFFIC_CACHE.put(
            COLLECTOR_STATE_KEY,
            JSON.stringify({
              ...stateBase,
              phase: "sudden-pending",
              baselineShardCursor: nextCursor,
              pendingTimeBand: timeBand,
              pendingAlerts,
              pendingDetectedCount
            }),
            { expirationTtl: COLLECTION_TTL }
          );
          console.log({
            event: "collector-sudden-analysis-progress",
            fetchedAt: previousSnapshot.fetchedAt,
            completedShards: nextCursor,
            totalShards: BASELINE_SHARD_COUNT,
            detectedCountSoFar: pendingDetectedCount
          });
        }
        return;
      }

      // 이력 저장 실패는 별도 실행에서 재시도해 수집 상태를 손상시키지 않는다.
      if (incrementalCollectorEnabled && state?.phase === "history-pending") {
        if (!previousSnapshot || !Array.isArray(previousSnapshot.rows)) {
          throw new Error("TRAFFIC_HISTORY_PENDING_SNAPSHOT_MISSING");
        }
        const analysis = await env.TRAFFIC_CACHE.get(SNAPSHOT_ANALYSIS_KEY, "json");
        const historySnapshot = analysis?.fetchedAt === previousSnapshot.fetchedAt
          ? {
              ...previousSnapshot,
              suddenCongestion: analysis.suddenCongestion || previousSnapshot.suddenCongestion,
              trafficBriefing: analysis.trafficBriefing || previousSnapshot.trafficBriefing
            }
          : previousSnapshot;
        const busanRows = historySnapshot.rows.filter((row) => row?.source !== "ITS");
        const historyResult = await archiveHistoricalSnapshot(env, historySnapshot, busanRows);
        await env.TRAFFIC_CACHE.delete(COLLECTOR_ACCUMULATOR_KEY);
        await env.TRAFFIC_CACHE.put(
          COLLECTOR_STATE_KEY,
          JSON.stringify({
            collectorVersion: 3,
            inProgress: false,
            phase: null,
            currentPage: 1,
            totalPages: Number(historySnapshot.collection?.totalPages || 0),
            reportedTotalCount: Number(historySnapshot.collection?.reportedTotalCount || 0),
            completedPages: [],
            failedPages: [],
            cycleStartedAt: null,
            refreshedLinks: 0,
            updatedAt: new Date().toISOString(),
            lastCompletedAt: historySnapshot.fetchedAt || new Date().toISOString()
          }),
          { expirationTtl: COLLECTION_TTL }
        );
        console.log({
          event: "collector-history-pending-recovered",
          historyKey: historyResult.historyKey,
          historyEntries: historyResult.historyEntries,
          historyRows: historyResult.historyRows
        });
        return;
      }

      let currentPage = Number(state?.currentPage || 1);
      let totalPages = Number(state?.totalPages || 0);
      let reportedTotalCount = Number(state?.reportedTotalCount || 0);
      let cycleStartedAt = state?.cycleStartedAt || null;
      let refreshedLinks = Number(state?.refreshedLinks || 0);

      if (!Number.isInteger(currentPage) || currentPage < 1) currentPage = 1;

      let completedPages = new Set(
        Array.isArray(state?.completedPages)
          ? state.completedPages
              .map((page) => Number(page))
              .filter((page) => Number.isInteger(page) && page >= 1)
          : []
      );

      let failedPages = new Set(
        Array.isArray(state?.failedPages)
          ? state.failedPages
              .map((page) => Number(page))
              .filter((page) => Number.isInteger(page) && page >= 1)
          : []
      );

      let accumulator = Array.isArray(previousSnapshot?.rows)
        ? previousSnapshot.rows
        : [];

      if (cycleInProgress) {
        // v3는 latest rows 자체를 누적 본문으로 사용해 대형 KV를 한 번만 읽고 쓴다.
        // 이전 상태에서 latest가 비어 있는 예외 상황에만 레거시 accumulator로 복구한다.
        if (accumulator.length === 0) {
          const legacyAccumulator =
            (await env.TRAFFIC_CACHE.get(COLLECTOR_ACCUMULATOR_KEY, "json")) || [];
          if (Array.isArray(legacyAccumulator)) accumulator = legacyAccumulator;
        }
      } else {
        // v2 상태/새 설치는 직전 스냅샷을 기준으로 새 사이클을 시작한다.
        completedPages = new Set();
        failedPages = new Set();
        currentPage = 1;
        totalPages = 0;
        reportedTotalCount = 0;
        cycleStartedAt = new Date().toISOString();
        refreshedLinks = 0;
      }

      if (!cycleStartedAt) cycleStartedAt = new Date().toISOString();

      const pageNumbers = [];
      const selectedPages = new Set();

      // 실패했던 페이지를 먼저 재시도한다.
      for (const page of [...failedPages].sort((a, b) => a - b)) {
        if (pageNumbers.length >= PAGES_PER_RUN) break;
        if (totalPages > 0 && page > totalPages) continue;
        pageNumbers.push(page);
        selectedPages.add(page);
      }

      // 남은 슬롯은 아직 처리하지 않은 순차 페이지로 채운다.
      let sequentialPage = currentPage;
      while (pageNumbers.length < PAGES_PER_RUN) {
        if (totalPages > 0 && sequentialPage > totalPages) break;

        if (
          !selectedPages.has(sequentialPage) &&
          !completedPages.has(sequentialPage) &&
          !failedPages.has(sequentialPage)
        ) {
          pageNumbers.push(sequentialPage);
          selectedPages.add(sequentialPage);
        }

        sequentialPage += 1;

        // 비정상 상태로 인한 무한 루프 방지
        if (sequentialPage > 100000) break;
      }

      // 최초 수집 또는 진행 중인 사이클에서 아무 페이지도 선택되지 않는 상태는 방지한다.
      if (pageNumbers.length === 0 && totalPages === 0) {
        pageNumbers.push(1);
      }

      const settledResults = await Promise.allSettled(
        pageNumbers.map((page) => fetchBusanPage(busanApiKey, page))
      );

      const batchRows = [];

      for (let index = 0; index < pageNumbers.length; index += 1) {
        const page = pageNumbers[index];
        const result = settledResults[index];

        if (result.status === "rejected") {
          failedPages.add(page);
          console.warn({
            event: "collector-page-failed",
            page,
            error: result.reason?.message || String(result.reason || "unknown error"),
            currentPage,
            totalPages,
            reportedTotalCount
          });
          continue;
        }

        const payload = result.value;
        const normalized = normalizeTrafficPayload(payload);
        const pageReportedTotal = Number(normalized.totalCount ?? 0);

        if (pageReportedTotal > 0) {
          reportedTotalCount = Math.max(reportedTotalCount, pageReportedTotal);
        }

        if (reportedTotalCount > 0) {
          totalPages = Math.max(1, Math.ceil(reportedTotalCount / PAGE_SIZE));
        }

        const pageRows = normalizeBusanItems(payload, normalized);

        if (pageRows.length === 0) {
          failedPages.add(page);
          console.warn({
            event: "collector-page-empty",
            page,
            totalPages,
            reportedTotalCount
          });
          continue;
        }

        batchRows.push(...pageRows);
        completedPages.add(page);
        failedPages.delete(page);
      }

      // API가 알려준 총 페이지 범위를 넘어선 오래된 상태값은 제거한다.
      if (totalPages > 0) {
        completedPages = new Set(
          [...completedPages].filter((page) => page <= totalPages)
        );
        failedPages = new Set(
          [...failedPages].filter((page) => page <= totalPages)
        );
      }

      const cycleComplete =
        totalPages > 0 &&
        completedPages.size >= totalPages &&
        failedPages.size === 0;

      const mergedRows = new Map();

      for (const row of accumulator) {
        // 전체 수집이 끝난 순간에는 이번 사이클에서 확인되지 않은 오래된 링크를 버린다.
        if (cycleComplete && row?.__collectorCycleId !== cycleStartedAt) continue;

        const key = row.linkId
          ? `link:${row.linkId}`
          : `section:${row.roadName}|${row.sectionName}|${row.startName}|${row.endName}`;

        if (cycleComplete && row?.__collectorCycleId === cycleStartedAt) {
          const cleanRow = { ...row };
          delete cleanRow.__collectorCycleId;
          mergedRows.set(key, cleanRow);
        } else {
          mergedRows.set(key, row);
        }
      }

      for (const row of batchRows) {
        const key = getTrafficRowKey(row);
        // 모든 행에 이번 사이클에서 실제 확인했는지 표시한다.
        // 이전에는 9천여 개 링크 키를 collector-state에 매번 저장했다.
        mergedRows.set(key, cycleComplete ? row : { ...row, __collectorCycleId: cycleStartedAt });
      }

      refreshedLinks += batchRows.length;
      accumulator = Array.from(mergedRows.values());

      const lastCollectedPage = completedPages.size > 0
        ? Math.max(...completedPages)
        : 0;

      console.log({
        event: "collector-progress",
        currentPage,
        lastCollectedPage,
        totalPages,
        reportedTotalCount,
        batchRows: batchRows.length,
        accumulatedRows: accumulator.length,
        completedPages: completedPages.size,
        failedPages: [...failedPages].sort((a, b) => a - b),
        cycleComplete
      });

      if (!cycleComplete) {
        const nextPage = Math.max(currentPage, sequentialPage);
        const nowIso = new Date().toISOString();

        const incrementalAnalysis = calculateBusanAnalysis(accumulator);
        const incrementalStats = incrementalAnalysis.stats;
        const incrementalTop10 = incrementalAnalysis.top10;
        const incrementalSnapshot = {
          snapshotType: "INCREMENTAL",
          source: "부산광역시 링크소통정보",
          stats: incrementalStats,
          top10: incrementalTop10,
          trafficBriefing: previousSnapshot?.trafficBriefing || null,
          suddenCongestion: previousSnapshot?.suddenCongestion || {
            detectedCount: 0,
            items: []
          },
          rows: accumulator,
          totalCount: accumulator.length,
          fetchedAt: nowIso,
          durationMs: Date.now() - startedAt,
          warning: "전체 수집 사이클 진행 중 · 일부 링크는 직전 스냅샷 값일 수 있습니다.",
          collection: {
            mode: "incremental",
            cycleComplete: false,
            cycleStartedAt,
            reportedTotalCount,
            totalPages,
            pagesPerRun: PAGES_PER_RUN,
            completedPages: completedPages.size,
            failedPages: [...failedPages].sort((a, b) => a - b),
            refreshedRows: batchRows.length,
            refreshedLinks,
            lastIncrementalUpdateAt: nowIso
          }
        };

        if (Array.isArray(incrementalSnapshot.rows) && incrementalSnapshot.rows.length > 0) {
          await env.TRAFFIC_CACHE.put(
            SNAPSHOT_KEY,
            JSON.stringify(incrementalSnapshot),
            { expirationTtl: LATEST_SNAPSHOT_TTL }
          );
        }

        // 체크포인트는 최신 스냅샷이 저장된 뒤 기록한다.
        // CPU 초과가 snapshot 생성 중 발생해도 다음 실행이 같은 페이지를 안전하게 재시도한다.
        await env.TRAFFIC_CACHE.put(
          COLLECTOR_STATE_KEY,
          JSON.stringify({
            collectorVersion: 3,
            inProgress: true,
            currentPage: totalPages > 0 && nextPage > totalPages ? 1 : nextPage,
            totalPages,
            reportedTotalCount,
            completedPages: [...completedPages].sort((a, b) => a - b),
            failedPages: [...failedPages].sort((a, b) => a - b),
            cycleStartedAt,
            refreshedLinks,
            updatedAt: nowIso,
            lastIncrementalUpdateAt: nowIso
          }),
          { expirationTtl: COLLECTION_TTL }
        );

        console.log({
          event: "collector-incremental-snapshot-saved",
          nextPage: totalPages > 0 && nextPage > totalPages ? 1 : nextPage,
          totalPages,
          accumulatedRows: accumulator.length,
          refreshedRows: batchRows.length,
          refreshedLinks,
          completedPages: completedPages.size,
          failedPages: [...failedPages].sort((a, b) => a - b)
        });

        return;
      }

      // 한 사이클이 모두 끝나면 이번 사이클에서 실제로 확인된 링크만 남겨
      // 오래된 링크를 정리하고 완성 스냅샷으로 확정한다.
      const sourceParts = ["부산광역시 링크소통정보"];
      const warnings = [];
      // cycleComplete 분기에서 최신 사이클에 포함된 행만 남기고 마커를 정리했다.
      const rows = accumulator;
      const busanRowsForHistory = rows.slice();

      // 2. ITS 데이터 수집 (보조/광역)
      if (itsApiKey) {
        try {
          const itsRows = await fetchItsData(itsApiKey);
          if (itsRows.length > 0) {
            const normalizedIts = itsRows.map((item) => {
              const cat = getRoadCategory(item.roadName);
              const ev = evaluateTrafficStatus(item.speed, cat);
              return {
                ...item,
                category: cat,
                categoryName: SPEED_CRITERIA[cat]?.categoryName || "일반도로",
                status: ev.status,
                statusText: ev.statusText,
                statusColor: ev.color,
                updatedAt: new Date().toISOString()
              };
            });
            rows.push(...normalizedIts);
            sourceParts.push("국토교통부 ITS");
          } else {
            warnings.push("ITS API에서 유효한 교통 데이터가 반환되지 않았습니다.");
          }
        } catch (error) {
          warnings.push(`ITS API 수집 실패: ${error?.message || error}`);
          console.warn("ITS API fetch failed in collector:", error);
        }
      }

      // 3. 비즈니스 파이프라인 연산: 전체 누적 데이터 기준 통계 및 정체 TOP 10 산출
      const completeAnalysis = calculateBusanAnalysis(rows);
      const stats = completeAnalysis.stats;
      const top10 = completeAnalysis.top10;

      // 급격한 정체 분석과 브리핑은 별도 Cron 단계에서 계산한다.
      // COMPLETE 스냅샷 생성과 대규모 baseline 처리를 한 invocation에 겹치지 않는다.
      const suddenCongestion = previousSnapshot?.suddenCongestion || {
        detectedCount: 0,
        items: [],
        baselineSampleSize: BASELINE_SAMPLE_SIZE,
        minimumSamples: SUDDEN_CONGESTION_MIN_SAMPLES,
        thresholds: {
          minimumDropKmh: SUDDEN_CONGESTION_MIN_DROP_KMH,
          minimumDropRatio: SUDDEN_CONGESTION_MIN_DROP_RATIO
        }
      };
      const trafficBriefing = previousSnapshot?.trafficBriefing || null;

      const snapshot = {
        snapshotType: "COMPLETE",
        source: sourceParts.join(" & "),
        stats,
        top10,
        trafficBriefing,
        suddenCongestion,
        rows,
        totalCount: rows.length,
        fetchedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        warning: warnings.length > 0 ? warnings.join(" | ") : null,
        collection: {
          reportedTotalCount,
          totalPages,
          pagesPerRun: PAGES_PER_RUN,
          mode: "complete",
          cycleComplete: true,
          cycleStartedAt,
          completedPages: completedPages.size,
          failedPages: [],
          refreshedLinks: rows.length,
          completedAt: new Date().toISOString()
        }
      };

      // 유효한 스냅샷만 KV에 저장한다.
      if (!Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
        throw new Error("TRAFFIC_SNAPSHOT_EMPTY: 빈 스냅샷은 KV에 저장하지 않습니다.");
      }

      // KV 캐시에 최신 스냅샷 저장 (2시간 만료 보존)
      await env.TRAFFIC_CACHE.put(SNAPSHOT_KEY, JSON.stringify(snapshot), {
        expirationTtl: LATEST_SNAPSHOT_TTL
      });

      // COMPLETE 스냅샷은 이 시점에서 확정한다. 이후 분석/이력 처리는 별도 Cron 실행이다.
      await env.TRAFFIC_CACHE.put(
        COLLECTOR_STATE_KEY,
        JSON.stringify({
          collectorVersion: 3,
          inProgress: false,
          phase: "sudden-pending",
          currentPage: 1,
          totalPages,
          reportedTotalCount,
          pendingSnapshotFetchedAt: snapshot.fetchedAt,
          completedPages: [],
          failedPages: [],
          cycleStartedAt: null,
          refreshedLinks: 0,
          updatedAt: new Date().toISOString(),
          lastCompletedAt: snapshot.fetchedAt
        }),
        { expirationTtl: COLLECTION_TTL }
      );

      console.log({
        event: "collector-cycle-snapshot-saved",
        fetchedAt: snapshot.fetchedAt,
        totalRows: rows.length,
        avgSpeed: stats.averageSpeed,
        congestedRatio: stats.statusRatios.congested,
        phase: "sudden-pending"
      });
      return;


    } catch (error) {
      console.error({ event: "collector-failed", error: error?.message || error });
      throw error;
    }
  }
};
