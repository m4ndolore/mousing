import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet, onRequestPut } from "../functions/api/lightning-lane/dashboard.js";

function mockEnv() {
  const store = new Map();
  return {
    KV: {
      get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
      put: async (k, v) => { store.set(k, v); },
    },
  };
}

const put = (env, body) => onRequestPut({ env, request: { json: async () => body } });

test("dashboard defaults to no saved rides and a 2-minute refresh", async () => {
  const body = await (await onRequestGet({ env: mockEnv() })).json();
  assert.deepEqual(body, { attractions: null, refresh_minutes: 2 });
});

test("dashboard saves rides without duplicates", async () => {
  const env = mockEnv();
  const res = await put(env, { attractions: ["Slinky Dog Dash", "Slinky Dog Dash"], refresh_minutes: 1 });
  assert.equal(res.status, 200);
  const body = await (await onRequestGet({ env })).json();
  assert.deepEqual(body, { attractions: ["Slinky Dog Dash"], refresh_minutes: 1 });
});

test("dashboard rejects bad rides and refresh rates", async () => {
  const env = mockEnv();
  assert.equal((await put(env, { attractions: "Slinky", refresh_minutes: 1 })).status, 400);
  assert.equal((await put(env, { attractions: [""], refresh_minutes: 1 })).status, 400);
  assert.equal((await put(env, { attractions: [], refresh_minutes: 3 })).status, 400);
});
