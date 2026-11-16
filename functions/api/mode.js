import { isDemo } from "../lib/access.js";

export const REPO_URL = "https://github.com/m4ndolore/mousing";

// GET /api/mode — whether this deployment is the read-only demo
export async function onRequestGet({ env }) {
  return Response.json({ demo: isDemo(env), repo_url: REPO_URL });
}
