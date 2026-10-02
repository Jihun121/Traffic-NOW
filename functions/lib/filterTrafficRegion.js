const REGIONS = {
  "busan-north-gu": {
    name: "부산 북구 테스트",
    mode: "keyword",
    keywords: [
      "북구",
      "구포",
      "덕천",
      "만덕",
      "화명",
      "금곡"
    ]
  },
  busan: {
    name: "부산 전체",
    mode: "all",
    keywords: []
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
  return REGIONS[regionKey] || REGIONS["busan-north-gu"];
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
