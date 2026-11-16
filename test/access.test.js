import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAccess } from "../functions/lib/access.js";

const request = (path, { method = "GET", key } = {}) => new Request(`https://mousing.test${path}`, {
  method,
  headers: key ? { Authorization: `Bearer ${key}` } : {},
});

test("live park data is public on every deployment", async () => {
  for (const env of [{}, { DEMO_MODE: "true" }, { ADMIN_TOKEN: "secret" }]) {
    for (const path of ["/api/lightning-lane", "/api/park-trends", "/api/mode"]) {
      assert.equal(await checkAccess(request(path), env), null, `${path} with ${JSON.stringify(env)}`);
    }
  }
});

test("the demo refuses owner routes even with a key", async () => {
  const env = { DEMO_MODE: "true", ADMIN_TOKEN: "secret" };
  for (const [path, method] of [["/api/watches", "GET"], ["/api/watches", "POST"], ["/api/config", "GET"], ["/api/push/subscribe", "POST"]]) {
    const denied = await checkAccess(request(path, { method, key: "secret" }), env);
    assert.equal(denied.status, 403, `${method} ${path}`);
  }
});

test("a self-hosted deployment without ADMIN_TOKEN refuses owner routes", async () => {
  const denied = await checkAccess(request("/api/watches"), {});
  assert.equal(denied.status, 503);
});

test("owner routes need the matching key", async () => {
  const env = { ADMIN_TOKEN: "secret" };
  assert.equal((await checkAccess(request("/api/watches"), env)).status, 401);
  assert.equal((await checkAccess(request("/api/watches", { key: "wrong" }), env)).status, 401);
  assert.equal(await checkAccess(request("/api/watches", { method: "POST", key: "secret" }), env), null);
});

test("writes to public paths still need the key", async () => {
  const denied = await checkAccess(request("/api/lightning-lane", { method: "POST" }), { ADMIN_TOKEN: "secret" });
  assert.equal(denied.status, 401);
});
