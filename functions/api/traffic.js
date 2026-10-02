import { fetchBusanTraffic, BusanTrafficError } from "../lib/fetchBusanTraffic.js";
import { filterTrafficRegion, getTrafficRegion } from "../lib/filterTrafficRegion.js";
import { readTrafficCache, writeTrafficCache } from "../lib/trafficCache.js";

const CACHE_TTL_SECONDS = 300;
const SOURCE_CACHE_TTL_SECONDS = 300;
const SLOWEST_LIMIT = 30;

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

function calculateAverage(rows) {
  const speeds = rows
    .map((row) => Number(row.speed))
    .filter((value) => Number.isFinite(value) && value >= 0);

  if (!speeds.length) return null;

  return Number(
    (speeds.reduce((sum, value) => sum + value, 0) / speeds.length).toFixed(1)
  );
}

function createPayload(regionKey, source, rows, cacheState, startedAt) {
  const region = getTrafficRegion(regionKey);
  const sorted = [...rows]
    .filter((row) => Number.isFinite(Number(row.speed)))
    .sort((a, b) => Number(a.speed) - Number(b.speed));

  return {
    ok: true,
    source: "부산광역시 교통정보서비스센터",
    region: {
      key: regionKey,
      name: region.name
    },
    count: source.totalCount,
    filteredCount: rows.length,
    averageSpeed: calculateAverage(rows),
    updatedAt: rows
      .map((row) => row.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
    data: sorted.slice(0, SLOWEST_LIMIT),
    cache: cacheState,
    timing: {
      upstreamMs: source.upstreamMs ?? null,
      totalMs: Date.now() - startedAt
    },
    fetchedAt: source.fetchedAt ?? null
  };
}

export async function onRequestGet(context) {
  const startedAt = Date.now();
  const url = new URL(context.request.url);
  const regionKey = url.searchParams.get("region") || "busan-north-gu";
  const forceRefresh = url.searchParams.get("forceRefresh") === "1";

  if (regionKey !== "busan-north-gu" && regionKey !== "busan") {
    return json({
      ok: false,
      error: "지원하지 않는 지역입니다.",
      supportedRegions: ["busan-north-gu", "busan"]
    }, 400);
  }

  try {
    let source = null;
    let cacheState = "MISS";

    if (!forceRefresh) {
      source = await readTrafficCache(context.request);
      if (source) {
        cacheState = "HIT";
      }
    }

    if (!source) {
      source = await fetchBusanTraffic(context);
      cacheState = "MISS";
      await writeTrafficCache(context.request, source, SOURCE_CACHE_TTL_SECONDS);
    }

    const filteredRows = filterTrafficRegion(source.rows || [], regionKey);
    const payload = createPayload(regionKey, source, filteredRows, cacheState, startedAt);

    return json(payload, 200, {
      "cache-control": "public, max-age=0, s-maxage=" + CACHE_TTL_SECONDS,
      "X-Traffic-Cache": cacheState,
      "X-Traffic-Source": "BUSAN"
    });
  } catch (error) {
    if (error instanceof BusanTrafficError) {
      return json({
        ok: false,
        error: error.message,
        diagnostics: {
          code: error.code,
          ...(error.diagnostics || {})
        }
      }, error.status);
    }

    return json({
      ok: false,
      error: "교통정보 처리 중 서버 오류가 발생했습니다.",
      diagnostics: {
        code: "TRAFFIC_INTERNAL_ERROR",
        detail: error instanceof Error ? error.message : String(error),
        name: error?.name || "UnknownError",
        stack: error instanceof Error
          ? String(error.stack || "").split("\n").slice(0, 4).join("\n")
          : ""
      }
    }, 500);
  }
}
