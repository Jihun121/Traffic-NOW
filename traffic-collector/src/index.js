import { normalizeTrafficPayload } from "../../functions/lib/normalizeTraffic.js";

const BUSAN_API_URL = "https://apis.data.go.kr/6260000/BusanITSLINKTraffic/LINKTrafficList";
const ITS_API_URL = "https://openapi.its.go.kr:9443/trafficInfo";
const SNAPSHOT_KEY = "traffic:busan:latest";
const PAGE_SIZE = 300;
const REQUEST_TIMEOUT_MS = 60000;
const MAX_PARALLEL_PAGES = 4;

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

function calculateBusanStats(rows) {
  const validRows = rows.filter((r) => Number.isFinite(Number(r.speed)) && Number(r.speed) >= 0);
  const totalCount = validRows.length;
  if (totalCount === 0) {
    return {
      totalCount: 0,
      averageSpeed: 0,
      statusCounts: { smooth: 0, slow: 0, congested: 0 },
      statusRatios: { smooth: 0, slow: 0, congested: 0 },
      congestionLevel: "데이터 없음",
      slowestRoad: null
    };
  }

  let totalSpeed = 0;
  let smoothCount = 0;
  let slowCount = 0;
  let congestedCount = 0;

  for (const row of validRows) {
    const spd = Number(row.speed);
    totalSpeed += spd;
    const cat = row.category || getRoadCategory(row.roadName);
    const evalResult = evaluateTrafficStatus(spd, cat);
    if (evalResult.status === "SMOOTH") smoothCount++;
    else if (evalResult.status === "SLOW") slowCount++;
    else if (evalResult.status === "CONGESTED") congestedCount++;
  }

  const averageSpeed = Number((totalSpeed / totalCount).toFixed(1));
  const smoothRatio = Number(((smoothCount / totalCount) * 100).toFixed(1));
  const slowRatio = Number(((slowCount / totalCount) * 100).toFixed(1));
  const congestedRatio = Number(((congestedCount / totalCount) * 100).toFixed(1));

  let congestionLevel = "원활";
  if (congestedRatio >= 25) congestionLevel = "매우 혼잡";
  else if (congestedRatio >= 15) congestionLevel = "혼잡";
  else if (congestedRatio >= 8 || slowRatio >= 30) congestionLevel = "다소 혼잡";

  const sorted = [...validRows].sort((a, b) => Number(a.speed) - Number(b.speed));
  const slowestRoad = sorted[0] ? {
    roadName: sorted[0].roadName || "무명도로",
    section: `${sorted[0].startName || ""} → ${sorted[0].endName || ""}`.trim(),
    speed: Number(sorted[0].speed)
  } : null;

  return {
    totalCount,
    averageSpeed,
    statusCounts: { smooth: smoothCount, slow: slowCount, congested: congestedCount },
    statusRatios: { smooth: smoothRatio, slow: slowRatio, congested: congestedRatio },
    congestionLevel,
    slowestRoad
  };
}

function calculateTop10(rows) {
  const validRows = rows.filter((r) => Number.isFinite(Number(r.speed)) && Number(r.speed) >= 0);
  const enriched = validRows.map((r) => {
    const category = r.category || getRoadCategory(r.roadName);
    const evaluation = evaluateTrafficStatus(r.speed, category);
    return {
      ...r,
      category,
      categoryName: SPEED_CRITERIA[category]?.categoryName || "일반도로",
      status: evaluation.status,
      statusText: evaluation.statusText,
      statusColor: evaluation.color
    };
  });

  enriched.sort((a, b) => {
    if (a.status === "CONGESTED" && b.status !== "CONGESTED") return -1;
    if (a.status !== "CONGESTED" && b.status === "CONGESTED") return 1;
    return Number(a.speed) - Number(b.speed);
  });

  const top10 = [];
  const seenRoadSections = new Set();
  for (const item of enriched) {
    if (top10.length >= 10) break;
    const key = `${item.roadName}-${item.startName}-${item.endName}`;
    if (seenRoadSections.has(key)) continue;
    seenRoadSections.add(key);
    top10.push({
      rank: top10.length + 1,
      linkId: item.linkId,
      roadName: item.roadName || "도로명 없음",
      startName: item.startName || "-",
      endName: item.endName || "-",
      speed: Number(item.speed),
      categoryName: item.categoryName,
      status: item.status,
      statusText: item.statusText,
      statusColor: item.statusColor,
      updatedAt: item.updatedAt || ""
    });
  }
  return top10;
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

function normalizeBusanItems(payload) {
  const normalized = normalizeTrafficPayload(payload);

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
      const first = await fetchBusanPage(busanApiKey, 1);
      const firstNormalized = normalizeTrafficPayload(first);
      const totalCount = Number(firstNormalized.totalCount ?? 0);
      const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
      const rows = normalizeBusanItems(first);
      const sourceParts = ["부산광역시 링크소통정보"];
      const warnings = [];

      for (let start = 2; start <= totalPages; start += MAX_PARALLEL_PAGES) {
        const pageNumbers = [];
        for (let p = start; p < start + MAX_PARALLEL_PAGES && p <= totalPages; p++) {
          pageNumbers.push(p);
        }
        const pages = await Promise.all(pageNumbers.map((no) => fetchBusanPage(busanApiKey, no)));
        for (const p of pages) rows.push(...normalizeBusanItems(p));
      }

      // 부산 API가 응답했지만 실제 유효 데이터가 0건이면
      // 기존 정상 스냅샷을 빈 데이터로 덮어쓰지 않는다.
      if (rows.length === 0) {
        throw new Error(
          `BUSAN_TRAFFIC_EMPTY_DATA: 부산 교통 API에서 유효한 행을 0건 수집했습니다. totalCount=${totalCount}. 첫 응답 구조를 확인하려면 API 오류가 아닌 경우에도 응답 메타데이터를 확인해야 합니다.`
        );
      }

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

      // 3. 비즈니스 파이프라인 연산: 통계 및 정체 TOP 10 산출
      const stats = calculateBusanStats(rows);
      const top10 = calculateTop10(rows);

      const snapshot = {
        source: sourceParts.join(" & "),
        stats,
        top10,
        rows,
        totalCount: rows.length,
        fetchedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        warning: warnings.length > 0 ? warnings.join(" | ") : null
      };

      // 유효한 스냅샷만 KV에 저장한다.
      if (!Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
        throw new Error("TRAFFIC_SNAPSHOT_EMPTY: 빈 스냅샷은 KV에 저장하지 않습니다.");
      }

      // KV 캐시에 최신 스냅샷 저장 (2시간 만료 보존)
      await env.TRAFFIC_CACHE.put(SNAPSHOT_KEY, JSON.stringify(snapshot), {
        expirationTtl: 60 * 60 * 2
      });

      console.log({
        event: "collector-kv-write-success",
        totalRows: rows.length,
        avgSpeed: stats.averageSpeed,
        congestedRatio: stats.statusRatios.congested,
        source: snapshot.source,
        warning: snapshot.warning,
        busanReportedTotalCount: totalCount,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      console.error({ event: "collector-failed", error: error?.message || error });
      throw error;
    }
  }
};
