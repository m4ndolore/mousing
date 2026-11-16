// GET /api/config — notification settings
// PUT /api/config — save them
const DEFAULT_NOTIFICATIONS = { email_enabled: false, email: "" };

export async function onRequestGet({ env }) {
  const notifications = await env.KV.get("config:notifications", "json");
  return Response.json({ notifications: notifications || DEFAULT_NOTIFICATIONS });
}

export async function onRequestPut({ request, env }) {
  const { notifications } = await request.json();
  if (!notifications || typeof notifications !== "object") {
    return Response.json({ error: "notifications must be an object" }, { status: 400 });
  }
  const saved = {
    email_enabled: notifications.email_enabled === true,
    email: typeof notifications.email === "string" ? notifications.email.trim().slice(0, 254) : "",
  };
  await env.KV.put("config:notifications", JSON.stringify(saved));
  return Response.json({ success: true });
}
