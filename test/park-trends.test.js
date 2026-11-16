import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baselineDates,
  buildTrends,
  isSampleMinute,
  loadTrends,
  recordParkSample,
  referenceCurve,
  referenceKey,
  summarizeParks,
  withUsualWaits,
} from "../functions/lib/park-trends.js";
import "../src/pages/assets/park-trends.js";

const { buildChartSvg, readingsAt, shortParkName, statusLabel, bestSummary } = globalThis.ParkTrends;

const NOON_ET = new Date("2026-10-30T12:00:00-04:00");

function makeEnv() {
  const store = new Map();
  return {
    store,
    KV: {
      async get(key) {
        return store.has(key) ? JSON.parse(store.get(key)) : null;
      },
      async put(key, value) {
        store.set(key, value);
      },
    },
  };
}

const ride = (parkId, waitTime, status = "OPERATING", entityType = "ATTRACTION") => ({
  parkId, status, entityType, queue: { STANDBY: { waitTime } },
});
const day = (parks) => ({
  parks: Object.fromEntries(Object.entries(parks).map(([id, points]) => [id, {
    name: id,
    points: points.map(([t, avg]) => ({ t, avg, rides: 10 })),
  }])),
});

test("summary averages only operating attractions with a wait", () => {
  const summary = summarizeParks([
    ride("mk", 10), ride("mk", 20), ride("mk", 30),
    ride("mk", 500, "DOWN"), ride("mk", 500, "OPERATING", "SHOW"), ride("mk", null),
  ]);
  assert.deepEqual(summary, { mk: { avg: 20, rides: 3 } });
});

test("summary skips a park with too few rides reporting", () => {
  assert.deepEqual(summarizeParks([ride("mk", 10), ride("mk", 20)]), {});
});

test("samples are taken on quarter hours", () => {
  assert.equal(isSampleMinute(new Date("2026-10-30T12:15:00Z")), true);
  assert.equal(isSampleMinute(new Date("2026-10-30T12:16:00Z")), false);
});

test("recording appends to the park day and skips a repeat of the same time", async () => {
  const env = makeEnv();
  const live = [ride("mk", 10), ride("mk", 20), ride("mk", 30)];
  const fetchParks = async () => ({ mk: "Magic Kingdom Park" });
  await recordParkSample(env, live, NOON_ET, fetchParks);
  await recordParkSample(env, live, NOON_ET, fetchParks);
  const record = JSON.parse(env.store.get("parks:history:2026-10-30"));
  assert.equal(record.parks.mk.name, "Magic Kingdom Park");
  assert.deepEqual(record.parks.mk.points, [{ t: "12:00", avg: 20, rides: 3 }]);
});

test("recording writes nothing while parks are closed", async () => {
  const env = makeEnv();
  assert.equal(await recordParkSample(env, [], NOON_ET, async () => ({})), false);
  assert.equal(env.store.size, 0);
});

test("baseline dates share today's weekday", () => {
  const dates = baselineDates("2026-10-30");
  assert.equal(dates[0], "2026-10-23");
  assert.ok(dates.includes("2025-10-31"));
  for (const d of dates) assert.equal(new Date(d + "T12:00:00Z").getUTCDay(), 5);
});

test("without history a park reports its current wait and no comparison", () => {
  const { parks, best } = buildTrends(day({ mk: [["11:45", 40]], ep: [["11:45", 25]] }), [], NOON_ET);
  const mk = parks.find((p) => p.id === "mk");
  assert.equal(mk.current, 40);
  assert.equal(mk.status, null);
  assert.deepEqual(mk.projection, []);
  assert.deepEqual(best, { parkId: "ep", basis: "current" });
});

test("one past day is not enough to call a park unusual", () => {
  const history = [day({ mk: [["11:30", 20], ["11:45", 20]] })];
  const { parks } = buildTrends(day({ mk: [["11:30", 40], ["11:45", 40]] }), history, NOON_ET);
  assert.equal(parks[0].status, null);
});

test("a busy morning scales the rest of the usual day", () => {
  const usual = [["11:30", 20], ["11:45", 20], ["12:00", 30], ["18:00", 10]];
  const history = [day({ mk: usual }), day({ mk: usual })];
  const { parks } = buildTrends(day({ mk: [["11:30", 30], ["11:45", 30]] }), history, NOON_ET);
  const [mk] = parks;
  assert.equal(mk.ratio, 1.5);
  assert.equal(mk.status, "busier");
  assert.deepEqual(mk.projection, [{ t: "12:00", avg: 45 }, { t: "18:00", avg: 15 }]);
  assert.equal(mk.projectedAvg, 30);
});

test("best park uses projections when every open park has one", () => {
  const usual = { mk: [["11:30", 20], ["11:45", 20], ["13:00", 60]], ep: [["11:30", 40], ["11:45", 40], ["13:00", 20]] };
  const today = day({ mk: [["11:30", 20], ["11:45", 20]], ep: [["11:30", 40], ["11:45", 40]] });
  const { best } = buildTrends(today, [day(usual), day(usual)], NOON_ET);
  assert.deepEqual(best, { parkId: "ep", basis: "projected" });
});

test("a park with stale readings counts as closed", () => {
  const { parks, best } = buildTrends(day({ mk: [["09:00", 5]], ep: [["11:45", 30]] }), [], NOON_ET);
  assert.equal(parks.find((p) => p.id === "mk").open, false);
  assert.equal(parks.find((p) => p.id === "mk").current, null);
  assert.equal(best.parkId, "ep");
});

test("all parks closed has no best park", () => {
  assert.equal(buildTrends(null, [], NOON_ET).best, null);
});

test("loadTrends reads today and past days from KV", async () => {
  const env = makeEnv();
  env.store.set("parks:history:2026-10-30", JSON.stringify(day({ mk: [["11:45", 30]] })));
  const trends = await loadTrends(env, NOON_ET);
  assert.equal(trends.date, "2026-10-30");
  assert.equal(trends.parks[0].current, 30);
});

test("park names shorten for labels", () => {
  assert.equal(shortParkName("Disney's Animal Kingdom Theme Park"), "Animal Kingdom");
  assert.equal(shortParkName("Disney's Hollywood Studios"), "Hollywood Studios");
  assert.equal(shortParkName("Magic Kingdom Park"), "Magic Kingdom");
  assert.equal(shortParkName("EPCOT"), "EPCOT");
});

const chartPark = {
  id: "mk", name: "Magic Kingdom Park",
  today: [{ t: "09:00", avg: 20 }, { t: "09:15", avg: 30 }],
  projection: [{ t: "10:00", avg: 40 }],
};

test("chart draws a solid and dashed line and escapes names", () => {
  const svg = buildChartSvg([{ ...chartPark, name: "A & B" }], 640);
  assert.equal((svg.match(/<path/g) || []).length, 2);
  assert.match(svg, /stroke-dasharray/);
  assert.match(svg, /A &amp; B/);
});

test("pointer reads the nearest time and marks projected values", () => {
  const reading = readingsAt([chartPark], 640, 10_000);
  assert.equal(reading.t, "10:00");
  assert.equal(reading.label, "10:00 AM");
  assert.deepEqual(reading.rows.map((r) => [r.avg, r.projected]), [[40, true]]);
});

test("labels state the comparison in words", () => {
  assert.match(statusLabel({ status: "busier", ratio: 1.22 }), /Busier than usual, \+22%/);
  assert.match(statusLabel({ status: "quieter", ratio: 0.7 }), /Quieter than usual, −30%/);
  assert.match(statusLabel({ status: "typical", ratio: 1 }), /Typical/);
});

test("best summary names its basis", () => {
  const parks = [{ id: "ep", name: "EPCOT", current: 24.6, projectedAvg: 31.2 }];
  assert.match(bestSummary({ parkId: "ep", basis: "current" }, parks), /right now: EPCOT, 25 min/);
  assert.match(bestSummary({ parkId: "ep", basis: "projected" }, parks), /rest of today: EPCOT, 31 min/);
  assert.equal(bestSummary(null, parks), "");
});

const REFERENCE = {
  generated_at: "2026-10-31T12:00:00Z",
  parks: { magic_kingdom: { hours: [{ hour: 11, avg: 20 }, { hour: 12, avg: 24 }, { hour: 13, avg: 28 }] } },
  rides: { spacemountain: { name: "Space Mountain", avg: 42, source: "ropedrop" } },
};
const MK_TODAY = { parks: { mk: { name: "Magic Kingdom Park", points: [{ t: "11:30", avg: 44 }, { t: "11:45", avg: 46 }] } } };

test("reference hours stretch onto 15-minute times", () => {
  assert.deepEqual(referenceCurve([{ hour: 11, avg: 20 }, { hour: 12, avg: 24 }]), [
    { t: "11:00", avg: 20 }, { t: "11:15", avg: 21 }, { t: "11:30", avg: 22 }, { t: "11:45", avg: 23 }, { t: "12:00", avg: 24 },
  ]);
});

test("reference curves do not bridge a missing hour", () => {
  assert.deepEqual(referenceCurve([{ hour: 11, avg: 20 }, { hour: 13, avg: 40 }]).map((p) => p.t), ["11:00", "13:00"]);
});

test("feed park names map to baseline keys", () => {
  assert.equal(referenceKey("Magic Kingdom Park"), "magic_kingdom");
  assert.equal(referenceKey("Disney's Hollywood Studios"), "hollywood_studios");
  assert.equal(referenceKey("Disney's Animal Kingdom Theme Park"), "animal_kingdom");
  assert.equal(referenceKey("EPCOT"), "epcot");
  assert.equal(referenceKey("Somewhere Else"), null);
});

test("the reference baseline compares and projects before own history exists", () => {
  const { parks, best } = buildTrends(MK_TODAY, [], NOON_ET, REFERENCE);
  const [mk] = parks;
  assert.equal(mk.baselineSource, "reference");
  assert.equal(mk.ratio, 2);
  assert.equal(mk.status, "busier");
  assert.equal(mk.projection[0].t, "12:00");
  assert.equal(mk.projection[0].avg, 48);
  assert.equal(best.basis, "projected");
});

test("own history replaces the reference baseline", () => {
  const usual = day({ mk: [["11:30", 44], ["11:45", 46], ["13:00", 50]] });
  usual.parks.mk.name = "Magic Kingdom Park";
  const [mk] = buildTrends(MK_TODAY, [usual, usual], NOON_ET, REFERENCE).parks;
  assert.equal(mk.baselineSource, "own");
  assert.equal(mk.ratio, 1);
  assert.equal(mk.status, "typical");
});

test("a park missing from the reference has no comparison", () => {
  const today = { parks: { x: { name: "EPCOT", points: [{ t: "11:30", avg: 44 }, { t: "11:45", avg: 46 }] } } };
  const [epcot] = buildTrends(today, [], NOON_ET, REFERENCE).parks;
  assert.equal(epcot.baselineSource, null);
  assert.equal(epcot.status, null);
});

test("loadTrends passes the stored baseline through", async () => {
  const env = makeEnv();
  env.store.set("parks:baseline", JSON.stringify(REFERENCE));
  env.store.set("parks:history:2026-10-30", JSON.stringify(MK_TODAY));
  const trends = await loadTrends(env, NOON_ET);
  assert.equal(trends.baseline_as_of, REFERENCE.generated_at);
  assert.equal(trends.parks[0].baselineSource, "reference");
});

test("usual waits match ride names regardless of punctuation", () => {
  const [known, unknown] = withUsualWaits([{ name: "Space-Mountain" }, { name: "Unknown Ride" }], REFERENCE);
  assert.equal(known.usualWait, 42);
  assert.equal(unknown.usualWait, null);
  assert.equal(withUsualWaits([{ name: "Space Mountain" }], null)[0].usualWait, null);
});
