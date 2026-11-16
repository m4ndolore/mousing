// Allowed per-watch check intervals, in minutes
export const ALLOWED_INTERVALS = [5, 15, 30, 60, 360];

// Coerce an interval value to an allowed one, defaulting to 15 minutes
export function normalizeInterval(v) {
  return ALLOWED_INTERVALS.includes(v) ? v : 15;
}

// Lightning Lane watches may poll faster than 5 minutes for a limited time.
export const FAST_INTERVALS = [1, 2];
export const FAST_INTERVAL_MS = 2 * 60 * 60_000;
export const FAST_REVERT_INTERVAL = 5;

// Set a watch's interval, starting a fresh fast window when one is allowed
export function applyCheckInterval(watch, requested, now = new Date()) {
  if (FAST_INTERVALS.includes(requested)) {
    watch.check_interval_minutes = requested;
    watch.fast_until = new Date(now.getTime() + FAST_INTERVAL_MS).toISOString();
  } else {
    watch.check_interval_minutes = normalizeInterval(requested);
    watch.fast_until = null;
  }
  return watch;
}

// Drop an expired fast interval back to 5 minutes; true when the watch changed
export function expireFastInterval(watch, now = new Date()) {
  if (!watch.fast_until || now < new Date(watch.fast_until)) return false;
  watch.check_interval_minutes = FAST_REVERT_INTERVAL;
  watch.fast_until = null;
  return true;
}

// The cron fires every minute. The 30s grace absorbs processing delay so a
// 5-minute watch runs on every fifth tick, without letting a 2-minute watch
// slip onto every tick.
const DUE_GRACE_MS = 30_000;

export function isWatchDue(watch, now = new Date()) {
  if (!watch.last_checked) return true;
  const intervalMin = watch.check_interval_minutes || 15;
  const dueAt = new Date(watch.last_checked).getTime() + intervalMin * 60_000 - DUE_GRACE_MS;
  return now.getTime() >= dueAt;
}
