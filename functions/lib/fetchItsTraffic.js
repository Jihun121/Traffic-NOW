/**
 * 국토교통부 국가교통정보센터 (ITS) API 연동 모듈
 * 환경 변수: ITS_API_KEY
 * - 부산권역 고속도로 및 주요 연계도로 소통정보/돌발정보 수집
 */

// 부산 광역 바운딩 박스 (경도, 위도)
const BUSAN_BBOX = {
  minX: "128.75",
  maxX: "129.35",
  minY: "34.98",
  maxY: "35.40"
};

const DEFAULT_ITS_TIMEOUT_MS = 8000;
const ITS_TRAFFIC_URL = "https://openapi.its.go.kr:9443/trafficInfo";

function getItsApiKey(env) {
  const raw = String(env.ITS_API_KEY || "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * ITS 소통정보 수집 (실패 시 빈 배열 반환하여 시스템 안정성 보장)
 */
export async function fetchItsTraffic(context) {
  const apiKey = getItsApiKey(context?.env || {});
  if (!apiKey) {
    return {
      ok: false,
      source: "국가교통정보센터(ITS)",
      items: [],
      reason: "ITS_API_KEY_NOT_CONFIGURED"
    };
  }

  const url = new URL(ITS_TRAFFIC_URL);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("type", "all");
  url.searchParams.set("getType", "json");
  url.searchParams.set("minX", BUSAN_BBOX.minX);
  url.searchParams.set("maxX", BUSAN_BBOX.maxX);
  url.searchParams.set("minY", BUSAN_BBOX.minY);
  url.searchParams.set("maxY", BUSAN_BBOX.maxY);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_ITS_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      headers: { accept: "application/json" },
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        ok: false,
        source: "국가교통정보센터(ITS)",
        items: [],
        status: response.status,
        reason: `HTTP_${response.status}`
      };
    }

    const data = await response.json();
    const rawItems = data?.body?.items || data?.response?.body?.items || [];
    const list = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);

    const normalized = list.map((item) => ({
      linkId: String(item.linkId || item.roadSectionId || "").trim(),
      roadName: String(item.roadName || item.routeName || "").trim(),
      startName: String(item.startNodeName || "").trim(),
      endName: String(item.endNodeName || "").trim(),
      speed: Number(item.speed || item.travelSpeed || 0),
      source: "ITS"
    })).filter((row) => row.roadName && Number.isFinite(row.speed) && row.speed > 0);

    return {
      ok: true,
      source: "국가교통정보센터(ITS)",
      items: normalized,
      count: normalized.length
    };
  } catch (error) {
    console.warn("ITS API fetch warning (graceful degradation):", error?.message || error);
    return {
      ok: false,
      source: "국가교통정보센터(ITS)",
      items: [],
      reason: error?.message || "FETCH_FAILED"
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
