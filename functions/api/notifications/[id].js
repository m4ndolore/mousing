// GET /api/notifications/:id — fetch a single notification with full match details
export async function onRequestGet(context) {
  const { env, params } = context;
  const id = params.id;

  const data = await env.KV.get(`notification:${id}`, "json");
  if (!data) {
    return Response.json({ error: "Notification not found" }, { status: 404 });
  }

  return Response.json(data);
}
