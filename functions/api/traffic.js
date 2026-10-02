import { fetchBusanTraffic, BusanTrafficError } from "../lib/fetchBusanTraffic.js";
import { filterTrafficRegion, getTrafficRegion } from "../lib/filterTrafficRegion.js";
import { readTrafficCache, writeTrafficCache } from "../lib/trafficCache.js";

const CACHE_TTL_SECONDS = 300;
const SOURCE_CACHE_TTL_SECONDS = 300;
const SLOWEST_LIMIT = 30;
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
  let stage = "start";
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

    // 사용자 요청에서는 부산 원본 API를 호출하지 않습니다.
    // 배경 수집기가 KV에 저장한 최신 스냅샷만 읽습니다.
    if (context.env.TRAFFIC_CACHE) {
      stage = "snapshot-read";
      const snapshot = await context.env.TRAFFIC_CACHE.get(SNAPSHOT_KEY, "json");
      if (snapshot && Array.isArray(snapshot.rows)) {
        source = snapshot;
        cacheState = "SNAPSHOT";
      }
    }

    if (!source) {
      return json({
        ok: false,
        error: "최신 부산 교통 스냅샷이 아직 준비되지 않았습니다.",
        diagnostics: {
          code: "TRAFFIC_SNAPSHOT_NOT_READY"
        }
      }, 503);
    }

    stage = "region-filter";
    const filteredRows = filterTrafficRegion(source.rows || [], regionKey);
    stage = "payload-build";
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
        stage,
        name: error?.name || "UnknownError",
        stack: error instanceof Error
          ? String(error.stack || "").split("\n").slice(0, 4).join("\n")
          : ""
      }
    }, 500);
  }
}
