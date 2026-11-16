// GET /api/lightning-lane/dashboard — saved dashboard rides and refresh rate
// PUT /api/lightning-lane/dashboard — save them
const CONFIG_KEY = "config:ll_dashboard";
const REFRESH_MINUTES = [0, 1, 2, 5]; // 0 means manual refresh only
const DEFAULT_REFRESH_MINUTES = 2;
const MAX_RIDES = 100;

export async function onRequestGet({ env }) {
  const saved = await env.KV.get(CONFIG_KEY, "json");
  return Response.json(saved || { attractions: null, refresh_minutes: DEFAULT_REFRESH_MINUTES });
}

export async function onRequestPut({ request, env }) {
  const body = await request.json();
  const { attractions, refresh_minutes: refresh } = body;
  if (
    !Array.isArray(attractions)
    || attractions.length > MAX_RIDES
    || !attractions.every((name) => typeof name === "string" && name)
  ) {
    return Response.json({ error: "attractions must be a list of ride names" }, { status: 400 });
  }
  if (!REFRESH_MINUTES.includes(refresh)) {
    return Response.json({ error: "refresh_minutes must be 0, 1, 2 or 5" }, { status: 400 });
  }
  const config = { attractions: [...new Set(attractions)], refresh_minutes: refresh };
  await env.KV.put(CONFIG_KEY, JSON.stringify(config));
  return Response.json(config);
}
