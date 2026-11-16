#!/usr/bin/env python3
"""
Builds the park baseline mousing compares today's waits with.
Primary source: RopeDrop Planner (https://ropedropplanner.com/developers)
Crowd levels and backup live waits: Queue-Times.com (https://queue-times.com)

Usage:
  ROPEDROP_CONTACT=you@example.com npm run baseline:build
  npm run baseline:load

Outputs land in data/ as CSV + JSON. park_baseline.json is the file the app
reads, loaded into KV by baseline:load. RopeDrop's analysis endpoints need a
contact address, so they run only when ROPEDROP_CONTACT is set. An optional
data/magic_kingdom_historical_averages.csv (columns Ride, Average Wait (mins))
adds your own ride averages.
"""

import json
import csv
import os
import re
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# ---------- Config ----------
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUTPUT_DIR = DATA_DIR
HISTORICAL_CSV = DATA_DIR / "magic_kingdom_historical_averages.csv"

CONTACT_EMAIL = os.environ.get("ROPEDROP_CONTACT")
USER_AGENT = f"mousing/0.1 ({CONTACT_EMAIL or 'https://github.com/m4ndolore/mousing'})"

SEASONAL_TABLES = {
    "months": "crowd level by month (all time)",
    "weekdays": "crowd level by day of the week (all time)",
}

WDW_PARKS = {
    "magic_kingdom": {"slug": "magic_kingdom", "qt_id": 6, "name": "Magic Kingdom"},
    "epcot": {"slug": "epcot", "qt_id": 5, "name": "Epcot"},
    "hollywood_studios": {"slug": "hollywood_studios", "qt_id": 7, "name": "Hollywood Studios"},
    "animal_kingdom": {"slug": "animal_kingdom", "qt_id": 8, "name": "Animal Kingdom"},
}

# ---------- Helpers ----------
def fetch_json(url, user_agent=None, timeout=20):
    headers = {"User-Agent": user_agent or USER_AGENT}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} for {url}")
        if e.code == 403:
            print("  → Analysis endpoints require a User-Agent with contact email.")
        return None
    except Exception as e:
        print(f"Error fetching {url}: {e}")
        return None

def write_csv(path, rows, fieldnames=None):
    if not rows:
        print(f"  (no rows) {path}")
        return
    if fieldnames is None:
        fieldnames = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    print(f"  Wrote {len(rows)} rows → {path}")

def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
    print(f"  Wrote JSON → {path}")

# ---------- RopeDrop Live Waits ----------
def get_ropedrop_live(park_slug):
    url = f"https://ropedropplanner.com/api/parks/wait-times?park_id={park_slug}"
    data = fetch_json(url)
    if not data:
        return []
    rides = []
    now = datetime.now(timezone.utc).isoformat()
    for entity_id, info in data.items():
        # The endpoint returns the whole resort whatever park_id says.
        if info.get("park") != park_slug or info.get("entity_type") not in ("ATTRACTION", "SHOW"):
            continue
        ll = info.get("lightning_lane") or {}
        rides.append({
            "snapshot_utc": now,
            "park": park_slug,
            "entity_id": entity_id,
            "name": info.get("name"),
            "entity_type": info.get("entity_type"),
            "status": info.get("status"),
            "wait_time": info.get("wait_time"),
            "ll_state": ll.get("state"),
            "ll_time": ll.get("time"),
            "ll_price_display": ll.get("price_display"),
            "last_updated": info.get("last_updated"),
            "slug": info.get("slug"),
            "lat": info.get("lat"),
            "lng": info.get("lng"),
            "source": "ropedrop",
        })
    return rides

# ---------- Queue-Times Live (optional backup) ----------
def get_queue_times(park_id):
    url = f"https://queue-times.com/parks/{park_id}/queue_times.json"
    data = fetch_json(url)
    if not data:
        return []
    rides = []
    now = datetime.now(timezone.utc).isoformat()
    for land in data.get("lands", []):
        for ride in land.get("rides", []):
            rides.append({
                "snapshot_utc": now,
                "park_id": park_id,
                "land": land.get("name"),
                "ride_id": ride.get("id"),
                "name": ride.get("name"),
                "is_open": ride.get("is_open"),
                "wait_time": ride.get("wait_time"),
                "last_updated": ride.get("last_updated"),
                "source": "queue-times",
            })
    return rides

# ---------- Top Waits ----------
def get_top_waits(days=7, limit=15):
    url = f"https://ropedropplanner.com/api/parks/top-waits?destination=wdw&days={days}&limit={limit}"
    data = fetch_json(url)
    if not data:
        return []
    return data.get("rides", [])

# ---------- Strategy ----------
def get_strategy(park_slug):
    # Note: endpoint uses hyphen in some docs; try both if needed
    url = f"https://ropedropplanner.com/api/parks/strategy/wdw/{park_slug}"
    return fetch_json(url)

# ---------- Analysis (require User-Agent) ----------
def get_top_volatile(park_slug, limit=15):
    url = f"https://ropedropplanner.com/api/analysis/top-volatile/{park_slug}?limit={limit}"
    return fetch_json(url, user_agent=USER_AGENT)

def get_sellouts(park_slug, limit=20):
    url = f"https://ropedropplanner.com/api/analysis/sellouts?park_id={park_slug}&limit={limit}"
    return fetch_json(url, user_agent=USER_AGENT)

def get_weather_impact(park_slug):
    url = f"https://ropedropplanner.com/api/analysis/weather-impact/{park_slug}"
    return fetch_json(url, user_agent=USER_AGENT)

# ---------- App baseline ----------
def normalize_name(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())

def read_historical_rides(path=HISTORICAL_CSV):
    """Hand-built ride averages, keyed by normalized name."""
    if not path.exists():
        print(f"  (no file) {path}")
        return {}
    with open(path, newline="", encoding="utf-8") as f:
        return {
            normalize_name(row["Ride"]): {"name": row["Ride"], "avg": int(row["Average Wait (mins)"]), "source": "queue-times"}
            for row in csv.DictReader(f)
            if row.get("Average Wait (mins)")
        }

def parse_crowd_table(html, heading):
    """Rows of the first table after a Queue-Times stats heading, as {label: level}."""
    start = html.find(heading)
    if start < 0:
        return {}
    body = html[start:html.find("</tbody>", start)]
    return {label: int(level) for label, level in re.findall(r"<td>(\w{3})</td>\s*<td>(\d+)</td>", body)}

def get_seasonal_levels():
    """Queue-Times all-time crowd levels by month and weekday, one page per park."""
    seasonal = {}
    for key, meta in WDW_PARKS.items():
        url = f"https://queue-times.com/en-US/parks/{meta['qt_id']}/stats"
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                html = resp.read().decode()
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"Error fetching {url}: {e}")
            continue
        tables = {name: parse_crowd_table(html, heading) for name, heading in SEASONAL_TABLES.items()}
        if len(tables["months"]) == 12 and len(tables["weekdays"]) == 7:
            seasonal[key] = tables
        else:
            print(f"  Skipped {meta['name']}: crowd tables not found")
        time.sleep(1)
    return seasonal

def build_baseline(strategies, top_waits, historical_rides, seasonal=None, sellouts=None):
    """What the app compares live readings against. Pure, so it is testable."""
    parks = {}
    for key, strategy in strategies.items():
        hours = (strategy.get("peak_hours") or {}).get("hourly_breakdown") or []
        # Zero means no rides reported that hour, not a zero-minute wait.
        curve = [{"hour": row["hour"], "avg": row["all_rides_avg"]} for row in hours if row.get("all_rides_avg")]
        if curve:
            parks[key] = {"hours": curve}
    rides = dict(historical_rides)
    # The trailing 30 days are more current than the annual figures.
    for ride in top_waits:
        rides[normalize_name(ride["name"])] = {"name": ride["name"], "avg": ride["avg_wait"], "source": "ropedrop"}
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "parks": parks,
        "rides": rides,
        "seasonal": seasonal or {},
        "sellouts": {
            ride["entity_id"]: {"name": ride["name"], "typicalTime": ride.get("typical_time"), "frequency": ride.get("sellout_frequency")}
            for ride in sellouts or []
            if ride.get("typical_time")
        },
    }

# ---------- Main ----------
def main():
    OUTPUT_DIR.mkdir(exist_ok=True)
    print("=== Disney World Wait Times Extractor ===")
    print(f"Output directory: {OUTPUT_DIR.resolve()}\n")

    # 1. Live waits (RopeDrop) for all parks
    all_live = []
    for key, meta in WDW_PARKS.items():
        print(f"Fetching live waits: {meta['name']}...")
        rides = get_ropedrop_live(meta["slug"])
        all_live.extend(rides)
        time.sleep(0.4)  # gentle on rate limits

    write_csv(OUTPUT_DIR / "live_waits_all_parks.csv", all_live)
    write_json(OUTPUT_DIR / "live_waits_all_parks.json", all_live)

    # 2. Top waits (7d and 30d)
    print("\nFetching top waits...")
    top7 = get_top_waits(days=7, limit=15)
    top30 = get_top_waits(days=30, limit=15)
    write_csv(OUTPUT_DIR / "top_waits_7d.csv", top7)
    write_csv(OUTPUT_DIR / "top_waits_30d.csv", top30)
    write_json(OUTPUT_DIR / "top_waits_7d.json", top7)
    write_json(OUTPUT_DIR / "top_waits_30d.json", top30)

    # 3. Strategy per park
    print("\nFetching strategy recommendations...")
    strategies = {}
    for key, meta in WDW_PARKS.items():
        print(f"  Strategy: {meta['name']}")
        strat = get_strategy(meta["slug"])
        if strat:
            strategies[key] = strat
            write_json(OUTPUT_DIR / f"strategy_{key}.json", strat)
        time.sleep(0.5)

    # 4. Analysis endpoints (volatile, sellouts, weather)
    sellout_rows = []
    if not CONTACT_EMAIL:
        print("\nSkipping analysis: set ROPEDROP_CONTACT to run it.")
    else:
        print("\nFetching analysis (volatile / sellouts / weather)...")
        volatile_rows = []
        weather_data = {}

        for key, meta in WDW_PARKS.items():
            slug = meta["slug"]
            print(f"  Analysis: {meta['name']}")

            vol = get_top_volatile(slug)
            if vol and isinstance(vol, list):
                for r in vol:
                    r["park"] = slug
                    volatile_rows.append(r)
            elif vol and "rides" in vol:
                for r in vol.get("rides", []):
                    r["park"] = slug
                    volatile_rows.append(r)

            sells = get_sellouts(slug)
            if sells and isinstance(sells, list):
                for r in sells:
                    r["park"] = slug
                    sellout_rows.append(r)
            elif sells and "rides" in sells:
                for r in sells.get("rides", []):
                    r["park"] = slug
                    sellout_rows.append(r)

            weather = get_weather_impact(slug)
            if weather:
                weather_data[slug] = weather

            time.sleep(0.6)

        write_csv(OUTPUT_DIR / "analysis_volatile.csv", volatile_rows)
        write_csv(OUTPUT_DIR / "analysis_sellouts.csv", sellout_rows)
        write_json(OUTPUT_DIR / "analysis_weather.json", weather_data)

    # 5. Optional Queue-Times snapshot (Magic Kingdom example)
    print("\nFetching Queue-Times live (Magic Kingdom) as backup...")
    qt_mk = get_queue_times(WDW_PARKS["magic_kingdom"]["qt_id"])
    write_csv(OUTPUT_DIR / "queue_times_magic_kingdom.csv", qt_mk)
    write_json(OUTPUT_DIR / "queue_times_magic_kingdom.json", qt_mk)

    print("\nFetching Queue-Times seasonal crowd levels...")
    seasonal = get_seasonal_levels()

    print("\nBuilding app baseline...")
    baseline = build_baseline(strategies, top30, read_historical_rides(), seasonal, sellout_rows)
    if len(baseline["parks"]) == len(WDW_PARKS):
        write_json(OUTPUT_DIR / "park_baseline.json", baseline)
    else:
        print(f"  Not written: only {len(baseline['parks'])} parks returned hourly data.")

    print("\n=== Done ===")
    print(f"All files written to: {OUTPUT_DIR.resolve()}")
    print("Tip: Re-run periodically during park hours and append snapshots for your own time-series.")

if __name__ == "__main__":
    main()
