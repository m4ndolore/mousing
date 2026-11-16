const KV_KEY = "push:subscriptions";

// POST /api/push/subscribe — store a push subscription
export async function onRequestPost(context) {
  const { env, request } = context;
  const subscription = await request.json();

  if (!subscription?.endpoint || !subscription?.keys) {
    return Response.json({ error: "Invalid subscription" }, { status: 400 });
  }

  const subs = (await env.KV.get(KV_KEY, "json")) || [];

  // Avoid duplicates
  if (!subs.some((s) => s.endpoint === subscription.endpoint)) {
    subs.push(subscription);
    await env.KV.put(KV_KEY, JSON.stringify(subs));
  }

  return Response.json({ success: true, count: subs.length });
}

// DELETE /api/push/subscribe — remove a push subscription
export async function onRequestDelete(context) {
  const { env, request } = context;
  const { endpoint } = await request.json();

  if (!endpoint) {
    return Response.json({ error: "Missing endpoint" }, { status: 400 });
  }

  const subs = (await env.KV.get(KV_KEY, "json")) || [];
  const filtered = subs.filter((s) => s.endpoint !== endpoint);
  await env.KV.put(KV_KEY, JSON.stringify(filtered));

  return Response.json({ success: true, count: filtered.length });
}
