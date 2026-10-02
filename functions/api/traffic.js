const ITS_ENDPOINT = "https://openapi.its.go.kr:9443/trafficInfo";

const MAX_SPAN_X = 0.6;
const MAX_SPAN_Y = 0.5;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function getNumber(url, name) {
  const value = Number(url.searchParams.get(name));
  return Number.isFinite(value) ? value : null;
}

function normalizeItem(item) {
  return {
    roadName: String(item?.roadName ?? ""),
    roadDrcType: String(item?.roadDrcType ?? ""),
    linkNo: String(item?.linkNo ?? ""),
    linkId: String(item?.linkId ?? ""),
    startNodeId: String(item?.startNodeId ?? ""),
    endNodeId: String(item?.endNodeId ?? ""),
    speed: Number(item?.speed),
    travelTime: Number(item?.travelTime),
    createdDate: String(item?.createdDate ?? "")
  };
}

function extractItems(payload) {
  const candidates = [
    payload?.response?.data,
    payload?.response?.body?.items,
    payload?.response?.body?.item,
    payload?.body?.items,
    payload?.items,
    payload?.data
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      if (Array.isArray(candidate.item)) return candidate.item;
      if (Array.isArray(candidate.items)) return candidate.items;
    }
  }

  return [];
}

export async function onRequestGet(context) {
  const apiKey = String(context.env.ITS_API_KEY || "").trim();

  if (!apiKey) {
    return json({
      ok: false,
      error: "Cloudflare에 ITS_API_KEY Secret이 설정되어 있지 않습니다."
    }, 500);
  }

  const url = new URL(context.request.url);

  const minX = getNumber(url, "minX");
  const maxX = getNumber(url, "maxX");
  const minY = getNumber(url, "minY");
  const maxY = getNumber(url, "maxY");

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

  if (maxX - minX > MAX_SPAN_X || maxY - minY > MAX_SPAN_Y) {
    return json({
      ok: false,
      error: "조회 영역이 너무 큽니다. 지도를 확대하거나 더 작은 영역으로 조회해주세요."
    }, 400);
  }

  const apiUrl = new URL(ITS_ENDPOINT);
  apiUrl.searchParams.set("apiKey", apiKey);
  apiUrl.searchParams.set("type", "all");
  apiUrl.searchParams.set("drcType", "all");
  apiUrl.searchParams.set("minX", String(minX));
  apiUrl.searchParams.set("maxX", String(maxX));
  apiUrl.searchParams.set("minY", String(minY));
  apiUrl.searchParams.set("maxY", String(maxY));
  apiUrl.searchParams.set("getType", "json");

  try {
    const response = await fetch(apiUrl.toString(), {
      headers: { accept: "application/json" }
    });

    const rawText = await response.text();

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return json({
        ok: false,
        error: `ITS API가 JSON이 아닌 응답을 반환했습니다. HTTP ${response.status}`
      }, 502);
    }

    if (!response.ok) {
      return json({
        ok: false,
        error: `ITS API HTTP 오류: ${response.status}`,
        upstream: payload
      }, 502);
    }

    const data = extractItems(payload)
      .map(normalizeItem)
      .filter(item => item.linkId || item.roadName);

    return json({
      ok: true,
      count: data.length,
      data
    });
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "ITS API 호출 중 오류가 발생했습니다."
    }, 502);
  }
}
