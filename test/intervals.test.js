import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCheckInterval,
  expireFastInterval,
  isWatchDue,
  normalizeInterval,
} from "../functions/lib/intervals.js";
import { onRequestPost as createWatch } from "../functions/api/watches/index.js";
import { onRequestPut as updateWatch } from "../functions/api/watches/[id].js";

const NOW = new Date("2026-10-29T20:20:00-04:00");
const minutesAfter = (date, min) => new Date(date.getTime() + min * 60_000);

test("normalizeInterval still rejects fast and unknown values", () => {
  assert.equal(normalizeInterval(5), 5);
  assert.equal(normalizeInterval(1), 15);
  assert.equal(normalizeInterval(20), 15);
});

test("fast interval on a Lightning Lane watch lasts two hours", () => {
  const watch = applyCheckInterval({ type: "lightning_lane" }, 1, NOW);
  assert.equal(watch.check_interval_minutes, 1);
  assert.equal(watch.fast_until, minutesAfter(NOW, 120).toISOString());
});

test("an unknown interval falls back to 15 minutes with no fast window", () => {
  const watch = applyCheckInterval({ type: "lightning_lane" }, 20, NOW);
  assert.equal(watch.check_interval_minutes, 15);
  assert.equal(watch.fast_until, null);
});

test("choosing a normal interval clears an earlier fast window", () => {
  const watch = applyCheckInterval(
    { type: "lightning_lane", check_interval_minutes: 1, fast_until: NOW.toISOString() },
    15,
    NOW
  );
  assert.equal(watch.check_interval_minutes, 15);
  assert.equal(watch.fast_until, null);
});

test("fast interval reverts to 5 minutes once its window passes", () => {
  const watch = applyCheckInterval({ type: "lightning_lane" }, 2, NOW);
  assert.equal(expireFastInterval(watch, minutesAfter(NOW, 119)), false);
  assert.equal(watch.check_interval_minutes, 2);

  assert.equal(expireFastInterval(watch, minutesAfter(NOW, 120)), true);
  assert.equal(watch.check_interval_minutes, 5);
  assert.equal(watch.fast_until, null);
});

test("watches without a fast window never expire", () => {
  const watch = { type: "lightning_lane", check_interval_minutes: 5 };
  assert.equal(expireFastInterval(watch, NOW), false);
  assert.equal(watch.check_interval_minutes, 5);
});

test("due check runs each interval on the matching once-a-minute tick", () => {
  // last_checked lands a few seconds after the tick that processed it.
  const lastTick = NOW;
  const last_checked = new Date(lastTick.getTime() + 8_000).toISOString();
  const dueTicks = (interval) => [1, 2, 3, 4, 5]
    .filter((m) => isWatchDue({ check_interval_minutes: interval, last_checked }, minutesAfter(lastTick, m)));

  assert.deepEqual(dueTicks(1), [1, 2, 3, 4, 5]);
  assert.deepEqual(dueTicks(2), [2, 3, 4, 5]);
  assert.deepEqual(dueTicks(5), [5]);
});

test("never-checked watches are due and missing intervals default to 15", () => {
  assert.equal(isWatchDue({}, NOW), true);
  const last_checked = NOW.toISOString();
  assert.equal(isWatchDue({ last_checked }, minutesAfter(NOW, 14)), false);
  assert.equal(isWatchDue({ last_checked }, minutesAfter(NOW, 15)), true);
});

function mockEnv() {
  const store = new Map();
  return {
    store,
    KV: {
      get: async (k, t) => { const v = store.get(k); return v ? (t === "json" ? JSON.parse(v) : v) : null; },
      put: async (k, v) => { store.set(k, v); },
    },
  };
}

const jsonRequest = (body) => ({ json: async () => body });

test("watch API starts a fast window and ignores client-sent fast_until", async () => {
  const env = mockEnv();
  const created = await (await createWatch({
    env,
    request: jsonRequest({ type: "lightning_lane", check_interval_minutes: 1 }),
  })).json();
  assert.equal(created.watch.check_interval_minutes, 1);
  assert.ok(created.watch.fast_until);

  const params = { id: created.watch.id };
  const forged = await (await updateWatch({
    env, params, request: jsonRequest({ fast_until: "2099-01-01T00:00:00Z" }),
  })).json();
  assert.equal(forged.watch.fast_until, created.watch.fast_until);

  const slowed = await (await updateWatch({
    env, params, request: jsonRequest({ check_interval_minutes: 15 }),
  })).json();
  assert.equal(slowed.watch.check_interval_minutes, 15);
  assert.equal(slowed.watch.fast_until, null);
});

test("watch API stores every watch as a Lightning Lane watch", async () => {
  const env = mockEnv();
  const { watch } = await (await createWatch({
    env, request: jsonRequest({ type: "dvc", resorts: ["BCV"], check_interval_minutes: 5 }),
  })).json();
  assert.equal(watch.type, "lightning_lane");
  assert.equal(watch.resorts, undefined);

  const { watch: updated } = await (await updateWatch({
    env, params: { id: watch.id }, request: jsonRequest({ type: "dvc" }),
  })).json();
  assert.equal(updated.type, "lightning_lane");
});
