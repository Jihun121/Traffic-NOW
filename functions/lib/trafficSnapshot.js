import { calculateBusanTrafficOverview } from "./trafficAnalyzer.js";

const LEGACY_SNAPSHOT_KEY = "traffic:busan:latest";
const COLLECTOR_STATE_KEY = "traffic:busan:collector-state";
const SNAPSHOT_ANALYSIS_KEY = "traffic:busan:latest-analysis";
const ITS_SNAPSHOT_KEY = "traffic:busan:its:latest";
const ROW_SHARD_KEY_PREFIX = "traffic:busan:rows:v4:";
const ROW_GROUP_COUNT = 10;
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

function flattenPageShards(shards) {
  const rows = [];
  for (const shard of shards) rows.push(...rowsFromShard(shard));
  return rows;
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

function emptyRowShard(cycleId, groupId) {
  return { cycleId: cycleId || "", groupId, pages: {}, summary: null };
}

async function readCycleShards(env, cycleId, groupIds = null) {
  const ids = Array.isArray(groupIds)
    ? [...new Set(groupIds)].filter((id) => Number.isInteger(id) && id >= 0 && id < ROW_GROUP_COUNT)
    : Array.from({ length: ROW_GROUP_COUNT }, (_, index) => index);
  const result = Array.from({ length: ROW_GROUP_COUNT }, (_, groupId) => emptyRowShard(cycleId, groupId));
  if (!cycleId || ids.length === 0) return result;

  const raw = await Promise.all(
    ids.map((groupId) =>
      env.TRAFFIC_CACHE.get(getCycleRowShardKey(cycleId, groupId), "json")
    )
  );

  ids.forEach((groupId, index) => {
    const shard = raw[index];
    if (shard && shard.cycleId === cycleId && shard.pages && typeof shard.pages === "object") {
      result[groupId] = shard;
    }
  });

  return result;
}

function mergeShardPages(baseShard, overlayShard, cycleId, groupId) {
  return {
    cycleId,
    groupId,
    pages: {
      ...(baseShard?.pages || {}),
      ...(overlayShard?.pages || {})
    }
  };
}

function buildStatsFromAggregate(aggregate) {
  const totalCount = Number(aggregate?.totalCount || 0);
  const totalSpeed = Number(aggregate?.totalSpeed || 0);
  const smoothCount = Number(aggregate?.smoothCount || 0);
  const slowCount = Number(aggregate?.slowCount || 0);
  const congestedCount = Number(aggregate?.congestedCount || 0);

  if (!totalCount) {
    return {
      totalCount: 0,
      averageSpeed: 0,
      trafficIndex: 0,
      trafficIndexGrade: "데이터 없음",
      statusCounts: { smooth: 0, slow: 0, congested: 0 },
      statusRatios: { smooth: 0, slow: 0, congested: 0 },
      congestionLevel: "데이터 없음",
      slowestRoad: null
    };
  }

  const averageSpeed = Number((totalSpeed / totalCount).toFixed(1));
  const smoothRatio = Number(((smoothCount / totalCount) * 100).toFixed(1));
  const slowRatio = Number(((slowCount / totalCount) * 100).toFixed(1));
  const congestedRatio = Number(((congestedCount / totalCount) * 100).toFixed(1));
  const trafficIndex = Number(Math.max(0, Math.min(100, smoothRatio + slowRatio * 0.5)).toFixed(1));

  let trafficIndexGrade = "매우 혼잡";
  if (trafficIndex >= 80) trafficIndexGrade = "매우 원활";
  else if (trafficIndex >= 65) trafficIndexGrade = "원활";
  else if (trafficIndex >= 50) trafficIndexGrade = "보통";
  else if (trafficIndex >= 35) trafficIndexGrade = "혼잡";

  let congestionLevel = "원활";
  if (congestedRatio >= 25) congestionLevel = "매우 혼잡";
  else if (congestedRatio >= 15) congestionLevel = "혼잡";
  else if (congestedRatio >= 8 || slowRatio >= 30) congestionLevel = "다소 혼잡";

  return {
    totalCount,
    averageSpeed,
    trafficIndex,
    trafficIndexGrade,
    statusCounts: { smooth: smoothCount, slow: slowCount, congested: congestedCount },
    statusRatios: { smooth: smoothRatio, slow: slowRatio, congested: congestedRatio },
    congestionLevel,
    slowestRoad: aggregate.slowestRoad || null
  };
}

function combineTrafficSummaries(summaries) {
  const aggregate = {
    totalCount: 0,
    totalSpeed: 0,
    smoothCount: 0,
    slowCount: 0,
    congestedCount: 0,
    slowestRoad: null
  };
  const bestBySection = new Map();
  const compare = (a, b) => {
    if (a.status === "CONGESTED" && b.status !== "CONGESTED") return -1;
    if (a.status !== "CONGESTED" && b.status === "CONGESTED") return 1;
    return Number(a.speed) - Number(b.speed);
  };

  for (const summary of summaries) {
    const part = summary?.aggregate;
    if (!part) continue;
    aggregate.totalCount += Number(part.totalCount || 0);
    aggregate.totalSpeed += Number(part.totalSpeed || 0);
    aggregate.smoothCount += Number(part.smoothCount || 0);
    aggregate.slowCount += Number(part.slowCount || 0);
    aggregate.congestedCount += Number(part.congestedCount || 0);

    const slowest = part.slowestRoad;
    if (slowest && (!aggregate.slowestRoad || Number(slowest.speed) < Number(aggregate.slowestRoad.speed))) {
      aggregate.slowestRoad = slowest;
    }

    for (const item of Array.isArray(summary?.top10) ? summary.top10 : []) {
      const key = [item.roadName || "", item.startName || "", item.endName || ""].join("|");
      const previous = bestBySection.get(key);
      if (!previous || compare(item, previous) < 0) bestBySection.set(key, item);
    }
  }

  const top10 = Array.from(bestBySection.values())
    .sort(compare)
    .slice(0, 10)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  return { stats: buildStatsFromAggregate(aggregate), top10, aggregate };
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
 * While collection is in progress, the active COMPLETE set remains intact and
 * only whole source pages from the current cycle overlay it.
 */
export async function loadTrafficSnapshot(env) {
  if (!env?.TRAFFIC_CACHE) return null;

  const state = await env.TRAFFIC_CACHE.get(COLLECTOR_STATE_KEY, "json");
  if (!state || Number(state.collectorVersion || 0) !== 4) {
    return env.TRAFFIC_CACHE.get(LEGACY_SNAPSHOT_KEY, "json");
  }

  const [analysis, itsSnapshot] = await Promise.all([
    env.TRAFFIC_CACHE.get(SNAPSHOT_ANALYSIS_KEY, "json"),
    state.activeCycleId
      ? env.TRAFFIC_CACHE.get(ITS_SNAPSHOT_KEY, "json")
      : Promise.resolve(null)
  ]);

  let legacySnapshot = null;
  let rows = [];
  let summaryList = [];
  let activeShards = null;

  const isIncremental = Boolean(state.inProgress && state.currentCycleId);
  if (isIncremental && state.activeCycleId) {
    // Read the current overlay first. When a group has every source page, its old
    // active shard is unnecessary; avoiding that read halves JSON parsing near cycle end.
    const currentShards = await readCycleShards(env, String(state.currentCycleId));
    const completedPages = new Set(
      Array.isArray(state.completedPages) ? state.completedPages.map(Number) : []
    );
    const totalPages = Number(state.totalPages || 0);
    const activeGroupIds = [];

    for (let groupId = 0; groupId < ROW_GROUP_COUNT; groupId += 1) {
      const firstPage = groupId * 10 + 1;
      const lastPage = totalPages > 0 ? Math.min(firstPage + 9, totalPages) : firstPage + 9;
      let groupComplete = totalPages > 0 && lastPage >= firstPage;
      for (let page = firstPage; groupComplete && page <= lastPage; page += 1) {
        if (!completedPages.has(page)) groupComplete = false;
      }
      if (!groupComplete) activeGroupIds.push(groupId);
    }

    activeShards = await readCycleShards(env, String(state.activeCycleId), activeGroupIds);
    rows = [];
    summaryList = [];

    for (let groupId = 0; groupId < ROW_GROUP_COUNT; groupId += 1) {
      const baseShard = activeShards[groupId];
      const overlayShard = currentShards[groupId];
      const hasOverlay = Object.keys(overlayShard.pages || {}).length > 0;
      const firstPage = groupId * 10 + 1;
      const lastPage = totalPages > 0 ? Math.min(firstPage + 9, totalPages) : firstPage + 9;
      let groupComplete = totalPages > 0 && lastPage >= firstPage;
      for (let page = firstPage; groupComplete && page <= lastPage; page += 1) {
        if (!completedPages.has(page)) groupComplete = false;
      }

      const mergedShard = groupComplete
        ? overlayShard
        : mergeShardPages(baseShard, overlayShard, String(state.activeCycleId), groupId);
      const groupRows = rowsFromShard(mergedShard);
      rows.push(...groupRows);

      if (groupComplete && overlayShard.summary) {
        summaryList.push(overlayShard.summary);
      } else if (hasOverlay) {
        summaryList.push(calculateBusanTrafficOverview(groupRows));
      } else if (baseShard.summary) {
        summaryList.push(baseShard.summary);
      }
    }
  } else if (state.activeCycleId) {
    activeShards = await readCycleShards(env, String(state.activeCycleId));
    rows = flattenPageShards(activeShards);
    summaryList = activeShards.map((shard) => shard.summary).filter(Boolean);
  }

  if (!rows.length) {
    legacySnapshot = await env.TRAFFIC_CACHE.get(LEGACY_SNAPSHOT_KEY, "json");
    rows = Array.isArray(legacySnapshot?.rows) ? legacySnapshot.rows : [];
  }

  if (isIncremental && !state.activeCycleId) {
    // Bootstrap from legacy: apply new pages over the last complete dataset.
    const currentShards = await readCycleShards(env, String(state.currentCycleId));
    const overlayRows = flattenPageShards(currentShards);
    const completedPages = Array.isArray(state.completedPages) ? state.completedPages.length : 0;
    const totalPages = Number(state.totalPages || 0);
    const nearCycleEnd = totalPages > 0 && totalPages - completedPages <= PAGES_PER_RUN;

    if (nearCycleEnd && overlayRows.length > 0) {
      // The last batch is about to become the active dataset; avoid deserializing/merging
      // the full legacy snapshot and thousands of newly refreshed rows for one response.
      rows = overlayRows;
      summaryList = currentShards.map((shard) => shard.summary).filter(Boolean);
    } else {
      rows = mergeRows(rows, overlayRows);
    }
  }

  const validItsSnapshot = Boolean(
    state.activeCycleId &&
    itsSnapshot &&
    itsSnapshot.fetchedAt &&
    itsSnapshot.fetchedAt === state.lastCompletedAt &&
    Array.isArray(itsSnapshot.rows)
  );

  if (validItsSnapshot) rows = mergeRows(rows, itsSnapshot.rows);

  const analysisMatchesActiveCycle = Boolean(
    analysis &&
    state.activeCycleId &&
    analysis.rowCycleId === state.activeCycleId &&
    analysis.fetchedAt
  );

  let overview;
  if (isIncremental && state.activeCycleId) {
    if (validItsSnapshot && itsSnapshot.rows.length) {
      const itsOverview = calculateBusanTrafficOverview(itsSnapshot.rows);
      summaryList.push(itsOverview);
    }
    overview = combineTrafficSummaries(summaryList);
  } else if (isIncremental && !state.activeCycleId) {
    const completedPages = Array.isArray(state.completedPages) ? state.completedPages.length : 0;
    const totalPages = Number(state.totalPages || 0);
    const nearCycleEnd = totalPages > 0 && totalPages - completedPages <= PAGES_PER_RUN;
    if (nearCycleEnd && summaryList.length) {
      overview = combineTrafficSummaries(summaryList);
    } else if (legacySnapshot?.stats && Array.isArray(legacySnapshot?.top10)) {
      overview = { stats: legacySnapshot.stats, top10: legacySnapshot.top10 };
    } else {
      overview = calculateBusanTrafficOverview(rows);
    }
  } else if (analysisMatchesActiveCycle && analysis.stats && Array.isArray(analysis.top10)) {
    overview = { stats: analysis.stats, top10: analysis.top10 };
  } else if (summaryList.length) {
    overview = combineTrafficSummaries(summaryList);
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
      activeShardCount: activeShards ? activeShards.filter((shard) => Boolean(shard?.summary)).length : 0
    }
  };
}
