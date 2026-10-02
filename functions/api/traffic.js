const ITS_ENDPOINT = "http://openapi.its.go.kr/trafficInfo";

const CACHE_TTL_SECONDS = 15;
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_SPAN_X = 0.08;
const MAX_SPAN_Y = 0.08;
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

function getNumber(url, name) {
  const value = Number(url.searchParams.get(name));
  return Number.isFinite(value) ? value : null;
}

function decodeXml(value) {
  return String(value ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function readTag(block, tag) {
  const open = "<" + tag + ">";
  const close = "</" + tag + ">";
  const start = block.indexOf(open);

  if (start < 0) return "";

  const valueStart = start + open.length;
  const end = block.indexOf(close, valueStart);

  if (end < 0) return "";

  return decodeXml(block.slice(valueStart, end).trim());
}

function parseTrafficXml(xml) {
  const source = String(xml);
  const items = [];
  let cursor = 0;
  let totalCount = null;
  let validSpeedCount = 0;
  let speedSum = 0;
  let latestCreatedDate = "";

  const reportedTotal = readTag(source, "totalCount");
  if (reportedTotal) {
    const parsedTotal = Number(reportedTotal);
    if (Number.isFinite(parsedTotal)) {
      totalCount = parsedTotal;
    }
  }

  while (true) {
    const start = source.indexOf("<item>", cursor);
    if (start < 0) break;

    const valueStart = start + "<item>".length;
    const end = source.indexOf("</item>", valueStart);
    if (end < 0) break;

    const block = source.slice(valueStart, end);
    const speed = Number(readTag(block, "speed"));

    if (Number.isFinite(speed) && speed >= 0) {
      validSpeedCount += 1;
      speedSum += speed;
    }

    const createdDate = readTag(block, "createdDate");
    if (createdDate > latestCreatedDate) {
      latestCreatedDate = createdDate;
    }

    items.push({
      roadName: readTag(block, "roadName"),
      linkId: readTag(block, "linkId"),
      speed,
      travelTime: Number(readTag(block, "travelTime"))
    });

    cursor = end + "</item>".length;
  }

  const validItems = items
    .filter(item => item.linkId || item.roadName)
    .filter(item => Number.isFinite(item.speed) && item.speed >= 0);

  validItems.sort((a, b) => a.speed - b.speed);

  return {
    count: totalCount ?? items.length,
    averageSpeed: validSpeedCount
      ? Number((speedSum / validSpeedCount).toFixed(1))
      : null,
    updatedAt: latestCreatedDate,
    slowest: validItems.slice(0, SLOWEST_LIMIT)
  };
}

function createCacheKey(requestUrl) {
  const cacheUrl = new URL(requestUrl.origin + requestUrl.pathname);
  cacheUrl.pathname = "/api/traffic-cache";
  cacheUrl.searchParams.set("minX", requestUrl.searchParams.get("minX"));
  cacheUrl.searchParams.set("maxX", requestUrl.searchParams.get("maxX"));
  cacheUrl.searchParams.set("minY", requestUrl.searchParams.get("minY"));
  cacheUrl.searchParams.set("maxY", requestUrl.searchParams.get("maxY"));
  cacheUrl.searchParams.set("v", "3");
  return new Request(cacheUrl.toString(), { method: "GET" });
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function onRequestGet(context) {
  const startedAt = Date.now();
  const apiKey = String(context.env.ITS_API_KEY || "").trim();

  if (!apiKey) {
    return json({
      ok: false,
      error: "Cloudflare에 ITS_API_KEY Secret이 설정되어 있지 않습니다."
    }, 500);
  }

  const requestUrl = new URL(context.request.url);

  const minX = getNumber(requestUrl, "minX");
  const maxX = getNumber(requestUrl, "maxX");
  const minY = getNumber(requestUrl, "minY");
  const maxY = getNumber(requestUrl, "maxY");

  if ([minX, maxX, minY, maxY].some(value => value === null)) {
    return json({
      ok: false,
      error: "minX, maxX, minY, maxY가 모두 필요합니다."
    }, 400);
  }

  if (minX >= maxX || minY >= maxY) {
    return json({
      ok: false,
      error: "좌표 범위가 올바르지 않습니다."
    }, 400);
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const EPSILON = 1e-9;

  if (spanX > MAX_SPAN_X + EPSILON || spanY > MAX_SPAN_Y + EPSILON) {
    return json({
      ok: false,
      error: "조회 영역이 너무 큽니다. 부산 북구 테스트 범위보다 큰 영역은 조회할 수 없습니다.",
      limits: {
        maxSpanX: MAX_SPAN_X,
        maxSpanY: MAX_SPAN_Y,
        requestedSpanX: spanX,
        requestedSpanY: spanY
      }
    }, 400);
  }

  const cache = caches.default;
  const cacheKey = createCacheKey(requestUrl);
  const cached = await cache.match(cacheKey);

  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("X-Traffic-Cache", "HIT");
    response.headers.set("X-Traffic-Response-Ms", String(Date.now() - startedAt));
    return response;
  }

  const apiUrl = new URL(ITS_ENDPOINT);
  apiUrl.searchParams.set("apiKey", apiKey);
  apiUrl.searchParams.set("type", "all");
  apiUrl.searchParams.set("minX", String(minX));
  apiUrl.searchParams.set("maxX", String(maxX));
  apiUrl.searchParams.set("minY", String(minY));
  apiUrl.searchParams.set("maxY", String(maxY));
  apiUrl.searchParams.set("getType", "xml");

  const upstreamStartedAt = Date.now();

  try {
    const response = await fetchWithTimeout(apiUrl.toString(), {
      headers: {
        accept: "application/xml, text/xml"
      }
    });

    const upstreamMs = Date.now() - upstreamStartedAt;
    const rawText = await response.text();

    if (!response.ok) {
      const body = rawText.slice(0, 500);

      return json({
        ok: false,
        error: "ITS API HTTP 오류: " + response.status,
        diagnostics: {
          endpoint: ITS_ENDPOINT,
          status: response.status,
          upstreamMs,
          body
        }
      }, 502);
    }

    const parseStartedAt = Date.now();
    const summary = parseTrafficXml(rawText);
    const parseMs = Date.now() - parseStartedAt;
    const totalMs = Date.now() - startedAt;

    const payload = {
      ok: true,
      count: summary.count,
      averageSpeed: summary.averageSpeed,
      updatedAt: summary.updatedAt,
      data: summary.slowest,
      timing: {
        upstreamMs,
        parseMs,
        totalMs
      }
    };

    const responseBody = JSON.stringify(payload);
    const responseForClient = new Response(responseBody, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "cache-control": "public, max-age=0, s-maxage=" + CACHE_TTL_SECONDS,
        "X-Traffic-Cache": "MISS",
        "X-Traffic-Upstream-Ms": String(upstreamMs),
        "X-Traffic-Parse-Ms": String(parseMs),
        "X-Traffic-Response-Ms": String(totalMs)
      }
    });

    context.waitUntil(cache.put(cacheKey, responseForClient.clone()));

    return responseForClient;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = error?.name === "AbortError";

    return json({
      ok: false,
      error: isTimeout
        ? "ITS API 응답 시간 초과 (" + UPSTREAM_TIMEOUT_MS + "ms)"
        : "ITS API에 연결할 수 없습니다.",
      diagnostics: {
        endpoint: ITS_ENDPOINT,
        elapsedMs,
        reason: isTimeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_CONNECTION_ERROR",
        detail: error instanceof Error ? error.message : String(error)
      }
    }, 502);
  }
}
