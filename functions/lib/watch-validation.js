const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A watch's date_range is optional. When present it needs both nights, as
// YYYY-MM-DD, with the last night on or after the first. Returns an error
// message, or null when the range is acceptable.
export function dateRangeError(range) {
  if (range === null || range === undefined) return null;
  if (typeof range !== "object") return "date_range must be an object with start and end.";
  const { start, end } = range;
  if (!DAY.test(start ?? "") || !DAY.test(end ?? "")) {
    return "date_range needs start and end dates as YYYY-MM-DD.";
  }
  if (end < start) return "The last night must be on or after the first night.";
  return null;
}
