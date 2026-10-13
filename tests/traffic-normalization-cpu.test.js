import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTrafficPayload } from "../functions/lib/normalizeTraffic.js";

test("normalizes numeric Busan traffic fields without changing values", () => {
  const result = normalizeTrafficPayload({
    response: {
      body: {
        items: {
          item: [
            {
              lkId: "numeric-row",
              roadNm: "중앙고속도로",
              bgngNodeNm: "삼락IC",
              endNodeNm: "대저JC",
              spd: 1,
              vol: 0,
              latitude: 35.2,
              longitude: 129.1,
              statsDt: "2026-10-13T09:00:00"
            },
            {
              lkId: "string-row",
              roadNm: "낙동대로",
              bgngNodeNm: "A",
              endNodeNm: "B",
              spd: " 12 km/h ",
              vol: "1,234",
              latitude: "35.1",
              longitude: "129.0",
              statsDt: "2026-10-13T09:00:00"
            }
          ]
        }
      }
    }
  });

  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map(({ linkId, speed, volume, latitude, longitude }) => ({
      linkId,
      speed,
      volume,
      latitude,
      longitude
    })),
    [
      {
        linkId: "numeric-row",
        speed: 1,
        volume: 0,
        latitude: 35.2,
        longitude: 129.1
      },
      {
        linkId: "string-row",
        speed: 12,
        volume: 1234,
        latitude: 35.1,
        longitude: 129
      }
    ]
  );
});

test("numeric fast path still rejects non-finite and out-of-range speeds", () => {
  const result = normalizeTrafficPayload({
    items: [
      { linkId: "valid-zero", roadName: "도로 A", speed: 0 },
      { linkId: "not-finite", roadName: "도로 B", speed: Number.NaN },
      { linkId: "too-fast", roadName: "도로 C", speed: 161 }
    ]
  });

  assert.deepEqual(result.rows.map((row) => row.linkId), ["valid-zero"]);
});
