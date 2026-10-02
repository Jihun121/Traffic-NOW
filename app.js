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

// 4. API 호출 및 데이터 로드
async function loadTraffic(regionKey = "busan", forceRefresh = false) {
  if (state.loading) return;

  state.loading = true;
  state.regionKey = regionKey;
  setStatus(forceRefresh ? "최신 데이터 갱신 중..." : "데이터 동기화 중...", false);
  statusMessage.textContent = "실시간 부산 교통정보 및 ITS 데이터를 수집 및 분석 중입니다...";

  const params = new URLSearchParams({ region: regionKey });
  if (forceRefresh) params.set("forceRefresh", "1");

  try {
    const response = await fetch(`/api/traffic?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      const err = payload?.error || "교통정보 수집에 실패했습니다.";
      throw new Error(err);
    }

    state.rawData = Array.isArray(payload.data) ? payload.data : [];
    state.stats = payload.stats || null;
    state.top10 = Array.isArray(payload.top10) ? payload.top10 : [];

    renderStats(state.stats, payload.updatedAt);
    renderTop10(state.top10);
    renderTable();

    const cacheLabel = payload.cache === "SNAPSHOT" ? "초고속 스냅샷" : "실시간 온디맨드";
    const duration = payload.timing?.totalMs ? ` (${payload.timing.totalMs}ms)` : "";
    statusMessage.textContent = `${payload.source || "부산시+ITS"} 기반 실시간 분석 완료 · ${cacheLabel}${duration}`;
    setStatus("실시간 동기화 완료", true);
    if (errorDetail) errorDetail.textContent = "";
  } catch (error) {
    console.error("Traffic Load Error:", error);
    statusMessage.textContent = `오류 발생: ${error.message}`;
    setStatus("연결 실패", false);
    if (errorDetail) errorDetail.textContent = `상세 에러: ${error.message}`;
  } finally {
    state.loading = false;
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
