// Wall-clock arithmetic in a named time zone, and a workday calendar. Everything is an instant
// in milliseconds; a person's local date and time exist only on the way in and out. Stored
// times are always absolute (ISO with an offset): "tomorrow morning" is resolved once, when a
// commitment is made, never re-read later.

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  weekday: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let found = formatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, found);
  }
  return found;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parts(ms: number, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) out[part.type] = part.value;
  return out;
}

export function localParts(ms: number, tz: string): LocalParts {
  const p = parts(ms, tz);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: WEEKDAYS.indexOf(p.weekday!) };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isDate(value: string): boolean {
  return DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** The instant a local date and time names in a zone. */
export function zoned(date: string, time: string, tz: string): number {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !t) throw new Error(`not a local date and time: ${date} ${time}`);
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const first = guess - offsetAt(guess, tz);
  // Twice, for the hour around an offset change.
  return guess - offsetAt(first, tz);
}

/** An instant as ISO 8601 with the zone's offset, the way it is stored. */
export function iso(ms: number, tz: string): string {
  const { date, time } = localParts(ms, tz);
  const seconds = String(new Date(ms).getUTCSeconds()).padStart(2, "0");
  const offset = Math.round(offsetAt(ms, tz) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${date}T${time}:${seconds}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** A year's exceptions to Monday-to-Friday: days off, and weekend days that are workdays. */
export interface CalendarYear {
  holidays: string[];
  workdays: string[];
}

export interface Calendar {
  isWorkday(date: string): boolean;
  /** Years the calendar has no table for; workdays there fall back to Monday-to-Friday. */
  missingYears(dates: string[]): string[];
}

export function createCalendar(years: Record<string, CalendarYear>): Calendar {
  const off = new Set<string>();
  const on = new Set<string>();
  for (const year of Object.values(years)) {
    for (const day of year.holidays) off.add(day);
    for (const day of year.workdays) on.add(day);
  }
  return {
    isWorkday(date) {
      if (on.has(date)) return true;
      if (off.has(date)) return false;
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      return weekday !== 0 && weekday !== 6;
    },
    missingYears(dates) {
      return [...new Set(dates.map((d) => d.slice(0, 4)))].filter((y) => !(y in years)).sort();
    },
  };
}

/** Whole workdays from `from` to `to`: the local dates strictly after from's, up to and including to's, that are workdays, minus one if to's time of day is earlier than from's. */
export function workdaysBetween(from: number, to: number, tz: string, calendar: Calendar): number {
  if (to <= from) return 0;
  const a = localParts(from, tz);
  const b = localParts(to, tz);
  let n = 0;
  for (let day = addDays(a.date, 1); day <= b.date; day = addDays(day, 1)) if (calendar.isWorkday(day)) n++;
  if (n > 0 && b.time < a.time && calendar.isWorkday(b.date)) n--;
  return n;
}

/** The n-th workday after `from`'s local date, at a local time. n = 0 is from's own date if it is a workday, else the next one. */
export function addWorkdays(from: number, n: number, time: string, tz: string, calendar: Calendar): number {
  let day = localParts(from, tz).date;
  let left = n;
  if (left === 0) {
    while (!calendar.isWorkday(day)) day = addDays(day, 1);
    return zoned(day, time, tz);
  }
  while (left > 0) {
    day = addDays(day, 1);
    if (calendar.isWorkday(day)) left--;
  }
  return zoned(day, time, tz);
}

/** A person's window for one kind of matter: which days, between which local times. */
export interface Window {
  days: "daily" | "workdays";
  from: string;
  to: string;
}

const WINDOW = /^(daily|workdays) ([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]|24):([0-5]\d)$/;

export function parseWindow(text: string): Window {
  const m = WINDOW.exec(text.trim());
  if (!m) throw new Error(`not a window: "${text}" (write "workdays 09:30-20:00" or "daily 08:00-23:00")`);
  const from = `${m[2]}:${m[3]}`;
  const to = `${m[4]}:${m[5]}`;
  if (to <= from) throw new Error(`window ends before it starts: "${text}"`);
  return { days: m[1] as Window["days"], from, to };
}

export function inWindow(ms: number, window: Window, tz: string, calendar: Calendar): boolean {
  const { date, time } = localParts(ms, tz);
  if (window.days === "workdays" && !calendar.isWorkday(date)) return false;
  return time >= window.from && time < window.to;
}

/** The first instant at or after `ms` inside the window (searching up to 31 days ahead). */
export function nextInWindow(ms: number, window: Window, tz: string, calendar: Calendar): number {
  if (inWindow(ms, window, tz, calendar)) return ms;
  let day = localParts(ms, tz).date;
  for (let i = 0; i < 32; i++) {
    const usable = window.days === "daily" || calendar.isWorkday(day);
    if (usable) {
      const start = zoned(day, window.from, tz);
      if (start >= ms) return start;
    }
    day = addDays(day, 1);
  }
  throw new Error("no time inside the window in the next month");
}
