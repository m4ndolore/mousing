import { applyCheckInterval } from "../../lib/intervals.js";
import { dateRangeError } from "../../lib/watch-validation.js";

// GET /api/watches/:id
// PUT /api/watches/:id
// DELETE /api/watches/:id
export async function onRequestGet(context) {
  const { env, params } = context;
  const watch = await env.KV.get(`watch:${params.id}`, "json");
  if (!watch) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ watch });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const existing = await env.KV.get(`watch:${params.id}`, "json");
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  if ("date_range" in body) {
    const rangeError = dateRangeError(body.date_range);
    if (rangeError) return Response.json({ error: rangeError }, { status: 400 });
  }
  const { fast_until: _ignored, ...changes } = body;
  const updated = { ...existing, ...changes, id: params.id, type: "lightning_lane" };
  if ("check_interval_minutes" in body) {
    applyCheckInterval(updated, body.check_interval_minutes);
  }
  await env.KV.put(`watch:${params.id}`, JSON.stringify(updated));

  return Response.json({ watch: updated });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  await env.KV.delete(`watch:${params.id}`);

  const index = await env.KV.get("watches:index", "json") || [];
  const newIndex = index.filter((id) => id !== params.id);
  await env.KV.put("watches:index", JSON.stringify(newIndex));

  await env.KV.delete(`results:${params.id}`);

  return Response.json({ success: true });
}
