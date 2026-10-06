import { filterTrafficRegion } from "../lib/filterTrafficRegion.js";

const SNAPSHOT_KEY = "traffic:busan:latest";
const MAP_ROW_LIMIT = 10000;

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

function normalizeMapRow(row) {
  return {
    linkId: row.linkId || "",
    roadName: row.roadName || "",
    sectionName: row.sectionName || "",
    startName: row.startName || "",
    endName: row.endName || "",
    speed: Number(row.speed),
    status: row.status || "UNKNOWN",
    statusText: row.statusText || "정보 없음",
    statusColor: row.statusColor || "",
    category: row.category || "",
    categoryName: row.categoryName || "일반도로",
    updatedAt: row.updatedAt || ""
  };
}

export async function onRequestGet(context) {
  const startedAt = Date.now();
  const url = new URL(context.request.url);
  const regionKey = url.searchParams.get("region") || "busan";

  try {
    if (!context.env?.TRAFFIC_CACHE) {
      return json({
        ok: false,
        error: "교통 지도 저장소가 연결되지 않았습니다.",
        diagnostics: {
          code: "TRAFFIC_MAP_CACHE_NOT_CONFIGURED"
        }
      }, 503);
    }

    const snapshot = await context.env.TRAFFIC_CACHE.get(SNAPSHOT_KEY, "json");

    if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
      return json({
        ok: false,
        error: "최신 부산 교통 스냅샷이 아직 준비되지 않았습니다.",
        diagnostics: {
          code: "TRAFFIC_MAP_SNAPSHOT_NOT_READY"
        }
      }, 503);
    }

    const filteredRows = filterTrafficRegion(snapshot.rows, regionKey);
    const mapRows = filteredRows
      .slice(0, MAP_ROW_LIMIT)
      .map(normalizeMapRow);

    return json({
      ok: true,
      source: snapshot.source || "부산광역시 링크소통정보",
      region: regionKey,
      fetchedAt: snapshot.fetchedAt || null,
      totalRows: filteredRows.length,
      returnedRows: mapRows.length,
      mapRowLimit: MAP_ROW_LIMIT,
      geometrySource: "/data/traffic-link-geometry.json",
      data: mapRows,
      timing: {
        totalMs: Date.now() - startedAt
      }
    }, 200, {
      "cache-control": "public, max-age=0, s-maxage=15",
      "X-Traffic-Map": "SNAPSHOT+STATIC_GEOMETRY"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return json({
      ok: false,
      error: message,
      diagnostics: {
        code: "TRAFFIC_MAP_INTERNAL_ERROR",
        detail: message,
        name: error?.name || "UnknownError",
        hasKvBinding: Boolean(context.env?.TRAFFIC_CACHE)
      }
    }, 500);
  }
}
