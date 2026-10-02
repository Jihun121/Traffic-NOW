import { normalizeTrafficPayload } from "./normalizeTraffic.js";

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_API_URL = "https://apis.data.go.kr/6260000/BusanITSLINKTraffic/getBusanITSLINKTraffic";

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

  if (url.pathname.endsWith("/BusanITSLINKTraffic")) {
    url.pathname += "/getBusanITSLINKTraffic";
  }

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
    url.searchParams.set("numOfRows", "50");
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

  try {
    const response = await fetchWithTimeout(apiUrl.toString(), timeoutMs);
    const elapsedMs = Date.now() - startedAt;
    const rawText = await response.text();

    if (!response.ok) {
      throw new BusanTrafficError(
        "부산시 교통 API HTTP 오류: " + response.status,
        502,
        "BUSAN_TRAFFIC_HTTP_ERROR",
        {
          endpoint: sanitizeUrlForDiagnostics(apiUrl.toString()),
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
          endpoint: sanitizeUrlForDiagnostics(apiUrl.toString()),
          elapsedMs,
          detail: error instanceof Error ? error.message : String(error),
          body: rawText.slice(0, 500)
        }
      );
    }

    const normalized = normalizeTrafficPayload(payload);

    return {
      ...normalized,
      fetchedAt: new Date().toISOString(),
      upstreamMs: elapsedMs
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
