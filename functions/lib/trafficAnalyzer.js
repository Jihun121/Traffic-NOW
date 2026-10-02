/**
 * 교통 분석 엔진 (Traffic Analyzer)
 * 두 번째 이미지의 파이프라인을 구현:
 * 도로 평균속도 -> 도로별 속도 기준 -> 원활/서행/정체 판정 -> 부산 전체 통계 -> 정체 TOP 10
 */

// 1. 도로별 속도 판정 기준 (도로 위계별 차등 임계값)
const SPEED_CRITERIA = {
  EXPRESSWAY: {
    categoryName: "도시고속/자동차전용도로",
    smooth: 50, // 50km/h 이상: 원활
    slow: 30    // 30~49km/h: 서행, 30km/h 미만: 정체
  },
  MAJOR_ARTERIAL: {
    categoryName: "주요 간선대로",
    smooth: 35, // 35km/h 이상: 원활
    slow: 20    // 20~34km/h: 서행, 20km/h 미만: 정체
  },
  URBAN_ROAD: {
    categoryName: "일반 시내도로",
    smooth: 25, // 25km/h 이상: 원활
    slow: 15    // 15~24km/h: 서행, 15km/h 미만: 정체
  }
};

// 고속화/대교 키워드
const EXPRESSWAY_KEYWORDS = [
  "고속", "번영로", "동서고가", "동서로", "광안대교", "남항대교",
  "부산항대교", "을숙도대교", "신호대교", "거가대로", "강변대로",
  "관문대로", "정관로", "산성터널", "만덕터널", "백양터널", "수영강변대로"
];

// 주요 간선도로 키워드
const ARTERIAL_KEYWORDS = [
  "대로", "중앙대로", "가야대로", "수영로", "낙동대로", "만덕대로",
  "백양대로", "충렬대로", "해운대로", "사상로", "구포대교", "낙동남로"
];

/**
 * 도로명을 기반으로 도로 유형(카테고리) 판별
 */
export function getRoadCategory(roadName) {
  const name = String(roadName || "").trim();
  if (!name) return "URBAN_ROAD";

  for (const kw of EXPRESSWAY_KEYWORDS) {
    if (name.includes(kw)) return "EXPRESSWAY";
  }

  for (const kw of ARTERIAL_KEYWORDS) {
    if (name.includes(kw)) return "MAJOR_ARTERIAL";
  }

  return "URBAN_ROAD";
}

/**
 * 도로 유형 및 속도에 기반하여 3단계 교통 상태(원활/서행/정체) 판정
 */
export function evaluateTrafficStatus(speed, roadCategory = "URBAN_ROAD") {
  const spd = Number(speed);
  if (!Number.isFinite(spd) || spd < 0) {
    return {
      status: "UNKNOWN",
      statusText: "정보 없음",
      color: "#94a3b8",
      categoryName: SPEED_CRITERIA[roadCategory]?.categoryName || "일반도로"
    };
  }

  const criteria = SPEED_CRITERIA[roadCategory] || SPEED_CRITERIA.URBAN_ROAD;

  if (spd >= criteria.smooth) {
    return {
      status: "SMOOTH",
      statusText: "원활",
      color: "#10b981", // 초록
      categoryName: criteria.categoryName
    };
  } else if (spd >= criteria.slow) {
    return {
      status: "SLOW",
      statusText: "서행",
      color: "#f59e0b", // 주황
      categoryName: criteria.categoryName
    };
  } else {
    return {
      status: "CONGESTED",
      statusText: "정체",
      color: "#ef4444", // 빨강
      categoryName: criteria.categoryName
    };
  }
}

/**
 * 부산 전체 통계 지표 산출
 */
export function calculateBusanTrafficStats(rows) {
  const validRows = rows.filter((r) => Number.isFinite(Number(r.speed)) && Number(r.speed) >= 0);
  const totalCount = validRows.length;

  if (totalCount === 0) {
    return {
      totalCount: 0,
      averageSpeed: 0,
      statusCounts: { smooth: 0, slow: 0, congested: 0 },
      statusRatios: { smooth: 0, slow: 0, congested: 0 },
      congestionLevel: "데이터 없음",
      slowestRoad: null
    };
  }

  let totalSpeed = 0;
  let smoothCount = 0;
  let slowCount = 0;
  let congestedCount = 0;

  for (const row of validRows) {
    const spd = Number(row.speed);
    totalSpeed += spd;
    const cat = row.category || getRoadCategory(row.roadName);
    const evalResult = evaluateTrafficStatus(spd, cat);

    if (evalResult.status === "SMOOTH") smoothCount++;
    else if (evalResult.status === "SLOW") slowCount++;
    else if (evalResult.status === "CONGESTED") congestedCount++;
  }

  const averageSpeed = Number((totalSpeed / totalCount).toFixed(1));
  const smoothRatio = Number(((smoothCount / totalCount) * 100).toFixed(1));
  const slowRatio = Number(((slowCount / totalCount) * 100).toFixed(1));
  const congestedRatio = Number(((congestedCount / totalCount) * 100).toFixed(1));

  // 종합 혼잡도 레벨 판정
  let congestionLevel = "원활";
  if (congestedRatio >= 25) {
    congestionLevel = "매우 혼잡";
  } else if (congestedRatio >= 15) {
    congestionLevel = "혼잡";
  } else if (congestedRatio >= 8 || slowRatio >= 30) {
    congestionLevel = "다소 혼잡";
  }

  // 가장 속도가 낮은 도로 선별
  const sorted = [...validRows].sort((a, b) => Number(a.speed) - Number(b.speed));
  const slowestRoad = sorted[0] ? {
    roadName: sorted[0].roadName || "무명도로",
    section: `${sorted[0].startName || ""} → ${sorted[0].endName || ""}`.trim(),
    speed: Number(sorted[0].speed)
  } : null;

  return {
    totalCount,
    averageSpeed,
    statusCounts: {
      smooth: smoothCount,
      slow: slowCount,
      congested: congestedCount
    },
    statusRatios: {
      smooth: smoothRatio,
      slow: slowRatio,
      congested: congestedRatio
    },
    congestionLevel,
    slowestRoad
  };
}

/**
 * 정체 TOP 10 랭킹 산출
 * - 정체 상태 및 속도가 가장 낮은 순서로 상위 10개 구간 추출
 */
export function getCongestionTop10(rows) {
  const validRows = rows.filter((r) => Number.isFinite(Number(r.speed)) && Number(r.speed) >= 0);

  // 각 행에 분석 정보 태깅
  const enriched = validRows.map((r) => {
    const category = r.category || getRoadCategory(r.roadName);
    const evaluation = evaluateTrafficStatus(r.speed, category);
    return {
      ...r,
      category,
      categoryName: evaluation.categoryName,
      status: evaluation.status,
      statusText: evaluation.statusText,
      statusColor: evaluation.color
    };
  });

  // 정렬 기준:
  // 1. 상태: CONGESTED(정체) 우선
  // 2. 속도 낮은 순 오름차순
  enriched.sort((a, b) => {
    if (a.status === "CONGESTED" && b.status !== "CONGESTED") return -1;
    if (a.status !== "CONGESTED" && b.status === "CONGESTED") return 1;
    return Number(a.speed) - Number(b.speed);
  });

  // 상위 10개 선택 (중복 구간 완화 고려)
  const top10 = [];
  const seenRoadSections = new Set();

  for (const item of enriched) {
    if (top10.length >= 10) break;

    const signature = `${item.roadName}-${item.startName}-${item.endName}`;
    if (seenRoadSections.has(signature)) continue;
    seenRoadSections.add(signature);

    top10.push({
      rank: top10.length + 1,
      linkId: item.linkId,
      roadName: item.roadName || "도로명 없음",
      sectionName: item.sectionName || "",
      startName: item.startName || "-",
      endName: item.endName || "-",
      speed: Number(item.speed),
      category: item.category,
      categoryName: item.categoryName,
      status: item.status,
      statusText: item.statusText,
      statusColor: item.statusColor,
      updatedAt: item.updatedAt || ""
    });
  }

  return top10;
}

/**
 * 전체 로우에 분석 메타데이터를 보강하는 헬퍼
 */
export function enrichRowsWithTrafficAnalysis(rows) {
  return rows.map((r) => {
    const category = r.category || getRoadCategory(r.roadName);
    const evaluation = evaluateTrafficStatus(r.speed, category);
    return {
      ...r,
      category,
      categoryName: evaluation.categoryName,
      status: evaluation.status,
      statusText: evaluation.statusText,
      statusColor: evaluation.color
    };
  });
}
