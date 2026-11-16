// Reference data the park trends compare against: today's park hours, the
// imported baseline (RopeDrop Planner hourly curves, ride averages, Lightning
// Lane sell-outs) and Queue-Times seasonal crowd levels. The cron keeps hours
// and the RopeDrop parts current; seasonal levels come from the import script.
import { THEMEPARKS_API, WDW_DESTINATION_ID, normalizeName, parkDate, parkTime } from "./lightning-lane.js";

export const BASELINE_KEY = "parks:baseline";
const ATTEMPT_KEY = "parks:baseline:attempt";
const ROPEDROP_API = "https://ropedropplanner.com/api";
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60_000;
const ATTEMPT_TTL_SECONDS = 6 * 60 * 60;
const HOURS_TTL_SECONDS = 3 * 24 * 60 * 60;
const BUSY_SCORE = 0.1;

export const PARK_SLUGS = ["magic_kingdom", "epcot", "hollywood_studios", "animal_kingdom"];
const PARK_NAMES = {
  magic_kingdom: "Magic Kingdom",
  epcot: "EPCOT",
  hollywood_studios: "Hollywood Studios",
  animal_kingdom: "Animal Kingdom",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const hoursKey = (day) => `parks:hours:${day}`;
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

// --- Park hours ---

// { [parkId]: { open: "09:00", close: "22:00" } } for the regular operating day.
export function readParkHours(schedule, day) {
  const hours = {};
  for (const park of schedule?.parks || []) {
    const operating = (park.schedule || []).find((s) => s.date === day && s.type === "OPERATING");
    if (operating) hours[park.id] = { open: parkTime(operating.openingTime), close: parkTime(operating.closingTime) };
  }
  return hours;
}

export async function recordParkHours(env, now = new Date(), fetchImpl = fetch) {
  const day = parkDate(now);
  if (await env.KV.get(hoursKey(day))) return false;
  const resp = await fetchImpl(`${THEMEPARKS_API}/${WDW_DESTINATION_ID}/schedule`, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`themeparks.wiki schedule returned ${resp.status}`);
  const hours = readParkHours(await resp.json(), day);
  if (!Object.keys(hours).length) return false;
  await env.KV.put(hoursKey(day), JSON.stringify(hours), { expirationTtl: HOURS_TTL_SECONDS });
  return true;
}

export function loadParkHours(env, day) {
  return env.KV.get(hoursKey(day), "json");
}

// --- Imported baseline ---

export async function loadBaseline(env) {
  return env.KV.get(BASELINE_KEY, "json");
}

export function hourlyCurve(strategy) {
  const rows = strategy?.peak_hours?.hourly_breakdown || [];
  // Zero means no rides reported that hour, not a zero-minute wait.
  return rows.filter((row) => row.all_rides_avg).map((row) => ({ hour: row.hour, avg: row.all_rides_avg }));
}

// The RopeDrop parts replaced; hand-built ride averages and seasonal levels kept.
export function mergeRopeDropBaseline(previous, { strategies, topWaits, sellouts }, now = new Date()) {
  const parks = {};
  for (const slug of PARK_SLUGS) {
    const hours = hourlyCurve(strategies[slug]);
    if (!hours.length) return null;
    parks[slug] = { hours };
  }
  const rides = Object.fromEntries(
    Object.entries(previous?.rides || {}).filter(([, ride]) => ride.source !== "ropedrop")
  );
  for (const ride of topWaits) {
    rides[normalizeName(ride.name)] = { name: ride.name, avg: ride.avg_wait, source: "ropedrop" };
  }
  const soldOut = {};
  for (const ride of sellouts) {
    soldOut[ride.entity_id] = { name: ride.name, typicalTime: ride.typical_time, frequency: ride.sellout_frequency };
  }
  return { ...previous, generated_at: now.toISOString(), parks, rides, sellouts: soldOut };
}

async function fetchRopeDrop(path, contact, fetchImpl) {
  // RopeDrop asks API users to identify themselves with a contact address.
  const resp = await fetchImpl(`${ROPEDROP_API}${path}`, {
    headers: { Accept: "application/json", "User-Agent": `mousing/0.1 (${contact})` },
  });
  if (!resp.ok) throw new Error(`RopeDrop ${path} returned ${resp.status}`);
  return resp.json();
}

// Weekly, only where ROPEDROP_CONTACT is set; at most one attempt per six hours.
export async function refreshBaseline(env, now = new Date(), fetchImpl = fetch) {
  const contact = env.ROPEDROP_CONTACT;
  if (!contact) return "disabled";
  const previous = await loadBaseline(env);
  if (previous && now - new Date(previous.generated_at) < REFRESH_AFTER_MS) return "fresh";
  if (await env.KV.get(ATTEMPT_KEY)) return "waiting";
  await env.KV.put(ATTEMPT_KEY, now.toISOString(), { expirationTtl: ATTEMPT_TTL_SECONDS });

  const strategyList = await Promise.all(
    PARK_SLUGS.map((slug) => fetchRopeDrop(`/parks/strategy/wdw/${slug}`, contact, fetchImpl))
  );
  const top = await fetchRopeDrop("/parks/top-waits?destination=wdw&days=30&limit=30", contact, fetchImpl);
  // Sell-outs are a bonus; a park that fails keeps the curves refreshing.
  const selloutResults = await Promise.allSettled(
    PARK_SLUGS.map((slug) => fetchRopeDrop(`/analysis/sellouts?park_id=${slug}&limit=30`, contact, fetchImpl))
  );
  const merged = mergeRopeDropBaseline(previous, {
    strategies: Object.fromEntries(PARK_SLUGS.map((slug, i) => [slug, strategyList[i]])),
    topWaits: top.rides || [],
    sellouts: selloutResults.flatMap((r) => (r.status === "fulfilled" ? r.value.rides || [] : [])),
  }, now);
  if (!merged) return "incomplete";
  await env.KV.put(BASELINE_KEY, JSON.stringify(merged));
  return "refreshed";
}

// --- Seasonal outlook ---

// How this month and weekday usually compare with each park's own average,
// from Queue-Times crowd levels across all years.
export function seasonalOutlook(seasonal, day) {
  if (!seasonal) return [];
  const date = new Date(day + "T12:00:00Z");
  const month = MONTHS[date.getUTCMonth()];
  const weekday = WEEKDAYS[date.getUTCDay()];
  return PARK_SLUGS.flatMap((slug) => {
    const park = seasonal[slug];
    const monthLevel = park?.months?.[month];
    const weekdayLevel = park?.weekdays?.[weekday];
    if (monthLevel == null || weekdayLevel == null) return [];
    const monthAverage = mean(Object.values(park.months));
    const weekdayAverage = mean(Object.values(park.weekdays));
    const score = monthLevel / monthAverage - 1 + (weekdayLevel / weekdayAverage - 1);
    return [{
      key: slug,
      name: PARK_NAMES[slug],
      month,
      weekday,
      monthLevel,
      weekdayLevel,
      average: Math.round(monthAverage),
      label: score >= BUSY_SCORE ? "busier" : score <= -BUSY_SCORE ? "quieter" : "average",
    }];
  });
}
