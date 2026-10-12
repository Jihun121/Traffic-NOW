const HISTORY_INDEX_KEY = "traffic:busan:history:index";
const HISTORY_KEY_PREFIX = "traffic:busan:history:";
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 96;
const MAX_ROWS = 100;
const LEGACY_ROW_SHARD_KEY_PREFIX = "traffic:busan:rows:v4:";
const ROW_SHARD_KEY_PREFIX = "traffic:busan:rows:v5:";
const LEGACY_ROW_SHARD_PAGES = 10;
const DEFAULT_ROW_SHARD_PAGES = 5;
const DEFAULT_TOTAL_PAGES = 93;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

function parseLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function isSafeHistoryKey(value) {
  return /^[A-Za-z0-9:_-]+$/.test(value);
}

function rowsFromShard(shard) {
  if (!shard || !shard.pages || typeof shard.pages !== "object") return [];
  return Object.keys(shard.pages)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b)
    .flatMap((page) => Array.isArray(shard.pages[String(page)]) ? shard.pages[String(page)] : []);
}

function rowShardConfig(snapshot) {
  const pagesPerShard = Number(snapshot?.rowShardPages || LEGACY_ROW_SHARD_PAGES);
  return {
    pagesPerShard,
    shardCount: Math.max(1, Math.ceil((Number(snapshot?.totalPages) || DEFAULT_TOTAL_PAGES) / pagesPerShard)),
    prefix: pagesPerShard === LEGACY_ROW_SHARD_PAGES
      ? LEGACY_ROW_SHARD_KEY_PREFIX
      : ROW_SHARD_KEY_PREFIX
  };
}

function normalizeFetchedAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const timestamp = Date.parse(raw);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }

  return raw;
}

function buildHistoryKey(atValue) {
  const raw = String(atValue || "").trim();
  if (!raw) return "";

  if (raw.startsWith(HISTORY_KEY_PREFIX)) {
    return isSafeHistoryKey(raw) ? raw : "";
  }

  const normalized = normalizeFetchedAt(raw);
  if (!normalized) return "";

  const cycleId = normalized.replace(/[-:.TZ]/g, "");
  return isSafeHistoryKey(cycleId)
    ? `${HISTORY_KEY_PREFIX}${cycleId}`
    : "";
}

function summarizeHistoryEntry(entry) {
  return {
    fetchedAt: entry?.fetchedAt || null,
    totalCount: Number(entry?.totalCount || 0),
    reportedTotalCount: Number(entry?.reportedTotalCount || 0),
    totalPages: Number(entry?.totalPages || 0),
    averageSpeed: Number(entry?.averageSpeed || 0),
    trafficIndex: Number(entry?.trafficIndex || 0),
    congestedRatio: Number(entry?.congestedRatio || 0),
    slowRatio: Number(entry?.slowRatio || 0),
    smoothRatio: Number(entry?.smoothRatio || 0),
    congestionLevel: entry?.congestionLevel || "데이터 없음",
    suddenCongestionCount: Number(entry?.suddenCongestionCount || 0)
  };
}

export async function onRequestGet(context) {
  const startedAt = Date.now();
  let stage = "start";

  const url = new URL(context.request.url);
  const at = url.searchParams.get("at");
  const limit = parseLimit(url.searchParams.get("limit"));
  const linkId = String(url.searchParams.get("linkId") || "").trim();

  try {
    if (!context.env?.TRAFFIC_CACHE) {
      return json({
        ok: false,
        error: "교통 시계열 저장소가 연결되지 않았습니다.",
        diagnostics: {
          code: "TRAFFIC_HISTORY_CACHE_NOT_CONFIGURED"
        }
      }, 503);
    }

    stage = "history-index-read";
    const index = await context.env.TRAFFIC_CACHE.get(HISTORY_INDEX_KEY, "json");
    const entries = Array.isArray(index) ? index : [];

    if (!at && !linkId) {
      const history = entries.slice(0, limit).map(summarizeHistoryEntry);

      return json({
        ok: true,
        source: "부산광역시 링크소통정보",
        count: history.length,
        history,
        retention: {
          maxEntries: MAX_LIMIT
        },
        timing: {
          totalMs: Date.now() - startedAt
        }
      }, 200, {
        "cache-control": "public, max-age=0, s-maxage=30",
        "X-Traffic-History": "INDEX"
      });
    }

    if (linkId) {
      const candidates = entries.slice(0, limit);
      const matched = [];
      // KV reads count as Worker subrequests. Bound the search below the Free-plan
      // per-invocation limit, including the history-index read performed above.
      const maxHistoryReads = 45;
      let historyReads = 0;

      for (const entry of candidates) {
        if (!entry?.key || !isSafeHistoryKey(String(entry.key))) continue;
        if (historyReads >= maxHistoryReads) break;

        const snapshot = await context.env.TRAFFIC_CACHE.get(entry.key, "json");
        historyReads += 1;
        if (!snapshot) continue;

        let row = Array.isArray(snapshot.rows)
          ? snapshot.rows.find((item) => String(item?.linkId || "") === linkId)
          : null;

        if (!row && snapshot.rowCycleId) {
          // Sharded history stores a pointer to its retained row cycle instead of
          // copying all 9k rows into every historical snapshot.
          const shardConfig = rowShardConfig(snapshot);
          for (let groupId = 0; groupId < shardConfig.shardCount && historyReads < maxHistoryReads; groupId += 1) {
            const shard = await context.env.TRAFFIC_CACHE.get(
              shardConfig.prefix + String(snapshot.rowCycleId) + ":" + groupId,
              "json"
            );
            historyReads += 1;
            const shardRows = rowsFromShard(shard);
            row = shardRows.find((item) => String(item?.linkId || "") === linkId) || null;
            if (row) break;
          }
        }

        if (!row) continue;

        matched.push({
          fetchedAt: snapshot.fetchedAt || entry.fetchedAt || null,
          linkId: row.linkId || linkId,
          roadName: row.roadName || "",
          startName: row.startName || "",
          endName: row.endName || "",
          speed: Number(row.speed),
          status: row.status || "UNKNOWN",
          category: row.category || ""
        });
      }

      return json({
        ok: true,
        mode: "link-history",
        linkId,
        count: matched.length,
        history: matched,
        timing: {
          totalMs: Date.now() - startedAt
        }
      }, 200, {
        "cache-control": "public, max-age=0, s-maxage=30",
        "X-Traffic-History": "LINK"
      });
    }

    stage = "history-snapshot-read";
    const historyKey = buildHistoryKey(at);

    if (!historyKey) {
      return json({
        ok: false,
        error: "유효하지 않은 history 시점입니다.",
        diagnostics: {
          code: "TRAFFIC_HISTORY_INVALID_AT"
        }
      }, 400);
    }

    const snapshot = await context.env.TRAFFIC_CACHE.get(historyKey, "json");

    if (
      !snapshot ||
      (!Array.isArray(snapshot.rows) && !snapshot.rowCycleId)
    ) {
      return json({
        ok: false,
        error: "해당 시점의 교통 이력을 찾을 수 없습니다.",
        diagnostics: {
          code: "TRAFFIC_HISTORY_NOT_FOUND",
          historyKey
        }
      }, 404);
    }

    let rows = [];
    if (Array.isArray(snapshot.rows)) {
      rows = snapshot.rows.slice(0, MAX_ROWS);
    } else {
      // 새 HISTORY는 대형 rows 배열을 복제하지 않고 완료된 row-cycle을 참조한다.
      // 그룹 0에는 원본 페이지 1~10이 들어 있어 기존 API 계약처럼 최대 100행을 반환할 수 있다.
      const shardConfig = rowShardConfig(snapshot);
      const firstShard = await context.env.TRAFFIC_CACHE.get(
        shardConfig.prefix + String(snapshot.rowCycleId) + ":0",
        "json"
      );
      rows = rowsFromShard(firstShard).slice(0, MAX_ROWS);
    }

    return json({
      ok: true,
      mode: "snapshot",
      source: snapshot.source || "부산광역시 링크소통정보",
      fetchedAt: snapshot.fetchedAt || null,
      stats: snapshot.stats || null,
      suddenCongestion: snapshot.suddenCongestion || null,
      trafficBriefing: snapshot.trafficBriefing || null,
      totalCount: Number(snapshot.totalCount || snapshot.stats?.totalCount || 0),
      returnedRows: rows.length,
      data: rows,
      timing: {
        totalMs: Date.now() - startedAt
      }
    }, 200, {
      "cache-control": "public, max-age=0, s-maxage=30",
      "X-Traffic-History": "SNAPSHOT"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return json({
      ok: false,
      error: message,
      diagnostics: {
        code: "TRAFFIC_HISTORY_INTERNAL_ERROR",
        stage,
        detail: message,
        name: error?.name || "UnknownError",
        hasKvBinding: Boolean(context.env?.TRAFFIC_CACHE)
      }
    }, 500);
  }
}
