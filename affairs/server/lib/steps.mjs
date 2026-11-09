import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { modeOf } from "./mode.mjs";

export const workReadme = (state, policy) => policy.workDir && path.resolve(policy.workDir, state.id, "README.md");

export function workSteps(state, policy) {
  const file = workReadme(state, policy);
  if (!file || !existsSync(file)) return [];
  const section = readFileSync(file, "utf8").split(/^## 步骤\s*\r?$/m)[1]?.split(/^#{1,2} /m)[0] || "";
  return [...section.matchAll(/^- \[([ xX])\] (.+)$/gm)].map((m, i) => ({ id: String(i + 1), title: m[2].trim(), state: m[1].toLowerCase() === "x" ? "done" : "todo", who: /谁[：:]\s*他/.test(m[2]) ? "him" : "agent" }));
}

/** Optional reading metadata, kept outside value so reading times do not change its fingerprint. */
export const stepFields = (reading) => reading.steps === undefined ? {} : { steps: reading.steps, ...(reading.validUntil ? { validUntil: reading.validUntil } : {}) };

export function stepProblem(reading) {
  if (reading.steps === undefined) return "";
  if (!Array.isArray(reading.steps) || reading.steps.some((s) => !s || typeof s.id !== "string" || !s.id || typeof s.title !== "string" || !s.title || !["done", "now", "todo", "blocked"].includes(s.state) || !["agent", "him", "wait"].includes(s.who) || (s.note != null && typeof s.note !== "string") || (s.since != null && s.since !== "" && (typeof s.since !== "string" || !Number.isFinite(Date.parse(s.since)))))) return "steps 要是步骤清单，每步有 id、title、state（done/now/todo/blocked）、who（agent/him/wait）";
  if (reading.validUntil != null && reading.validUntil !== "" && !Number.isFinite(Date.parse(reading.validUntil))) return "validUntil 要是 ISO 时间";
  return "";
}

const WHO = { agent: "我来做", him: "你来做", wait: "等外部" };

export const stepsOf = (state, policy) => policy && modeOf(state, policy) === "drive" ? workSteps(state, policy) : state.stepRead?.steps ?? [];

/** The compact checklist a chat and a look both read. No checklist leaves the old brief untouched. */
export function stepLines(state, now, policy) {
  const drive = policy && modeOf(state, policy) === "drive";
  const reading = drive ? { steps: stepsOf(state, policy), at: new Date(now).toISOString() } : state.stepRead;
  if (drive && !reading.steps.length) return ["done", "stopped"].includes(state.status) ? [] : ["## 走到哪一步", "README 还没有步骤清单，先写步骤和估算请他批。"];
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
