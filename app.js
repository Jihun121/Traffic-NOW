const state = {
  regionKey: "busan",
  rawData: [],
  filteredData: [],
  stats: null,
  top10: [],
  loading: false,
  searchTerm: "",
  onlyCongested: false
};

// DOM 요소 캐싱
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const refreshButton = document.querySelector("#refreshButton");
const updatedAtLabel = document.querySelector("#updatedAtLabel");

const statAvgSpeed = document.querySelector("#statAvgSpeed");
const statTotalLinks = document.querySelector("#statTotalLinks");
const statCongestionLevel = document.querySelector("#statCongestionLevel");
const statLevelDetail = document.querySelector("#statLevelDetail");
const statSlowestRoad = document.querySelector("#statSlowestRoad");
const statSlowestSpeed = document.querySelector("#statSlowestSpeed");

const ratioSmoothText = document.querySelector("#ratioSmoothText");
const ratioSlowText = document.querySelector("#ratioSlowText");
const ratioCongestedText = document.querySelector("#ratioCongestedText");
const barSmooth = document.querySelector("#barSmooth");
const barSlow = document.querySelector("#barSlow");
const barCongested = document.querySelector("#barCongested");

const top10Container = document.querySelector("#top10Container");
const trafficTable = document.querySelector("#trafficTable");
const searchInput = document.querySelector("#searchInput");
const onlyCongestedCheck = document.querySelector("#onlyCongestedCheck");
const statusMessage = document.querySelector("#statusMessage");
const resultCountLabel = document.querySelector("#resultCountLabel");
const errorDetail = document.querySelector("#errorDetail");

function setStatus(text, active = false) {
  if (statusText) statusText.textContent = text;
  if (statusDot) {
    statusDot.className = active ? "dot active" : "dot";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value, digits = 0) {
  return Number.isFinite(value)
    ? value.toLocaleString("ko-KR", { maximumFractionDigits: digits })
    : "-";
}

function formatApiDate(value) {
  if (!value) return "확인 불가";
  const text = String(value);
  if (/^\d{14}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}`;
  }
  try {
    const d = new Date(text);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
  } catch {}
  return text;
}

// 1. 부산 전체 통계 요약 렌더링
function renderStats(stats, updatedAt) {
  if (!stats) return;

  statAvgSpeed.textContent = `${formatNumber(stats.averageSpeed, 1)} km/h`;
  statTotalLinks.textContent = `${formatNumber(stats.totalCount)}개 구간`;
  statCongestionLevel.textContent = stats.congestionLevel || "원활";

  if (stats.statusRatios) {
    statLevelDetail.textContent = `정체 비율 ${stats.statusRatios.congested}% · 서행 ${stats.statusRatios.slow}%`;
    ratioSmoothText.textContent = `${stats.statusRatios.smooth}%`;
    ratioSlowText.textContent = `${stats.statusRatios.slow}%`;
    ratioCongestedText.textContent = `${stats.statusRatios.congested}%`;

    barSmooth.style.width = `${Math.max(1, stats.statusRatios.smooth)}%`;
    barSlow.style.width = `${Math.max(1, stats.statusRatios.slow)}%`;
    barCongested.style.width = `${Math.max(1, stats.statusRatios.congested)}%`;
  }

  if (stats.slowestRoad) {
    statSlowestRoad.textContent = stats.slowestRoad.roadName;
    statSlowestSpeed.textContent = `${stats.slowestRoad.section} (${formatNumber(stats.slowestRoad.speed, 1)} km/h)`;
  } else {
    statSlowestRoad.textContent = "-";
    statSlowestSpeed.textContent = "원활한 소통 상태";
  }

  if (updatedAtLabel) {
    updatedAtLabel.textContent = `최종 갱신: ${formatApiDate(updatedAt)}`;
  }
}

// 2. 실시간 정체 TOP 10 랭킹 카드 렌더링
function renderTop10(top10List) {
  if (!top10Container) return;

  if (!Array.isArray(top10List) || top10List.length === 0) {
    top10Container.innerHTML = `<div class="loading-placeholder">현재 부산 전역에 뚜렷한 정체 구간이 없거나 원활합니다.</div>`;
    return;
  }

  top10Container.innerHTML = top10List.slice(0, 10).map((item, idx) => {
    const rank = idx + 1;
    const rankClass = rank === 1 ? "top-1" : rank === 2 ? "top-2" : rank === 3 ? "top-3" : "";
    const cardRankClass = rank === 1 ? "rank-1" : "";

    return `
      <article class="top10-item ${cardRankClass}">
        <div class="top10-header">
          <span class="rank-badge ${rankClass}">${rank}위</span>
          <span class="status-badge ${item.status || "CONGESTED"}">${escapeHtml(item.statusText || "정체")}</span>
        </div>
        <div class="top10-road" title="${escapeHtml(item.roadName)}">${escapeHtml(item.roadName || "도로명 없음")}</div>
        <div class="top10-section" title="${escapeHtml(item.startName)} → ${escapeHtml(item.endName)}">
          ${escapeHtml(item.startName || "-")} → ${escapeHtml(item.endName || "-")}
        </div>
        <div class="top10-speed-box">
          <span class="top10-speed">${formatNumber(item.speed, 1)} km/h</span>
          <span class="top10-cat">${escapeHtml(item.categoryName || "도로")}</span>
        </div>
      </article>
    `;
  }).join("");
}

// 3. 상세 도로 테이블 렌더링
function renderTable() {
  if (!trafficTable) return;

  let filtered = [...state.rawData];

  // 검색어 필터
  if (state.searchTerm) {
    const term = state.searchTerm.toLowerCase().replaceAll(" ", "");
    filtered = filtered.filter((row) => {
      const combined = `${row.roadName} ${row.sectionName} ${row.startName} ${row.endName}`.toLowerCase().replaceAll(" ", "");
      return combined.includes(term);
    });
  }

  // 정체/서행만 보기 필터
  if (state.onlyCongested) {
    filtered = filtered.filter((row) => row.status === "CONGESTED" || row.status === "SLOW");
  }

  if (filtered.length === 0) {
    trafficTable.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 30px; color: var(--text-dim);">
          조건에 부합하는 도로 소통 정보가 없습니다.
        </td>
      </tr>
    `;
    resultCountLabel.textContent = "조회 결과: 0건";
    return;
  }

  trafficTable.innerHTML = filtered.slice(0, 100).map((row) => `
    <tr>
      <td>
        <span class="status-badge ${row.status || "SMOOTH"}">
          ${escapeHtml(row.statusText || "원활")}
        </span>
      </td>
      <td><strong>${escapeHtml(row.roadName || "도로명 없음")}</strong></td>
      <td><span style="color: var(--text-dim); font-size: 12px;">${escapeHtml(row.categoryName || "일반도로")}</span></td>
      <td>${escapeHtml(row.startName || "-")} → ${escapeHtml(row.endName || "-")}</td>
      <td><strong style="color: ${row.statusColor || "#fff"};">${formatNumber(row.speed, 1)} km/h</strong></td>
      <td><code style="color: var(--text-dim); font-size: 11px;">${escapeHtml(row.linkId || "-")}</code></td>
    </tr>
  `).join("");

  resultCountLabel.textContent = `조회 결과: ${filtered.length.toLocaleString("ko-KR")}건 (최대 100건 표시)`;
}

// 4. API 에러 원인 정밀 진단 함수
function diagnoseTrafficError(response, payload, rawText = "") {
  const status = response?.status;
  const diag = payload?.diagnostics || {};
  const code = diag.code || "";
  const detail = diag.detail || payload?.error || "";

  // 1) 명확한 타임아웃 판정
  const isTimeout =
    status === 504 ||
    status === 524 ||
    code === "BUSAN_TRAFFIC_UPSTREAM_TIMEOUT" ||
    /timeout|시간 초과|timed out|abort/i.test(detail);

  if (isTimeout) {
    return {
      isTimeout: true,
      title: "⏱️ 공공데이터 API 응답 시간 초과 (Timeout)",
      message: "부산시 공공데이터포털 서버의 응답이 지연되어 시간 초과가 발생했습니다.",
      detail: detail || "12초 내에 공공데이터포털이 응답하지 못했습니다.",
      tip: "대책: Cloudflare의 TRAFFIC_CACHE KV가 바인딩되어 있는지 확인하고, 백그라운드 수집기 Worker를 먼저 1회 실행하면 지연 없이 즉시 조회됩니다."
    };
  }

  // 2) API 키 미설정 판정
  if (code === "BUSAN_TRAFFIC_API_KEY_MISSING" || !diag.hasBusanKey) {
    return {
      isTimeout: false,
      title: "🔑 API 인증키 누락",
      message: "Cloudflare 대시보드에 BUSAN_TRAFFIC_API_KEY 환경변수가 설정되지 않았습니다.",
      detail: detail,
      tip: "Cloudflare Pages > Settings > Environment variables에 키를 추가하세요."
    };
  }

  // 3) 공공데이터포털 인증/권한 에러
  if (code === "BUSAN_TRAFFIC_API_RESULT_ERROR") {
    return {
      isTimeout: false,
      title: "🚫 공공데이터포털 인증 오류",
      message: detail || "공공데이터 서비스키 승인 상태 또는 사용기간을 확인하세요.",
      detail: `resultCode: ${diag.resultCode || "알 수 없음"}`,
      tip: "공공데이터포털(data.go.kr)에서 '부산광역시_링크소통정보' 활용신청이 승인 상태인지 확인하세요."
    };
  }

  // 4) 일반 HTTP 오류
  return {
    isTimeout: false,
    title: `⚠️ 서버 오류 (HTTP ${status || "알 수 없음"})`,
    message: detail || "교통정보 수집에 실패했습니다.",
    detail: rawText.slice(0, 200) || JSON.stringify(diag),
    tip: "잠시 후 새로고침을 시도해 주세요."
  };
}

// 5. API 호출 및 데이터 로드
async function loadTraffic(regionKey = "busan", forceRefresh = false) {
  if (state.loading) return;

  state.loading = true;
  state.regionKey = regionKey;
  setStatus(forceRefresh ? "최신 스냅샷 확인 중..." : "데이터 동기화 중...", false);
  statusMessage.textContent = forceRefresh
    ? "백그라운드 수집기가 저장한 최신 교통 스냅샷을 확인하고 있습니다..."
    : "백그라운드 수집기가 저장한 교통 스냅샷을 불러오는 중입니다...";

  const params = new URLSearchParams({ region: regionKey });
  if (forceRefresh) params.set("forceRefresh", "1");

  // 클라이언트 단에서도 최대 20초 후 자동 중단 방지 컨트롤러
  const abortCtrl = new AbortController();
  const timer = setTimeout(() => abortCtrl.abort(), 20000);

  try {
    let response;
    let payload = null;
    let rawText = "";

    try {
      response = await fetch(`/api/traffic?${params.toString()}`, {
        signal: abortCtrl.signal
      });
      rawText = await response.text();
      payload = JSON.parse(rawText);
    } catch (fetchErr) {
      const isClientTimeout = fetchErr.name === "AbortError";
      const errorDiag = {
        isTimeout: isClientTimeout,
        title: isClientTimeout ? "⏱️ 브라우저 요청 시간 초과 (Client Timeout)" : "네트워크 오류",
        message: isClientTimeout
          ? "서버 응답이 20초 이상 지연되어 연결이 중단되었습니다."
          : (fetchErr.message || "서버와 연결할 수 없습니다."),
        detail: isClientTimeout ? "Cloudflare Pages Function 응답 지연" : String(fetchErr),
        tip: "공공데이터포털 트래픽 지연 또는 Cloudflare 연결을 확인하세요."
      };
      displayError(errorDiag);
      throw new Error(errorDiag.message);
    }

    if (!response.ok || !payload || !payload.ok) {
      const errorDiag = diagnoseTrafficError(response, payload, rawText);
      displayError(errorDiag);
      console.error("[Traffic API Error Diagnosis]:", errorDiag, { response, payload });
      throw new Error(errorDiag.message);
    }

    state.rawData = Array.isArray(payload.data) ? payload.data : [];
    state.stats = payload.stats || null;
    state.top10 = Array.isArray(payload.top10) ? payload.top10 : [];

    renderStats(state.stats, payload.updatedAt);
    renderTop10(state.top10);
    renderTable();

    const cacheLabel = payload.cache === "SNAPSHOT" ? "백그라운드 스냅샷" : "스냅샷";
    const duration = payload.timing?.totalMs ? ` (${payload.timing.totalMs}ms)` : "";
    statusMessage.textContent = `${payload.source || "부산시+ITS"} 기반 실시간 분석 완료 · ${cacheLabel}${duration}`;
    setStatus("실시간 동기화 완료", true);
    if (errorDetail) errorDetail.textContent = "";
  } catch (error) {
    setStatus("연결 실패", false);
  } finally {
    clearTimeout(timer);
    state.loading = false;
  }
}

function displayError(diag) {
  statusMessage.textContent = `${diag.title}: ${diag.message}`;
  if (errorDetail) {
    errorDetail.innerHTML = `
      <strong>[원인 분석]:</strong> ${escapeHtml(diag.detail)}<br/>
      <strong>[해결 가이드]:</strong> ${escapeHtml(diag.tip)}
    `;
  }
}

// 이벤트 리스너 등록
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    loadTraffic(btn.dataset.region);
  });
});

if (refreshButton) {
  refreshButton.addEventListener("click", () => {
    loadTraffic(state.regionKey, true);
  });
}

if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    state.searchTerm = e.target.value.trim();
    renderTable();
  });
}

if (onlyCongestedCheck) {
  onlyCongestedCheck.addEventListener("change", (e) => {
    state.onlyCongested = e.target.checked;
    renderTable();
  });
}

// 최초 실행: 부산 전체 로드
loadTraffic("busan");
