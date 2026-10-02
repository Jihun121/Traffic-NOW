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
