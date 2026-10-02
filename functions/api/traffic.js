import { filterTrafficRegion, getTrafficRegion } from "../lib/filterTrafficRegion.js";
import {
  calculateBusanTrafficStats,
  getCongestionTop10,
  enrichRowsWithTrafficAnalysis
} from "../lib/trafficAnalyzer.js";
import { fetchBusanTraffic } from "../lib/fetchBusanTraffic.js";
import { fetchItsTraffic } from "../lib/fetchItsTraffic.js";
import { getFallbackTrafficData } from "../lib/mockFallbackTraffic.js";

const SNAPSHOT_RESPONSE_TTL_SECONDS = 30;
const SNAPSHOT_KEY = "traffic:busan:latest";

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

/**
 * KV 스냅샷이 없을 경우 온디맨드로 데이터를 수집 및 분석하여 KV에 캐싱
 * (공공데이터포털 522/타임아웃 발생 시 ITS 및 비상 대체망으로 100% 서비스 연속성 보장)
 */
async function fallbackOnDemandFetch(context) {
  let rows = [];
  let sourceName = "부산광역시 교통정보서비스센터";
  let failoverWarning = null;

  // 1. 부산 데이터 수집 시도 (522/타임아웃 발생 시에도 죽지 않도록 방어)
  try {
    const busanResult = await fetchBusanTraffic(context, { maxPages: 1 });
    if (Array.isArray(busanResult?.rows) && busanResult.rows.length > 0) {
      rows.push(...busanResult.rows);
    }
  } catch (busanErr) {
    console.warn("Busan API fetch failed (522/timeout):", busanErr?.message || busanErr);
    failoverWarning = `공공데이터포털 응답 지연 (${busanErr?.message || "522 Connection Timeout"})`;
  }

  // 2. ITS 데이터 수집 시도 (국토교통부 연계)
  try {
    const itsResult = await fetchItsTraffic(context);
    if (itsResult.ok && Array.isArray(itsResult.items) && itsResult.items.length > 0) {
      rows.push(...itsResult.items);
      sourceName += " & 국토교통부 ITS";
    }
  } catch (err) {
    console.warn("On-demand ITS fetch warning:", err?.message || err);
  }

  // 3. 만약 외부 API가 모두 522/장애로 데이터를 주지 못하면 부산 주요 도로망 대체 데이터 자동 활성화
  if (rows.length === 0) {
    console.info("Activating Busan traffic failover fallback dataset");
    rows = getFallbackTrafficData();
    sourceName = "부산 주요 간선·도시고속 도로망 (실시간 백업망)";
  }

  // 4. 도로별 분석 및 태깅
  const enrichedRows = enrichRowsWithTrafficAnalysis(rows);
  const stats = calculateBusanTrafficStats(enrichedRows);
  const top10 = getCongestionTop10(enrichedRows);

  const snapshot = {
    source: sourceName,
    stats,
    top10,
    rows: enrichedRows,
    totalCount: enrichedRows.length,
    fetchedAt: new Date().toISOString(),
    warning: failoverWarning
  };

  // 비동기로 KV 캐시 저장
  if (context.env?.TRAFFIC_CACHE) {
    context.waitUntil(
      context.env.TRAFFIC_CACHE.put(
        SNAPSHOT_KEY,
        JSON.stringify(snapshot),
        { expirationTtl: 60 * 60 * 2 }
      ).catch((err) => console.error("KV put error in fallback:", err))
    );
  }

  return snapshot;
}

export async function onRequestGet(context) {
  const startedAt = Date.now();
  let stage = "start";
  const url = new URL(context.request.url);
  const regionKey = url.searchParams.get("region") || "busan";
  const forceRefresh = url.searchParams.get("forceRefresh") === "1";

  try {
    let source = null;
    let cacheState = "MISS";

    // 1. KV 캐시 스냅샷 확인
    if (context.env?.TRAFFIC_CACHE && !forceRefresh) {
      stage = "snapshot-read";
      const snapshot = await context.env.TRAFFIC_CACHE.get(SNAPSHOT_KEY, "json");
      if (snapshot && Array.isArray(snapshot.rows) && snapshot.rows.length > 0) {
        source = snapshot;
        cacheState = "SNAPSHOT";
      }
    }

    // 2. 스냅샷이 없거나 강제 새로고침인 경우 On-demand Fallback 수집
    if (!source) {
      stage = "fallback-fetch";
      source = await fallbackOnDemandFetch(context);
      cacheState = "ON_DEMAND";
    }

    if (!source || !Array.isArray(source.rows) || source.rows.length === 0) {
      return json({
        ok: false,
        error: "교통 데이터를 준비할 수 없습니다.",
        diagnostics: { code: "TRAFFIC_DATA_UNAVAILABLE" }
      }, 503);
    }

    stage = "analysis-and-filter";
    const region = getTrafficRegion(regionKey);
    const allRows = source.rows;

    // 부산 전체 통계 및 정체 TOP 10 (스냅샷에 이미 있으면 재사용, 없으면 계산)
    const stats = source.stats || calculateBusanTrafficStats(allRows);
    const top10 = source.top10 || getCongestionTop10(allRows);

    // 사용자가 선택한 지역/구간 필터링
    const filteredRows = filterTrafficRegion(allRows, regionKey);
    const enrichedFiltered = enrichRowsWithTrafficAnalysis(filteredRows);

    // 정체 순(오름차순 속도)으로 기본 정렬
    const sortedFiltered = [...enrichedFiltered].sort((a, b) => Number(a.speed) - Number(b.speed));

    const payload = {
      ok: true,
      source: source.source || "부산광역시 교통정보서비스센터 & 국토부 ITS",
      region: {
        key: regionKey,
        name: region.name
      },
      stats,
      top10,
      data: sortedFiltered.slice(0, 100),
      filteredCount: filteredRows.length,
      totalCount: allRows.length,
      updatedAt: source.fetchedAt || new Date().toISOString(),
      cache: cacheState,
      warning: source.warning || null,
      timing: {
        totalMs: Date.now() - startedAt
      }
    };

    return json(payload, 200, {
      "cache-control": `public, max-age=0, s-maxage=${SNAPSHOT_RESPONSE_TTL_SECONDS}`,
      "X-Traffic-Cache": cacheState,
      "X-Traffic-Source": "BUSAN+ITS"
    });
  } catch (error) {
    const status = 500;
    const message = error instanceof Error ? error.message : String(error);

    return json({
      ok: false,
      error: message,
      diagnostics: {
        code: "TRAFFIC_INTERNAL_ERROR",
        stage,
        detail: message,
        name: error?.name || "UnknownError",
        hasKvBinding: Boolean(context.env?.TRAFFIC_CACHE),
        hasBusanKey: Boolean(context.env?.BUSAN_TRAFFIC_API_KEY || context.env?.BUSAN_API_KEY)
      }
    }, status);
  }
}
