const FIELD_ALIASES = {
  linkId: ["linkId", "linkID", "LINK_ID", "link_id", "lkId", "링크ID", "링크아이디"],
  roadName: ["roadName", "road", "ROAD_NAME", "road_name", "roadNm", "도로명"],
  sectionName: ["sectionName", "section", "구간명"],
  startName: ["startName", "startPoint", "start", "START_NAME", "bgngNodeNm", "시점명", "구간시점명", "시점"],
  endName: ["endName", "endPoint", "end", "END_NAME", "endNodeNm", "종점명", "구간종점명", "종점"],
  speed: ["speed", "avgSpeed", "averageSpeed", "SPEED", "AVG_SPEED", "speedKmh", "spd", "통행속도", "속도"],
  volume: ["volume", "trafficVolume", "traffic", "VOLUME", "TRAFFIC_VOLUME", "vol", "교통량", "통행량"],
  updatedAt: [
    "updatedAt",
    "createdDate",
    "collectDate",
    "collectedAt",
    "observationDate",
    "obsDate",
    "datetime",
    "기준일시",
    "생성일시",
    "수집일시",
    "가공일시"
  ]
};

const ARRAY_KEYS = [
  "item",
  "items",
  "data",
  "results",
  "result",
  "rows",
  "list",
  "records",
  "content"
];

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  const normalized = String(value)
    .replaceAll(",", "")
    .replace(/km\/h/gi, "")
    .trim();

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function pick(source, aliases) {
  if (!source || typeof source !== "object") return null;

  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        return value;
      }
    }
  }

  return null;
}

function findRows(node, depth = 0) {
  if (depth > 8 || node === null || node === undefined) return null;

  if (Array.isArray(node)) {
    return node;
  }

  if (typeof node !== "object") {
    return null;
  }

  const directFields = ["linkId", "linkID", "LINK_ID", "링크ID", "speed", "속도"];
  if (directFields.some(key => Object.prototype.hasOwnProperty.call(node, key))) {
    return [node];
  }

  for (const key of ARRAY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const found = findRows(node[key], depth + 1);
      if (found) return found;
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      const found = findRows(value, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function findTotalCount(node, depth = 0) {
  if (depth > 6 || node === null || node === undefined) return null;

  if (typeof node !== "object") return null;

  for (const key of ["totalCount", "total", "totalCnt", "전체건수", "총건수"]) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const number = toFiniteNumber(node[key]);
      if (number !== null) return number;
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      const found = findTotalCount(value, depth + 1);
      if (found !== null) return found;
    }
  }

  return null;
}

export function extractTrafficItems(payload) {
  return findRows(payload) || [];
}

export function normalizeTrafficPayload(payload) {
  const rawItems = extractTrafficItems(payload);

  const rows = rawItems
    .map((item) => {
      const speed = toFiniteNumber(pick(item, FIELD_ALIASES.speed));
      const volume = toFiniteNumber(pick(item, FIELD_ALIASES.volume));

      return {
        linkId: String(pick(item, FIELD_ALIASES.linkId) ?? "").trim(),
        roadName: String(pick(item, FIELD_ALIASES.roadName) ?? "").trim(),
        sectionName: String(pick(item, FIELD_ALIASES.sectionName) ?? "").trim(),
        startName: String(pick(item, FIELD_ALIASES.startName) ?? "").trim(),
        endName: String(pick(item, FIELD_ALIASES.endName) ?? "").trim(),
        speed,
        volume,
        updatedAt: String(pick(item, FIELD_ALIASES.updatedAt) ?? "").trim()
      };
    })
    .filter((row) => row.linkId || row.roadName || row.sectionName)
    .filter((row) => Number.isFinite(row.speed))
    .filter((row) => row.speed >= 0 && row.speed <= 160);

  const reportedTotal = findTotalCount(payload);

  return {
    rows,
    totalCount: reportedTotal ?? rows.length
  };
}
