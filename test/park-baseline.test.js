import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeRopeDropBaseline,
  readParkHours,
  recordParkHours,
  refreshBaseline,
  seasonalOutlook,
} from "../functions/lib/park-baseline.js";
import { buildTrends, withUsualWaits } from "../functions/lib/park-trends.js";
import "../src/pages/assets/lightning-lane-form.js";
import "../src/pages/assets/park-trends.js";

const NOW = new Date("2026-11-02T12:00:00-05:00");
const SLUGS = ["magic_kingdom", "epcot", "hollywood_studios", "animal_kingdom"];

function makeEnv(entries = {}, vars = {}) {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    json: (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
    ...vars,
    KV: {
      get: async (key, type) => (store.has(key) ? (type === "json" ? JSON.parse(store.get(key)) : store.get(key)) : null),
      put: async (key, value) => store.set(key, value),
    },
  };
}

const SCHEDULE = {
  parks: [{
    id: "mk",
    schedule: [
      { date: "2026-11-02", type: "TICKETED_EVENT", openingTime: "2026-11-02T08:30:00-05:00", closingTime: "2026-11-02T09:00:00-05:00" },
      { date: "2026-11-02", type: "OPERATING", openingTime: "2026-11-02T09:00:00-05:00", closingTime: "2026-11-02T22:00:00-05:00" },
      { date: "2026-11-03", type: "OPERATING", openingTime: "2026-11-03T09:00:00-05:00", closingTime: "2026-11-03T18:00:00-05:00" },
    ],
  }, { id: "closed", schedule: [] }],
};

test("park hours use the regular operating day, not Early Entry", () => {
  assert.deepEqual(readParkHours(SCHEDULE, "2026-11-02"), { mk: { open: "09:00", close: "22:00" } });
  assert.deepEqual(readParkHours(SCHEDULE, "2026-11-03"), { mk: { open: "09:00", close: "18:00" } });
});

test("park hours are fetched once per day", async () => {
  const env = makeEnv();
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json(SCHEDULE); };
  assert.equal(await recordParkHours(env, NOW, fetchImpl), true);
  assert.equal(await recordParkHours(env, NOW, fetchImpl), false);
  assert.equal(calls, 1);
  assert.deepEqual(env.json("parks:hours:2026-11-02"), { mk: { open: "09:00", close: "22:00" } });
});

test("projections stop at closing time", () => {
  const today = { parks: { mk: { name: "Magic Kingdom Park", points: [{ t: "11:30", avg: 20 }, { t: "11:45", avg: 20 }] } } };
  const reference = { parks: { magic_kingdom: { hours: [11, 12, 13, 14, 15].map((hour) => ({ hour, avg: 20 })) } } };
  const [mk] = buildTrends(today, [], NOW, reference, { mk: { open: "09:00", close: "13:00" } }).parks;
  assert.equal(mk.projection.at(-1).t, "13:00");
  assert.equal(mk.closes, "13:00");
});

test("a park counts as closed after closing time", () => {
  const today = { parks: { mk: { name: "Magic Kingdom Park", points: [{ t: "11:45", avg: 20 }] } } };
  const [mk] = buildTrends(today, [], NOW, null, { mk: { open: "09:00", close: "11:50" } }).parks;
  assert.equal(mk.open, false);
});

const strategy = (avg) => ({ peak_hours: { hourly_breakdown: [{ hour: 7, all_rides_avg: 0 }, { hour: 9, all_rides_avg: avg }] } });
const STRATEGIES = Object.fromEntries(SLUGS.map((slug) => [slug, strategy(20)]));
const PREVIOUS = {
  generated_at: "2026-10-01T00:00:00Z",
  seasonal: { magic_kingdom: { months: { Nov: 53 }, weekdays: { Mon: 59 } } },
  rides: {
    peterpansflight: { name: "Peter Pan's Flight", avg: 51, source: "queue-times" },
    oldride: { name: "Old Ride", avg: 10, source: "ropedrop" },
  },
};

test("merge replaces RopeDrop parts and keeps hand-built rides and seasonal levels", () => {
  const merged = mergeRopeDropBaseline(PREVIOUS, {
    strategies: STRATEGIES,
    topWaits: [{ name: "TRON Lightcycle / Run", avg_wait: 61 }],
    sellouts: [{ entity_id: "tron", name: "TRON Lightcycle / Run", typical_time: "11:45 AM", sellout_frequency: 0.95 }],
  }, NOW);
  assert.deepEqual(merged.parks.magic_kingdom.hours, [{ hour: 9, avg: 20 }]);
  assert.equal(merged.rides.peterpansflight.avg, 51);
  assert.equal(merged.rides.oldride, undefined);
  assert.equal(merged.rides.tronlightcyclerun.avg, 61);
  assert.deepEqual(merged.sellouts.tron, { name: "TRON Lightcycle / Run", typicalTime: "11:45 AM", frequency: 0.95 });
  assert.deepEqual(merged.seasonal, PREVIOUS.seasonal);
  assert.equal(merged.generated_at, NOW.toISOString());
});

test("merge refuses a refresh missing a park", () => {
  const strategies = { ...STRATEGIES, epcot: {} };
  assert.equal(mergeRopeDropBaseline(PREVIOUS, { strategies, topWaits: [], sellouts: [] }, NOW), null);
});

function ropeDropFetch(seen, failSellouts = false) {
  return async (url, init) => {
    seen.push({ url: String(url), agent: init.headers["User-Agent"] });
    if (url.includes("/strategy/")) return Response.json(strategy(25));
    if (url.includes("/top-waits")) return Response.json({ rides: [{ name: "Space Mountain", avg_wait: 42 }] });
    if (failSellouts) return new Response("down", { status: 503 });
    return Response.json({ rides: [] });
  };
}

test("refresh is off without a contact address", async () => {
  const seen = [];
  assert.equal(await refreshBaseline(makeEnv(), NOW, ropeDropFetch(seen)), "disabled");
  assert.equal(seen.length, 0);
});

test("refresh identifies itself and replaces a week-old baseline", async () => {
  const env = makeEnv({ "parks:baseline": PREVIOUS }, { ROPEDROP_CONTACT: "owner@example.com" });
  const seen = [];
  assert.equal(await refreshBaseline(env, NOW, ropeDropFetch(seen)), "refreshed");
  assert.equal(seen.length, 9);
  assert.ok(seen.every((call) => call.agent === "mousing/0.1 (owner@example.com)"));
  assert.equal(env.json("parks:baseline").rides.spacemountain.avg, 42);
  assert.deepEqual(env.json("parks:baseline").seasonal, PREVIOUS.seasonal);
});

test("refresh skips a fresh baseline and waits after a recent attempt", async () => {
  const fresh = makeEnv({ "parks:baseline": { ...PREVIOUS, generated_at: "2026-11-01T00:00:00Z" } }, { ROPEDROP_CONTACT: "a@b.c" });
  assert.equal(await refreshBaseline(fresh, NOW, ropeDropFetch([])), "fresh");
  const attempted = makeEnv({ "parks:baseline": PREVIOUS, "parks:baseline:attempt": "x" }, { ROPEDROP_CONTACT: "a@b.c" });
  assert.equal(await refreshBaseline(attempted, NOW, ropeDropFetch([])), "waiting");
});

test("failed sell-outs still refresh the curves", async () => {
  const env = makeEnv({ "parks:baseline": PREVIOUS }, { ROPEDROP_CONTACT: "a@b.c" });
  assert.equal(await refreshBaseline(env, NOW, ropeDropFetch([], true)), "refreshed");
  assert.deepEqual(env.json("parks:baseline").sellouts, {});
});

const SEASONAL = {
  magic_kingdom: {
    months: { Jan: 56, Feb: 65, Mar: 69, Apr: 59, May: 48, Jun: 54, Jul: 54, Aug: 43, Sep: 28, Oct: 44, Nov: 53, Dec: 59 },
    weekdays: { Sun: 44, Mon: 59, Tue: 52, Wed: 57, Thu: 48, Fri: 48, Sat: 58 },
  },
};

test("outlook compares this month and weekday with the park's own average", () => {
  const [mk] = seasonalOutlook(SEASONAL, "2026-11-02");
  assert.equal(mk.name, "Magic Kingdom");
  assert.deepEqual([mk.month, mk.monthLevel, mk.weekday, mk.weekdayLevel, mk.average], ["Nov", 53, "Mon", 59, 53]);
  assert.equal(mk.label, "busier");
});

test("outlook marks a quiet month and weekday", () => {
  assert.equal(seasonalOutlook(SEASONAL, "2026-09-06")[0].label, "quieter");
});

test("outlook is empty without seasonal data", () => {
  assert.deepEqual(seasonalOutlook(undefined, "2026-11-02"), []);
  assert.deepEqual(seasonalOutlook({ epcot: { months: {}, weekdays: {} } }, "2026-11-02"), []);
});

test("rides get their sell-out time by attraction ID", () => {
  const baseline = { sellouts: { tron: { typicalTime: "11:45 AM", frequency: 0.95 } } };
  const [tron, other] = withUsualWaits([{ name: "TRON", attractionId: "tron" }, { name: "Other", attractionId: "x" }], baseline);
  assert.equal(tron.sellout.typicalTime, "11:45 AM");
  assert.equal(other.sellout, null);
});

test("ride detail warns only for rides that usually sell out", () => {
  const { rideDetail } = globalThis.LightningLaneForm;
  assert.equal(rideDetail({ standbyWait: 60, sellout: { typicalTime: "11:45 AM", frequency: 0.95 } }), "Standby 60 min · usually gone by 11:45 AM");
  assert.equal(rideDetail({ standbyWait: 60, sellout: { typicalTime: "4:00 PM", frequency: 0.2 } }), "Standby 60 min");
});

test("outlook names the day and month once, in the heading", () => {
  const { outlookHeading, outlookLabel, outlookDetail } = globalThis.ParkTrends;
  const row = { label: "busier", weekday: "Mon", month: "Nov", monthLevel: 53, weekdayLevel: 59, average: 53 };
  assert.equal(outlookHeading([row]), "Usual crowds for a Monday in November");
  assert.equal(outlookHeading([]), "");
  assert.equal(outlookLabel(row), "▲ Busier than its average");
  assert.equal(outlookLabel({ ...row, label: "average" }), "● Near its average");
  assert.equal(outlookDetail(row), "Nov 53%, Mon 59%, average 53%");
});
