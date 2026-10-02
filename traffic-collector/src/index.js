const API_URL = "https://apis.data.go.kr/6260000/BusanITSLINKTraffic/LINKTrafficList";
const SNAPSHOT_KEY = "traffic:busan:latest";
const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 60000;
const MAX_PARALLEL_PAGES = 4;

function getApiKey(env) {
  const raw = String(env.BUSAN_TRAFFIC_API_KEY || "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function fetchPage(apiKey, pageNo) {
  const url = new URL(API_URL);
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

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload = JSON.parse(text);
    const header = payload?.OpenAPI_ServiceResponse?.cmmMsgHeader;

    if (header?.returnReasonCode) {
      throw new Error(
        `API error ${header.returnReasonCode}: ${header.errMsg || header.returnAuthMsg || ""}`
      );
    }

    return payload;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeItems(payload) {
  const items = payload?.content?.items;
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      linkId: String(item?.lkId ?? "").trim(),
      roadName: String(item?.roadNm ?? "").trim(),
      startName: String(item?.bgngNodeNm ?? "").trim(),
      endName: String(item?.endNodeNm ?? "").trim(),
      speed: Number(item?.spd),
      volume: Number(item?.vol),
      updatedAt: String(
        item?.collectDt ??
        item?.createdDate ??
        item?.processDt ??
        item?.updDt ??
        ""
      ).trim()
    }))
    .filter((row) =>
      (row.linkId || row.roadName || row.startName || row.endName) &&
      Number.isFinite(row.speed) &&
      row.speed >= 0 &&
      row.speed <= 160
    );
}

export default {
  async scheduled(controller, env) {
    const apiKey = getApiKey(env);

    if (!apiKey) {
      throw new Error("BUSAN_TRAFFIC_API_KEY secret is not configured.");
    }

    const startedAt = Date.now();
    const first = await fetchPage(apiKey, 1);
    const totalCount = Number(first?.content?.totalCount ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

    const rows = normalizeItems(first);

    for (let start = 2; start <= totalPages; start += MAX_PARALLEL_PAGES) {
      const pageNumbers = [];

      for (
        let page = start;
        page < start + MAX_PARALLEL_PAGES && page <= totalPages;
        page += 1
      ) {
        pageNumbers.push(page);
      }

      const pages = await Promise.all(
        pageNumbers.map((pageNo) => fetchPage(apiKey, pageNo))
      );

      for (const payload of pages) {
        rows.push(...normalizeItems(payload));
      }
    }

    const snapshot = {
      source: "부산광역시_링크소통정보",
      rows,
      totalCount,
      pageCount: totalPages,
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt
    };

    await env.TRAFFIC_CACHE.put(
      SNAPSHOT_KEY,
      JSON.stringify(snapshot),
      {
        expirationTtl: 60 * 60 * 2
      }
    );
  }
};
