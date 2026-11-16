import { applyCheckInterval } from "../../lib/intervals.js";
import { dateRangeError } from "../../lib/watch-validation.js";

// GET /api/watches — list all watches
// POST /api/watches — create a new watch
export async function onRequestGet(context) {
  const { env } = context;
  const index = await env.KV.get("watches:index", "json") || [];

  const watches = [];
  for (const id of index) {
    const watch = await env.KV.get(`watch:${id}`, "json");
    if (watch) watches.push(watch);
  }

  return Response.json({ watches });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const rangeError = dateRangeError(body.date_range);
  if (rangeError) return Response.json({ error: rangeError }, { status: 400 });

  const id = `watch_${Date.now().toString(36)}`;
  const watch = {
    id,
    type: "lightning_lane",
    name: body.name || "Lightning Lane alert",
    date_range: body.date_range || null,
    attractions: body.attractions || [],
    time_window: body.time_window || null,
    enabled: true,
    created_at: new Date().toISOString(),
    last_checked: null,
    last_match: null,
  };
  applyCheckInterval(watch, body.check_interval_minutes);

  await env.KV.put(`watch:${id}`, JSON.stringify(watch));

  const index = await env.KV.get("watches:index", "json") || [];
  index.push(id);
  await env.KV.put("watches:index", JSON.stringify(index));

  return Response.json({ watch }, { status: 201 });
}
