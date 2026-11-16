// Form and link helpers for the Lightning Lane pages. A classic script in the
// browser and an imported module in tests, so it publishes on globalThis.
(() => {
  const PARK_TZ = "America/New_York";
  const FIRST_SLOT_MINUTES = 6 * 60;
  const LAST_SLOT_MINUTES = 23 * 60 + 30;
  const SLOT_MINUTES = 30;

  // Disney's apple-app-site-association claims only /passes/renew/ for this
  // app, so no https URL opens a Lightning Lane screen. Store listings show
  // an Open button when the app is installed.
  const APP_STORE_URL = "https://apps.apple.com/app/id547436543";
  const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.disney.wdw.android";
  const WEB_URL = "https://disneyworld.disney.go.com/";

  const pad = (n) => String(n).padStart(2, "0");
  const toHhmm = (minutes) => pad(Math.floor(minutes / 60)) + ":" + pad(minutes % 60);

  function parkToday(now = new Date()) {
    return now.toLocaleDateString("en-CA", { timeZone: PARK_TZ });
  }

  function addDays(day, count) {
    const date = new Date(day + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + count);
    return date.toISOString().slice(0, 10);
  }

  // Keep start <= end, moving the side the guest did not just edit.
  function syncDateRange(start, end, edited) {
    if (edited === "start" && start && (!end || end < start)) return { start, end: start };
    if (edited === "end" && end && (!start || start > end)) return { start: end, end };
    return { start, end };
  }

  // An empty side means open or close, so clear the side that no longer fits.
  function syncTimeWindow(start, end, edited) {
    if (!start || !end || start <= end) return { start, end };
    return edited === "start" ? { start, end: "" } : { start: "", end };
  }

  function formatTime(hhmm) {
    const [hour, minute] = hhmm.split(":").map(Number);
    return (hour % 12 || 12) + ":" + pad(minute) + (hour < 12 ? " AM" : " PM");
  }

  // Half-hour slots, plus any saved time that falls between them.
  function timeSlots(...savedTimes) {
    const values = new Set(savedTimes.filter(Boolean));
    for (let m = FIRST_SLOT_MINUTES; m <= LAST_SLOT_MINUTES; m += SLOT_MINUTES) values.add(toHhmm(m));
    return [...values].sort().map((value) => ({ value, label: formatTime(value) }));
  }

  function timePresets(now = new Date()) {
    const [hour, minute] = now
      .toLocaleTimeString("en-GB", { timeZone: PARK_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .split(":")
      .map(Number);
    const slot = hour * 60 + minute - (minute % SLOT_MINUTES);
    return [
      { label: "From now", start: toHhmm(slot), end: "" },
      { label: "Morning", start: "09:00", end: "12:00" },
      { label: "Afternoon", start: "12:00", end: "17:00" },
      { label: "Evening", start: "17:00", end: "" },
      { label: "Any time", start: "", end: "" },
    ];
  }

  function datePresets(now = new Date()) {
    const today = parkToday(now);
    const tomorrow = addDays(today, 1);
    return [
      { label: "Today", start: today, end: today },
      { label: "Tomorrow", start: tomorrow, end: tomorrow },
      { label: "Any day", start: "", end: "" },
    ];
  }

  function disneyAppLink(userAgent = "", maxTouchPoints = 0) {
    // iPadOS reports a Mac user agent, so touch support tells them apart.
    const isIos = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
    if (isIos) return { url: APP_STORE_URL, label: "Open My Disney Experience", hint: "Tap a ride, then tap Open on the App Store page." };
    if (/Android/.test(userAgent)) return { url: PLAY_STORE_URL, label: "Open My Disney Experience", hint: "Tap a ride, then tap Open on the Google Play page." };
    return { url: WEB_URL, label: "Open Disney World", hint: "Select a ride to open the Walt Disney World website." };
  }

  // Dashboard groups in park order, keeping only the guest's selected rides.
  function dashboardGroups(attractions, selected, otherPark = "Other") {
    const groups = new Map();
    for (const ride of attractions) {
      if (!selected.includes(ride.name)) continue;
      const park = ride.parkName || otherPark;
      if (!groups.has(park)) groups.set(park, []);
      groups.get(park).push(ride);
    }
    return [...groups.keys()].sort().map((park) => ({ park, rides: groups.get(park) }));
  }

  function rideDetail(ride) {
    const parts = [];
    if (ride.standbyWait != null) {
      parts.push("Standby " + ride.standbyWait + " min" + (ride.usualWait != null ? ", usually " + ride.usualWait : ""));
    }
    // Only rides that sell out on most days get a warning.
    if (ride.sellout?.frequency >= 0.5) parts.push("usually gone by " + ride.sellout.typicalTime);
    if (ride.paid) parts.push(ride.price != null ? "Single Pass $" + ride.price.toFixed(2) : "Single Pass");
    return parts.join(" · ");
  }

  const STATE_RANK = { AVAILABLE: 0, TEMP_FULL: 1, FINISHED: 3 };
  const NO_DATA_RANK = 2;
  const NOT_OPERATING_RANK = 4;

  function availabilityRank(ride) {
    if (ride.status && ride.status !== "OPERATING") return NOT_OPERATING_RANK;
    if (ride.state === "AVAILABLE" && !ride.returnStart) return NO_DATA_RANK;
    return STATE_RANK[ride.state] ?? NO_DATA_RANK;
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const COMPARATORS = {
    // Soonest return first, with sold-out rides last.
    next: (a, b) =>
      availabilityRank(a) - availabilityRank(b)
      || (a.returnStart && b.returnStart ? Date.parse(a.returnStart) - Date.parse(b.returnStart) : 0)
      || byName(a, b),
    name: byName,
    // Shortest standby first, with rides reporting no wait last.
    standby: (a, b) =>
      (a.standbyWait ?? Infinity) - (b.standbyWait ?? Infinity) || byName(a, b),
  };

  function sortRides(rides, sort) {
    return [...rides].sort(COMPARATORS[sort] || COMPARATORS.next);
  }

  function filterByPass(rides, pass) {
    return rides.filter((ride) => (pass === "single" ? ride.paid : !ride.paid));
  }

  globalThis.LightningLaneForm = {
    sortRides,
    filterByPass,
    dashboardGroups,
    rideDetail,
    syncDateRange,
    syncTimeWindow,
    timeSlots,
    timePresets,
    datePresets,
    disneyAppLink,
  };
})();
