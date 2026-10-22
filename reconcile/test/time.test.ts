import assert from "node:assert/strict";
import { test } from "node:test";
import { addWorkdays, createCalendar, inWindow, iso, localParts, nextInWindow, parseWindow, workdaysBetween, zoned } from "../server/time";

const TZ = "Asia/Shanghai";
const calendar = createCalendar({ "2026": { holidays: ["2026-10-01", "2026-10-02", "2026-10-05"], workdays: ["2026-10-10"] } });

test("zoned and iso round-trip with the zone's offset", () => {
  const ms = zoned("2026-10-23", "18:00", TZ);
  assert.equal(new Date(ms).toISOString(), "2026-10-23T10:00:00.000Z");
  assert.equal(iso(ms, TZ), "2026-10-23T18:00:00+08:00");
  assert.deepEqual(localParts(ms, TZ), { date: "2026-10-23", time: "18:00", weekday: 5 });
  // A zone with daylight saving: the wall time is kept across the change.
  assert.equal(iso(zoned("2026-03-29", "12:00", "Europe/Berlin"), "Europe/Berlin"), "2026-03-29T12:00:00+02:00");
});

test("the calendar knows days off and make-up workdays", () => {
  assert.equal(calendar.isWorkday("2026-10-01"), false);
  assert.equal(calendar.isWorkday("2026-10-10"), true); // a Saturday that is a workday
  assert.equal(calendar.isWorkday("2026-10-11"), false);
  assert.equal(calendar.isWorkday("2026-10-12"), true);
  assert.deepEqual(calendar.missingYears(["2026-12-31", "2027-01-02"]), ["2027"]);
});

test("workdaysBetween counts whole workdays", () => {
  const mon = zoned("2026-10-12", "16:38", TZ);
  assert.equal(workdaysBetween(mon, zoned("2026-10-15", "16:45", TZ), TZ, calendar), 3);
  assert.equal(workdaysBetween(mon, zoned("2026-10-15", "16:00", TZ), TZ, calendar), 2);
  // Friday evening to Monday morning is not a workday.
  assert.equal(workdaysBetween(zoned("2026-10-16", "18:00", TZ), zoned("2026-10-19", "09:00", TZ), TZ, calendar), 0);
  assert.equal(workdaysBetween(mon, mon, TZ, calendar), 0);
});

test("addWorkdays skips weekends and holidays", () => {
  assert.equal(iso(addWorkdays(zoned("2026-10-23", "18:05", TZ), 2, "10:00", TZ, calendar), TZ), "2026-10-27T10:00:00+08:00");
  assert.equal(iso(addWorkdays(zoned("2026-09-30", "18:00", TZ), 1, "10:00", TZ, calendar), TZ), "2026-10-06T10:00:00+08:00");
  assert.equal(iso(addWorkdays(zoned("2026-10-11", "09:00", TZ), 0, "10:00", TZ, calendar), TZ), "2026-10-12T10:00:00+08:00");
});

test("windows", () => {
  const work = parseWindow("workdays 09:30-20:00");
  assert.equal(inWindow(zoned("2026-10-23", "18:00", TZ), work, TZ, calendar), true);
  assert.equal(inWindow(zoned("2026-10-23", "21:00", TZ), work, TZ, calendar), false);
  assert.equal(inWindow(zoned("2026-10-24", "12:00", TZ), work, TZ, calendar), false);
  assert.equal(iso(nextInWindow(zoned("2026-10-23", "21:00", TZ), work, TZ, calendar), TZ), "2026-10-26T09:30:00+08:00");
  assert.equal(iso(nextInWindow(zoned("2026-10-26", "07:00", TZ), work, TZ, calendar), TZ), "2026-10-26T09:30:00+08:00");
  const daily = parseWindow("daily 08:00-23:00");
  assert.equal(iso(nextInWindow(zoned("2026-10-24", "23:30", TZ), daily, TZ, calendar), TZ), "2026-10-25T08:00:00+08:00");
  assert.throws(() => parseWindow("weekdays 9-5"), /not a window/);
  assert.throws(() => parseWindow("daily 20:00-08:00"), /ends before/);
});
