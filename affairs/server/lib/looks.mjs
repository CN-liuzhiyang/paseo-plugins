import { hashOf } from "./readers.mjs";

/** Which reports are certainly quiet, using only their existing log fields and the look that produced them. */
export function quietLooks(lines) {
  const result = new Map();
  const values = new Map();
  let visit = null;
  let seenReport = false;
  const finish = () => {
    if (!visit) return;
    for (const report of visit.reports) result.set(report.seq, {
      noChange: report.known && !visit.news,
      scheduled: visit.why.length === 1 && visit.why[0] === "time",
    });
  };
  for (const line of lines) {
    if (line.kind === "wake") {
      finish();
      visit = { why: Array.isArray(line.why) ? line.why : [], news: false, reports: [] };
    } else if (line.kind === "wake.end") {
      if (visit && line.state !== "ok") visit.news = true;
      finish();
      visit = null;
    } else if (line.kind === "read" || line.kind === "watch.read") {
      if (line.ok === false) { if (visit) visit.news = true; continue; }
      if (line.expired || line.reset) continue;
      const key = line.kind === "read" ? `${line.tool}|${hashOf(line.args)}` : `watch:${line.id}`;
      const value = hashOf({ value: line.value, steps: line.steps });
      if (visit && values.get(key) !== value) visit.news = true;
      values.set(key, value);
    } else if (line.kind === "report" && line.from !== "chat" && line.verdict !== "rejected") {
      if (visit) visit.reports.push({ seq: line.seq, known: seenReport && line.changed === false && ["pass", "recorded"].includes(line.verdict) });
      seenReport = true;
    } else if (visit && (line.kind === "asked" || line.kind === "status" || line.kind === "flag" || (line.kind === "next" && ["ask", "appeal", "fallback"].includes(line.verdict)))) visit.news = true;
  }
  finish();
  return result;
}
