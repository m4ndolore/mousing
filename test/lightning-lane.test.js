import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WDW_DESTINATION_ID,
  buildLightningLaneMatch,
  fetchWdwParks,
  findAttraction,
  inTimeWindow,
  isTripDay,
  listLightningLanes,
  parkDate,
  parkTime,
  readLightningLane,
  shouldAlert,
} from "../functions/lib/lightning-lane.js";
import watcher, { formatLightningLaneMessage } from "../src/cron/watcher.js";
import { onRequestGet as getLightningLanes } from "../functions/api/lightning-lane.js";

function attraction(name, queue, extra = {}) {
  return { id: `id-${name}`, name, entityType: "ATTRACTION", status: "OPERATING", queue, ...extra };
}

function slinky(state, returnStart, returnEnd) {
  return attraction("Slinky Dog Dash", {
    STANDBY: { waitTime: 75 },
    RETURN_TIME: { state, returnStart, returnEnd },
  });
}

const liveData = [
  attraction("Slinky Dog Dash Meet", { STANDBY: { waitTime: 5 } }),
  slinky("AVAILABLE", "2026-10-29T14:35:00-04:00", "2026-10-29T15:35:00-04:00"),
  attraction("Star Wars: Rise of the Resistance", {
    STANDBY: { waitTime: 90 },
    PAID_RETURN_TIME: {
      state: "AVAILABLE",
      returnStart: "2026-10-29T18:00:00-04:00",
      returnEnd: "2026-10-29T19:00:00-04:00",
      price: { amount: 2500, currency: "USD" },
    },
  }),
  attraction("Hollywood Brown Derby", {}, { entityType: "RESTAURANT" }),
];

test("findAttraction prefers exact names over partial matches", () => {
  assert.equal(findAttraction(liveData, "slinky dog dash").id, "id-Slinky Dog Dash");
  assert.equal(findAttraction(liveData, "Rise of the Resistance").name, "Star Wars: Rise of the Resistance");
  assert.equal(findAttraction(liveData, "Brown Derby"), null);
});

test("readLightningLane handles Multi Pass, Single Pass and no LL", () => {
  const multi = readLightningLane(findAttraction(liveData, "Slinky Dog Dash"));
  assert.equal(multi.paid, false);
  assert.equal(multi.state, "AVAILABLE");
  assert.equal(multi.standbyWait, 75);
  assert.equal(multi.price, null);

  const single = readLightningLane(findAttraction(liveData, "Rise of the Resistance"));
  assert.equal(single.paid, true);
  assert.equal(single.price, 25);

  assert.equal(readLightningLane(findAttraction(liveData, "Slinky Dog Dash Meet")), null);
  assert.equal(readLightningLane(null), null);
});

test("listLightningLanes only returns attractions with an LL queue", () => {
  assert.deepEqual(
    listLightningLanes(liveData).map((a) => a.name),
    ["Slinky Dog Dash", "Star Wars: Rise of the Resistance"]
  );
});

test("listLightningLanes labels each ride with its park", () => {
  const feed = [
    attraction("Frozen Ever After", { RETURN_TIME: { state: "AVAILABLE" } }, { parkId: "epcot" }),
    attraction("Mystery Ride", { RETURN_TIME: { state: "FINISHED" } }, { parkId: "unknown" }),
  ];
  const list = listLightningLanes(feed, { epcot: "EPCOT" });
  assert.deepEqual(list.map((a) => [a.name, a.parkName]), [
    ["Frozen Ever After", "EPCOT"],
    ["Mystery Ride", null],
  ]);
});

test("fetchWdwParks maps park ids to names and skips non-parks", async () => {
  let requested;
  const parks = await fetchWdwParks(async (url) => {
    requested = url;
    return Response.json({ children: [
      { id: "epcot", name: "EPCOT", entityType: "PARK" },
      { id: "hotel", name: "Disney's Beach Club Resort", entityType: "HOTEL" },
    ] });
  });
  assert.equal(requested, `https://api.themeparks.wiki/v1/entity/${WDW_DESTINATION_ID}/children`);
  assert.deepEqual(parks, { epcot: "EPCOT" });
});

test("parkTime and parkDate use Walt Disney World local time", () => {
  assert.equal(parkTime("2026-10-29T14:35:00-04:00"), "14:35");
  assert.equal(parkTime("2026-10-29T18:35:00Z"), "14:35");
  // 02:00 UTC on Oct 30 is still Oct 29 in Orlando
  assert.equal(parkDate(new Date("2026-10-30T02:00:00Z")), "2026-10-29");
});

test("inTimeWindow supports open-ended windows", () => {
  assert.equal(inTimeWindow("14:35", null), true);
  assert.equal(inTimeWindow("14:35", { start: "13:00", end: "16:00" }), true);
  assert.equal(inTimeWindow("16:00", { start: "13:00", end: "16:00" }), true);
  assert.equal(inTimeWindow("16:05", { start: "13:00", end: "16:00" }), false);
  assert.equal(inTimeWindow("12:00", { start: "13:00", end: null }), false);
  assert.equal(inTimeWindow("09:00", { start: null, end: "10:00" }), true);
});

test("isTripDay limits checks to the configured park days", () => {
  assert.equal(isTripDay("2026-10-29", null), true);
  assert.equal(isTripDay("2026-10-29", { start: "2026-10-28", end: "2026-10-30" }), true);
  assert.equal(isTripDay("2026-10-31", { start: "2026-10-28", end: "2026-10-30" }), false);
});

test("shouldAlert fires only on high-value changes", () => {
  const window = { start: "13:00", end: "16:00" };
  const at = (state, time) => ({ state, returnStart: `2026-10-29T${time}:00-04:00` });

  assert.equal(shouldAlert(null, at("AVAILABLE", "14:35"), window), true, "first sighting");
  assert.equal(shouldAlert(at("FINISHED", "14:35"), at("AVAILABLE", "14:35"), window), true, "restock");
  assert.equal(shouldAlert(at("AVAILABLE", "17:00"), at("AVAILABLE", "15:30"), window), true, "enters window");
  assert.equal(shouldAlert(at("AVAILABLE", "14:35"), at("AVAILABLE", "14:20"), window), true, "15 min earlier");
  assert.equal(shouldAlert(at("AVAILABLE", "14:35"), at("AVAILABLE", "14:25"), window), false, "small move earlier");
  assert.equal(shouldAlert(at("AVAILABLE", "14:35"), at("AVAILABLE", "15:10"), window), false, "later");
  assert.equal(shouldAlert(at("AVAILABLE", "14:35"), at("AVAILABLE", "14:35"), window), false, "unchanged");
  assert.equal(shouldAlert(null, at("AVAILABLE", "17:00"), window), false, "outside window");
  assert.equal(shouldAlert(at("AVAILABLE", "14:35"), at("FINISHED", "14:35"), window), false, "sold out");
  assert.equal(shouldAlert(null, { state: "AVAILABLE", returnStart: null }, window), false, "no time");
});

test("LL alert text names the attraction and return window", () => {
  const match = buildLightningLaneMatch(readLightningLane(findAttraction(liveData, "Slinky Dog Dash")));
  const text = formatLightningLaneMessage("Slinky", [match]);
  assert.match(text, /Slinky Dog Dash — return 2:35\s?PM–3:35\s?PM \(Multi Pass, standby 75 min\)/);
});

async function withFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("API groups rides by park and survives a failed park lookup", async () => {
  const feed = [attraction("Test Track", { RETURN_TIME: { state: "AVAILABLE" } }, { parkId: "epcot" })];
  const live = async (url) => (String(url).endsWith("/live")
    ? Response.json({ liveData: feed })
    : Response.json({ children: [{ id: "epcot", name: "EPCOT", entityType: "PARK" }] }));
  const ok = await (await withFetch(live, getLightningLanes)).json();
  assert.equal(ok.attractions[0].parkName, "EPCOT");

  const noParks = async (url) => (String(url).endsWith("/live")
    ? Response.json({ liveData: feed })
    : new Response("down", { status: 503 }));
  const fallback = await (await withFetch(noParks, getLightningLanes)).json();
  assert.equal(fallback.attractions[0].parkName, null);

  const down = await withFetch(async () => new Response("down", { status: 503 }), getLightningLanes);
  assert.equal(down.status, 502);
});

function mockEnv(entries = {}) {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    json: (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
    KV: {
      get: async (key, type) => {
        const value = store.get(key);
        return type === "json" && value ? JSON.parse(value) : value ?? null;
      },
      put: async (key, value) => store.set(key, value),
      delete: async (key) => store.delete(key),
    },
  };
}

async function runCron(env, feed, event = {}) {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return Response.json({ liveData: feed });
  };
  try {
    let pending;
    await watcher.scheduled(event, env, { waitUntil: (p) => { pending = p; } });
    await pending;
  } finally {
    globalThis.fetch = originalFetch;
  }
  return requested;
}

function llWatch(extra = {}) {
  return {
    id: "w_ll",
    type: "lightning_lane",
    name: "Slinky",
    attractions: ["Slinky Dog Dash"],
    time_window: { start: "13:00", end: "16:00" },
    date_range: null,
    check_interval_minutes: 5,
    enabled: true,
    last_checked: null,
    ...extra,
  };
}

test("cron runs LL watches without a Disney token and alerts once per return time", async () => {
  const env = mockEnv({ "watches:index": ["w_ll"], "watch:w_ll": llWatch() });

  const requested = await runCron(env, [slinky("AVAILABLE", "2026-10-29T14:35:00-04:00")]);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /api\.themeparks\.wiki\/v1\/entity\/.+\/live$/);
  assert.equal(env.json("notifications:log").length, 1);
  assert.equal(env.json("notifications:cooldown").token_expired, undefined);

  const log = env.json("notifications:log");
  const notification = env.json(`notification:${log[0].id}`);
  assert.equal(notification.watch_type, "lightning_lane");
  assert.equal(notification.matches[0].resort, "Slinky Dog Dash");
  assert.equal(env.json("results:w_ll").attractions["Slinky Dog Dash"].state, "AVAILABLE");

  // Same return time: no new alert
  env.store.set("watch:w_ll", JSON.stringify({ ...env.json("watch:w_ll"), last_checked: null }));
  await runCron(env, [slinky("AVAILABLE", "2026-10-29T14:35:00-04:00")]);
  assert.equal(env.json("notifications:log").length, 1);

  // Return time drifted later: no new alert
  env.store.set("watch:w_ll", JSON.stringify({ ...env.json("watch:w_ll"), last_checked: null }));
  await runCron(env, [slinky("AVAILABLE", "2026-10-29T15:20:00-04:00")]);
  assert.equal(env.json("notifications:log").length, 1);

  // Return time jumped earlier: alert
  env.store.set("watch:w_ll", JSON.stringify({ ...env.json("watch:w_ll"), last_checked: null }));
  await runCron(env, [slinky("AVAILABLE", "2026-10-29T14:30:00-04:00")]);
  assert.equal(env.json("notifications:log").length, 2);
});

test("one watch covers several Epcot rides and alerts only for in-window ones", async () => {
  const epcotRide = (name, time) => attraction(name, {
    RETURN_TIME: { state: "AVAILABLE", returnStart: `2026-10-29T${time}:00-04:00` },
  });
  const env = mockEnv({
    "watches:index": ["w_epcot"],
    "watch:w_epcot": llWatch({
      id: "w_epcot",
      name: "EPCOT Lightning Lanes",
      attractions: ["Frozen Ever After", "Test Track", "Remy's Ratatouille Adventure"],
    }),
  });
  await runCron(env, [
    epcotRide("Frozen Ever After", "14:00"),
    epcotRide("Test Track", "18:30"),
    epcotRide("Remy's Ratatouille Adventure", "15:45"),
  ]);

  const [entry] = env.json("notifications:log");
  const notification = env.json(`notification:${entry.id}`);
  assert.deepEqual(
    notification.matches.map((m) => m.resort),
    ["Frozen Ever After", "Remy's Ratatouille Adventure"]
  );
  assert.equal(Object.keys(env.json("results:w_epcot").attractions).length, 3);
});

const openRides = ["A", "B", "C"].map((name) => ({
  id: name, name, parkId: "mk", entityType: "ATTRACTION", status: "OPERATING", queue: { STANDBY: { waitTime: 30 } },
}));

test("cron records park waits on a quarter hour, using the scheduled time", async () => {
  const env = mockEnv({ "watches:index": [] });
  await runCron(env, openRides, { scheduledTime: Date.parse("2026-10-30T12:15:00-04:00") });
  const record = env.json("parks:history:2026-10-30");
  assert.deepEqual(record.parks.mk.points, [{ t: "12:15", avg: 30, rides: 3 }]);
});

test("cron records no park waits between quarter hours", async () => {
  const env = mockEnv({ "watches:index": [] });
  const requested = await runCron(env, openRides, { scheduledTime: Date.parse("2026-10-30T12:16:00-04:00") });
  assert.equal(requested.length, 0);
  assert.equal(env.json("parks:history:2026-10-30"), null);
});

test("a failed park sample does not stop watches", async () => {
  const env = mockEnv({ "watches:index": ["w_ll"], "watch:w_ll": llWatch() });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error("feed down");
    return Response.json({ liveData: [slinky("AVAILABLE", "2026-10-29T14:35:00-04:00")] });
  };
  try {
    let pending;
    await watcher.scheduled({ scheduledTime: Date.parse("2026-10-30T12:15:00-04:00") }, env, { waitUntil: (p) => { pending = p; } });
    await pending;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(env.json("watch:w_ll").last_checked);
});

test("cron skips LL checks outside the trip dates", async () => {
  const env = mockEnv({
    "watches:index": ["w_ll"],
    "watch:w_ll": llWatch({ date_range: { start: "2000-01-01", end: "2000-01-02" } }),
  });
  const requested = await runCron(env, [slinky("AVAILABLE", "2026-10-29T14:35:00-04:00")]);
  assert.equal(requested.length, 0);
  assert.ok(env.json("watch:w_ll").last_checked);
  assert.equal(env.json("notifications:log"), null);
});

test("the demo samples parks but runs no alerts", async () => {
  const env = mockEnv({ "watches:index": ["w_ll"], "watch:w_ll": llWatch() });
  env.DEMO_MODE = "true";
  await runCron(env, [slinky("AVAILABLE", "2026-10-29T14:35:00-04:00")]);
  assert.equal(env.json("watch:w_ll").last_checked, null);
  assert.equal(env.json("notifications:log"), null);
});
