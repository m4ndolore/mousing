// GET /api/push/vapid-key — return public VAPID key for client subscription
export async function onRequestGet(context) {
  return Response.json({ key: context.env.VAPID_PUBLIC_KEY });
}
