/** Optional reading metadata, kept outside value so reading times do not change its fingerprint. */
export const stepFields = (reading) => reading.steps === undefined ? {} : { steps: reading.steps, ...(reading.validUntil ? { validUntil: reading.validUntil } : {}) };

export function stepProblem(reading) {
  if (reading.steps === undefined) return "";
  if (!Array.isArray(reading.steps) || reading.steps.some((s) => !s || typeof s.id !== "string" || !s.id || typeof s.title !== "string" || !s.title || !["done", "now", "todo", "blocked"].includes(s.state) || !["agent", "him", "wait"].includes(s.who) || (s.note != null && typeof s.note !== "string") || (s.since != null && s.since !== "" && (typeof s.since !== "string" || !Number.isFinite(Date.parse(s.since)))))) return "steps 要是步骤清单，每步有 id、title、state（done/now/todo/blocked）、who（agent/him/wait）";
  if (reading.validUntil != null && reading.validUntil !== "" && !Number.isFinite(Date.parse(reading.validUntil))) return "validUntil 要是 ISO 时间";
  return "";
}

const WHO = { agent: "我来做", him: "你来做", wait: "等外部" };

/** The compact checklist a chat and a look both read. No checklist leaves the old brief untouched. */
export function stepLines(state, now) {
  const reading = state.stepRead;
  if (!reading?.steps?.length) return [];
  const { steps } = reading;
  const at = Date.parse(reading.at);
  const until = reading.validUntil ? Date.parse(reading.validUntil) : at + 24 * 3_600_000;
  const done = steps.filter((s) => s.state === "done").length;
  const current = steps.findIndex((s) => s.state === "now" || s.state === "blocked");
  const index = current >= 0 ? current : steps.findIndex((s) => s.state !== "done");
  const next = steps.findIndex((s, i) => i > index && s.state !== "done");
  const line = (i, label) => {
    const s = steps[i];
    return `- ${label}：第 ${i + 1}/${steps.length} 步 ${s.title}（${WHO[s.who]}）${s.state === "blocked" ? `；卡住了：${s.note || "原因未说明"}` : s.note ? `；${s.note}` : ""}`;
  };
  return [
    "## 走到哪一步",
    ...(now > until ? [`可能过时：${Math.max(1, Math.floor((now - at) / 3_600_000))} 小时前读的`] : []),
    ...(done ? [done === steps.length ? `全部 ${done} 步已完成` : `前面 ${done} 步已完成`] : []),
    ...(index >= 0 ? [line(index, "现在"), ...(next >= 0 ? [line(next, "下一步")] : [])] : []),
    "",
  ];
}
