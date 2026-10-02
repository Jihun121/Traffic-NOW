const REGIONS = {
  busan: {
    // 부산 북구 중심부 테스트용 범위.
    // ITS에서 넓은 조회 영역을 거부하는 문제를 피하기 위해 작게 제한합니다.
    name: "부산 북구 테스트",
    minX: 128.98,
    maxX: 129.04,
    minY: 35.17,
    maxY: 35.23
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
  const diagnostics = payload?.diagnostics;
  const upstreamStatus = diagnostics?.status;

  if (upstreamStatus === 522 || String(payload?.error || "").includes("522")) {
    return "ITS 서버 연결 시간 초과(522) · 사용량 부족보다는 API 서버/네트워크 연결 문제일 가능성이 큽니다.";
  }

  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return "ITS 인증 오류 · API 키 또는 사용처/권한 설정을 확인하세요.";
  }

  if (upstreamStatus === 429) {
    return "ITS 요청 제한(429) · 호출 한도 또는 순간 요청량을 확인하세요.";
  }

  if (response?.status === 502) {
    return "ITS API 연결 실패 · 외부 API 서버 응답 상태를 확인하는 중입니다.";
  }

  if (response?.status === 500) {
    return "서버 설정 오류 · Cloudflare의 ITS_API_KEY Secret 설정을 확인하세요.";
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
        <td>${escapeHtml(row.roadName || "도로명 없음")}</td>
        <td>${formatNumber(row.speed)} km/h</td>
        <td>${formatNumber(row.travelTime, 1)}초</td>
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
  linkCount.textContent = formatNumber(rows.length);

  const average = Number(payload.averageSpeed);

  avgSpeed.textContent = Number.isFinite(average)
    ? `${average.toFixed(1)} km/h`
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

async function loadTraffic(regionKey) {
  if (state.loading) return;

  const region = REGIONS[regionKey];
  if (!region) return;

  state.loading = true;
  state.regionKey = regionKey;
  setStatus("조회 중");

  regionName.textContent = region.name;
  message.textContent = "국가교통정보센터에서 교통정보를 가져오는 중입니다...";
  trafficTable.innerHTML = "";

  const params = new URLSearchParams({
    minX: region.minX,
    maxX: region.maxX,
    minY: region.minY,
    maxY: region.maxY
  });

  try {
    const response = await fetch(`/api/traffic?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      setErrorDetail(classifyApiError(response, payload));
      throw new Error(payload.error || "교통정보 조회에 실패했습니다.");
    }

    state.rows = Array.isArray(payload.data) ? payload.data : [];

    renderSummary(region, state.rows, payload);

    const cacheState = response.headers.get("X-Traffic-Cache") || "MISS";
    const totalMs = payload.timing?.totalMs ?? response.headers.get("X-Traffic-Response-Ms");
    const timingText = totalMs ? ` · 응답 ${Number(totalMs).toLocaleString("ko-KR")}ms` : "";
    message.textContent = `조회 완료 · 전체 ${Number(payload.count ?? 0).toLocaleString("ko-KR")}개 구간 중 느린 구간 ${state.rows.length}개 표시 · 캐시 ${cacheState}${timingText}`;
    setErrorDetail("");
    setStatus("정상", true);
  } catch (error) {
    state.rows = [];
    trafficTable.innerHTML = "";
    message.textContent = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
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
  if (state.regionKey) loadTraffic(state.regionKey);
});
