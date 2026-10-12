import { normalizeTrafficPayload } from "../../functions/lib/normalizeTraffic.js";

const BUSAN_API_URL = "https://apis.data.go.kr/6260000/BusanITSLINKTraffic/LINKTrafficList";
const ITS_API_URL = "https://openapi.its.go.kr:9443/trafficInfo";
const SNAPSHOT_KEY = "traffic:busan:latest"; // 구형 스냅샷 호환용
const SNAPSHOT_ANALYSIS_KEY = "traffic:busan:latest-analysis";
const COLLECTOR_STATE_KEY = "traffic:busan:collector-state";
const POSTPROCESS_STATE_KEY = "traffic:busan:postprocess-state";
const PAGE_SIZE = 100;
const PAGES_PER_RUN = 3;
const REQUEST_TIMEOUT_MS = 60000;
const LATEST_SNAPSHOT_TTL = 60 * 60 * 24 * 14;
const COLLECTION_TTL = 60 * 60 * 24 * 14;
const HISTORY_INDEX_KEY = "traffic:busan:history:index";
const HISTORY_KEY_PREFIX = "traffic:busan:history:";
const ROW_SHARD_KEY_PREFIX = "traffic:busan:rows:v4:";
const GROUP_SUMMARY_KEY_PREFIX = "traffic:busan:rows:v4-summary:";
const HISTORY_RETENTION_DAYS = 14;
const HISTORY_RETENTION_TTL = 60 * 60 * 24 * HISTORY_RETENTION_DAYS;
// Row shards outlive their history index entry so the final history items remain resolvable.
const ROW_SHARD_RETENTION_TTL = HISTORY_RETENTION_TTL + 60 * 60 * 24;
const HISTORY_MAX_ENTRIES = 96;
// 10개 그룹으로 나눠 Worker가 매번 전체 9천 행을 읽거나 저장하지 않도록 한다.
const ROW_GROUP_COUNT = 10;
const ROW_PAGES_PER_GROUP = 10;
// 시간대별 기준값도 같은 페이지 그룹 단위로 분할해 소량씩 갱신한다.
const BASELINE_KEY_PREFIX = "traffic:busan:baseline-by-timeband:v5:";
const BASELINE_VERSION = 5;
const BASELINE_SHARD_COUNT = ROW_GROUP_COUNT;
// Free tier의 10ms CPU 제한에 여유를 두기 위해 실행당 최대 2개 그룹만 분석한다.
const BASELINE_SHARDS_PER_RUN = 2;
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

  return {
    stats,
    top10,
    aggregate: {
      totalCount,
      totalSpeed,
      smoothCount,
      slowCount,
      congestedCount,
      slowestRoad: stats.slowestRoad
    }
  };
}

function buildStatsFromAggregate(aggregate) {
  const totalCount = Number(aggregate?.totalCount || 0);
  const totalSpeed = Number(aggregate?.totalSpeed || 0);
  const smoothCount = Number(aggregate?.smoothCount || 0);
  const slowCount = Number(aggregate?.slowCount || 0);
  const congestedCount = Number(aggregate?.congestedCount || 0);

  if (!totalCount) {
    return {
      totalCount: 0,
      averageSpeed: 0,
      trafficIndex: 0,
      trafficIndexGrade: "데이터 없음",
      statusCounts: { smooth: 0, slow: 0, congested: 0 },
      statusRatios: { smooth: 0, slow: 0, congested: 0 },
      congestionLevel: "데이터 없음",
      slowestRoad: null
    };
  }

  const averageSpeed = Number((totalSpeed / totalCount).toFixed(1));
  const smoothRatio = Number(((smoothCount / totalCount) * 100).toFixed(1));
  const slowRatio = Number(((slowCount / totalCount) * 100).toFixed(1));
  const congestedRatio = Number(((congestedCount / totalCount) * 100).toFixed(1));
  const trafficIndex = Number(Math.max(0, Math.min(100, smoothRatio + slowRatio * 0.5)).toFixed(1));

  let trafficIndexGrade = "매우 혼잡";
  if (trafficIndex >= 80) trafficIndexGrade = "매우 원활";
  else if (trafficIndex >= 65) trafficIndexGrade = "원활";
  else if (trafficIndex >= 50) trafficIndexGrade = "보통";
  else if (trafficIndex >= 35) trafficIndexGrade = "혼잡";

  let congestionLevel = "원활";
  if (congestedRatio >= 25) congestionLevel = "매우 혼잡";
  else if (congestedRatio >= 15) congestionLevel = "혼잡";
  else if (congestedRatio >= 8 || slowRatio >= 30) congestionLevel = "다소 혼잡";

  return {
    totalCount,
    averageSpeed,
    trafficIndex,
    trafficIndexGrade,
    statusCounts: { smooth: smoothCount, slow: slowCount, congested: congestedCount },
    statusRatios: { smooth: smoothRatio, slow: slowRatio, congested: congestedRatio },
    congestionLevel,
    slowestRoad: aggregate.slowestRoad || null
  };
}

function combineGroupAnalyses(groupAnalyses) {
  const aggregate = {
    totalCount: 0,
    totalSpeed: 0,
    smoothCount: 0,
    slowCount: 0,
    congestedCount: 0,
    slowestRoad: null
  };
  const bestBySection = new Map();

  const compareRows = (a, b) => {
    if (a.status === "CONGESTED" && b.status !== "CONGESTED") return -1;
    if (a.status !== "CONGESTED" && b.status === "CONGESTED") return 1;
    return Number(a.speed) - Number(b.speed);
  };

  for (const analysis of groupAnalyses) {
    const part = analysis?.aggregate || {};
    aggregate.totalCount += Number(part.totalCount || 0);
    aggregate.totalSpeed += Number(part.totalSpeed || 0);
    aggregate.smoothCount += Number(part.smoothCount || 0);
    aggregate.slowCount += Number(part.slowCount || 0);
    aggregate.congestedCount += Number(part.congestedCount || 0);

    const slowest = part.slowestRoad;
    if (slowest && (!aggregate.slowestRoad || Number(slowest.speed) < Number(aggregate.slowestRoad.speed))) {
      aggregate.slowestRoad = slowest;
    }

    for (const item of Array.isArray(analysis?.top10) ? analysis.top10 : []) {
      const sectionKey = `${item.roadName}-${item.startName}-${item.endName}`;
      const existing = bestBySection.get(sectionKey);
      if (!existing || compareRows(item, existing) < 0) {
        bestBySection.set(sectionKey, item);
      }
    }
  }

  const top10 = Array.from(bestBySection.values())
    .sort(compareRows)
    .slice(0, 10)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  return {
    stats: buildStatsFromAggregate(aggregate),
    top10,
    aggregate
  };
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

function getRowGroupIndex(page) {
  return Math.max(0, Math.min(ROW_GROUP_COUNT - 1, Math.floor((Number(page) - 1) / ROW_PAGES_PER_GROUP)));
}

function getCycleRowShardKey(cycleId, groupId) {
  return `${ROW_SHARD_KEY_PREFIX}${cycleId}:${groupId}`;
}

async function readCycleRowShard(env, cycleId, groupId) {
  const shard = await env.TRAFFIC_CACHE.get(getCycleRowShardKey(cycleId, groupId), "json");
  if (!shard || shard.cycleId !== cycleId || !shard.pages || typeof shard.pages !== "object") {
    return { cycleId, groupId, pages: {}, summary: null };
  }
  return shard;
}

async function readCycleGroupSummary(env, cycleId, groupId) {
  const summary = await env.TRAFFIC_CACHE.get(
    `${GROUP_SUMMARY_KEY_PREFIX}${cycleId}:${groupId}`,
    "json"
  );
  return summary?.cycleId === cycleId ? summary.summary : null;
}

function rowsFromPageShard(shard) {
  const pages = shard?.pages && typeof shard.pages === "object" ? shard.pages : {};
  return Object.keys(pages)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b)
    .flatMap((page) => Array.isArray(pages[String(page)]) ? pages[String(page)] : []);
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

function buildHistoryRowsAndStats(busanRows) {
  const historyRows = [];
  let totalCount = 0;
  let totalSpeed = 0;
  let smoothCount = 0;
  let slowCount = 0;
  let congestedCount = 0;
  let slowestRow = null;
  let slowestSpeed = Infinity;

  // Compact history row 생성과 통계 산출을 한 번의 순회에서 처리한다.
  for (const row of busanRows) {
    const historyRow = {
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
    };
    historyRows.push(historyRow);

    const speed = Number(historyRow.speed);
    if (!Number.isFinite(speed) || speed < 0) continue;

    totalCount += 1;
    totalSpeed += speed;
    const category = historyRow.category || getRoadCategory(historyRow.roadName);
    const evaluation = evaluateTrafficStatus(speed, category);
    if (evaluation.status === "SMOOTH") smoothCount += 1;
    else if (evaluation.status === "SLOW") slowCount += 1;
    else if (evaluation.status === "CONGESTED") congestedCount += 1;

    if (speed < slowestSpeed) {
      slowestSpeed = speed;
      slowestRow = historyRow;
    }
  }

  if (totalCount === 0) {
    return {
      historyRows,
      stats: {
        totalCount: 0,
        averageSpeed: 0,
        trafficIndex: 0,
        trafficIndexGrade: "데이터 없음",
        statusCounts: { smooth: 0, slow: 0, congested: 0 },
        statusRatios: { smooth: 0, slow: 0, congested: 0 },
        congestionLevel: "데이터 없음",
        slowestRoad: null
      }
    };
  }

  const averageSpeed = Number((totalSpeed / totalCount).toFixed(1));
  const smoothRatio = Number(((smoothCount / totalCount) * 100).toFixed(1));
  const slowRatio = Number(((slowCount / totalCount) * 100).toFixed(1));
  const congestedRatio = Number(((congestedCount / totalCount) * 100).toFixed(1));
  const trafficIndex = Number(Math.max(0, Math.min(100, smoothRatio + slowRatio * 0.5)).toFixed(1));

  let trafficIndexGrade = "매우 혼잡";
  if (trafficIndex >= 80) trafficIndexGrade = "매우 원활";
  else if (trafficIndex >= 65) trafficIndexGrade = "원활";
  else if (trafficIndex >= 50) trafficIndexGrade = "보통";
  else if (trafficIndex >= 35) trafficIndexGrade = "혼잡";

  let congestionLevel = "원활";
  if (congestedRatio >= 25) congestionLevel = "매우 혼잡";
  else if (congestedRatio >= 15) congestionLevel = "혼잡";
  else if (congestedRatio >= 8 || slowRatio >= 30) congestionLevel = "다소 혼잡";

  return {
    historyRows,
    stats: {
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
    }
  };
}

async function archiveHistoricalSnapshot(env, snapshot, busanRows) {
  const fetchedAt = snapshot.fetchedAt || new Date().toISOString();
  const cycleId = fetchedAt.replace(/[-:.TZ]/g, "");
  const historyKey = `${HISTORY_KEY_PREFIX}${cycleId}`;
  const historicalData = buildHistoryRowsAndStats(busanRows);
  const historyRows = historicalData.historyRows;

  const historyEntry = {
    version: 1,
    fetchedAt,
    source: "부산광역시 링크소통정보",
    totalCount: historyRows.length,
    reportedTotalCount: Number(snapshot.collection?.reportedTotalCount || historyRows.length),
    totalPages: Number(snapshot.collection?.totalPages || 0),
    stats: historicalData.stats,
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

async function archiveHistoricalSummary(env, analysis) {
  const fetchedAt = analysis.fetchedAt || new Date().toISOString();
  const historyKey = HISTORY_KEY_PREFIX + fetchedAt.replace(/[-:.TZ]/g, "");
  const busanStats = analysis.busanStats || analysis.stats || {};
  const historyEntry = {
    version: 2,
    fetchedAt,
    source: "부산광역시 링크소통정보",
    rowCycleId: analysis.rowCycleId || "",
    rowsSharded: true,
    totalCount: Number(busanStats.totalCount || 0),
    reportedTotalCount: Number(analysis.reportedTotalCount || busanStats.totalCount || 0),
    totalPages: Number(analysis.totalPages || 0),
    stats: busanStats,
    suddenCongestion: analysis.suddenCongestion || null,
    trafficBriefing: analysis.trafficBriefing || null
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
      totalCount: historyEntry.totalCount,
      averageSpeed: Number(busanStats.averageSpeed || 0),
      trafficIndex: Number(busanStats.trafficIndex || 0),
      congestedRatio: Number(busanStats.statusRatios?.congested || 0),
      rowCycleId: historyEntry.rowCycleId,
      rowsSharded: true
    }
  ]
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))
    .slice(0, HISTORY_MAX_ENTRIES);

  await env.TRAFFIC_CACHE.put(
    HISTORY_INDEX_KEY,
    JSON.stringify(nextIndex),
    { expirationTtl: HISTORY_RETENTION_TTL }
  );

  return { historyKey, historyEntries: nextIndex.length, historyRows: historyEntry.totalCount };
}

async function runPostprocessing(env, itsApiKey) {
  const job = await env.TRAFFIC_CACHE.get(POSTPROCESS_STATE_KEY, "json");
  if (!job?.phase) {
    console.log({ event: "collector-postprocess-idle" });
    return;
  }

  const cycleId = String(job.cycleId || "");
  const fetchedAt = String(job.fetchedAt || "");
  if (!cycleId || !fetchedAt) throw new Error("TRAFFIC_POSTPROCESS_STATE_INVALID");

  const analysis = await env.TRAFFIC_CACHE.get(SNAPSHOT_ANALYSIS_KEY, "json");
  if (!analysis || analysis.rowCycleId !== cycleId || analysis.fetchedAt !== fetchedAt) {
    throw new Error("TRAFFIC_POSTPROCESS_ANALYSIS_MISMATCH");
  }

  if (job.phase === "its-pending") {
    let itsRows = [];
    let itsWarning = null;

    try {
      itsRows = await fetchItsData(itsApiKey);
      itsRows = itsRows.map((row) => {
        const category = getRoadCategory(row.roadName);
        const evaluation = evaluateTrafficStatus(row.speed, category);
        return {
          ...row,
          category,
          categoryName: SPEED_CRITERIA[category]?.categoryName || "일반도로",
          status: evaluation.status,
          statusText: evaluation.statusText,
          statusColor: evaluation.color,
          source: "ITS",
          updatedAt: new Date().toISOString()
        };
      });
      if (itsRows.length === 0) itsWarning = "ITS API에서 유효한 교통 데이터가 반환되지 않았습니다.";
    } catch (error) {
      itsWarning = error?.message || String(error);
      console.warn({ event: "collector-its-fetch-failed", error: itsWarning });
      itsRows = [];
    }

    await env.TRAFFIC_CACHE.put(
      ITS_SNAPSHOT_KEY,
      JSON.stringify({ fetchedAt, rows: itsRows, warning: itsWarning }),
      { expirationTtl: LATEST_SNAPSHOT_TTL }
    );

    const groupSummaries = await Promise.all(
      Array.from({ length: ROW_GROUP_COUNT }, async (_, groupId) =>
        (await readCycleGroupSummary(env, cycleId, groupId)) || calculateBusanAnalysis([])
      )
    );
    const busanOverview = combineGroupAnalyses(groupSummaries);
    const itsOverview = itsRows.length ? calculateBusanAnalysis(itsRows) : null;
    const overall = combineGroupAnalyses(
      itsOverview ? [...groupSummaries, itsOverview] : groupSummaries
    );

    analysis.source = itsRows.length
      ? "부산광역시 링크소통정보 & 국토교통부 ITS"
      : "부산광역시 링크소통정보";
    analysis.warning = itsWarning;
    analysis.stats = overall.stats;
    analysis.top10 = overall.top10;
    analysis.busanStats = busanOverview.stats;
    analysis.busanTop10 = busanOverview.top10;
    analysis.suddenAnalysisComplete = false;
    analysis.suddenCongestion = {
      detectedCount: 0,
      items: [],
      baselineSampleSize: BASELINE_SAMPLE_SIZE,
      minimumSamples: SUDDEN_CONGESTION_MIN_SAMPLES,
      mode: "same-timeband-baseline",
      pending: true
    };
    analysis.trafficBriefing = null;
    analysis.updatedAt = new Date().toISOString();

    await env.TRAFFIC_CACHE.put(
      SNAPSHOT_ANALYSIS_KEY,
      JSON.stringify(analysis),
      { expirationTtl: LATEST_SNAPSHOT_TTL }
    );
    await env.TRAFFIC_CACHE.put(
      POSTPROCESS_STATE_KEY,
      JSON.stringify({
        ...job,
        phase: "sudden-pending",
        cursor: 0,
        pendingAlerts: [],
        pendingDetectedCount: 0,
        timeBand: getTimeBand(getKoreaHour(new Date(fetchedAt))),
        updatedAt: new Date().toISOString()
      }),
      { expirationTtl: COLLECTION_TTL }
    );
    console.log({
      event: "collector-postprocess-its-complete",
      fetchedAt,
      itsRows: itsRows.length,
      totalRows: overall.stats.totalCount,
      avgSpeed: overall.stats.averageSpeed
    });
    return;
  }

  if (job.phase === "sudden-pending") {
    const cursor = Math.max(0, Math.min(ROW_GROUP_COUNT, Number(job.cursor || 0)));
    const groupIds = [];
    for (
      let groupId = cursor;
      groupId < Math.min(ROW_GROUP_COUNT, cursor + BASELINE_SHARDS_PER_RUN);
      groupId += 1
    ) {
      groupIds.push(groupId);
    }

    const timeBand = job.timeBand || getTimeBand(getKoreaHour(new Date(fetchedAt)));
    let pendingAlerts = Array.isArray(job.pendingAlerts) ? job.pendingAlerts : [];
    let pendingDetectedCount = Number(job.pendingDetectedCount || 0);

    for (const groupId of groupIds) {
      const shard = await readCycleRowShard(env, cycleId, groupId);
      const result = await calculateAndUpdateSuddenCongestion(
        env,
        rowsFromPageShard(shard),
        fetchedAt,
        timeBand,
        groupId
      );
      pendingDetectedCount += Number(result.detectedCount || 0);
      pendingAlerts = mergeSuddenCongestionAlerts(pendingAlerts, result.items);
    }

    const nextCursor = cursor + groupIds.length;
    if (nextCursor >= ROW_GROUP_COUNT) {
      analysis.suddenCongestion = {
        detectedCount: pendingDetectedCount,
        items: pendingAlerts,
        baselineSampleSize: BASELINE_SAMPLE_SIZE,
        minimumSamples: SUDDEN_CONGESTION_MIN_SAMPLES,
        mode: "same-timeband-baseline",
        pending: false,
        timeBand,
        thresholds: {
          minimumDropKmh: SUDDEN_CONGESTION_MIN_DROP_KMH,
          minimumDropRatio: SUDDEN_CONGESTION_MIN_DROP_RATIO
        }
      };
      analysis.suddenAnalysisComplete = true;
      analysis.updatedAt = new Date().toISOString();
      await env.TRAFFIC_CACHE.put(
        SNAPSHOT_ANALYSIS_KEY,
        JSON.stringify(analysis),
        { expirationTtl: LATEST_SNAPSHOT_TTL }
      );
      await env.TRAFFIC_CACHE.put(
        POSTPROCESS_STATE_KEY,
        JSON.stringify({
          ...job,
          phase: "briefing-pending",
          cursor: 0,
          pendingAlerts: [],
          pendingDetectedCount: 0,
          updatedAt: new Date().toISOString()
        }),
        { expirationTtl: COLLECTION_TTL }
      );
      console.log({
        event: "collector-postprocess-sudden-complete",
        fetchedAt,
        baselineShards: ROW_GROUP_COUNT,
        detectedCount: pendingDetectedCount
      });
    } else {
      await env.TRAFFIC_CACHE.put(
        POSTPROCESS_STATE_KEY,
        JSON.stringify({
          ...job,
          phase: "sudden-pending",
          cursor: nextCursor,
          pendingAlerts,
          pendingDetectedCount,
          timeBand,
          updatedAt: new Date().toISOString()
        }),
        { expirationTtl: COLLECTION_TTL }
      );
      console.log({
        event: "collector-postprocess-sudden-progress",
        fetchedAt,
        completedShards: nextCursor,
        totalShards: ROW_GROUP_COUNT,
        detectedCountSoFar: pendingDetectedCount
      });
    }
    return;
  }

  if (job.phase === "briefing-pending") {
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
    await env.TRAFFIC_CACHE.put(
      POSTPROCESS_STATE_KEY,
      JSON.stringify({
        ...job,
        phase: "history-pending",
        updatedAt: new Date().toISOString()
      }),
      { expirationTtl: COLLECTION_TTL }
    );
    console.log({
      event: "collector-postprocess-briefing-complete",
      fetchedAt,
      trend: analysis.trafficBriefing?.trend || null
    });
    return;
  }

  if (job.phase === "history-pending") {
    const historyResult = await archiveHistoricalSummary(env, analysis);
    await env.TRAFFIC_CACHE.delete(POSTPROCESS_STATE_KEY);
    console.log({
      event: "collector-history-archive-success",
      historyKey: historyResult.historyKey,
      historyEntries: historyResult.historyEntries,
      historyRows: historyResult.historyRows
    });
    return;
  }

  throw new Error("TRAFFIC_POSTPROCESS_PHASE_UNKNOWN:" + String(job.phase));
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

      let state = (await env.TRAFFIC_CACHE.get(COLLECTOR_STATE_KEY, "json")) || {};
      const version4 = Number(state?.collectorVersion || 0) === 4;

      // 단계 1: COMPLETE 데이터의 보조 ITS 통계 포함. 원본 도로 행 전체를 읽지 않고 그룹 요약만 결합한다.
      if (version4 && state.phase === "its-pending") {
        const cycleId = String(state.pendingCycleId || state.activeCycleId || "");
        const fetchedAt = String(state.pendingSnapshotFetchedAt || state.lastCompletedAt || "");
        if (!cycleId || !fetchedAt) throw new Error("TRAFFIC_ITS_PENDING_STATE_INVALID");

        let itsRows = [];
        let itsWarning = null;
        try {
          itsRows = await fetchItsData(itsApiKey);
          itsRows = itsRows.map((row) => {
            const category = getRoadCategory(row.roadName);
            const evaluation = evaluateTrafficStatus(row.speed, category);
            return {
              ...row,
              category,
              categoryName: SPEED_CRITERIA[category]?.categoryName || "일반도로",
              status: evaluation.status,
              statusText: evaluation.statusText,
              statusColor: evaluation.color,
              source: "ITS",
              updatedAt: new Date().toISOString()
            };
          });
        } catch (error) {
          itsWarning = error?.message || String(error);
          console.warn({ event: "collector-its-fetch-failed", error: itsWarning });
          itsRows = [];
        }

        await env.TRAFFIC_CACHE.put(
          "traffic:busan:its:latest",
          JSON.stringify({ fetchedAt, rows: itsRows, warning: itsWarning }),
          { expirationTtl: LATEST_SNAPSHOT_TTL }
        );

        const groupSummaries = await Promise.all(
          Array.from({ length: ROW_GROUP_COUNT }, async (_, groupId) =>
            (await readCycleGroupSummary(env, cycleId, groupId)) || calculateBusanAnalysis([])
          )
        );

        const busanOverview = combineGroupAnalyses(groupSummaries);
        const itsOverview = itsRows.length ? calculateBusanAnalysis(itsRows) : null;
        const overall = combineGroupAnalyses(
          itsOverview ? [...groupSummaries, itsOverview] : groupSummaries
        );
        const analysis = {
          fetchedAt,
          rowCycleId: cycleId,
          source: itsRows.length
            ? "부산광역시 링크소통정보 & 국토교통부 ITS"
            : "부산광역시 링크소통정보",
          warning: itsWarning,
          totalPages: Number(state.totalPages || 0),
          reportedTotalCount: Number(state.reportedTotalCount || 0),
          stats: overall.stats,
          top10: overall.top10,
          busanStats: busanOverview.stats,
          busanTop10: busanOverview.top10,
          // These are calculated in their own bounded Cron stages for this cycle.
          suddenAnalysisComplete: false,
          suddenCongestion: {
            detectedCount: 0,
            items: [],
            baselineSampleSize: BASELINE_SAMPLE_SIZE,
            minimumSamples: SUDDEN_CONGESTION_MIN_SAMPLES,
            mode: "same-timeband-baseline",
            pending: true
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
          JSON.stringify({
            ...state,
            collectorVersion: 4,
            inProgress: false,
            phase: "sudden-pending",
            activeCycleId: cycleId,
            currentCycleId: null,
            pendingCycleId: cycleId,
            pendingSnapshotFetchedAt: fetchedAt,
            baselineShardCursor: 0,
            pendingAlerts: [],
            pendingDetectedCount: 0,
            pendingTimeBand: getTimeBand(getKoreaHour(new Date(fetchedAt))),
            updatedAt: new Date().toISOString()
          }),
          { expirationTtl: COLLECTION_TTL }
        );
        console.log({
          event: "collector-its-analysis-complete",
          fetchedAt,
          itsRows: itsRows.length,
          totalRows: overall.stats.totalCount,
          avgSpeed: overall.stats.averageSpeed
        });
        return;
      }

      // 단계 2: 기준 데이터 비교를 페이지 그룹 단위로 처리해 매 실행의 CPU 사용량을 제한한다.
      if (version4 && state.phase === "sudden-pending") {
        const cycleId = String(state.pendingCycleId || state.activeCycleId || "");
        const sampleId = String(state.pendingSnapshotFetchedAt || "");
        if (!cycleId || !sampleId) throw new Error("TRAFFIC_SUDDEN_PENDING_STATE_INVALID");

        const cursor = Math.max(
          0,
          Math.min(ROW_GROUP_COUNT, Number(state.baselineShardCursor || 0))
        );
        const groupIds = [];
        for (
          let groupId = cursor;
          groupId < Math.min(ROW_GROUP_COUNT, cursor + BASELINE_SHARDS_PER_RUN);
          groupId += 1
        ) {
          groupIds.push(groupId);
        }

        const timeBand = state.pendingTimeBand ||
          getTimeBand(getKoreaHour(new Date(sampleId)));
        let pendingAlerts = Array.isArray(state.pendingAlerts) ? state.pendingAlerts : [];
        let pendingDetectedCount = Number(state.pendingDetectedCount || 0);

        for (const groupId of groupIds) {
          const shard = await readCycleRowShard(env, cycleId, groupId);
          const result = await calculateAndUpdateSuddenCongestion(
            env,
            rowsFromPageShard(shard),
            sampleId,
            timeBand,
            groupId
          );
          pendingDetectedCount += Number(result.detectedCount || 0);
          pendingAlerts = mergeSuddenCongestionAlerts(pendingAlerts, result.items);
        }

        const nextCursor = cursor + groupIds.length;
        const nextState = {
          ...state,
          collectorVersion: 4,
          inProgress: false,
          currentCycleId: null,
          activeCycleId: cycleId,
          pendingCycleId: cycleId,
          baselineShardCursor: nextCursor,
          pendingAlerts,
          pendingDetectedCount,
          updatedAt: new Date().toISOString()
        };

        if (nextCursor >= ROW_GROUP_COUNT) {
          const analysis = (await env.TRAFFIC_CACHE.get(SNAPSHOT_ANALYSIS_KEY, "json")) || {};
          if (analysis.fetchedAt !== sampleId) {
            throw new Error("TRAFFIC_SUDDEN_ANALYSIS_TIMESTAMP_MISMATCH");
          }
          analysis.suddenCongestion = {
            detectedCount: pendingDetectedCount,
            items: pendingAlerts,
            baselineSampleSize: BASELINE_SAMPLE_SIZE,
            minimumSamples: SUDDEN_CONGESTION_MIN_SAMPLES,
            mode: "same-timeband-baseline",
            pending: false,
            timeBand,
            thresholds: {
              minimumDropKmh: SUDDEN_CONGESTION_MIN_DROP_KMH,
              minimumDropRatio: SUDDEN_CONGESTION_MIN_DROP_RATIO
            }
          };
          analysis.suddenAnalysisComplete = true;
          analysis.updatedAt = new Date().toISOString();
          await env.TRAFFIC_CACHE.put(
            SNAPSHOT_ANALYSIS_KEY,
            JSON.stringify(analysis),
            { expirationTtl: LATEST_SNAPSHOT_TTL }
          );
          await env.TRAFFIC_CACHE.put(
            COLLECTOR_STATE_KEY,
            JSON.stringify({
              ...nextState,
              phase: "briefing-pending",
              baselineShardCursor: 0,
              pendingAlerts: [],
              pendingDetectedCount: 0
            }),
            { expirationTtl: COLLECTION_TTL }
          );
          console.log({
            event: "collector-sudden-analysis-complete",
            fetchedAt: sampleId,
            baselineShards: ROW_GROUP_COUNT,
            detectedCount: pendingDetectedCount
          });
        } else {
          await env.TRAFFIC_CACHE.put(
            COLLECTOR_STATE_KEY,
            JSON.stringify({ ...nextState, phase: "sudden-pending" }),
            { expirationTtl: COLLECTION_TTL }
          );
          console.log({
            event: "collector-sudden-analysis-progress",
            fetchedAt: sampleId,
            completedShards: nextCursor,
            totalShards: ROW_GROUP_COUNT,
            detectedCountSoFar: pendingDetectedCount
          });
        }
        return;
      }

      // 단계 3: 브리핑은 작은 summary/index만 이용한다.
      if (version4 && state.phase === "briefing-pending") {
        const analysis = (await env.TRAFFIC_CACHE.get(SNAPSHOT_ANALYSIS_KEY, "json")) || null;
        if (!analysis || analysis.fetchedAt !== state.pendingSnapshotFetchedAt) {
          throw new Error("TRAFFIC_BRIEFING_ANALYSIS_MISSING");
        }

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
        await env.TRAFFIC_CACHE.put(
          COLLECTOR_STATE_KEY,
          JSON.stringify({
            ...state,
            collectorVersion: 4,
            inProgress: false,
            phase: "history-pending",
            currentCycleId: null,
            activeCycleId: analysis.rowCycleId,
            pendingCycleId: analysis.rowCycleId,
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

      // 단계 4: 이력은 통계/브리핑 메타데이터와 완료된 row-shard의 포인터만 저장한다.
      if (version4 && state.phase === "history-pending") {
        const analysis = (await env.TRAFFIC_CACHE.get(SNAPSHOT_ANALYSIS_KEY, "json")) || null;
        if (!analysis || analysis.fetchedAt !== state.pendingSnapshotFetchedAt) {
          throw new Error("TRAFFIC_HISTORY_ANALYSIS_MISSING");
        }
        const historyResult = await archiveHistoricalSummary(env, analysis);
        const completedAt = analysis.fetchedAt;
        await env.TRAFFIC_CACHE.put(
          COLLECTOR_STATE_KEY,
          JSON.stringify({
            collectorVersion: 4,
            inProgress: false,
            phase: null,
            currentPage: 1,
            totalPages: Number(state.totalPages || 0),
            reportedTotalCount: Number(state.reportedTotalCount || 0),
            completedPages: [],
            failedPages: [],
            currentCycleId: null,
            activeCycleId: analysis.rowCycleId,
            pendingCycleId: null,
            cycleStartedAt: null,
            refreshedLinks: 0,
            updatedAt: new Date().toISOString(),
            lastCompletedAt: completedAt,
            lastIncrementalUpdateAt: state.lastIncrementalUpdateAt || completedAt
          }),
          { expirationTtl: COLLECTION_TTL }
        );
        console.log({
          event: "collector-history-archive-success",
          historyKey: historyResult.historyKey,
          historyEntries: historyResult.historyEntries,
          historyRows: historyResult.historyRows
        });
        return;
      }

      // 새 사이클을 시작한다. 기존 activeCycleId는 다음 전체 사이클이 검증되기 전까지 보존한다.
      const resumingCycle = version4 && state.inProgress === true && state.currentCycleId;
      const cycleId = resumingCycle
        ? String(state.currentCycleId)
        : new Date().toISOString().replace(/[-:.TZ]/g, "");
      const cycleStartedAt = resumingCycle
        ? (state.cycleStartedAt || new Date().toISOString())
        : new Date().toISOString();
      const activeCycleId = version4 ? (state.activeCycleId || null) : null;
      let currentPage = resumingCycle ? Number(state.currentPage || 1) : 1;
      let totalPages = resumingCycle ? Number(state.totalPages || 0) : 0;
      let reportedTotalCount = resumingCycle ? Number(state.reportedTotalCount || 0) : 0;
      let refreshedLinks = resumingCycle ? Number(state.refreshedLinks || 0) : 0;
      let completedPages = new Set(
        resumingCycle && Array.isArray(state.completedPages) ? state.completedPages.map(Number) : []
      );
      let failedPages = new Set(
        resumingCycle && Array.isArray(state.failedPages) ? state.failedPages.map(Number) : []
      );

      if (!Number.isInteger(currentPage) || currentPage < 1) currentPage = 1;

      // 체크포인트를 먼저 저장하므로, 네트워크 호출이나 저장 중 실패해도 다음 Cron에서 같은 사이클을 재개한다.
      const initialState = {
        collectorVersion: 4,
        inProgress: true,
        phase: null,
        activeCycleId,
        currentCycleId: cycleId,
        currentPage,
        totalPages,
        reportedTotalCount,
        completedPages: [...completedPages].sort((a, b) => a - b),
        failedPages: [...failedPages].sort((a, b) => a - b),
        cycleStartedAt,
        refreshedLinks,
        updatedAt: new Date().toISOString()
      };
      await env.TRAFFIC_CACHE.put(
        COLLECTOR_STATE_KEY,
        JSON.stringify(initialState),
        { expirationTtl: COLLECTION_TTL }
      );

      const pageNumbers = [];
      const selectedPages = new Set();

      for (const page of [...failedPages].sort((a, b) => a - b)) {
        if (pageNumbers.length >= PAGES_PER_RUN) break;
        if (totalPages > 0 && page > totalPages) continue;
        pageNumbers.push(page);
        selectedPages.add(page);
      }

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
        if (sequentialPage > 100000) break;
      }

      if (pageNumbers.length === 0 && totalPages === 0) pageNumbers.push(1);

      const settledResults = await Promise.allSettled(
        pageNumbers.map((page) => fetchBusanPage(busanApiKey, page))
      );
      const batchPages = [];

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
        if (pageReportedTotal > 0) reportedTotalCount = Math.max(reportedTotalCount, pageReportedTotal);
        if (reportedTotalCount > 0) totalPages = Math.max(1, Math.ceil(reportedTotalCount / PAGE_SIZE));

        const pageRows = normalizeBusanItems(payload, normalized);
        if (pageRows.length === 0) {
          failedPages.add(page);
          console.warn({ event: "collector-page-empty", page, totalPages, reportedTotalCount });
          continue;
        }

        batchPages.push({ page, rows: pageRows });
        completedPages.add(page);
        failedPages.delete(page);
      }

      if (totalPages > 0) {
        completedPages = new Set([...completedPages].filter((page) => page <= totalPages));
        failedPages = new Set([...failedPages].filter((page) => page <= totalPages));
      }

      // 페이지별 데이터를 해당 그룹 shard에만 반영한다. 전체 9천 행은 이 단계에서 읽거나 쓰지 않는다.
      const pagesByGroup = new Map();
      for (const batchPage of batchPages) {
        const groupId = getRowGroupIndex(batchPage.page);
        if (!pagesByGroup.has(groupId)) pagesByGroup.set(groupId, []);
        pagesByGroup.get(groupId).push(batchPage);
      }

      const nowIso = new Date().toISOString();
      for (const [groupId, groupPages] of pagesByGroup) {
        const oldShard = await readCycleRowShard(env, cycleId, groupId);
        const pages = { ...oldShard.pages };
        for (const batchPage of groupPages) {
          pages[String(batchPage.page)] = batchPage.rows;
        }

        const groupRows = rowsFromPageShard({ pages });
        const groupAnalysis = calculateBusanAnalysis(groupRows);
        const groupSummary = {
          stats: groupAnalysis.stats,
          top10: groupAnalysis.top10,
          aggregate: groupAnalysis.aggregate,
          totalRows: groupRows.length,
          updatedAt: nowIso
        };
        await env.TRAFFIC_CACHE.put(
          getCycleRowShardKey(cycleId, groupId),
          JSON.stringify({
            version: 4,
            cycleId,
            groupId,
            pages,
            summary: groupSummary
          }),
          { expirationTtl: ROW_SHARD_RETENTION_TTL }
        );
        // Separating summaries lets completion logic read only a few KB instead of parsing all rows.
        await env.TRAFFIC_CACHE.put(
          `${GROUP_SUMMARY_KEY_PREFIX}${cycleId}:${groupId}`,
          JSON.stringify({ cycleId, groupId, summary: groupSummary }),
          { expirationTtl: ROW_SHARD_RETENTION_TTL }
        );
      }

      refreshedLinks += batchPages.reduce((sum, item) => sum + item.rows.length, 0);
      const cycleComplete =
        totalPages > 0 &&
        completedPages.size >= totalPages &&
        failedPages.size === 0;
      const nextPage = Math.max(currentPage, sequentialPage);

      console.log({
        event: "collector-progress",
        currentPage,
        nextPage,
        totalPages,
        reportedTotalCount,
        batchRows: batchPages.reduce((sum, item) => sum + item.rows.length, 0),
        refreshedLinks,
        completedPages: completedPages.size,
        failedPages: [...failedPages].sort((a, b) => a - b),
        cycleComplete,
        storageMode: "page-shards"
      });

      if (!cycleComplete) {
        await env.TRAFFIC_CACHE.put(
          COLLECTOR_STATE_KEY,
          JSON.stringify({
            collectorVersion: 4,
            inProgress: true,
            phase: null,
            activeCycleId,
            currentCycleId: cycleId,
            currentPage: totalPages > 0 && nextPage > totalPages ? 1 : nextPage,
            totalPages,
            reportedTotalCount,
            completedPages: [...completedPages].sort((a, b) => a - b),
            failedPages: [...failedPages].sort((a, b) => a - b),
            cycleStartedAt,
            refreshedLinks,
            lastBatchRows: batchPages.reduce((sum, item) => sum + item.rows.length, 0),
            updatedAt: nowIso,
            lastIncrementalUpdateAt: nowIso
          }),
          { expirationTtl: COLLECTION_TTL }
        );
        console.log({
          event: "collector-page-shards-saved",
          currentCycleId: cycleId,
          pagesUpdated: batchPages.map((item) => item.page),
          groupsUpdated: [...pagesByGroup.keys()]
        });
        return;
      }

      // 전체 수집 완료 시에는 작은 shard summaries만 결합한다. rows 배열 전체를 만들지 않는다.
      const groupAnalyses = await Promise.all(
        Array.from({ length: ROW_GROUP_COUNT }, async (_, groupId) =>
          (await readCycleGroupSummary(env, cycleId, groupId)) || calculateBusanAnalysis([])
        )
      );
      const busanOverview = combineGroupAnalyses(groupAnalyses);
      const completedAt = new Date().toISOString();
      const initialAnalysis = {
        fetchedAt: completedAt,
        rowCycleId: cycleId,
        source: "부산광역시 링크소통정보",
        warning: null,
        totalPages,
        reportedTotalCount,
        stats: busanOverview.stats,
        top10: busanOverview.top10,
        busanStats: busanOverview.stats,
        busanTop10: busanOverview.top10,
        suddenAnalysisComplete: false,
        suddenCongestion: {
          detectedCount: 0,
          items: [],
          baselineSampleSize: BASELINE_SAMPLE_SIZE,
          minimumSamples: SUDDEN_CONGESTION_MIN_SAMPLES,
          mode: "same-timeband-baseline",
          pending: true
        },
        trafficBriefing: null,
        updatedAt: completedAt
      };

      await env.TRAFFIC_CACHE.put(
        SNAPSHOT_ANALYSIS_KEY,
        JSON.stringify(initialAnalysis),
        { expirationTtl: LATEST_SNAPSHOT_TTL }
      );
      await env.TRAFFIC_CACHE.put(
        COLLECTOR_STATE_KEY,
        JSON.stringify({
          collectorVersion: 4,
          inProgress: false,
          phase: "its-pending",
          activeCycleId: cycleId,
          currentCycleId: null,
          pendingCycleId: cycleId,
          pendingSnapshotFetchedAt: completedAt,
          currentPage: 1,
          totalPages,
          reportedTotalCount,
          completedPages: [],
          failedPages: [],
          cycleStartedAt: null,
          refreshedLinks,
          lastIncrementalUpdateAt: nowIso,
          lastCompletedAt: completedAt,
          updatedAt: new Date().toISOString()
        }),
        { expirationTtl: COLLECTION_TTL }
      );
      console.log({
        event: "collector-cycle-shards-complete",
        cycleId,
        completedAt,
        totalRows: busanOverview.stats.totalCount,
        avgSpeed: busanOverview.stats.averageSpeed,
        congestedRatio: busanOverview.stats.statusRatios.congested,
        totalPages
      });
    } catch (error) {
      console.error({
        event: "collector-failed",
        error: error?.message || error,
        cpuSensitiveStage: true
      });
      throw error;
    }
  }
};
