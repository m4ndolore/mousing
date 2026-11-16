// GET /api/notifications/log
export async function onRequestGet(context) {
  const { env } = context;
  const log = await env.KV.get("notifications:log", "json") || [];
  return Response.json({ log });
}
