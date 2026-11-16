// Same-day Lightning Lane availability from the public themeparks.wiki feed.
// Disney exposes LL Multi Pass as the RETURN_TIME queue and LL Single Pass as
// PAID_RETURN_TIME; each carries a state and the next return window.
// See https://api.themeparks.wiki/docs/v1/

export const THEMEPARKS_API = "https://api.themeparks.wiki/v1/entity";
export const WDW_DESTINATION_ID = "e957da41-3552-4cf6-b636-5babc5cbc4e5";
export const PARK_TIMEZONE = "America/New_York";
export const DEFAULT_ATTRACTION = "Slinky Dog Dash";

export async function fetchWdwLiveData(fetchImpl = fetch) {
  const resp = await fetchImpl(`${THEMEPARKS_API}/${WDW_DESTINATION_ID}/live`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`themeparks.wiki returned ${resp.status}`);
  const data = await resp.json();
  return data.liveData || [];
}

// { [parkId]: "EPCOT", ... } from the destination's child entities
export async function fetchWdwParks(fetchImpl = fetch) {
  const resp = await fetchImpl(`${THEMEPARKS_API}/${WDW_DESTINATION_ID}/children`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`themeparks.wiki returned ${resp.status}`);
  const data = await resp.json();
  return Object.fromEntries(
    (data.children || []).filter((c) => c.entityType === "PARK").map((c) => [c.id, c.name])
  );
}

export function normalizeName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Exact (punctuation-insensitive) match first, so "Slinky Dog Dash" never
// resolves to a similarly named show or restaurant.
export function findAttraction(liveData, name) {
  const target = normalizeName(name);
  const attractions = liveData.filter((e) => e.entityType === "ATTRACTION");
  return attractions.find((e) => normalizeName(e.name) === target)
    || attractions.find((e) => normalizeName(e.name).includes(target))
    || null;
}

export function readLightningLane(entry) {
  const queue = entry?.queue || {};
  const ll = queue.RETURN_TIME || queue.PAID_RETURN_TIME;
  if (!ll) return null;
  return {
    attractionId: entry.id,
    name: entry.name,
    parkId: entry.parkId || null,
    status: entry.status || null,
    paid: !queue.RETURN_TIME,
    state: ll.state || null,
    returnStart: ll.returnStart || null,
    returnEnd: ll.returnEnd || null,
    price: ll.price ? ll.price.amount / 100 : null,
    standbyWait: queue.STANDBY?.waitTime ?? null,
  };
}

export function listLightningLanes(liveData, parkNames = {}) {
  return liveData
    .filter((e) => e.entityType === "ATTRACTION")
    .map(readLightningLane)
    .filter(Boolean)
    .map((ll) => ({ ...ll, parkName: parkNames[ll.parkId] || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// "HH:MM" (24h) in park-local time
export function parkTime(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: PARK_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}

// "YYYY-MM-DD" in park-local time
export function parkDate(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: PARK_TIMEZONE });
}

export function formatParkTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: PARK_TIMEZONE, hour: "numeric", minute: "2-digit",
  });
}

export function inTimeWindow(hhmm, window) {
  if (!window?.start && !window?.end) return true;
  if (window.start && hhmm < window.start) return false;
  if (window.end && hhmm > window.end) return false;
  return true;
}

export function isTripDay(day, dateRange) {
  if (!dateRange?.start || !dateRange?.end) return true;
  return day >= dateRange.start && day <= dateRange.end;
}

// A return time this much earlier is worth interrupting the guest for. Smaller
// moves are normal drift and stay on the dashboard.
const EARLIER_ALERT_MS = 15 * 60_000;

// Alert when a ride becomes bookable inside the guest's window, or when its
// return time jumps earlier. A return time drifting later never alerts.
export function shouldAlert(prev, curr, window) {
  if (!curr || curr.state !== "AVAILABLE" || !curr.returnStart) return false;
  if (!inTimeWindow(parkTime(curr.returnStart), window)) return false;
  if (!prev || prev.state !== "AVAILABLE" || !prev.returnStart) return true;
  if (!inTimeWindow(parkTime(prev.returnStart), window)) return true;
  return new Date(prev.returnStart) - new Date(curr.returnStart) >= EARLIER_ALERT_MS;
}

export function buildLightningLaneMatch(ll) {
  return {
    resort: ll.name,
    resortCode: "LL",
    roomCode: ll.attractionId,
    roomType: ll.paid ? "Single Pass" : "Multi Pass",
    dates: [ll.returnStart],
    points: 0,
    total_points: 0,
    rooms: 0,
    return_label: formatParkTime(ll.returnStart)
      + (ll.returnEnd ? `–${formatParkTime(ll.returnEnd)}` : ""),
    price: ll.price,
    standby_wait: ll.standbyWait,
  };
}

export function describeLightningLaneMatch(m) {
  const extras = [m.roomType];
  if (m.price != null) extras.push(`$${m.price.toFixed(2)}`);
  if (m.standby_wait != null) extras.push(`standby ${m.standby_wait} min`);
  return `${m.resort} — return ${m.return_label} (${extras.join(", ")})`;
}
