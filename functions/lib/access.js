// Live park data is public. Everything else belongs to the deployment's owner:
// a demo refuses it, and a self-hosted deployment needs the owner key.
const PUBLIC_READS = new Set(["/api/lightning-lane", "/api/park-trends", "/api/mode"]);

export function isDemo(env) {
  return env?.DEMO_MODE === "true";
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

// Compare fixed-length digests so the time taken says nothing about the key.
async function sameSecret(given, expected) {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Returns a Response refusing the request, or null when it may go ahead.
export async function checkAccess(request, env) {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && PUBLIC_READS.has(pathname)) return null;
  if (isDemo(env)) {
    return Response.json({ error: "This demo is read-only. Deploy your own copy to save alerts." }, { status: 403 });
  }
  if (!env?.ADMIN_TOKEN) {
    return Response.json({ error: "Set the ADMIN_TOKEN secret on this deployment to use alerts and settings." }, { status: 503 });
  }
  const header = request.headers.get("Authorization") || "";
  if (!(await sameSecret(header, `Bearer ${env.ADMIN_TOKEN}`))) {
    return Response.json({ error: "Enter the owner key in Settings." }, { status: 401 });
  }
  return null;
}
