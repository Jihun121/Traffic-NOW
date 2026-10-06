const state = {
  regionKey: "busan",
  rawData: [],
  filteredData: [],
  stats: null,
  top10: [],
  loading: false,
  searchTerm: "",
  onlyCongested: false,
  history: [],
  historyLoading: false,
  selectedHistoryAt: "",
  suddenCongestion: null,
  mapFilter: "all",
  map: null,
  mapLayer: null,
  mapRows: [],
  mapTotalRows: 0,
  mapGeometry: null,
  mapGeometryMeta: null,
  mapGeometryPromise: null
};

// DOM 요소 캐싱
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const refreshButton = document.querySelector("#refreshButton");
const updatedAtLabel = document.querySelector("#updatedAtLabel");

const statAvgSpeed = document.querySelector("#statAvgSpeed");
const statTrafficIndex = document.querySelector("#statTrafficIndex");
const statTrafficIndexGrade = document.querySelector("#statTrafficIndexGrade");
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

const historySelect = document.querySelector("#historySelect");
const historyRefreshButton = document.querySelector("#historyRefreshButton");
const historyChart = document.querySelector("#historyChart");
const historyAvgSpeed = document.querySelector("#historyAvgSpeed");
const historyCongestedRatio = document.querySelector("#historyCongestedRatio");
const historyCongestionLevel = document.querySelector("#historyCongestionLevel");
const historyFetchedAt = document.querySelector("#historyFetchedAt");
const historyMessage = document.querySelector("#historyMessage");
const suddenCongestionContainer = document.querySelector("#suddenCongestionContainer");
const briefingTrendBadge = document.querySelector("#briefingTrendBadge");
const briefingHeadline = document.querySelector("#briefingHeadline");
const briefingSummary = document.querySelector("#briefingSummary");
const briefingIndexDelta = document.querySelector("#briefingIndexDelta");
const briefingSpeedDelta = document.querySelector("#briefingSpeedDelta");
const briefingCongestionDelta = document.querySelector("#briefingCongestionDelta");
const briefingSuddenCount = document.querySelector("#briefingSuddenCount");
const briefingMeta = document.querySelector("#briefingMeta");

const commuteMorningStatus = document.querySelector("#commuteMorningStatus");
const commuteMorningSpeed = document.querySelector("#commuteMorningSpeed");
const commuteMorningBaseline = document.querySelector("#commuteMorningBaseline");
const commuteMorningIndex = document.querySelector("#commuteMorningIndex");
const commuteMorningCongestion = document.querySelector("#commuteMorningCongestion");
const commuteMorningMessage = document.querySelector("#commuteMorningMessage");

const commuteEveningStatus = document.querySelector("#commuteEveningStatus");
const commuteEveningSpeed = document.querySelector("#commuteEveningSpeed");
const commuteEveningBaseline = document.querySelector("#commuteEveningBaseline");
const commuteEveningIndex = document.querySelector("#commuteEveningIndex");
const commuteEveningCongestion = document.querySelector("#commuteEveningCongestion");
const commuteEveningMessage = document.querySelector("#commuteEveningMessage");

const trafficMap = document.querySelector("#trafficMap");
const mapMessage = document.querySelector("#mapMessage");
const mapAllButton = document.querySelector("#mapAllButton");
const mapCongestedButton = document.querySelector("#mapCongestedButton");

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

  if (statTrafficIndex) {
    statTrafficIndex.textContent =
      stats.trafficIndex !== undefined ? `${formatNumber(stats.trafficIndex, 1)}` : "-";
  }

  if (statTrafficIndexGrade) {
    statTrafficIndexGrade.textContent =
      stats.trafficIndexGrade
        ? `0~100 · ${stats.trafficIndexGrade}`
        : "0~100 · 지수 산출 중";
  }

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




function formatDelta(value, unit, invert = false) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";

  const effective = invert ? -number : number;
  if (effective === 0) return "변화 없음";

  const sign = effective > 0 ? "+" : "-";
  return sign + formatNumber(Math.abs(number), 1) + unit;
}



function getMapPoint(row) {
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);

  if (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= 33 &&
    latitude <= 39.5 &&
    longitude >= 124 &&
    longitude <= 132.5
  ) {
    return { latitude, longitude };
  }

  const startLatitude = Number(row.startLatitude);
  const startLongitude = Number(row.startLongitude);
  const endLatitude = Number(row.endLatitude);
  const endLongitude = Number(row.endLongitude);

  if (
    Number.isFinite(startLatitude) &&
    Number.isFinite(startLongitude) &&
    Number.isFinite(endLatitude) &&
    Number.isFinite(endLongitude)
  ) {
    return {
      latitude: (startLatitude + endLatitude) / 2,
      longitude: (startLongitude + endLongitude) / 2
    };
  }

  return null;
}

function geometryToLatLngs(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 2) return null;

  const isMultiPart =
    Array.isArray(geometry[0]) &&
    Array.isArray(geometry[0][0]);

  if (isMultiPart) {
    return geometry
      .map(function(part) {
        if (!Array.isArray(part) || part.length < 2) return null;
        return part
          .map(function(pair) {
            if (!Array.isArray(pair) || pair.length < 2) return null;
            const longitude = Number(pair[0]);
            const latitude = Number(pair[1]);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
            return [latitude, longitude];
          })
          .filter(Boolean);
      })
      .filter(function(part) {
        return Array.isArray(part) && part.length >= 2;
      });
  }

  return geometry
    .map(function(pair) {
      if (!Array.isArray(pair) || pair.length < 2) return null;
      const longitude = Number(pair[0]);
      const latitude = Number(pair[1]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return [latitude, longitude];
    })
    .filter(Boolean);
}

async function loadTrafficMapGeometry() {
  if (state.mapGeometry) return state.mapGeometry;
  if (state.mapGeometryPromise) return state.mapGeometryPromise;

  state.mapGeometryPromise = fetch("/data/traffic-link-geometry.json", {
    cache: "force-cache"
  })
    .then(function(response) {
      if (!response.ok) {
        throw new Error("교통 도로 geometry 파일을 불러오지 못했습니다. HTTP " + response.status);
      }
      return response.json();
    })
    .then(function(payload) {
      if (!payload || typeof payload.links !== "object") {
        throw new Error("교통 도로 geometry 파일 형식이 올바르지 않습니다.");
      }

      state.mapGeometry = payload.links;
      state.mapGeometryMeta = payload;
      return state.mapGeometry;
    })
    .finally(function() {
      state.mapGeometryPromise = null;
    });

  return state.mapGeometryPromise;
}

async function loadTrafficMap(regionKey) {
  try {
    const [response, geometry] = await Promise.all([
      fetch(
        "/api/traffic-map?region=" + encodeURIComponent(regionKey || state.regionKey || "busan"),
        { cache: "no-store" }
      ),
      loadTrafficMapGeometry()
    ]);

    const payload = await response.json();

    if (!response.ok || !payload || !payload.ok) {
      throw new Error((payload && payload.error) || "HTTP " + response.status);
    }

    state.mapRows = Array.isArray(payload.data) ? payload.data : [];
    state.mapTotalRows = Number(payload.totalRows || state.mapRows.length);

    renderTrafficMap(state.mapRows);

    const matchedInSnapshot = state.mapRows.filter(function(row) {
      return Boolean(geometry[String(row.linkId || "")]);
    }).length;

    if (mapMessage && state.mapRows.length > 0) {
      const metaMatched = Number(state.mapGeometryMeta?.matchedLinkCount || 0);
      const metaTotal = Number(state.mapGeometryMeta?.trafficLinkCount || state.mapTotalRows);
      const metaUnmatched = Number(state.mapGeometryMeta?.unmatchedLinkCount || 0);

      mapMessage.textContent =
        "실제 도로 선형 " +
        matchedInSnapshot.toLocaleString("ko-KR") +
        "개 표시 · 전체 " +
        state.mapTotalRows.toLocaleString("ko-KR") +
        "개 링크 · geometry 매칭 " +
        metaMatched.toLocaleString("ko-KR") +
        "/" +
        metaTotal.toLocaleString("ko-KR") +
        (metaUnmatched > 0 ? " · " + metaUnmatched.toLocaleString("ko-KR") + "개 미매칭" : "");
    }
  } catch (error) {
    if (mapMessage) {
      mapMessage.textContent =
        "실제 도로 geometry 지도를 불러오지 못했습니다: " +
        (error && error.message ? error.message : error);
    }
  }
}

function getMapStatusColor(status) {
  if (status === "CONGESTED") return "#ef4444";
  if (status === "SLOW") return "#f59e0b";
  if (status === "SMOOTH") return "#10b981";
  return "#94a3b8";
}

function ensureTrafficMap() {
  if (!trafficMap || !window.L) return false;

  if (!state.map) {
    state.map = window.L.map(trafficMap, {
      zoomControl: true,
      preferCanvas: true
    }).setView([35.1796, 129.0756], 11);

    window.L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
      }
    ).addTo(state.map);

    state.mapLayer = window.L.layerGroup().addTo(state.map);

    setTimeout(function() {
      state.map.invalidateSize();
    }, 0);
  }

  return true;
}

function renderTrafficMap(rows) {
  if (!trafficMap) return;

  if (!ensureTrafficMap()) {
    if (mapMessage) mapMessage.textContent = "지도 라이브러리를 불러오지 못했습니다.";
    return;
  }

  state.mapLayer.clearLayers();

  const candidates = Array.isArray(rows) ? rows : [];
  const filtered = state.mapFilter === "congested"
    ? candidates.filter(function(row) {
        return row.status === "CONGESTED" || row.status === "SLOW";
      })
    : candidates;

  const plottedPoints = [];
  let plottedLines = 0;
  let geometryMatched = 0;

  filtered.forEach(function(row) {
    const color = getMapStatusColor(row.status);
    const linkId = String(row.linkId || "");
    const geometry = state.mapGeometry?.[linkId];
    const latLngs = geometryToLatLngs(geometry);

    const popup =
      '<strong>' + escapeHtml(row.roadName || "도로명 없음") + '</strong><br>' +
      escapeHtml(row.startName || "-") + ' → ' + escapeHtml(row.endName || "-") + '<br>' +
      '<strong>' + formatNumber(row.speed, 1) + ' km/h</strong> · ' +
      escapeHtml(row.statusText || "정보 없음");

    if (latLngs && latLngs.length >= 2) {
      const line = window.L.polyline(
        latLngs,
        {
          color,
          weight: row.status === "CONGESTED" ? 5 : row.status === "SLOW" ? 4 : 3,
          opacity: 0.78,
          interactive: true
        }
      );

      line.bindPopup(popup);
      line.addTo(state.mapLayer);

      const first = latLngs[0];
      const last = latLngs[latLngs.length - 1];

      if (Array.isArray(first) && first.length >= 2) {
        plottedPoints.push({ latitude: first[0], longitude: first[1] });
      }
      if (Array.isArray(last) && last.length >= 2) {
        plottedPoints.push({ latitude: last[0], longitude: last[1] });
      }

      geometryMatched++;
      plottedLines++;
      return;
    }

    const point = getMapPoint(row);
    if (!point) return;

    const marker = window.L.circleMarker(
      [point.latitude, point.longitude],
      {
        radius: row.status === "CONGESTED" ? 8 : 6,
        color,
        weight: 1.5,
        fillColor: color,
        fillOpacity: 0.75
      }
    );

    marker.bindPopup(popup);
    marker.addTo(state.mapLayer);
    plottedPoints.push(point);
  });

  if (plottedPoints.length > 0) {
    const bounds = window.L.latLngBounds(
      plottedPoints.map(function(point) {
        return [point.latitude, point.longitude];
      })
    );

    state.map.fitBounds(bounds.pad(0.06), {
      maxZoom: 13
    });
  } else {
    state.map.setView([35.1796, 129.0756], 11);
  }

  if (mapMessage) {
    const overallMatched = Number(state.mapGeometryMeta?.matchedLinkCount || 0);
    const overallTotal = Number(state.mapGeometryMeta?.trafficLinkCount || state.mapTotalRows || candidates.length);
    const overallUnmatched = Number(state.mapGeometryMeta?.unmatchedLinkCount || Math.max(0, overallTotal - overallMatched));

    if (plottedLines === 0) {
      mapMessage.textContent =
        "표준노드링크 geometry와 매칭된 도로가 없어 현재 지도를 표시할 수 없습니다.";
    } else {
      const filterLabel = state.mapFilter === "congested" ? "정체·서행" : "전체";
      mapMessage.textContent =
        filterLabel + " 도로 선형 " +
        plottedLines.toLocaleString("ko-KR") +
        "개 표시 · 전체 링크 " +
        Number(state.mapTotalRows || candidates.length).toLocaleString("ko-KR") +
        "개 · geometry 매칭 " +
        overallMatched.toLocaleString("ko-KR") +
        "/" +
        overallTotal.toLocaleString("ko-KR") +
        " (미매칭 " +
        overallUnmatched.toLocaleString("ko-KR") +
        "개)";
    }
  }
}

function formatCommuteDelta(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (number === 0) return "변화 없음";
  return (number > 0 ? "+" : "-") + formatNumber(Math.abs(number), 1) + unit;
}

function renderCommutePeriod(period, prefix) {
  const statusEl = document.querySelector("#commute" + prefix + "Status");
  const speedEl = document.querySelector("#commute" + prefix + "Speed");
  const baselineEl = document.querySelector("#commute" + prefix + "Baseline");
  const indexEl = document.querySelector("#commute" + prefix + "Index");
  const congestionEl = document.querySelector("#commute" + prefix + "Congestion");
  const messageEl = document.querySelector("#commute" + prefix + "Message");

  if (!period) return;

  if (statusEl) {
    statusEl.textContent = period.status || (period.available ? "비교 완료" : "데이터 부족");
    statusEl.className = "commute-status " + (
      period.status === "악화"
        ? "commute-worsening"
        : period.status === "개선"
          ? "commute-improving"
          : ""
    );
  }

  const latest = period.latest || {};
  const baseline = period.baseline || {};
  const delta = period.delta || {};

  if (speedEl) {
    speedEl.textContent = Number.isFinite(Number(latest.averageSpeed))
      ? formatNumber(latest.averageSpeed, 1) + " km/h"
      : "-";
  }

  if (baselineEl) {
    baselineEl.textContent = Number.isFinite(Number(baseline.averageSpeed))
      ? formatNumber(baseline.averageSpeed, 1) + " km/h" +
        (delta.averageSpeed !== null && delta.averageSpeed !== undefined
          ? " (" + formatCommuteDelta(delta.averageSpeed, " km/h") + ")"
          : "")
      : "-";
  }

  if (indexEl) {
    indexEl.textContent = Number.isFinite(Number(latest.trafficIndex))
      ? formatNumber(latest.trafficIndex, 1)
      : "-";
  }

  if (congestionEl) {
    congestionEl.textContent = Number.isFinite(Number(latest.congestedRatio))
      ? formatNumber(latest.congestedRatio, 1) + "%"
      : "-";
  }

  if (messageEl) {
    if (period.available) {
      messageEl.textContent =
        (period.label || "해당 시간대") +
        ": 과거 동일 시간대 " +
        Number(baseline.sampleCount || 0) +
        "개 샘플의 중앙값과 비교";
    } else {
      const sampleCount = Number(baseline.sampleCount || 0);
      const required = Number(baseline.requiredSamples || 3);
      messageEl.textContent =
        period.message ||
        ("동일 시간대 과거 데이터 " + sampleCount + "/" + required + "개. 데이터가 쌓이면 비교가 활성화됩니다.");
    }
  }
}

async function loadCommuteComparison() {
  try {
    const response = await fetch("/api/traffic-commute", { cache: "no-store" });
    const payload = await response.json();

    if (!response.ok || !payload || !payload.ok) {
      throw new Error((payload && payload.error) || "HTTP " + response.status);
    }

    renderCommutePeriod(payload.periods?.morning, "Morning");
    renderCommutePeriod(payload.periods?.evening, "Evening");
  } catch (error) {
    const message = "출퇴근 비교 데이터를 불러오지 못했습니다: " +
      (error && error.message ? error.message : error);

    [commuteMorningMessage, commuteEveningMessage].forEach(function(el) {
      if (el) el.textContent = message;
    });
  }
}

function renderTrafficBriefing(briefing) {
  if (!briefing) {
    if (briefingHeadline) briefingHeadline.textContent = "아직 비교할 과거 교통 사이클이 없습니다.";
    if (briefingSummary) briefingSummary.textContent = "첫 번째 완성 스냅샷이 저장되면 이후 사이클부터 자동 브리핑이 생성됩니다.";
    if (briefingTrendBadge) briefingTrendBadge.textContent = "FIRST SNAPSHOT";
    if (briefingIndexDelta) briefingIndexDelta.textContent = "-";
    if (briefingSpeedDelta) briefingSpeedDelta.textContent = "-";
    if (briefingCongestionDelta) briefingCongestionDelta.textContent = "-";
    if (briefingSuddenCount) briefingSuddenCount.textContent = "-";
    return;
  }

  const metrics = briefing.metrics || {};
  const trend = briefing.trend || "유지";

  if (briefingHeadline) briefingHeadline.textContent = briefing.headline || "부산 교통 브리핑";
  if (briefingSummary) briefingSummary.textContent = briefing.summary || "-";

  if (briefingTrendBadge) {
    briefingTrendBadge.textContent = trend === "악화"
      ? "WORSENING"
      : trend === "개선"
        ? "IMPROVING"
        : "STABLE";

    briefingTrendBadge.classList.toggle("briefing-worsening", trend === "악화");
    briefingTrendBadge.classList.toggle("briefing-improving", trend === "개선");
  }

  if (briefingIndexDelta) {
    briefingIndexDelta.textContent = formatDelta(metrics.trafficIndexDelta, "점");
  }

  if (briefingSpeedDelta) {
    briefingSpeedDelta.textContent = formatDelta(metrics.averageSpeedDelta, " km/h");
  }

  if (briefingCongestionDelta) {
    briefingCongestionDelta.textContent = formatDelta(metrics.congestedRatioDelta, "%p");
  }

  if (briefingSuddenCount) {
    briefingSuddenCount.textContent = Number.isFinite(Number(metrics.suddenCongestionCount))
      ? Number(metrics.suddenCongestionCount).toLocaleString("ko-KR") + "개"
      : "-";
  }

  if (briefingMeta) {
    briefingMeta.textContent =
      "분석 기준: 직전 완성 교통 수집 사이클 · 생성 시각: " +
      formatHistoryDate(briefing.generatedAt);
  }
}

function renderSuddenCongestion(sudden) {
  if (!suddenCongestionContainer) return;

  const items = Array.isArray(sudden && sudden.items) ? sudden.items : [];
  const detectedCount = Number(sudden && sudden.detectedCount || 0);

  if (items.length === 0) {
    const message = detectedCount > 0
      ? "급격한 속도 저하가 감지되었지만 표시할 구간을 계산하지 못했습니다."
      : (Number(sudden && sudden.minimumSamples || 0) > 0
        ? "동일 시간대 기준 데이터가 아직 충분하지 않습니다. 같은 시간대의 전체 수집 이력이 더 쌓이면 급격한 정체 감지가 활성화됩니다."
        : "현재 평소 대비 급격한 속도 저하가 감지되지 않았습니다.");

    suddenCongestionContainer.innerHTML =
      '<div class="loading-placeholder">' + escapeHtml(message) + '</div>';
    return;
  }

  suddenCongestionContainer.innerHTML = items.map(function(item, index) {
    return (
      '<article class="sudden-item">' +
        '<div class="sudden-rank">' + (index + 1) + '</div>' +
        '<div class="sudden-main">' +
          '<strong class="sudden-road">' + escapeHtml(item.roadName || "도로명 없음") + '</strong>' +
          '<span class="sudden-section">' +
            escapeHtml(item.startName || "-") + ' → ' + escapeHtml(item.endName || "-") +
          '</span>' +
        '</div>' +
        '<div class="sudden-current">' +
          '<span>현재</span>' +
          '<strong>' + formatNumber(item.currentSpeed, 1) + ' km/h</strong>' +
        '</div>' +
        '<div class="sudden-baseline">' +
          '<span>평소 기준</span>' +
          '<strong>' + formatNumber(item.baselineSpeed, 1) + ' km/h</strong>' +
        '</div>' +
        '<div class="sudden-drop">' +
          '<strong>-' + formatNumber(item.dropKmh, 1) + ' km/h</strong>' +
          '<span>-' + formatNumber(item.dropRatio, 1) + '%</span>' +
        '</div>' +
      '</article>'
    );
  }).join("");
}

function formatHistoryDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderHistorySummary(item) {
  if (!item) {
    historyAvgSpeed.textContent = "-";
    historyCongestedRatio.textContent = "-";
    historyCongestionLevel.textContent = "-";
    historyFetchedAt.textContent = "-";
    return;
  }

  historyAvgSpeed.textContent = formatNumber(item.averageSpeed, 1) + " km/h";
  historyCongestedRatio.textContent = formatNumber(item.congestedRatio, 1) + "%";
  historyCongestionLevel.textContent = item.congestionLevel || "-";
  historyFetchedAt.textContent = formatHistoryDate(item.fetchedAt);
}

function renderHistoryChart(history) {
  if (!historyChart) return;

  if (!Array.isArray(history) || history.length < 1) {
    historyChart.innerHTML =
      '<div class="loading-placeholder">' +
      '아직 완성된 교통 시계열 데이터가 없습니다. 전체 수집 사이클이 완료되면 자동으로 표시됩니다.' +
      '</div>';
    renderHistorySummary(null);
    return;
  }

  const width = 900;
  const height = 300;
  const pad = { top: 24, right: 54, bottom: 42, left: 54 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const speedValues = history.map(function(item) { return Number(item.averageSpeed) || 0; });
  const minSpeedRaw = Math.min.apply(null, speedValues);
  const maxSpeedRaw = Math.max.apply(null, speedValues);
  const minSpeed = Math.max(0, Math.floor((minSpeedRaw - 5) / 5) * 5);
  const maxSpeed = Math.max(minSpeed + 10, Math.ceil((maxSpeedRaw + 5) / 5) * 5);

  function x(index) {
    return pad.left + (history.length === 1
      ? plotW / 2
      : (index / (history.length - 1)) * plotW);
  }

  function ySpeed(value) {
    return pad.top + (1 - ((value - minSpeed) / (maxSpeed - minSpeed))) * plotH;
  }

  function yCongestion(value) {
    return pad.top + (1 - Math.min(100, Math.max(0, value)) / 100) * plotH;
  }

  const speedPoints = history.map(function(item, index) {
    return x(index).toFixed(1) + "," + ySpeed(Number(item.averageSpeed) || 0).toFixed(1);
  }).join(" ");

  const congestionPoints = history.map(function(item, index) {
    return x(index).toFixed(1) + "," + yCongestion(Number(item.congestedRatio) || 0).toFixed(1);
  }).join(" ");

  const gridValues = [0, 25, 50, 75, 100];
  const grid = gridValues.map(function(value) {
    const y = yCongestion(value).toFixed(1);
    return (
      '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" class="history-grid-line" />' +
      '<text x="' + (pad.left - 10) + '" y="' + (Number(y) + 4) + '" text-anchor="end" class="history-axis-label">' + value + '%</text>'
    );
  }).join("");

  const xLabels = history.map(function(item, index) {
    if (
      history.length > 12 &&
      index % Math.ceil(history.length / 6) !== 0 &&
      index !== history.length - 1
    ) {
      return "";
    }
    return (
      '<text x="' + x(index) + '" y="' + (height - 14) +
      '" text-anchor="middle" class="history-axis-label">' +
      escapeHtml(formatHistoryDate(item.fetchedAt)) +
      '</text>'
    );
  }).join("");

  const selectedIndex = history.findIndex(function(item) {
    return item.fetchedAt === state.selectedHistoryAt;
  });

  const fallbackIndex = history.length - 1;
  const selected = selectedIndex >= 0 ? history[selectedIndex] : history[fallbackIndex];

  historyChart.innerHTML =
    '<svg class="history-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="부산 교통 평균속도와 정체율 시계열">' +
      grid +
      '<line x1="' + pad.left + '" y1="' + (pad.top + plotH) + '" x2="' + (width - pad.right) + '" y2="' + (pad.top + plotH) + '" class="history-axis-line" />' +
      '<polyline points="' + speedPoints + '" class="history-speed-line" fill="none" />' +
      '<polyline points="' + congestionPoints + '" class="history-congestion-line" fill="none" />' +
      history.map(function(item, index) {
        return (
          '<circle cx="' + x(index) + '"' +
          ' cy="' + ySpeed(Number(item.averageSpeed) || 0) + '"' +
          ' r="' + (index === selectedIndex ? 5 : 3) + '"' +
          ' class="history-speed-point' + (index === selectedIndex ? " selected" : "") + '"' +
          ' data-history-index="' + index + '" />'
        );
      }).join("") +
      xLabels +
      '<text x="' + pad.left + '" y="15" class="history-chart-title">평균속도 km/h</text>' +
      '<text x="' + (width - pad.right) + '" y="15" text-anchor="end" class="history-chart-title">정체율 %</text>' +
    '</svg>' +
    '<div class="history-legend">' +
      '<span><i class="history-legend-speed"></i> 평균속도</span>' +
      '<span><i class="history-legend-congestion"></i> 정체율</span>' +
    '</div>';

  renderHistorySummary(selected);

  historyChart.querySelectorAll("[data-history-index]").forEach(function(point) {
    point.addEventListener("click", function() {
      const index = Number(point.dataset.historyIndex);
      const item = state.history[index];
      if (!item) return;
      state.selectedHistoryAt = item.fetchedAt || "";
      if (historySelect) historySelect.value = state.selectedHistoryAt;
      renderHistoryChart(state.history);
    });
  });
}

function renderHistorySelect(history) {
  if (!historySelect) return;

  if (!Array.isArray(history) || history.length === 0) {
    historySelect.innerHTML = '<option value="">아직 시계열 데이터 없음</option>';
    return;
  }

  historySelect.innerHTML = history.map(function(item) {
    return (
      '<option value="' + escapeHtml(item.fetchedAt || "") + '">' +
      escapeHtml(formatHistoryDate(item.fetchedAt)) +
      ' · ' + formatNumber(item.averageSpeed, 1) + ' km/h' +
      ' · 정체 ' + formatNumber(item.congestedRatio, 1) + '%' +
      '</option>'
    );
  }).join("");

  if (
    !state.selectedHistoryAt ||
    !history.some(function(item) { return item.fetchedAt === state.selectedHistoryAt; })
  ) {
    state.selectedHistoryAt = history[history.length - 1].fetchedAt || "";
  }

  historySelect.value = state.selectedHistoryAt;
}

async function loadTrafficHistory() {
  if (state.historyLoading) return;

  state.historyLoading = true;
  if (historyMessage) historyMessage.textContent = "완성된 교통 수집 이력을 불러오는 중입니다...";
  if (historyRefreshButton) historyRefreshButton.disabled = true;

  try {
    const response = await fetch("/api/traffic-history?limit=96", { cache: "no-store" });
    const payload = await response.json();

    if (!response.ok || !payload || !payload.ok) {
      throw new Error((payload && payload.error) || "HTTP " + response.status);
    }

    state.history = Array.isArray(payload.history) ? payload.history.slice().reverse() : [];
    renderHistorySelect(state.history);
    renderHistoryChart(state.history);

    const count = state.history.length;
    if (historyMessage) {
      historyMessage.textContent = count > 0
        ? "총 " + count + "개의 완성된 교통 스냅샷을 보관 중입니다. 각 시점은 부산 전체 수집 사이클 기준입니다."
        : "아직 완성된 시계열 스냅샷이 없습니다. 수집 사이클 완료 후 자동으로 표시됩니다.";
    }
  } catch (error) {
    state.history = [];
    renderHistorySelect([]);
    renderHistoryChart([]);
    if (historyMessage) {
      historyMessage.textContent = "시계열 데이터를 불러오지 못했습니다: " + (error && error.message ? error.message : error);
    }
  } finally {
    state.historyLoading = false;
    if (historyRefreshButton) historyRefreshButton.disabled = false;
  }
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

  // 2) KV 스냅샷 준비 상태 판정
  if (code === "TRAFFIC_SNAPSHOT_NOT_READY") {
    return {
      isTimeout: false,
      title: "⏳ 최신 교통 스냅샷 준비 중",
      message: "백그라운드 수집기가 아직 최신 부산 교통정보를 KV에 저장하지 못했습니다.",
      detail: detail || "traffic:busan:latest 스냅샷이 존재하지 않습니다.",
      tip: "traffic-now-worker의 다음 Cron 실행 결과를 확인해 주세요. 수집이 성공하면 이 화면은 자동으로 정상 데이터를 표시합니다."
    };
  }

  // 3) KV 바인딩 미설정 판정
  if (code === "TRAFFIC_CACHE_NOT_CONFIGURED") {
    return {
      isTimeout: false,
      title: "⚙️ 교통 스냅샷 저장소 연결 오류",
      message: "Cloudflare Pages에 TRAFFIC_CACHE KV 바인딩이 연결되어 있지 않습니다.",
      detail: detail,
      tip: "Cloudflare Pages > Settings > Bindings에서 TRAFFIC_CACHE가 Traffic-NOW KV에 연결되어 있는지 확인하세요."
    };
  }

  // 4) API 키 미설정 판정
  if (code === "BUSAN_TRAFFIC_API_KEY_MISSING" || diag.hasBusanKey === false) {
    return {
      isTimeout: false,
      title: "🔑 API 인증키 누락",
      message: "Cloudflare 대시보드에 BUSAN_TRAFFIC_API_KEY 환경변수가 설정되지 않았습니다.",
      detail: detail,
      tip: "Cloudflare Pages > Settings > Environment variables에 키를 추가하세요."
    };
  }

  // 5) 공공데이터포털 인증/권한 에러
  if (code === "BUSAN_TRAFFIC_API_RESULT_ERROR") {
    return {
      isTimeout: false,
      title: "🚫 공공데이터포털 인증 오류",
      message: detail || "공공데이터 서비스키 승인 상태 또는 사용기간을 확인하세요.",
      detail: `resultCode: ${diag.resultCode || "알 수 없음"}`,
      tip: "공공데이터포털(data.go.kr)에서 '부산광역시_링크소통정보' 활용신청이 승인 상태인지 확인하세요."
    };
  }

  // 6) 일반 HTTP 오류
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
    state.suddenCongestion = payload.suddenCongestion || null;

    renderStats(state.stats, payload.updatedAt);
    renderTop10(state.top10);
    renderSuddenCongestion(state.suddenCongestion);
    renderTrafficBriefing(payload.trafficBriefing || null);
    loadTrafficMap(state.regionKey);
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


if (mapAllButton) {
  mapAllButton.addEventListener("click", function() {
    state.mapFilter = "all";
    mapAllButton.classList.add("active");
    if (mapCongestedButton) mapCongestedButton.classList.remove("active");
    renderTrafficMap(state.mapRows);
  });
}

if (mapCongestedButton) {
  mapCongestedButton.addEventListener("click", function() {
    state.mapFilter = "congested";
    mapCongestedButton.classList.add("active");
    if (mapAllButton) mapAllButton.classList.remove("active");
    renderTrafficMap(state.mapRows);
  });
}

window.addEventListener("resize", function() {
  if (state.map) {
    state.map.invalidateSize();
  }
});

if (historySelect) {
  historySelect.addEventListener("change", function() {
    state.selectedHistoryAt = historySelect.value;
    renderHistoryChart(state.history);
  });
}

if (historyRefreshButton) {
  historyRefreshButton.addEventListener("click", function() {
    loadTrafficHistory();
  });
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
loadTrafficHistory();
loadCommuteComparison();
