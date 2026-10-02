import { normalizeTrafficPayload } from "./normalizeTraffic.js";

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_API_URL = "https://apis.data.go.kr/6260000/BusanITSLINKTraffic/LINKTrafficList";

function getApiKey(env) {
  const raw = String(
    env.BUSAN_TRAFFIC_API_KEY ||
    env.BUSAN_API_KEY ||
    ""
  ).trim();

  if (!raw) return "";

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sanitizeUrlForDiagnostics(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("serviceKey");
    url.searchParams.delete("apiKey");
    return url.toString();
  } catch {
    return String(value);
  }
}

function buildApiUrl(rawUrl, apiKey) {
  let url = new URL(rawUrl);

  if (!url.searchParams.has("serviceKey") && !url.searchParams.has("apiKey")) {
    url.searchParams.set("serviceKey", apiKey);
  }

  if (!url.searchParams.has("resultType") && !url.searchParams.has("type")) {
    url.searchParams.set("resultType", "json");
  }

  if (!url.searchParams.has("pageNo")) {
    url.searchParams.set("pageNo", "1");
  }

  if (!url.searchParams.has("numOfRows")) {
    url.searchParams.set("numOfRows", "1000");
  }

  return url;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export class BusanTrafficError extends Error {
  constructor(message, status = 502, code = "BUSAN_TRAFFIC_UPSTREAM_ERROR", diagnostics = {}) {
    super(message);
    this.name = "BusanTrafficError";
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export async function fetchBusanTraffic(context) {
  const rawUrl = String(context.env.BUSAN_TRAFFIC_API_URL || DEFAULT_API_URL).trim();
  const apiKey = getApiKey(context.env);

  if (!apiKey && !/[?&](serviceKey|apiKey)=/i.test(rawUrl)) {
    throw new BusanTrafficError(
      "부산 교통 API 인증키가 설정되어 있지 않습니다. BUSAN_TRAFFIC_API_KEY 또는 BUSAN_API_KEY를 확인하세요.",
      500,
      "BUSAN_TRAFFIC_API_KEY_MISSING"
    );
  }

  let apiUrl;
  try {
    apiUrl = buildApiUrl(rawUrl, apiKey);
  } catch (error) {
    throw new BusanTrafficError(
      "BUSAN_TRAFFIC_API_URL 형식이 올바르지 않습니다.",
      500,
      "BUSAN_TRAFFIC_API_URL_INVALID",
      { detail: error instanceof Error ? error.message : String(error) }
    );
  }

  const timeoutMs = Number(context.env.BUSAN_TRAFFIC_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  async function requestPage(pageNo) {
    const pageUrl = new URL(apiUrl);
    pageUrl.searchParams.set("pageNo", String(pageNo));
    pageUrl.searchParams.set("numOfRows", "1000");

    const response = await fetchWithTimeout(pageUrl.toString(), timeoutMs);
    const elapsedMs = Date.now() - startedAt;
    const rawText = await response.text();

    if (!response.ok) {
      throw new BusanTrafficError(
        "부산시 교통 API HTTP 오류: " + response.status,
        502,
        "BUSAN_TRAFFIC_HTTP_ERROR",
        {
          endpoint: sanitizeUrlForDiagnostics(pageUrl.toString()),
          status: response.status,
          elapsedMs,
          body: rawText.slice(0, 500)
        }
      );
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      throw new BusanTrafficError(
        "부산시 교통 API 응답이 JSON 형식이 아닙니다.",
        502,
        "BUSAN_TRAFFIC_INVALID_JSON",
        {
          endpoint: sanitizeUrlForDiagnostics(pageUrl.toString()),
          elapsedMs,
          detail: error instanceof Error ? error.message : String(error),
          body: rawText.slice(0, 500)
        }
      );
    }

    const header = payload?.OpenAPI_ServiceResponse?.cmmMsgHeader || {};
    const resultCode = String(
      payload?.resultCode ??
      payload?.result?.resultCode ??
      header.returnReasonCode ??
      ""
    );
    const resultMsg =
      payload?.resultMsg ??
      payload?.result?.resultMsg ??
      header.errMsg ??
      "";
    const returnAuthMsg =
      payload?.returnAuthMsg ??
      payload?.result?.returnAuthMsg ??
      header.returnAuthMsg ??
      "";

    if (resultCode && resultCode !== "00" && resultCode !== "0") {
      throw new BusanTrafficError(
        "부산시 교통 API가 오류를 반환했습니다.",
        502,
        "BUSAN_TRAFFIC_API_RESULT_ERROR",
        {
          endpoint: sanitizeUrlForDiagnostics(pageUrl.toString()),
          resultCode,
          resultMsg,
          returnReasonCode: header.returnReasonCode || payload?.returnReasonCode || "",
          returnAuthMsg,
          responsePreview: JSON.stringify(payload).slice(0, 1200)
        }
      );
    }

    return {
      payload,
      elapsedMs,
      url: pageUrl
    };
  }

  try {
    const first = await requestPage(1);
    const content = first.payload?.content || {};
    const totalCount = Number(content?.totalCount ?? 0);
    const pageSize = 1000;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    const responses = [first.payload];

    // 북구 테스트에 필요한 데이터가 첫 페이지에 없을 수 있으므로
    // 전체 링크를 가져오되, 동시 요청은 4개씩만 실행합니다.
    if (totalPages > 1) {
      for (let page = 2; page <= totalPages; page += 4) {
        const pageNumbers = [];
        for (let n = page; n < page + 4 && n <= totalPages; n += 1) {
          pageNumbers.push(n);
        }

        const batch = await Promise.all(pageNumbers.map(requestPage));
        responses.push(...batch.map((item) => item.payload));
      }
    }

    const rawItems = responses.flatMap((payload) =>
      Array.isArray(payload?.content?.items) ? payload.content.items : []
    );

    const normalized = normalizeTrafficPayload({
      totalCount,
      content: {
        totalCount,
        items: rawItems
      }
    });

    return {
      ...normalized,
      fetchedAt: new Date().toISOString(),
      upstreamMs: Date.now() - startedAt,
      pageCount: totalPages
    };
  } catch (error) {
    if (error instanceof BusanTrafficError) {
      throw error;
    }

    const elapsedMs = Date.now() - startedAt;
    const isTimeout = error?.name === "AbortError";

    throw new BusanTrafficError(
      isTimeout
        ? "부산시 교통 API 응답 시간 초과 (" + timeoutMs + "ms)"
        : "부산시 교통 API에 연결할 수 없습니다.",
      isTimeout ? 503 : 502,
      isTimeout ? "BUSAN_TRAFFIC_UPSTREAM_TIMEOUT" : "BUSAN_TRAFFIC_UPSTREAM_CONNECTION_ERROR",
      {
        endpoint: sanitizeUrlForDiagnostics(apiUrl.toString()),
        elapsedMs,
        reason: isTimeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_CONNECTION_ERROR",
        detail: error instanceof Error ? error.message : String(error)
      }
    );
  }
}
