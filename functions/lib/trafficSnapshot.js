import { calculateBusanTrafficOverview } from "./trafficAnalyzer.js";

const LEGACY_SNAPSHOT_KEY = "traffic:busan:latest";
const COLLECTOR_STATE_KEY = "traffic:busan:collector-state";
const SNAPSHOT_ANALYSIS_KEY = "traffic:busan:latest-analysis";
const ITS_SNAPSHOT_KEY = "traffic:busan:its:latest";
const ROW_SHARD_KEY_PREFIX = "traffic:busan:rows:v4:";
const ROW_GROUP_COUNT = 10;
const PAGE_SIZE = 100;
const PAGES_PER_RUN = 3;

function getCycleRowShardKey(cycleId, groupId) {
  return ROW_SHARD_KEY_PREFIX + cycleId + ":" + groupId;
}

function rowsFromShard(shard) {
  if (!shard || !shard.pages || typeof shard.pages !== "object") return [];
  return Object.keys(shard.pages)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b)
    .flatMap((page) => Array.isArray(shard.pages[String(page)]) ? shard.pages[String(page)] : []);
}

function rowIdentity(row) {
  const prefix = row?.source === "ITS" ? "its:" : "busan:";
  if (row?.linkId) return prefix + "link:" + String(row.linkId);
  return prefix + "section:" + [
    row?.roadName || "",
    row?.sectionName || "",
    row?.startName || "",
    row?.endName || ""
  ].join("|");
}

function mergeRows(baseRows, overlayRows) {
  const byKey = new Map();
  for (const row of Array.isArray(baseRows) ? baseRows : []) {
    byKey.set(rowIdentity(row), row);
  }
  for (const row of Array.isArray(overlayRows) ? overlayRows : []) {
    byKey.set(rowIdentity(row), row);
  }
  return Array.from(byKey.values());
}

async function readCycleRows(env, cycleId) {
  if (!cycleId) return { rows: [], summaries: [] };
  const shards = await Promise.all(
    Array.from({ length: ROW_GROUP_COUNT }, (_, groupId) =>
      env.TRAFFIC_CACHE.get(getCycleRowShardKey(cycleId, groupId), "json")
    )
  );

  const rows = [];
  const summaries = [];
  for (let groupId = 0; groupId < shards.length; groupId += 1) {
    const shard = shards[groupId];
    if (!shard || shard.cycleId !== cycleId) continue;
    rows.push(...rowsFromShard(shard));
    if (shard.summary) summaries.push(shard.summary);
  }

  return { rows, summaries };
}

function buildCollectionMeta(state) {
  if (state?.inProgress) {
    return {
      mode: "incremental",
      cycleComplete: false,
      cycleStartedAt: state.cycleStartedAt || null,
      totalPages: Number(state.totalPages || 0),
      pagesPerRun: PAGES_PER_RUN,
      completedPages: Array.isArray(state.completedPages) ? state.completedPages.length : 0,
      failedPages: Array.isArray(state.failedPages) ? state.failedPages : [],
      refreshedRows: Number(state.lastBatchRows || 0),
      refreshedLinks: Number(state.refreshedLinks || 0),
      lastIncrementalUpdateAt: state.lastIncrementalUpdateAt || state.updatedAt || null
    };
  }

  return {
    mode: "complete",
    cycleComplete: Boolean(state?.activeCycleId),
    cycleStartedAt: null,
    totalPages: Number(state?.totalPages || 0),
    pagesPerRun: PAGES_PER_RUN,
    completedPages: Number(state?.totalPages || 0),
    failedPages: [],
    refreshedRows: 0,
    refreshedLinks: Number(state?.refreshedLinks || 0),
    completedAt: state?.lastCompletedAt || null
  };
}

/**
 * Reads the current traffic dataset from page-grouped KV shards.
 * While collection is in progress, the last complete dataset remains the base
 * and only the newly collected pages are overlaid on top of it.
 */
export async function loadTrafficSnapshot(env) {
  if (!env?.TRAFFIC_CACHE) return null;

  const state = await env.TRAFFIC_CACHE.get(COLLECTOR_STATE_KEY, "json");
  if (!state || Number(state.collectorVersion || 0) !== 4) {
    return env.TRAFFIC_CACHE.get(LEGACY_SNAPSHOT_KEY, "json");
  }

  const analysisPromise = env.TRAFFIC_CACHE.get(SNAPSHOT_ANALYSIS_KEY, "json");
  const itsPromise = state.activeCycleId
    ? env.TRAFFIC_CACHE.get(ITS_SNAPSHOT_KEY, "json")
    : Promise.resolve(null);

  let legacySnapshot = null;
  let baseRows = [];
  let activeSummaries = [];

  if (state.activeCycleId) {
    const active = await readCycleRows(env, String(state.activeCycleId));
    baseRows = active.rows;
    activeSummaries = active.summaries;
  }

  if (!baseRows.length) {
    legacySnapshot = await env.TRAFFIC_CACHE.get(LEGACY_SNAPSHOT_KEY, "json");
    baseRows = Array.isArray(legacySnapshot?.rows) ? legacySnapshot.rows : [];
  }

  let rows = baseRows;

  if (state.inProgress && state.currentCycleId) {
    const current = await readCycleRows(env, String(state.currentCycleId));
    rows = mergeRows(rows, current.rows);
  }

  const [analysis, itsSnapshot] = await Promise.all([analysisPromise, itsPromise]);

  // The active row shards contain Busan rows only. ITS is stored separately
  // so the collector never rewrites a multi-thousand-row combined snapshot.
  if (state.activeCycleId && Array.isArray(itsSnapshot?.rows)) {
    rows = mergeRows(rows, itsSnapshot.rows);
  }

  const isIncremental = Boolean(state.inProgress && state.currentCycleId);
  const analysisMatchesActiveCycle = Boolean(
    analysis &&
    state.activeCycleId &&
    analysis.rowCycleId === state.activeCycleId &&
    analysis.fetchedAt
  );

  let overview;
  if (isIncremental) {
    // Only this request computes an interim global summary; the scheduled Worker
    // writes compact aggregate summaries per page group and does not stringify all rows.
    overview = calculateBusanTrafficOverview(rows);
  } else if (analysisMatchesActiveCycle && analysis.stats && Array.isArray(analysis.top10)) {
    overview = { stats: analysis.stats, top10: analysis.top10 };
  } else {
    overview = calculateBusanTrafficOverview(rows);
  }

  const latestAnalysis = analysisMatchesActiveCycle ? analysis : null;
  const updatedAt = isIncremental
    ? (state.lastIncrementalUpdateAt || state.updatedAt || legacySnapshot?.fetchedAt || new Date().toISOString())
    : (state.lastCompletedAt || latestAnalysis?.fetchedAt || legacySnapshot?.fetchedAt || new Date().toISOString());

  return {
    ok: true,
    source: latestAnalysis?.source || legacySnapshot?.source || "부산광역시 링크소통정보",
    snapshotType: isIncremental ? "INCREMENTAL" : "COMPLETE",
    collection: buildCollectionMeta(state),
    stats: overview.stats,
    top10: overview.top10,
    suddenCongestion: latestAnalysis?.suddenCongestion ||
      legacySnapshot?.suddenCongestion || { detectedCount: 0, items: [] },
    trafficBriefing: latestAnalysis?.trafficBriefing || legacySnapshot?.trafficBriefing || null,
    rows,
    totalCount: rows.length,
    fetchedAt: updatedAt,
    warning: latestAnalysis?.warning || legacySnapshot?.warning || null,
    metadata: {
      activeCycleId: state.activeCycleId || null,
      currentCycleId: state.currentCycleId || null,
      activeShardCount: activeSummaries.length
    }
  };
}
