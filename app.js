const REGIONS = {
  busan: {
    name: "부산 북구 테스트",
    region: "busan-north-gu"
  }
};

const state = {
  regionKey: null,
  rows: [],
  loading: false
};

const regionName = document.querySelector("#regionName");
const linkCount = document.querySelector("#linkCount");
const avgSpeed = document.querySelector("#avgSpeed");
const updatedAt = document.querySelector("#updatedAt");
const resultCount = document.querySelector("#resultCount");
const trafficTable = document.querySelector("#trafficTable");
const message = document.querySelector("#message");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const refreshButton = document.querySelector("#refreshButton");
const errorDetail = document.querySelector("#errorDetail");

function setStatus(text, active = false) {
  statusText.textContent = text;
  statusDot.style.background = active ? "#1c9b62" : "#a7b0c2";
}

function setErrorDetail(text = "") {
  if (errorDetail) errorDetail.textContent = text;
}

function classifyApiError(response, payload) {
  const code = payload?.diagnostics?.code;

  if (code === "BUSAN_TRAFFIC_API_URL_MISSING") {
    return "부산 교통 API 주소가 설정되지 않았습니다. Cloudflare의 BUSAN_TRAFFIC_API_URL Secret을 확인하세요.";
  }

  if (code === "BUSAN_TRAFFIC_API_KEY_MISSING") {
    return "부산 교통 API 인증키가 설정되지 않았습니다. BUSAN_TRAFFIC_API_KEY 또는 BUSAN_API_KEY를 확인하세요.";
  }

  if (code === "BUSAN_TRAFFIC_UPSTREAM_TIMEOUT") {
    return "부산시 교통 API 응답 시간 초과 · 좌표 영역 조회가 아닌 부산시 데이터 API 자체의 응답 상태를 확인해야 합니다.";
  }

  if (code === "BUSAN_TRAFFIC_HTTP_ERROR") {
    return "부산시 교통 API HTTP 오류 · 인증키와 API 주소를 확인하세요.";
  }

  if (response?.status === 500) {
    return "Traffic-NOW 서버 설정 오류를 확인하세요.";
  }

  return payload?.error || "교통정보 조회에 실패했습니다.";
}

function formatNumber(value, digits = 0) {
  return Number.isFinite(value)
    ? value.toLocaleString("ko-KR", { maximumFractionDigits: digits })
    : "-";
}

function renderRows(rows) {
  trafficTable.innerHTML = rows
    .slice(0, 30)
    .map(row => `
      <tr>
        <td>${escapeHtml(row.roadName || row.sectionName || "도로명 없음")}</td>
        <td>${formatNumber(Number(row.speed))} km/h</td>
        <td>${escapeHtml(row.startName || "-")} → ${escapeHtml(row.endName || "-")}</td>
        <td>${escapeHtml(row.linkId || "-")}</td>
      </tr>
    `)
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderSummary(region, rows, payload = {}) {
  regionName.textContent = region.name;
  linkCount.textContent = formatNumber(Number(payload.filteredCount ?? rows.length));
  avgSpeed.textContent = Number.isFinite(Number(payload.averageSpeed))
    ? `${Number(payload.averageSpeed).toFixed(1)} km/h`
    : "-";
  updatedAt.textContent = payload.updatedAt
    ? formatApiDate(payload.updatedAt)
    : "-";
  resultCount.textContent = `${rows.length.toLocaleString("ko-KR")}건`;

  renderRows([...rows].sort((a, b) => Number(a.speed) - Number(b.speed)));
}

function formatApiDate(value) {
  const text = String(value);

  if (/^\d{14}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}`;
  }

  return text;
}

async function loadTraffic(regionKey, forceRefresh = false) {
  if (state.loading) return;

  const region = REGIONS[regionKey];
  if (!region) return;

  state.loading = true;
  state.regionKey = regionKey;
  setStatus(forceRefresh ? "최신 데이터 요청 중" : "조회 중");

  regionName.textContent = region.name;
  message.textContent = forceRefresh
    ? "부산시 교통정보에서 최신 데이터를 가져오는 중입니다..."
    : "부산시 교통정보 캐시에서 데이터를 준비하는 중입니다...";
  trafficTable.innerHTML = "";

  const params = new URLSearchParams({
    region: region.region
  });

  if (forceRefresh) {
    params.set("forceRefresh", "1");
  }

  try {
    const response = await fetch(`/api/traffic?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      setErrorDetail(classifyApiError(response, payload));
      throw new Error(payload.error || "교통정보 조회에 실패했습니다.");
    }

    state.rows = Array.isArray(payload.data) ? payload.data : [];
    renderSummary(region, state.rows, payload);

    const cacheState = payload.cache || response.headers.get("X-Traffic-Cache") || "MISS";
    const totalMs = payload.timing?.totalMs ?? response.headers.get("X-Traffic-Response-Ms");
    const timingText = totalMs
      ? ` · 응답 ${Number(totalMs).toLocaleString("ko-KR")}ms`
      : "";

    message.textContent =
      `부산시 실시간 교통 데이터 기반 · 북구 필터 결과 ${state.rows.length}건 · 캐시 ${cacheState}${timingText}`;

    setErrorDetail("");
    setStatus("정상", true);
  } catch (error) {
    state.rows = [];
    trafficTable.innerHTML = "";
    message.textContent = error instanceof Error
      ? error.message
      : "알 수 없는 오류가 발생했습니다.";
    resultCount.textContent = "0건";
    setStatus("오류");
  } finally {
    state.loading = false;
  }
}

document.querySelectorAll("[data-region]").forEach(button => {
  button.addEventListener("click", () => loadTraffic(button.dataset.region));
});

refreshButton.addEventListener("click", () => {
  if (state.regionKey) {
    loadTraffic(state.regionKey, true);
  } else {
    loadTraffic("busan", true);
  }
});
