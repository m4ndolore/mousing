import { fetchWdwLiveData, fetchWdwParks, listLightningLanes } from "../lib/lightning-lane.js";
import { loadBaseline, withUsualWaits } from "../lib/park-trends.js";

// GET /api/lightning-lane — current Lightning Lane state for every WDW attraction
export async function onRequestGet({ env } = {}) {
  // Park names and usual waits only add detail; a failed lookup still returns live data.
  const [live, parks, baseline] = await Promise.allSettled([fetchWdwLiveData(), fetchWdwParks(), loadBaseline(env)]);
  if (live.status === "rejected") {
    return Response.json({ error: live.reason.message }, { status: 502 });
  }
  return Response.json({
    fetched_at: new Date().toISOString(),
    attractions: withUsualWaits(
      listLightningLanes(live.value, parks.status === "fulfilled" ? parks.value : {}),
      baseline.status === "fulfilled" ? baseline.value : null,
    ),
  });
}
