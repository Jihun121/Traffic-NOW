const REGIONS = {
  busan: {
    name: "부산",
    minX: 128.90,
    maxX: 129.30,
    minY: 35.02,
    maxY: 35.30
  },
  seoul: {
    name: "서울",
    minX: 126.73,
    maxX: 127.20,
    minY: 37.40,
    maxY: 37.72
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

function setStatus(text, active = false) {
  statusText.textContent = text;
  statusDot.style.background = active ? "#1c9b62" : "#a7b0c2";
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

function renderSummary(region, rows) {
  regionName.textContent = region.name;
  linkCount.textContent = formatNumber(rows.length);

  const speeds = rows
    .map(row => Number(row.speed))
    .filter(Number.isFinite)
    .filter(speed => speed >= 0);

  const average = speeds.length
    ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length
    : NaN;

  avgSpeed.textContent = Number.isFinite(average)
    ? `${average.toFixed(1)} km/h`
    : "-";

  const dates = rows
    .map(row => row.createdDate)
    .filter(Boolean)
    .sort();

  updatedAt.textContent = dates.length ? formatApiDate(dates[dates.length - 1]) : "-";
  resultCount.textContent = `${rows.length.toLocaleString("ko-KR")}건`;

  renderRows([...rows].sort((a, b) => Number(a.speed) - Number(b.speed)));
}

function formatApiDate(value) {
  const text = String(value);
  if (/^\\d{14}$/.test(text)) {
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
      throw new Error(payload.error || "교통정보 조회에 실패했습니다.");
    }

    state.rows = Array.isArray(payload.data) ? payload.data : [];

    renderSummary(region, state.rows);
    message.textContent = `조회 완료 · ${state.rows.length.toLocaleString("ko-KR")}개 도로 구간`;
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
