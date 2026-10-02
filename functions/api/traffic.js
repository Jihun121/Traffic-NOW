const ITS_ENDPOINTS = [
  "http://openapi.its.go.kr/trafficInfo",
  "https://openapi.its.go.kr:9443/trafficInfo"
];

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

function decodeXml(value) {
  return String(value ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function readTag(block, tag) {
  const match = block.match(new RegExp("<" + tag + ">([\\s\\S]*?)<\\/" + tag + ">"));
  return match ? decodeXml(match[1].trim()) : "";
}

function parseTrafficXml(xml) {
  const items = [];
  const itemMatches = String(xml).matchAll(/<item>([\\s\\S]*?)<\/item>/g);

  for (const match of itemMatches) {
    const block = match[1];

    items.push({
      roadName: readTag(block, "roadName"),
      roadDrcType: readTag(block, "drcType"),
      linkNo: readTag(block, "linkNo"),
      linkId: readTag(block, "linkId"),
      startNodeId: readTag(block, "startNodeId"),
      endNodeId: readTag(block, "endNodeId"),
      speed: Number(readTag(block, "speed")),
      travelTime: Number(readTag(block, "travelTime")),
      createdDate: readTag(block, "createdDate")
    });
  }

  return items;
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

  let lastFailure = null;

  for (const endpoint of ITS_ENDPOINTS) {
    const apiUrl = new URL(endpoint);
    apiUrl.searchParams.set("apiKey", apiKey);
    apiUrl.searchParams.set("type", "all");
    apiUrl.searchParams.set("minX", String(minX));
    apiUrl.searchParams.set("maxX", String(maxX));
    apiUrl.searchParams.set("minY", String(minY));
    apiUrl.searchParams.set("maxY", String(maxY));
    apiUrl.searchParams.set("getType", "xml");

    try {
      const response = await fetch(apiUrl.toString(), {
        headers: { accept: "application/xml, text/xml" }
      });

      const rawText = await response.text();

      if (!response.ok) {
        lastFailure = {
          endpoint,
          status: response.status,
          body: rawText.slice(0, 500)
        };
        continue;
      }

      const data = parseTrafficXml(rawText)
        .map(normalizeItem)
        .filter(item => item.linkId || item.roadName);

      return json({
        ok: true,
        count: data.length,
        data
      });
    } catch (error) {
      lastFailure = {
        endpoint,
        error: error instanceof Error ? error.message : "알 수 없는 네트워크 오류"
      };
    }
  }

  return json({
    ok: false,
    error: "ITS API에 연결할 수 없습니다. 모든 공식 접속 경로에서 응답을 받지 못했습니다.",
    diagnostics: lastFailure
  }, 502);

