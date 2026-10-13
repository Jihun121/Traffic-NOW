import assert from "node:assert/strict";
import test from "node:test";

import { selectDiverseTop10 } from "../functions/lib/top10Diversity.js";

function congested(linkId, roadName, startName, endName, speed = 1) {
  return {
    linkId,
    roadName,
    startName,
    endName,
    speed,
    status: "CONGESTED",
    statusText: "정체",
    updatedAt: "2026-10-13T09:00:00"
  };
}

test("directly adjacent congested links are suppressed and TOP 10 is backfilled", () => {
  const centralLinks = [
    congested("1440054400", "중앙고속도로", "삼락IC", "삼락IC", 1),
    congested("1410013400", "중앙고속도로", "삼락IC", "대저2동1200", 1),
    congested("1410013600", "중앙고속도로", "대저2동1200", "대저2동1200-1", 1),
    congested("1410013803", "중앙고속도로", "삼락IC", "신대저교차로", 1),
    congested("1410015400", "중앙고속도로", "신대저교차로", "대저JC남측", 1)
  ];
  const independentLinks = Array.from({ length: 10 }, (_, index) =>
    congested(`other-${index}`, `별도도로${index}`, `시점${index}`, `종점${index}`, index + 2)
  );
  const input = [...centralLinks, ...independentLinks];
  const original = JSON.stringify(input);

  const selected = selectDiverseTop10(input, 10);

  assert.equal(selected.length, 10);
  assert.equal(selected.filter((item) => item.roadName === "중앙고속도로").length, 2);
  assert.equal(selected[0].linkId, "1410013400", "prefer a real section over a self-loop at equal speed");
  assert.equal(selected[0].speed, 1, "source speed must be preserved");
  assert.ok(!selected.some((item) => item.linkId === "1410013600"), "directly adjacent link should be suppressed");
  assert.ok(selected.some((item) => item.linkId === "1410015400"), "separate bottleneck should remain eligible");
  assert.deepEqual(selected.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(JSON.stringify(input), original, "selection must not mutate source data");
});

test("a long connected road is not collapsed into one whole-road cluster", () => {
  const chain = Array.from({ length: 8 }, (_, index) =>
    congested(`central-${index}`, "중앙고속도로", `N${index}`, `N${index + 1}`, index + 1)
  );

  const selected = selectDiverseTop10(chain);

  assert.deepEqual(
    selected.map((item) => item.linkId),
    ["central-0", "central-2", "central-4", "central-6"]
  );
});

test("disconnected sections of the same road remain separate TOP 10 candidates", () => {
  const items = [
    congested("central-a", "중앙고속도로", "AIC", "B교차로", 2),
    congested("central-b", "중앙고속도로", "XIC", "Y교차로", 3)
  ];

  const selected = selectDiverseTop10(items);

  assert.deepEqual(selected.map((item) => item.linkId), ["central-a", "central-b"]);
});

test("matching node names on different roads do not merge", () => {
  const items = [
    congested("road-a", "중앙고속도로", "삼락IC", "대저2동", 1),
    congested("road-b", "낙동대로", "삼락IC", "구포대교", 2)
  ];

  const selected = selectDiverseTop10(items);

  assert.equal(selected.length, 2);
});

test("non-congested links do not suppress separate congestion candidates", () => {
  const items = [
    congested("left", "중앙고속도로", "AIC", "BIC", 1),
    {
      ...congested("middle", "중앙고속도로", "BIC", "CIC", 35),
      status: "SMOOTH"
    },
    congested("right", "중앙고속도로", "CIC", "DIC", 2)
  ];

  const selected = selectDiverseTop10(items);

  assert.deepEqual(selected.map((item) => item.linkId), ["left", "right", "middle"]);
});
