import { loadTrends } from "../lib/park-trends.js";

// GET /api/park-trends — today's park waits compared with past readings
export async function onRequestGet({ env }) {
  return Response.json({ fetched_at: new Date().toISOString(), ...(await loadTrends(env)) });
}
