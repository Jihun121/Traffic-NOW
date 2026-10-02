import { normalizeTrafficPayload } from "./normalizeTraffic.js";

const DEFAULT_TIMEOUT_MS = 20000;
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

export async function fetchBusanTraffic(context, options = {}) {
  const rawUrl = String(context.env?.BUSAN_TRAFFIC_API_URL || DEFAULT_API_URL).trim();
  const apiKey = getApiKey(context.env || {});

  if (!apiKey && !/[?&](serviceKey|apiKey)=/i.test(rawUrl)) {
    throw new BusanTrafficError(
      "부산 교통 API 인증키가 설정되어 있지 않습니다. BUSAN_TRAFFIC_API_KEY 환경 변수를 확인하세요.",
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

  const timeoutMs = Number(context.env?.BUSAN_TRAFFIC_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  const maxPages = Number(options.maxPages || 1); // 기본 1페이지만 빠르게 수집하여 온디맨드 타임아웃 방지

  async function requestPage(pageNo) {
    const pageUrl = new URL(apiUrl);
    pageUrl.searchParams.set("pageNo", String(pageNo));
    const requestedRows = String(options.pageSize || (maxPages === 1 ? 300 : 1000));
    pageUrl.searchParams.set("numOfRows", requestedRows);

    let response;
    try {
      response = await fetchWithTimeout(pageUrl.toString(), timeoutMs);
    } catch (err) {
      const isTimeout = err?.name === "AbortError";
      const elapsedMs = Date.now() - startedAt;
      throw new BusanTrafficError(
        isTimeout
          ? `부산시 공공데이터 API 응답 시간 초과 (제한: ${timeoutMs}ms, 소요: ${elapsedMs}ms)`
          : `부산시 공공데이터 API 네트워크 연결 실패: ${err?.message || err}`,
        isTimeout ? 504 : 502,
        isTimeout ? "BUSAN_TRAFFIC_UPSTREAM_TIMEOUT" : "BUSAN_TRAFFIC_UPSTREAM_CONNECTION_ERROR",
        {
          endpoint: sanitizeUrlForDiagnostics(pageUrl.toString()),
          elapsedMs,
          timeoutLimitMs: timeoutMs,
          pageNo,
          reason: isTimeout ? "UPSTREAM_TIMEOUT" : "CONNECTION_ERROR",
          detail: err instanceof Error ? err.message : String(err)
        }
      );
    }

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
        `부산시 교통 API 오류 응답 (코드: ${resultCode}): ${resultMsg || returnAuthMsg || "인증키 또는 파라미터를 확인하세요"}`,
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

  const first = await requestPage(1);
  const content = first.payload?.content || {};
  const totalCount = Number(content?.totalCount ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / 1000));
  const responses = [first.payload];

  // maxPages 제한이 1보다 크고 totalPages가 여러 개일 때만 추가 페이지 수집
  if (maxPages > 1 && totalPages > 1) {
    const targetPages = Math.min(maxPages, totalPages);
    for (let page = 2; page <= targetPages; page += 4) {
      const pageNumbers = [];
      for (let n = page; n < page + 4 && n <= targetPages; n += 1) {
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
    pageCount: responses.length
  };
}
