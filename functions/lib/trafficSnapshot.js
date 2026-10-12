import { calculateBusanTrafficOverview } from "./trafficAnalyzer.js";

const LEGACY_SNAPSHOT_KEY = "traffic:busan:latest";
const COLLECTOR_STATE_KEY = "traffic:busan:collector-state";
const SNAPSHOT_ANALYSIS_KEY = "traffic:busan:latest-analysis";
const ITS_SNAPSHOT_KEY = "traffic:busan:its:latest";
const LEGACY_ROW_SHARD_KEY_PREFIX = "traffic:busan:rows:v4:";
const ROW_SHARD_KEY_PREFIX = "traffic:busan:rows:v5:";
const LEGACY_GROUP_SUMMARY_KEY_PREFIX = "traffic:busan:rows:v4-summary:";
const GROUP_SUMMARY_KEY_PREFIX = "traffic:busan:rows:v5-summary:";
const ROW_GROUP_COUNT = 10;
const ANALYSIS_PAGES_PER_GROUP = 10;
const DEFAULT_ROW_SHARD_PAGES = 5;
const LEGACY_ROW_SHARD_PAGES = 10;
const DEFAULT_TOTAL_PAGES = 93;
const PAGES_PER_RUN = 3;

function getCycleRowShardKey(cycleId, shardId, pagesPerShard = LEGACY_ROW_SHARD_PAGES) {
  const prefix = pagesPerShard === LEGACY_ROW_SHARD_PAGES
    ? LEGACY_ROW_SHARD_KEY_PREFIX
    : ROW_SHARD_KEY_PREFIX;
  return prefix + cycleId + ":" + shardId;
}

function getRowShardIndex(page, pagesPerShard) {
  return Math.max(0, Math.floor((Number(page) - 1) / pagesPerShard));
}

function rowsFromShard(shard, startPage = 1, endPage = Infinity) {
  if (!shard || !shard.pages || typeof shard.pages !== "object") return [];
  return Object.keys(shard.pages)
    .map(Number)
    .filter((page) => Number.isInteger(page) && page >= startPage && page <= endPage)
    .sort((a, b) => a - b)
    .flatMap((page) => Array.isArray(shard.pages[String(page)]) ? shard.pages[String(page)] : []);
}

function flattenPageShards(shards) {
  const rows = [];
  for (const shard of shards) rows.push(...rowsFromShard(shard));
  return rows;
}

function emptyRowShard(cycleId, shardId) {
  return { cycleId: cycleId || "", shardId, pages: {}, summary: null };
}

async function readCycleShards(env, cycleId, shardIds = null, pagesPerShard = LEGACY_ROW_SHARD_PAGES, totalPages = DEFAULT_TOTAL_PAGES) {
  const shardCount = Math.max(1, Math.ceil((Number(totalPages) || DEFAULT_TOTAL_PAGES) / pagesPerShard));
  const ids = Array.isArray(shardIds)
    ? [...new Set(shardIds)].filter((id) => Number.isInteger(id) && id >= 0 && id < shardCount)
    : Array.from({ length: shardCount }, (_, index) => index);
  const result = Array.from({ length: shardCount }, (_, shardId) => emptyRowShard(cycleId, shardId));
  if (!cycleId || ids.length === 0) return result;

  const raw = await Promise.all(
    ids.map((shardId) =>
      env.TRAFFIC_CACHE.get(getCycleRowShardKey(cycleId, shardId, pagesPerShard), "json")
    )
  );

  ids.forEach((shardId, index) => {
    const shard = raw[index];
    if (shard && shard.cycleId === cycleId && shard.pages && typeof shard.pages === "object") {
      result[shardId] = shard;
    }
  });
  return result;
}

async function readCycleGroupSummary(env, cycleId, groupId, pagesPerShard) {
  const prefix = pagesPerShard === LEGACY_ROW_SHARD_PAGES
    ? LEGACY_GROUP_SUMMARY_KEY_PREFIX
    : GROUP_SUMMARY_KEY_PREFIX;
  const value = await env.TRAFFIC_CACHE.get(prefix + cycleId + ":" + groupId, "json");
  return value?.cycleId === cycleId ? value.summary : null;
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
  const activePagesPerShard = Number(
    state.activeRowShardPages || (state.activeCycleId ? LEGACY_ROW_SHARD_PAGES : DEFAULT_ROW_SHARD_PAGES)
  );
  const currentPagesPerShard = Number(state.rowShardPages || LEGACY_ROW_SHARD_PAGES);
  const totalPages = Math.max(
    1,
    Number(state.totalPages || analysis?.totalPages || DEFAULT_TOTAL_PAGES)
  );
  const rowsByPage = new Map();

  if (isIncremental) {
    const completedPages = new Set(
      Array.isArray(state.completedPages) ? state.completedPages.map(Number) : []
    );
    const overlayShardIds = [...new Set(
      [...completedPages]
        .filter((page) => page >= 1 && page <= totalPages)
        .map((page) => getRowShardIndex(page, currentPagesPerShard))
    )];
    const currentShards = await readCycleShards(
      env,
      String(state.currentCycleId),
      overlayShardIds,
      currentPagesPerShard,
      totalPages
    );

    let activeGroupIds = [];
    if (state.activeCycleId) {
      const activeShardCount = Math.ceil(totalPages / activePagesPerShard);
      for (let shardId = 0; shardId < activeShardCount; shardId += 1) {
        const firstPage = shardId * activePagesPerShard + 1;
        const lastPage = Math.min(firstPage + activePagesPerShard - 1, totalPages);
        let allPagesUpdated = true;
        for (let page = firstPage; page <= lastPage; page += 1) {
          if (!completedPages.has(page)) {
            allPagesUpdated = false;
            break;
          }
        }
        if (!allPagesUpdated) activeGroupIds.push(shardId);
      }

      activeShards = await readCycleShards(
        env,
        String(state.activeCycleId),
        activeGroupIds,
        activePagesPerShard,
        totalPages
      );
    }

    // Assemble rows per source page. This avoids assumptions that the old and new
    // physical shard boundaries match during the one-time v4 -> v5 migration.
    for (let page = 1; page <= totalPages; page += 1) {
      let pageRows = null;
      if (completedPages.has(page)) {
        const overlay = currentShards[getRowShardIndex(page, currentPagesPerShard)];
        const rowsForPage = overlay?.pages?.[String(page)];
        if (Array.isArray(rowsForPage)) pageRows = rowsForPage;
      }
      if (!pageRows && state.activeCycleId) {
        const base = activeShards?.[getRowShardIndex(page, activePagesPerShard)];
        const baseRows = base?.pages?.[String(page)];
        if (Array.isArray(baseRows)) pageRows = baseRows;
      }
      if (pageRows) rowsByPage.set(page, pageRows);
    }

    rows = [];
    for (let page = 1; page <= totalPages; page += 1) {
      const pageRows = rowsByPage.get(page);
      if (pageRows) rows.push(...pageRows);
    }

    if (state.activeCycleId) {
      const summaryGroupCount = Math.ceil(totalPages / ANALYSIS_PAGES_PER_GROUP);
      for (let groupId = 0; groupId < summaryGroupCount; groupId += 1) {
        const firstPage = groupId * ANALYSIS_PAGES_PER_GROUP + 1;
        const lastPage = Math.min(firstPage + ANALYSIS_PAGES_PER_GROUP - 1, totalPages);
        let allPagesUpdated = true;
        let anyPageUpdated = false;
        for (let page = firstPage; page <= lastPage; page += 1) {
          if (completedPages.has(page)) anyPageUpdated = true;
          else allPagesUpdated = false;
        }

        if (allPagesUpdated) {
          const currentSummary = await readCycleGroupSummary(
            env,
            String(state.currentCycleId),
            groupId,
            currentPagesPerShard
          );
          if (currentSummary) {
            summaryList.push(currentSummary);
          } else {
            const groupRows = [];
            for (let page = firstPage; page <= lastPage; page += 1) {
              groupRows.push(...(rowsByPage.get(page) || []));
            }
            if (groupRows.length) summaryList.push(calculateBusanTrafficOverview(groupRows));
          }
          continue;
        }

        if (anyPageUpdated) {
          const groupRows = [];
          for (let page = firstPage; page <= lastPage; page += 1) {
            groupRows.push(...(rowsByPage.get(page) || []));
          }
          summaryList.push(calculateBusanTrafficOverview(groupRows));
          continue;
        }

        const activeSummary = await readCycleGroupSummary(
          env,
          String(state.activeCycleId),
          groupId,
          activePagesPerShard
        );
        if (activeSummary) {
          summaryList.push(activeSummary);
        } else {
          const groupRows = [];
          for (let page = firstPage; page <= lastPage; page += 1) {
            groupRows.push(...(rowsByPage.get(page) || []));
          }
          if (groupRows.length) summaryList.push(calculateBusanTrafficOverview(groupRows));
        }
      }
    }
  } else if (state.activeCycleId) {
    activeShards = await readCycleShards(
      env,
      String(state.activeCycleId),
      null,
      activePagesPerShard,
      totalPages
    );
    rows = flattenPageShards(activeShards);

    if (!analysis || analysis.rowCycleId !== state.activeCycleId || !analysis.stats) {
      const summaryGroupCount = Math.ceil(totalPages / ANALYSIS_PAGES_PER_GROUP);
      summaryList = await Promise.all(
        Array.from({ length: summaryGroupCount }, async (_, groupId) => {
          const stored = await readCycleGroupSummary(
            env,
            String(state.activeCycleId),
            groupId,
            activePagesPerShard
          );
          if (stored) return stored;

          const firstPage = groupId * ANALYSIS_PAGES_PER_GROUP + 1;
          const lastPage = Math.min(firstPage + ANALYSIS_PAGES_PER_GROUP - 1, totalPages);
          const groupRows = [];
          for (let page = firstPage; page <= lastPage; page += 1) {
            const shard = activeShards[getRowShardIndex(page, activePagesPerShard)];
            groupRows.push(...(Array.isArray(shard?.pages?.[String(page)]) ? shard.pages[String(page)] : []));
          }
          return calculateBusanTrafficOverview(groupRows);
        })
      );
    }
  }

  if (isIncremental && !state.activeCycleId) {
    // Bootstrap from the previous legacy snapshot until a complete v5 cycle is active.
    legacySnapshot = await env.TRAFFIC_CACHE.get(LEGACY_SNAPSHOT_KEY, "json");
    const overlayRows = rows;
    rows = mergeRows(Array.isArray(legacySnapshot?.rows) ? legacySnapshot.rows : [], overlayRows);
  } else if (!rows.length) {
    legacySnapshot = await env.TRAFFIC_CACHE.get(LEGACY_SNAPSHOT_KEY, "json");
    rows = Array.isArray(legacySnapshot?.rows) ? legacySnapshot.rows : [];
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
      summaryList.push(calculateBusanTrafficOverview(itsSnapshot.rows));
    }
    overview = combineTrafficSummaries(summaryList);
  } else if (isIncremental && !state.activeCycleId) {
    if (legacySnapshot?.stats && Array.isArray(legacySnapshot?.top10)) {
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
    postprocessPhase: latestAnalysis?.postprocessPhase || "",
    analysisUpdatedAt: latestAnalysis?.updatedAt || "",
    rows,
    totalCount: rows.length,
    fetchedAt: updatedAt,
    warning: latestAnalysis?.warning || legacySnapshot?.warning || null,
    metadata: {
      activeCycleId: state.activeCycleId || null,
      currentCycleId: state.currentCycleId || null,
      activeShardCount: activeShards ? activeShards.filter((shard) => Object.keys(shard.pages || {}).length > 0).length : 0,
      activeRowShardPages: activePagesPerShard,
      currentRowShardPages: currentPagesPerShard
    }
  };
}
