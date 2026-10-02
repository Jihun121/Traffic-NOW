const CACHE_VERSION = "busan-link-traffic-v1";

function createCacheKey(requestUrl) {
  const keyUrl = new URL(requestUrl.origin + requestUrl.pathname);
  keyUrl.pathname = "/api/traffic-cache";
  keyUrl.search = "";
  keyUrl.searchParams.set("source", CACHE_VERSION);

  return new Request(keyUrl.toString(), {
    method: "GET"
  });
}

export async function readTrafficCache(requestUrl) {
  const cache = caches.default;
  const cached = await cache.match(createCacheKey(requestUrl));

  if (!cached) {
    return null;
  }

  try {
    return await cached.json();
  } catch {
    return null;
  }
}

export async function writeTrafficCache(requestUrl, payload, ttlSeconds) {
  const cache = caches.default;
  const body = JSON.stringify(payload);
  const response = new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "public, s-maxage=" + ttlSeconds
    }
  });

  await cache.put(createCacheKey(requestUrl), response);
}
