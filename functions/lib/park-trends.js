// Park crowd trends from our own samples of the themeparks.wiki feed. The cron
// stores each park's average standby every 15 minutes; today is then compared
// with the same weekday in recent weeks and the same weeks a year ago. Until two
// such days exist, an imported reference baseline stands in (see parks:baseline).
import { fetchWdwParks, normalizeName, parkDate, parkTime } from "./lightning-lane.js";
import { BASELINE_KEY, loadBaseline, loadParkHours, seasonalOutlook } from "./park-baseline.js";

const SAMPLE_EVERY_MINUTES = 15;
const SAMPLE_TTL_SECONDS = 400 * 24 * 60 * 60;
const MIN_OPEN_RIDES = 3;
const MIN_BASELINE_DAYS = 2;
const MIN_OVERLAP_SAMPLES = 2;
const UNUSUAL_RATIO = 0.15;
const OPEN_WITHIN_MS = 30 * 60_000;
const RECENT_WEEKS = [7, 14, 21, 28];
const LAST_YEAR_DAYS = [357, 364, 371];

const sampleKey = (day) => `parks:history:${day}`;
const roundTenth = (n) => Math.round(n * 10) / 10;
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

export function isSampleMinute(date) {
  return date.getUTCMinutes() % SAMPLE_EVERY_MINUTES === 0;
}

// Parks with too few rides reporting are closed or just opening.
export function summarizeParks(liveData) {
  const waitsByPark = {};
  for (const entry of liveData) {
    const wait = entry.queue?.STANDBY?.waitTime;
    if (entry.entityType !== "ATTRACTION" || entry.status !== "OPERATING" || typeof wait !== "number") continue;
    (waitsByPark[entry.parkId] ??= []).push(wait);
  }
  return Object.fromEntries(
    Object.entries(waitsByPark)
      .filter(([, waits]) => waits.length >= MIN_OPEN_RIDES)
      .map(([parkId, waits]) => [parkId, { avg: roundTenth(mean(waits)), rides: waits.length }])
  );
}

export async function recordParkSample(env, liveData, now = new Date(), fetchParks = fetchWdwParks) {
  const summary = summarizeParks(liveData);
  if (!Object.keys(summary).length) return false;

  const day = parkDate(now);
  const t = parkTime(now.toISOString());
  const parkNames = await fetchParks();
  const record = await env.KV.get(sampleKey(day), "json") || { parks: {} };
  for (const [parkId, { avg, rides }] of Object.entries(summary)) {
    const park = (record.parks[parkId] ??= { name: parkNames[parkId] || parkId, points: [] });
    if (!park.points.some((p) => p.t === t)) park.points.push({ t, avg, rides });
  }
  await env.KV.put(sampleKey(day), JSON.stringify(record), { expirationTtl: SAMPLE_TTL_SECONDS });
  return true;
}

export function baselineDates(day) {
  return [...RECENT_WEEKS, ...LAST_YEAR_DAYS].map((back) => {
    const date = new Date(day + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() - back);
    return date.toISOString().slice(0, 10);
  });
}

function averageByTime(records, parkId) {
  const byTime = new Map();
  for (const record of records) {
    for (const { t, avg } of record.parks[parkId]?.points || []) {
      byTime.set(t, [...(byTime.get(t) || []), avg]);
    }
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, values]) => ({ t, avg: roundTenth(mean(values)) }));
}

export function referenceKey(parkName) {
  const name = parkName.toLowerCase();
  if (name.includes("magic kingdom")) return "magic_kingdom";
  if (name.includes("epcot")) return "epcot";
  if (name.includes("hollywood")) return "hollywood_studios";
  if (name.includes("animal kingdom")) return "animal_kingdom";
  return null;
}

// Hourly averages stretched onto the 15-minute times our readings use.
export function referenceCurve(hours) {
  const toT = (minutes) =>
    String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
  const curve = [];
  hours.forEach(({ hour, avg }, i) => {
    const next = hours[i + 1]?.hour === hour + 1 ? hours[i + 1] : null;
    for (let step = 0; step < (next ? 4 : 1); step++) {
      const value = next ? avg + ((next.avg - avg) * step) / 4 : avg;
      curve.push({ t: toT(hour * 60 + step * SAMPLE_EVERY_MINUTES), avg: roundTenth(value) });
    }
  });
  return curve;
}

function classify(ratio) {
  if (ratio == null) return null;
  if (ratio >= 1 + UNUSUAL_RATIO) return "busier";
  if (ratio <= 1 - UNUSUAL_RATIO) return "quieter";
  return "typical";
}

// `today` compared with `history` (a list of past day records), falling back to
// `reference` (parks:baseline). A park gets a ratio and projection only with a
// baseline and overlapping readings; `hours` stops projections at closing.
export function buildTrends(today, history, now = new Date(), reference = null, hours = null) {
  const nowTime = parkTime(now.toISOString());
  const nowMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

  const parks = Object.entries(today?.parks || {}).map(([id, park]) => {
    const points = [...park.points].sort((a, b) => a.t.localeCompare(b.t)).map(({ t, avg }) => ({ t, avg }));
    const latest = points.at(-1);
    const close = hours?.[id]?.close;
    const open = Boolean(latest) && (nowMinutes(nowTime) - nowMinutes(latest.t)) * 60_000 <= OPEN_WITHIN_MS
      && !(close && nowTime >= close);
    const baselineDays = history.filter((record) => record.parks[id]?.points?.length).length;
    const hasOwnBaseline = baselineDays >= MIN_BASELINE_DAYS;
    const referenceHours = reference?.parks?.[referenceKey(park.name)]?.hours;
    const baseline = hasOwnBaseline
      ? averageByTime(history, id)
      : referenceHours ? referenceCurve(referenceHours) : [];

    let ratio = null;
    let projection = [];
    if (baseline.length) {
      const typicalAt = new Map(baseline.map(({ t, avg }) => [t, avg]));
      const overlap = points.filter(({ t }) => typicalAt.has(t) && typicalAt.get(t) > 0);
      if (overlap.length >= MIN_OVERLAP_SAMPLES) {
        ratio = Math.round((mean(overlap.map((p) => p.avg)) / mean(overlap.map((p) => typicalAt.get(p.t)))) * 100) / 100;
        projection = baseline
          .filter(({ t }) => latest && t > latest.t && !(close && t > close))
          .map(({ t, avg }) => ({ t, avg: roundTenth(avg * ratio) }));
      }
    }

    return {
      id,
      name: park.name,
      open,
      current: open ? latest.avg : null,
      today: points,
      projection: open ? projection : [],
      projectedAvg: open && projection.length ? roundTenth(mean(projection.map((p) => p.avg))) : null,
      ratio,
      status: classify(ratio),
      baselineDays,
      baselineSource: ratio == null ? null : hasOwnBaseline ? "own" : "reference",
      closes: close || null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const openParks = parks.filter((park) => park.open);
  const projected = openParks.filter((park) => park.projectedAvg != null);
  const lowest = (list, field) => list.reduce((best, park) => (!best || park[field] < best[field] ? park : best), null);
  // Rank on one basis only: mixing projected and current waits misleads.
  const best = projected.length === openParks.length && projected.length
    ? { parkId: lowest(projected, "projectedAvg").id, basis: "projected" }
    : openParks.length
      ? { parkId: lowest(openParks, "current").id, basis: "current" }
      : null;

  return { parks, best };
}

export { BASELINE_KEY, loadBaseline };

export async function loadTrends(env, now = new Date()) {
  const day = parkDate(now);
  const [reference, hours, today, ...past] = await Promise.all([
    loadBaseline(env),
    loadParkHours(env, day),
    ...[day, ...baselineDates(day)].map((d) => env.KV.get(sampleKey(d), "json")),
  ]);
  return {
    date: day,
    baseline_as_of: reference?.generated_at || null,
    outlook: seasonalOutlook(reference?.seasonal, day),
    ...buildTrends(today, past.filter(Boolean), now, reference, hours),
  };
}

export function withUsualWaits(rides, baseline) {
  const usual = baseline?.rides || {};
  const sellouts = baseline?.sellouts || {};
  return rides.map((ride) => ({
    ...ride,
    usualWait: usual[normalizeName(ride.name)]?.avg ?? null,
    sellout: sellouts[ride.attractionId] || null,
  }));
}
