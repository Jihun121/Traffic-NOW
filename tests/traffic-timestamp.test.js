import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTrafficPayload } from "../functions/lib/normalizeTraffic.js";
import { onRequestGet } from "../functions/api/traffic.js";

test("Busan statsDt is mapped to updatedAt without changing speed=1", () => {
  const sourceTimestamp = "2026-10-12T14:00:00";
  const result = normalizeTrafficPayload({
    response: {
      body: {
        items: {
          item: [{
            lkId: "1440054400",
            roadNm: "중앙고속도로",
            bgngNodeNm: "삼락IC",
            endNodeNm: "삼락IC",
            spd: 1,
            vol: 0,
            statsDt: sourceTimestamp
          }]
        }
      }
    }
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].linkId, "1440054400");
  assert.equal(result.rows[0].speed, 1);
  assert.equal(result.rows[0].volume, 0);
  assert.equal(result.rows[0].updatedAt, sourceTimestamp);
});

test("traffic API returns a valid fallback timestamp when incremental state has blanks", async () => {
  const expectedTimestamp = "2026-10-12T06:21:11.808Z";
  const state = {
    collectorVersion: 4,
    inProgress: true,
    currentCycleId: "cycle-test",
    activeCycleId: null,
    totalPages: 1,
    rowShardPages: 5,
    completedPages: [],
    failedPages: [],
    lastIncrementalUpdateAt: " ",
    updatedAt: " "
  };
  const legacySnapshot = {
    source: "부산광역시 링크소통정보",
    rows: [{
      linkId: "1440054400",
      roadName: "중앙고속도로",
      startName: "삼락IC",
      endName: "삼락IC",
      speed: 1,
      updatedAt: ""
    }],
    stats: { totalCount: 1, averageSpeed: 1 },
    top10: [{
      rank: 1,
      linkId: "1440054400",
      roadName: "중앙고속도로",
      startName: "삼락IC",
      endName: "삼락IC",
      speed: 1,
      status: "CONGESTED",
      updatedAt: ""
    }],
    fetchedAt: expectedTimestamp
  };

  const values = new Map([
    ["traffic:busan:collector-state", state],
    ["traffic:busan:latest-analysis", null],
    ["traffic:busan:latest", legacySnapshot]
  ]);
  const env = {
    TRAFFIC_CACHE: {
      async get(key, type) {
        assert.equal(type, "json");
        return values.get(key) ?? null;
      }
    }
  };

  const response = await onRequestGet({
    request: new Request("https://traffic-now.test/api/traffic?region=busan"),
    env
  });

  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.updatedAt, expectedTimestamp);
  assert.equal(payload.top10[0].speed, 1);
  assert.equal(payload.data[0].speed, 1);
});
