// Local times are written "YYYY-MM-DD HH:mm" in the policy's time zone; the log keeps ISO with offset; a Paseo
// schedule keeps cron plus the zone name.

const pad = (n) => String(n).padStart(2, "0");

/** Minutes east of UTC at that instant. */
export function offsetMinutes(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

export function localParts(ms, tz) {
  const shifted = new Date(ms + offsetMinutes(ms, tz) * 60_000);
  const y = shifted.getUTCFullYear(), mo = shifted.getUTCMonth() + 1, d = shifted.getUTCDate(), h = shifted.getUTCHours(), mi = shifted.getUTCMinutes();
  return { y, mo, d, h, mi, dow: shifted.getUTCDay(), date: `${y}-${pad(mo)}-${pad(d)}`, text: `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}` };
}

/** "2026-11-05 18:00" -> epoch ms, or null when it is not that shape or not a real time. */
export function parseLocal(text, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(wall).getUTCMonth() !== mo - 1 || h > 23 || mi > 59) return null;
  let guess = wall - offsetMinutes(wall, tz) * 60_000;
  guess = wall - offsetMinutes(guess, tz) * 60_000;
  return guess;
}

export function isoLocal(ms, tz) {
  const offset = offsetMinutes(ms, tz);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${localParts(ms, tz).text.replace(" ", "T")}:${pad(Math.floor(ms / 1000) % 60)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export const cronOf = (ms, tz) => {
  const p = localParts(ms, tz);
  return `${p.mi} ${p.h} ${p.d} ${p.mo} *`;
};

/** "11-10 周二 20:00", or "明天 9:30" within the next two days; for the card. */
export function speak(ms, now, tz) {
  const p = localParts(ms, tz);
  const today = localParts(now, tz);
  const dayDiff = Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(today.y, today.mo - 1, today.d)) / 86_400_000);
  const clock = `${p.h}:${pad(p.mi)}`;
  if (dayDiff === 0) return `今天 ${clock}`;
  if (dayDiff === 1) return `明天 ${clock}`;
  const week = "日一二三四五六"[p.dow];
  return `${pad(p.mo)}-${pad(p.d)} 周${week} ${pad(p.h)}:${pad(p.mi)}`;
}
