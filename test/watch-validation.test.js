import { test } from "node:test";
import assert from "node:assert/strict";
import { dateRangeError } from "../functions/lib/watch-validation.js";
import { onRequestPost } from "../functions/api/watches/index.js";
import { onRequestPut } from "../functions/api/watches/[id].js";

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

const jsonRequest = (method, body) =>
  new Request("https://example.test/api/watches", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("no range, or a forward range, is accepted", () => {
  assert.equal(dateRangeError(null), null);
  assert.equal(dateRangeError(undefined), null);
  assert.equal(dateRangeError({ start: "2026-12-10", end: "2026-12-10" }), null);
  assert.equal(dateRangeError({ start: "2026-12-10", end: "2026-12-14" }), null);
});

test("an inverted, partial or malformed range is rejected", () => {
  assert.match(dateRangeError({ start: "2026-12-14", end: "2026-12-10" }), /on or after/);
  assert.match(dateRangeError({ start: "2026-12-14" }), /YYYY-MM-DD/);
  assert.match(dateRangeError({ start: "12/14/2026", end: "12/20/2026" }), /YYYY-MM-DD/);
  assert.match(dateRangeError("2026-12-14"), /object/);
});

test("POST /api/watches refuses an inverted range and stores nothing", async () => {
  const kv = memoryKv();
  const res = await onRequestPost({
    request: jsonRequest("POST", { name: "x", date_range: { start: "2026-12-14", end: "2026-12-10" } }),
    env: { KV: kv },
  });
  assert.equal(res.status, 400);
  assert.equal(kv.store.size, 0);
});

test("PUT /api/watches/:id refuses an inverted range and keeps the old one", async () => {
  const original = { id: "w1", name: "x", date_range: { start: "2026-12-10", end: "2026-12-14" } };
  const kv = memoryKv({ "watch:w1": original });
  const res = await onRequestPut({
    request: jsonRequest("PUT", { date_range: { start: "2026-12-20", end: "2026-12-01" } }),
    env: { KV: kv },
    params: { id: "w1" },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await kv.get("watch:w1", "json"), original);
});

test("PUT without date_range, such as the enable toggle, still works", async () => {
  const kv = memoryKv({ "watch:w1": { id: "w1", enabled: true, date_range: null } });
  const res = await onRequestPut({
    request: jsonRequest("PUT", { enabled: false }),
    env: { KV: kv },
    params: { id: "w1" },
  });
  assert.equal(res.status, 200);
  assert.equal((await kv.get("watch:w1", "json")).enabled, false);
});
