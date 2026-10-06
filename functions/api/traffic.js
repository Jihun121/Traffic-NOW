import { filterTrafficRegion, getTrafficRegion } from "../lib/filterTrafficRegion.js";
import { enrichRowsWithTrafficAnalysis } from "../lib/trafficAnalyzer.js";

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

export async function onRequestGet(context) {
  const startedAt = Date.now();
  let stage = "start";
  const url = new URL(context.request.url);
  const regionKey = url.searchParams.get("region") || "busan";
  const refreshRequested = url.searchParams.get("forceRefresh") === "1";

  try {
    // 교통 원본 데이터는 background collector Worker만 갱신한다.
    // Pages Function은 KV의 최신 스냅샷을 읽기만 하므로
    // 사용자 요청/강제 새로고침이 정상 데이터를 fallback 데이터로 덮어쓰지 않는다.
    if (!context.env?.TRAFFIC_CACHE) {
      return json({
        ok: false,
        error: "교통 스냅샷 저장소가 연결되지 않았습니다.",
        diagnostics: {
          code: "TRAFFIC_CACHE_NOT_CONFIGURED"
        }
      }, 503);
    }

    stage = "snapshot-read";
    const snapshot = await context.env.TRAFFIC_CACHE.get(SNAPSHOT_KEY, "json");

    if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
      return json({
        ok: false,
        error: "최신 부산 교통 스냅샷이 아직 준비되지 않았습니다.",
        diagnostics: {
          code: "TRAFFIC_SNAPSHOT_NOT_READY",
          snapshotKey: SNAPSHOT_KEY,
          refreshRequested
        }
      }, 503, {
        "X-Traffic-Cache": "MISS"
      });
    }

    stage = "analysis-and-filter";
    const region = getTrafficRegion(regionKey);
    const allRows = snapshot.rows;

    // Collector가 산출한 전체 통계/TOP10을 우선 재사용한다.
    const stats = snapshot.stats || null;
    const top10 = Array.isArray(snapshot.top10) ? snapshot.top10 : [];

    const filteredRows = filterTrafficRegion(allRows, regionKey);
    const enrichedFiltered = enrichRowsWithTrafficAnalysis(filteredRows);

    // 정체 순(오름차순 속도)으로 기본 정렬
    const sortedFiltered = [...enrichedFiltered].sort((a, b) => Number(a.speed) - Number(b.speed));

    const payload = {
      ok: true,
      source: snapshot.source || "부산광역시 링크소통정보",
      region: {
        key: regionKey,
        name: region.name
      },
      stats,
      top10,
      suddenCongestion: snapshot.suddenCongestion || {
        detectedCount: 0,
        items: []
      },
      trafficBriefing: snapshot.trafficBriefing || null,
      data: sortedFiltered.slice(0, 100),
      filteredCount: filteredRows.length,
      totalCount: allRows.length,
      updatedAt: snapshot.fetchedAt || new Date().toISOString(),
      cache: "SNAPSHOT",
      warning: snapshot.warning || null,
      refreshRequested,
      timing: {
        totalMs: Date.now() - startedAt
      }
    };

    return json(payload, 200, {
      "cache-control": `public, max-age=0, s-maxage=${SNAPSHOT_RESPONSE_TTL_SECONDS}`,
      "X-Traffic-Cache": "SNAPSHOT",
      "X-Traffic-Source": snapshot.source || "BUSAN"
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
        hasKvBinding: Boolean(context.env?.TRAFFIC_CACHE)
      }
    }, status);
  }
}
