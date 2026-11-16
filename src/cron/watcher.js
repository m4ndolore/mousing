import { buildPushHTTPRequest } from "@pushforge/builder";
import { expireFastInterval, isWatchDue } from "../../functions/lib/intervals.js";
import { isSampleMinute, recordParkSample } from "../../functions/lib/park-trends.js";
import { recordParkHours, refreshBaseline } from "../../functions/lib/park-baseline.js";
import {
  DEFAULT_ATTRACTION,
  buildLightningLaneMatch,
  describeLightningLaneMatch,
  fetchWdwLiveData,
  findAttraction,
  isTripDay,
  parkDate,
  readLightningLane,
  shouldAlert,
} from "../../functions/lib/lightning-lane.js";

const APP_NAME = "mousing";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWatcher(env, event.scheduledTime));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const secret = request.headers.get("X-Auth-Secret");
    if (request.method !== "POST" || !env.AUTH_SHARED_SECRET || secret !== env.AUTH_SHARED_SECRET) {
      if (request.method === "POST" && (url.pathname === "/test-email" || url.pathname === "/test-push")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/test-email") {
      const config = await env.KV.get("config:notifications", "json") || {};
      if (!config.email) {
        return Response.json({ error: "No email configured" }, { status: 400 });
      }
      if (!canEmail(env)) {
        return Response.json({ error: "Email needs the SEND_EMAIL binding and EMAIL_FROM on the cron worker." }, { status: 503 });
      }
      try {
        await env.SEND_EMAIL.send({
          from: env.EMAIL_FROM,
          to: config.email,
          subject: `${APP_NAME}: test notification`,
          html: `<p>This is a test notification from ${APP_NAME}. Email alerts are working.</p>`,
          text: `This is a test notification from ${APP_NAME}. Email alerts are working.`,
        });
        return Response.json({ success: true });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/test-push") {
      try {
        const result = await sendPushToAll(env, {
          title: APP_NAME,
          body: "Test push notification. Alerts will arrive on this device.",
          tag: "test",
          url: appUrl(env),
        });
        return Response.json({ success: result.sent > 0, ...result });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

function appUrl(env, path = "/") {
  return new URL(path, env.APP_URL || "https://example.com").toString();
}

function canEmail(env) {
  return Boolean(env.SEND_EMAIL && env.EMAIL_FROM);
}

async function runWatcher(env, scheduledTime) {
  // One themeparks.wiki fetch per run, shared by every Lightning Lane watch.
  let wdwLive = null;
  const getWdwLive = () => (wdwLive ??= fetchWdwLiveData());

  // Trend sampling must never stop watches from running.
  const scheduledAt = new Date(scheduledTime);
  if (scheduledTime && isSampleMinute(scheduledAt)) {
    try {
      await recordParkSample(env, await getWdwLive(), scheduledAt);
    } catch (e) {
      console.error("Park trend sample failed:", e.message);
      wdwLive = null;
    }
    try {
      await recordParkHours(env, scheduledAt);
    } catch (e) {
      console.error("Park hours fetch failed:", e.message);
    }
    try {
      await refreshBaseline(env, scheduledAt);
    } catch (e) {
      console.error("Park baseline refresh failed:", e.message);
    }
  }

  // The public demo has no owner, so it keeps no alerts.
  if (env.DEMO_MODE === "true") return;

  const index = await env.KV.get("watches:index", "json") || [];
  const notifyConfig = await env.KV.get("config:notifications", "json") || {};
  const now = new Date();

  for (const id of index) {
    const watch = await env.KV.get(`watch:${id}`, "json");
    if (!watch || !watch.enabled) continue;

    // A 1- or 2-minute interval drops back to 5 once its window ends.
    if (expireFastInterval(watch, now)) {
      await env.KV.put(`watch:${id}`, JSON.stringify(watch));
    }
    if (!isWatchDue(watch, now)) continue;

    try {
      await processLightningLaneWatch(env, watch, notifyConfig, getWdwLive);
    } catch (e) {
      console.error(`Watch ${id} failed: ${e.message}`);
    }
  }
}

async function processLightningLaneWatch(env, watch, notifyConfig, getLiveData) {
  const today = parkDate();
  watch.last_checked = new Date().toISOString();
  if (!isTripDay(today, watch.date_range)) {
    await env.KV.put(`watch:${watch.id}`, JSON.stringify(watch));
    return;
  }

  const liveData = await getLiveData();
  // Return times reset overnight, so only compare against today's snapshot.
  const prevRaw = await env.KV.get(`results:${watch.id}`, "json");
  const previous = prevRaw?.date === today ? prevRaw.attractions || {} : {};

  const current = {};
  const matches = [];
  const names = watch.attractions?.length ? watch.attractions : [DEFAULT_ATTRACTION];
  for (const name of names) {
    const ll = readLightningLane(findAttraction(liveData, name));
    if (!ll) {
      console.error(`Lightning Lane watch ${watch.id}: no Lightning Lane data for ${name}`);
      continue;
    }
    current[name] = ll;
    if (shouldAlert(previous[name], ll, watch.time_window)) {
      matches.push(buildLightningLaneMatch(ll));
    }
  }

  await env.KV.put(`results:${watch.id}`, JSON.stringify({
    checked_at: watch.last_checked,
    date: today,
    attractions: current,
  }));

  if (matches.length) watch.last_match = watch.last_checked;
  await env.KV.put(`watch:${watch.id}`, JSON.stringify(watch));

  if (matches.length > 0) {
    await sendNotifications(env, watch, matches, notifyConfig);
  }
}

async function sendPushToAll(env, payload) {
  const subs = (await env.KV.get("push:subscriptions", "json")) || [];
  if (!subs.length) return { sent: 0, errors: [], total: 0 };

  const deadEndpoints = [];
  const errors = [];
  let sent = 0;

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        const { endpoint, headers, body } = await buildPushHTTPRequest({
          privateJWK: env.VAPID_PRIVATE_JWK,
          subscription: sub,
          message: {
            payload,
            adminContact: env.VAPID_SUBJECT,
            options: { ttl: 3600, urgency: "high" },
          },
        });

        const resp = await fetch(endpoint, { method: "POST", headers, body });
        if (resp.ok || resp.status === 201) {
          sent++;
        } else {
          const text = await resp.text();
          errors.push({ status: resp.status, message: text });
          if (resp.status === 404 || resp.status === 410) {
            deadEndpoints.push(sub.endpoint);
          }
        }
      } catch (err) {
        errors.push({ status: 0, message: err.message });
      }
    })
  );

  // Clean up dead subscriptions
  if (deadEndpoints.length > 0) {
    const cleaned = subs.filter((s) => !deadEndpoints.includes(s.endpoint));
    await env.KV.put("push:subscriptions", JSON.stringify(cleaned));
  }

  return { sent, errors, total: subs.length };
}

async function sendNotifications(env, watch, matches, notifyConfig) {
  const cooldownRaw = await env.KV.get("notifications:cooldown", "json") || {};
  const now = new Date();
  // Prune expired cooldown entries (older than 24h)
  for (const [k, v] of Object.entries(cooldownRaw)) {
    if (now - new Date(v) > 24 * 60 * 60 * 1000) delete cooldownRaw[k];
  }
  const newMatches = matches.filter((m) => {
    const key = `${watch.id}:${m.resortCode || ""}:${m.roomCode || ""}:${m.dates[0]}:${m.dates.length}`;
    const last = cooldownRaw[key];
    if (last && (now - new Date(last)) < 24 * 60 * 60 * 1000) return false;
    cooldownRaw[key] = now.toISOString();
    return true;
  });
  if (!newMatches.length) return;
  await env.KV.put("notifications:cooldown", JSON.stringify(cooldownRaw));

  const notifId = `n_${Date.now().toString(36)}`;
  const channels = [];
  const title = `Lightning Lane: ${watch.name}`;
  const detailUrl = appUrl(env, `/notification?id=${notifId}`);

  if (notifyConfig.email_enabled && notifyConfig.email && canEmail(env)) {
    try {
      await env.SEND_EMAIL.send({
        from: env.EMAIL_FROM,
        to: notifyConfig.email,
        subject: title,
        html: formatLightningLaneEmail(watch.name, newMatches, detailUrl),
        text: `${formatLightningLaneMessage(watch.name, newMatches)}\n\nOpen in app: ${detailUrl}`,
      });
      channels.push("email");
    } catch (e) {
      console.error("Email send failed:", e.message);
    }
  }

  try {
    const pushResult = await sendPushToAll(env, {
      title,
      body: formatLightningLaneMessage(watch.name, newMatches),
      tag: `watch-${watch.id}`,
      url: detailUrl,
    });
    if (pushResult.sent > 0) channels.push("push");
  } catch (e) {
    console.error("Push send failed:", e.message);
  }

  // Keep the alert for its detail page for 30 days.
  const notification = {
    id: notifId,
    sent_at: now.toISOString(),
    watch_id: watch.id,
    watch_name: watch.name,
    watch_type: "lightning_lane",
    matches: newMatches,
    channels,
  };
  await env.KV.put(`notification:${notifId}`, JSON.stringify(notification), { expirationTtl: 60 * 60 * 24 * 30 });

  const log = await env.KV.get("notifications:log", "json") || [];
  log.unshift({ id: notifId, sent_at: now.toISOString(), watch_id: watch.id, watch_name: watch.name, match_count: newMatches.length, channels });
  await env.KV.put("notifications:log", JSON.stringify(log.slice(0, 50)));
}

export function formatLightningLaneMessage(watchName, matches) {
  return [
    `Lightning Lane: ${watchName}`,
    ...matches.map(describeLightningLaneMatch),
    "Book in the My Disney Experience app",
  ].join("\n");
}

function formatLightningLaneEmail(watchName, matches, detailUrl) {
  const rows = matches.map((m) => `<li style="padding:4px 0">${escapeHtml(describeLightningLaneMatch(m))}</li>`).join("");
  return `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px"><h2 style="color:#7c3aed">Lightning Lane: ${escapeHtml(watchName)}</h2><ul style="padding-left:18px">${rows}</ul><p style="margin-top:16px">Book in the My Disney Experience app.</p><p><a href="${escapeHtml(detailUrl)}" style="color:#2563eb">Open in ${APP_NAME}</a></p></div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
