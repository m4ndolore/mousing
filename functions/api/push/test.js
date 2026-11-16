// POST /api/push/test — send a test push notification through the cron worker,
// which holds the email binding and the push signing key.
export async function onRequestPost({ env }) {
  if (!env.WATCHER_URL) {
    return Response.json({ error: "Set WATCHER_URL to the cron worker's URL." }, { status: 503 });
  }
  try {
    const resp = await fetch(`${env.WATCHER_URL}/test-push`, {
      method: "POST",
      headers: { "X-Auth-Secret": env.AUTH_SHARED_SECRET },
    });
    return Response.json(await resp.json(), { status: resp.status });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
