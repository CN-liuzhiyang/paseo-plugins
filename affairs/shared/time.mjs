/** How long ago, in the words he uses: 刚才 / 12 分钟前 / 3 小时前 / 2 天前. */
export function ago(atIso, now) {
  const m = Math.max(0, Math.round((now - Date.parse(atIso)) / 60_000));
  if (m < 1) return "刚才";
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
}

/** Today's activity is relative; older activity uses the viewer's local month and day. */
export function sessionWhen(atIso, now = Date.now()) {
  const at = new Date(atIso);
  if (!Number.isFinite(at.getTime())) return "";
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return ago(atIso, now);
  return `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}
