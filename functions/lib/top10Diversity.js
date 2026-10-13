/**
 * Selects representative congestion links for the TOP 10 without changing source rows.
 *
 * Only CONGESTED links on the same named road are clustered. Candidate links that
 * share a node are joined into one connected cluster, and the lowest-speed
 * representative wins. Other traffic statuses remain independent so a free-flowing
 * connector cannot merge otherwise separate congestion areas.
 */
function normalizeLabel(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
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

  // For equal status and speed, prefer a section with two distinct endpoints over
  // a self-loop such as "삼락IC → 삼락IC", which is less informative to readers.
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

/**
 * Select up to `limit` top-ranked items while collapsing adjacent congested
 * links into one representative per connected component. The input array and
 * its records are not mutated.
 */
export function selectDiverseTop10(items, limit = 10) {
  if (!Array.isArray(items) || items.length === 0 || limit <= 0) return [];

  const uniqueBySection = new Map();
  items.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const key = getSectionKey(item, index);
    const existing = uniqueBySection.get(key);
    if (!existing || compareCandidates(item, existing.item) < 0) {
      uniqueBySection.set(key, { item, key });
    }
  });

  const entries = [...uniqueBySection.values()];
  const parent = entries.map((_, index) => index);
  const rank = entries.map(() => 0);

  function find(index) {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  }

  function union(a, b) {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return;

    if (rank[rootA] < rank[rootB]) [rootA, rootB] = [rootB, rootA];
    parent[rootB] = rootA;
    if (rank[rootA] === rank[rootB]) rank[rootA] += 1;
  }

  const firstByRoadNode = new Map();
  entries.forEach(({ item }, index) => {
    if (item.status !== "CONGESTED") return;
    const road = normalizeLabel(item.roadName);
    if (!road) return;

    const nodes = new Set([
      normalizeLabel(item.startName),
      normalizeLabel(item.endName)
    ].filter(Boolean));

    for (const node of nodes) {
      const nodeKey = `${road}|${node}`;
      const previous = firstByRoadNode.get(nodeKey);
      if (previous === undefined) {
        firstByRoadNode.set(nodeKey, index);
      } else {
        union(index, previous);
      }
    }
  });

  const sorted = entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => compareCandidates(a.item, b.item));

  const selected = [];
  const selectedClusters = new Set();
  for (const entry of sorted) {
    const item = entry.item;
    const cluster = item.status === "CONGESTED"
      ? find(entry.index)
      : `independent|${entry.index}`;

    if (selectedClusters.has(cluster)) continue;
    selectedClusters.add(cluster);
    selected.push(item);
    if (selected.length >= limit) break;
  }

  return selected.map((item, index) => ({ ...item, rank: index + 1 }));
}
