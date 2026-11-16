import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/pages/assets/lightning-lane-form.js";

const {
  syncDateRange,
  syncTimeWindow,
  timeSlots,
  timePresets,
  datePresets,
  disneyAppLink,
} = globalThis.LightningLaneForm;

const AFTERNOON_ET = new Date("2026-10-30T13:47:00-04:00");
const LATE_NIGHT_ET = new Date("2026-10-30T23:30:00-04:00");

test("start date fills an empty end date", () => {
  assert.deepEqual(syncDateRange("2026-11-02", "", "start"), { start: "2026-11-02", end: "2026-11-02" });
});

test("start date moves an end date that falls before it", () => {
  assert.deepEqual(syncDateRange("2026-11-10", "2026-11-02", "start"), { start: "2026-11-10", end: "2026-11-10" });
});

test("start date leaves a later end date alone", () => {
  assert.deepEqual(syncDateRange("2026-11-02", "2026-11-05", "start"), { start: "2026-11-02", end: "2026-11-05" });
});

test("end date fills an empty start date and pulls a later one back", () => {
  assert.deepEqual(syncDateRange("", "2026-11-05", "end"), { start: "2026-11-05", end: "2026-11-05" });
  assert.deepEqual(syncDateRange("2026-11-09", "2026-11-05", "end"), { start: "2026-11-05", end: "2026-11-05" });
});

test("clearing a date does not touch the other side", () => {
  assert.deepEqual(syncDateRange("", "2026-11-05", "start"), { start: "", end: "2026-11-05" });
});

test("a return window that crosses itself clears the other side", () => {
  assert.deepEqual(syncTimeWindow("18:00", "12:00", "start"), { start: "18:00", end: "" });
  assert.deepEqual(syncTimeWindow("18:00", "12:00", "end"), { start: "", end: "12:00" });
  assert.deepEqual(syncTimeWindow("12:00", "18:00", "start"), { start: "12:00", end: "18:00" });
});

test("time slots run half-hourly with readable labels", () => {
  const slots = timeSlots();
  assert.deepEqual(slots[0], { value: "06:00", label: "6:00 AM" });
  assert.deepEqual(slots.at(-1), { value: "23:30", label: "11:30 PM" });
  assert.equal(slots.find((s) => s.value === "12:00").label, "12:00 PM");
  assert.equal(slots.length, 36);
});

test("time slots keep a saved time between slots, in order", () => {
  const values = timeSlots("13:07", "").map((s) => s.value);
  assert.equal(values.indexOf("13:07"), values.indexOf("13:00") + 1);
  assert.equal(values.length, 37);
});

test("From now rounds down to a half hour in park time", () => {
  const fromNow = timePresets(AFTERNOON_ET).find((p) => p.label === "From now");
  assert.deepEqual([fromNow.start, fromNow.end], ["13:30", ""]);
});

test("date presets use the park's date near midnight", () => {
  const [today, tomorrow] = datePresets(LATE_NIGHT_ET);
  assert.equal(today.start, "2026-10-30");
  assert.equal(tomorrow.end, "2026-10-31");
});

test("Tomorrow crosses a month boundary", () => {
  const [, tomorrow] = datePresets(new Date("2026-10-31T12:00:00-04:00"));
  assert.equal(tomorrow.start, "2026-11-01");
});

test("app link follows the device", () => {
  assert.match(disneyAppLink("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)").url, /apps\.apple\.com/);
  assert.match(disneyAppLink("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5).url, /apps\.apple\.com/);
  assert.match(disneyAppLink("Mozilla/5.0 (Linux; Android 15)").url, /play\.google\.com/);
  assert.match(disneyAppLink("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0).url, /disneyworld\.disney\.go\.com/);
});

test("dashboard groups keep selected rides under sorted parks", () => {
  const rides = [
    { name: "Test Track", parkName: "EPCOT" },
    { name: "Slinky Dog Dash", parkName: "Disney's Hollywood Studios" },
    { name: "Frozen Ever After", parkName: "EPCOT" },
    { name: "Mystery Ride", parkName: null },
  ];
  const groups = LightningLaneForm.dashboardGroups(rides, ["Slinky Dog Dash", "Frozen Ever After", "Mystery Ride"]);
  assert.deepEqual(groups.map((g) => g.park), ["Disney's Hollywood Studios", "EPCOT", "Other"]);
  assert.deepEqual(groups[1].rides.map((r) => r.name), ["Frozen Ever After"]);
});

test("ride detail shows standby and Single Pass price", () => {
  assert.equal(
    LightningLaneForm.rideDetail({ standbyWait: 65, paid: true, price: 24 }),
    "Standby 65 min · Single Pass $24.00"
  );
  assert.equal(LightningLaneForm.rideDetail({ standbyWait: null, paid: false }), "");
});

const ride = (name, extra = {}) => ({ name, status: "OPERATING", paid: false, standbyWait: null, ...extra });
const names = (rides) => rides.map((r) => r.name);
const soldOut = ride("Alpha", { state: "FINISHED", standbyWait: 5 });
const later = ride("Bravo", { state: "AVAILABLE", returnStart: "2026-10-30T15:00:00-04:00", standbyWait: 40 });
const sooner = ride("Charlie", { state: "AVAILABLE", returnStart: "2026-10-30T11:00:00-04:00", standbyWait: 70 });
const closed = ride("Delta", { status: "CLOSED", state: "AVAILABLE", returnStart: "2026-10-30T09:00:00-04:00" });
const full = ride("Echo", { state: "TEMP_FULL", standbyWait: 20 });
const RIDES = [soldOut, later, sooner, closed, full];

test("next available puts the soonest first and sold out and closed last", () => {
  assert.deepEqual(names(LightningLaneForm.sortRides(RIDES, "next")), ["Charlie", "Bravo", "Echo", "Alpha", "Delta"]);
});

test("rides sort by name", () => {
  assert.deepEqual(names(LightningLaneForm.sortRides(RIDES, "name")), ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
});

test("shortest standby leaves rides with no wait last", () => {
  assert.deepEqual(names(LightningLaneForm.sortRides(RIDES, "standby")), ["Alpha", "Echo", "Bravo", "Charlie", "Delta"]);
});

test("sorting does not change the original list", () => {
  LightningLaneForm.sortRides(RIDES, "name");
  assert.equal(RIDES[0], soldOut);
});

test("pass filter separates Multi and Single Pass rides", () => {
  const rides = [ride("Multi"), ride("Single", { paid: true })];
  assert.deepEqual(names(LightningLaneForm.filterByPass(rides, "multi")), ["Multi"]);
  assert.deepEqual(names(LightningLaneForm.filterByPass(rides, "single")), ["Single"]);
});

test("ride detail adds the usual wait when known", () => {
  assert.equal(LightningLaneForm.rideDetail({ standbyWait: 45, usualWait: 36, paid: false }), "Standby 45 min, usually 36");
  assert.equal(LightningLaneForm.rideDetail({ standbyWait: 45, usualWait: null, paid: false }), "Standby 45 min");
});
