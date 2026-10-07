const REGIONS = {
  busan: {
    name: "부산 전체",
    mode: "all",
    keywords: []
  },
  "busan-north-gu": {
    name: "북구",
    mode: "keyword",
    keywords: ["북구", "구포", "덕천", "만덕", "화명", "금곡"]
  },
  "busan-haeundae": {
    name: "해운대·수영",
    mode: "keyword",
    keywords: ["해운대", "센텀", "마린시티", "수영", "광안", "송정", "좌동", "우동"]
  },
  "busan-jin": {
    name: "부산진·서면",
    mode: "keyword",
    keywords: ["부산진", "서면", "범천", "가야", "부암", "양정", "전포", "당감"]
  },
  "busan-expressway": {
    name: "도시고속·대교",
    mode: "keyword",
    keywords: ["번영로", "동서고가", "동서로", "광안대교", "부산항대교", "남항대교", "을숙도대교", "산성터널", "만덕터널", "백양터널"]
  },
  "busan-dongrae-yeonje": {
    name: "동래·연제",
    mode: "keyword",
    keywords: ["동래", "연제", "온천", "사직", "거제", "연산", "명륜", "안락", "수안", "낙민"]
  },
  "busan-nam": {
    name: "남구",
    mode: "keyword",
    keywords: ["남구", "대연", "용호", "문현", "감만", "우암", "석포"]
  },
  "busan-donggu": {
    name: "동구",
    mode: "keyword",
    keywords: ["동구", "초량", "수정", "좌천", "범일"]
  },
  "busan-saha-gangseo": {
    name: "사하·강서",
    mode: "keyword",
    keywords: ["사하", "하단", "당리", "괴정", "장림", "다대", "신평", "강서", "명지", "대저", "가덕", "녹산", "신호"]
  },
  "busan-sasang": {
    name: "사상",
    mode: "keyword",
    keywords: ["사상", "괘법", "주례", "감전", "학장", "엄궁", "모라", "덕포"]
  },
  "busan-geumjeong": {
    name: "금정",
    mode: "keyword",
    keywords: ["금정", "구서", "장전", "부곡", "서동", "남산", "두구", "노포", "범어사"]
  },
  "busan-jung-seo-yeongdo": {
    name: "중구·서구·영도",
    mode: "keyword",
    keywords: ["중구", "서구", "영도", "남포", "광복", "부평", "동대신", "서대신", "암남", "대신", "청학", "동삼", "봉래"]
  }
};

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll(" ", "");
}

function createSearchText(row) {
  return normalizeText([
    row.roadName,
    row.sectionName,
    row.startName,
    row.endName
  ].join(" "));
}

export function getTrafficRegion(regionKey) {
  return REGIONS[regionKey] || REGIONS.busan;
}

export function getSupportedRegions() {
  return Object.entries(REGIONS).map(([key, item]) => ({
    key,
    name: item.name
  }));
}

export function filterTrafficRegion(rows, regionKey) {
  const region = getTrafficRegion(regionKey);

  if (region.mode === "all") {
    return rows;
  }

  return rows.filter((row) => {
    const haystack = createSearchText(row);
    return region.keywords.some((keyword) => haystack.includes(normalizeText(keyword)));
  });
}
