// Dashboard card for park crowd trends. A classic script in the browser and an
// imported module in tests, so the chart builder publishes on globalThis.
(() => {
  const HEIGHT = 220;
  const MARGIN = { top: 12, right: 112, bottom: 24, left: 34 };
  const DEFAULT_START = 8 * 60;
  const DEFAULT_END = 23 * 60;
  const LABEL_GAP = 13;
  const INK = "#374151";
  const MUTED = "#6b7280";
  const GRID = "#e5e7eb";
  const SURFACE = "#ffffff";

  // Fixed per park so a closed park never repaints the others.
  const PARK_COLORS = {
    "Animal Kingdom": "#0f8a6a",
    EPCOT: "#c2410c",
    "Hollywood Studios": "#7c3aed",
    "Magic Kingdom": "#2a78d6",
  };
  const FALLBACK_COLOR = "#6b7280";

  const escapeXml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

  function shortParkName(name) {
    return name.replace(/^Disney's\s+/, "").replace(/\s+Theme Park$/, "").replace(/\s+Park$/, "");
  }

  const parkColor = (name) => PARK_COLORS[shortParkName(name)] || FALLBACK_COLOR;

  function formatClock(t) {
    const minutes = toMinutes(t);
    const hour = Math.floor(minutes / 60);
    return (hour % 12 || 12) + ":" + String(minutes % 60).padStart(2, "0") + (hour < 12 ? " AM" : " PM");
  }

  function chartScales(parks, width) {
    const points = parks.flatMap((p) => [...p.today, ...p.projection]);
    const times = points.map((p) => toMinutes(p.t));
    const start = Math.min(DEFAULT_START, ...times);
    const end = Math.max(DEFAULT_END, ...times);
    const top = Math.max(30, ...points.map((p) => p.avg));
    const yMax = Math.ceil(top / 15) * 15;
    const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 60);
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
    return {
      start, end, yMax,
      x: (minutes) => MARGIN.left + ((minutes - start) / (end - start)) * plotWidth,
      y: (avg) => MARGIN.top + (1 - avg / yMax) * plotHeight,
    };
  }

  function linePath(points, scales) {
    return points.map((p, i) => (i ? "L" : "M") + scales.x(toMinutes(p.t)).toFixed(1) + " " + scales.y(p.avg).toFixed(1)).join(" ");
  }

  // Push end labels apart so parks with similar waits stay readable.
  function spaceLabels(labels) {
    const sorted = [...labels].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      sorted[i].y = Math.max(sorted[i].y, sorted[i - 1].y + LABEL_GAP);
    }
    return sorted;
  }

  function buildChartSvg(parks, width) {
    const scales = chartScales(parks, width);
    const parts = [];
    const right = width - MARGIN.right;

    for (let wait = 0; wait <= scales.yMax; wait += 15) {
      const y = scales.y(wait).toFixed(1);
      parts.push(`<line x1="${MARGIN.left}" x2="${right}" y1="${y}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`);
      parts.push(`<text x="${MARGIN.left - 6}" y="${y}" dy="4" text-anchor="end" font-size="11" fill="${MUTED}">${wait}</text>`);
    }
    for (let minutes = Math.ceil(scales.start / 180) * 180; minutes <= scales.end; minutes += 180) {
      const hour = minutes / 60;
      const label = (hour % 12 || 12) + (hour % 24 < 12 ? "a" : "p");
      parts.push(`<text x="${scales.x(minutes).toFixed(1)}" y="${HEIGHT - 6}" text-anchor="middle" font-size="11" fill="${MUTED}">${label}</text>`);
    }

    const labels = [];
    for (const park of parks) {
      const color = parkColor(park.name);
      const joined = park.today.length ? [park.today.at(-1), ...park.projection] : park.projection;
      if (joined.length > 1) {
        parts.push(`<path d="${linePath(joined, scales)}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="4 4" stroke-linecap="round"/>`);
      }
      if (park.today.length > 1) {
        parts.push(`<path d="${linePath(park.today, scales)}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      }
      const last = joined.at(-1);
      if (last) labels.push({ name: shortParkName(park.name), y: scales.y(last.avg) + 4, color });
      const latest = park.today.at(-1);
      if (latest) {
        parts.push(`<circle cx="${scales.x(toMinutes(latest.t)).toFixed(1)}" cy="${scales.y(latest.avg).toFixed(1)}" r="4" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`);
      }
    }
    for (const label of spaceLabels(labels)) {
      parts.push(`<text x="${right + 6}" y="${label.y.toFixed(1)}" font-size="11" fill="${INK}">${escapeXml(label.name)}</text>`);
    }

    return `<svg width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="Average standby wait in minutes by time of day for each park">${parts.join("")}</svg>`;
  }

  // Readings nearest a pointer position, for the crosshair and tooltip.
  function readingsAt(parks, width, pointerX) {
    const scales = chartScales(parks, width);
    const times = [...new Set(parks.flatMap((p) => [...p.today, ...p.projection].map((pt) => pt.t)))].sort();
    if (!times.length) return null;
    const t = times.reduce((best, candidate) =>
      Math.abs(scales.x(toMinutes(candidate)) - pointerX) < Math.abs(scales.x(toMinutes(best)) - pointerX) ? candidate : best);
    const rows = parks.flatMap((park) => {
      const actual = park.today.find((p) => p.t === t);
      const projected = park.projection.find((p) => p.t === t);
      const point = actual || projected;
      return point ? [{ name: shortParkName(park.name), color: parkColor(park.name), avg: point.avg, projected: !actual }] : [];
    });
    return { t, label: formatClock(t), x: scales.x(toMinutes(t)), rows };
  }

  function statusLabel(park) {
    if (!park.status) return "";
    const percent = Math.abs(Math.round((park.ratio - 1) * 100));
    if (park.status === "busier") return "▲ Busier than usual, +" + percent + "%";
    if (park.status === "quieter") return "▼ Quieter than usual, −" + percent + "%";
    return "● Typical";
  }

  const MONTH_NAMES = { Jan: "January", Feb: "February", Mar: "March", Apr: "April", May: "May", Jun: "June", Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December" };
  const WEEKDAY_NAMES = { Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday" };

  function outlookHeading(outlook) {
    const row = outlook[0];
    return row ? "Usual crowds for a " + WEEKDAY_NAMES[row.weekday] + " in " + MONTH_NAMES[row.month] : "";
  }

  function outlookLabel(row) {
    if (row.label === "busier") return "▲ Busier than its average";
    if (row.label === "quieter") return "▼ Quieter than its average";
    return "● Near its average";
  }

  function outlookDetail(row) {
    return row.month + " " + row.monthLevel + "%, " + row.weekday + " " + row.weekdayLevel + "%, average " + row.average + "%";
  }

  function bestSummary(best, parks) {
    const park = best && parks.find((p) => p.id === best.parkId);
    if (!park) return "";
    const name = shortParkName(park.name);
    return best.basis === "projected"
      ? "Lowest projected wait for the rest of today: " + name + ", " + Math.round(park.projectedAvg) + " min"
      : "Lowest average wait right now: " + name + ", " + Math.round(park.current) + " min";
  }

  globalThis.ParkTrends = { buildChartSvg, readingsAt, shortParkName, statusLabel, bestSummary, parkColor, formatClock, outlookHeading, outlookLabel, outlookDetail };

  if (typeof document === "undefined") return;
  document.addEventListener("alpine:init", () => {
    Alpine.data("parkTrends", () => ({
      loading: true,
      error: null,
      parks: [],
      best: null,
      baselineAsOf: null,
      outlook: [],
      width: 640,
      hover: null,
      ...globalThis.ParkTrends,

      get hasReadings() {
        return this.parks.some((p) => p.today.length);
      },
      get hasBaseline() {
        return this.parks.some((p) => p.status);
      },
      get usesReference() {
        return this.parks.some((p) => p.baselineSource === "reference");
      },
      get baselineDate() {
        return this.baselineAsOf
          ? new Date(this.baselineAsOf).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : "";
      },
      get svg() {
        return buildChartSvg(this.parks, this.width);
      },
      get tableRows() {
        return this.parks.map((park) => ({
          name: shortParkName(park.name),
          current: park.current == null ? "Closed" : Math.round(park.current) + " min",
          projected: park.projectedAvg == null ? "—" : Math.round(park.projectedAvg) + " min",
          versus: park.status ? statusLabel(park) : "Not enough history",
        }));
      },

      async init() {
        try {
          const res = await fetch("/api/park-trends");
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Could not load park trends");
          this.parks = data.parks;
          this.best = data.best;
          this.baselineAsOf = data.baseline_as_of;
          this.outlook = data.outlook || [];
        } catch (e) {
          this.error = e.message;
        } finally {
          this.loading = false;
        }
        this.$nextTick(() => {
          if (!this.$refs.plot) return;
          const measure = () => { this.width = this.$refs.plot.clientWidth || this.width; };
          new ResizeObserver(measure).observe(this.$refs.plot);
          measure();
        });
      },

      trackPointer(event) {
        const box = this.$refs.plot.getBoundingClientRect();
        this.hover = readingsAt(this.parks, this.width, event.clientX - box.left);
      },
    }));
  });
})();
