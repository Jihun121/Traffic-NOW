/**
 * Select diverse TOP 10 entries without changing source rows or speeds.
 *
 * Congested candidates on the same named road that directly share an endpoint
 * with an already-selected congested candidate are suppressed. This reduces
 * adjacent-link duplicates without collapsing an entire connected road network
 * into one result. A lower-ranked link can still represent a distinct bottleneck
 * farther along the same road.
 */
function normalizeLabel(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (["-", "n/a", "na", "unknown", "정보없음", "도로명없음"].includes(normalized)) return "";
  return normalized;
}

function compareCandidates(a, b) {
  const aStatus = a?.status === "CONGESTED" ? 0 : 1;
  const bStatus = b?.status === "CONGESTED" ? 0 : 1;
  if (aStatus !== bStatus) return aStatus - bStatus;

  const aSpeed = Number(a?.speed);
  const bSpeed = Number(b?.speed);
  const safeASpeed = Number.isFinite(aSpeed) ? aSpeed : Number.POSITIVE_INFINITY;
  const safeBSpeed = Number.isFinite(bSpeed) ? bSpeed : Number.POSITIVE_INFINITY;
  if (safeASpeed !== safeBSpeed) return safeASpeed - safeBSpeed;

  // For equal status and speed, prefer an informative section over
  // a self-loop such as "삼락IC → 삼락IC".
  const aStart = normalizeLabel(a?.startName);
  const aEnd = normalizeLabel(a?.endName);
  const bStart = normalizeLabel(b?.startName);
  const bEnd = normalizeLabel(b?.endName);
  const aIsSelfLoop = Boolean(aStart && aStart === aEnd);
  const bIsSelfLoop = Boolean(bStart && bStart === bEnd);
  if (aIsSelfLoop !== bIsSelfLoop) return aIsSelfLoop ? 1 : -1;

  return 0;
}

function getSectionKey(item, index) {
  const road = normalizeLabel(item?.roadName);
  const start = normalizeLabel(item?.startName);
  const end = normalizeLabel(item?.endName);

  if (road && (start || end)) return `${road}|${start}|${end}`;
  if (item?.linkId !== undefined && item?.linkId !== null && String(item.linkId).trim()) {
    return `link|${String(item.linkId).trim()}`;
  }
  return `anonymous|${index}`;
}

function getNamedNodes(item) {
  return new Set([
    normalizeLabel(item?.startName),
    normalizeLabel(item?.endName)
  ].filter(Boolean));
}

function isDirectlyAdjacentCongestion(candidate, selected) {
  if (candidate?.status !== "CONGESTED") return false;

  const road = normalizeLabel(candidate?.roadName);
  if (!road) return false;

  const candidateNodes = getNamedNodes(candidate);
  if (candidateNodes.size === 0) return false;

  return selected.some((chosen) => {
    if (chosen?.status !== "CONGESTED" || normalizeLabel(chosen?.roadName) !== road) {
      return false;
    }

    const chosenNodes = getNamedNodes(chosen);
    for (const node of candidateNodes) {
      if (chosenNodes.has(node)) return true;
    }
    return false;
  });
}

/**
 * Select up to `limit` ranked items. Only directly adjacent congested links on
 * the same road compete for one slot; disconnected congestion remains visible.
 * Neither the input array nor its records are mutated.
 */
export function selectDiverseTop10(items, limit = 10) {
  if (!Array.isArray(items) || items.length === 0 || !Number.isFinite(Number(limit)) || limit <= 0) {
    return [];
  }

  const uniqueBySection = new Map();
  items.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const key = getSectionKey(item, index);
    const existing = uniqueBySection.get(key);
    if (!existing || compareCandidates(item, existing.item) < 0) {
      uniqueBySection.set(key, { item });
    }
  });

  const ranked = [...uniqueBySection.values()]
    .map(({ item }) => item)
    .sort(compareCandidates);

  const selected = [];
  for (const item of ranked) {
    if (isDirectlyAdjacentCongestion(item, selected)) continue;

    selected.push(item);
    if (selected.length >= Math.floor(Number(limit))) break;
  }

  return selected.map((item, index) => ({ ...item, rank: index + 1 }));
}
