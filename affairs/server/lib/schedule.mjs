import { json } from "./paseo.mjs";
import { cronOf, parseLocal } from "./time.mjs";

// One Paseo schedule per affair, named affair:<id>, running in the affair's own workspace and delivering each finished
// run to this plugin. The log decides when it looks next; the schedule is made to agree with it (sync).

export const nameOf = (id) => `affair:${id}`;

export function promptOf(id, command) {
  return [
    `事项 ${id} 看一眼`,
    `1. 跑 \`${command} brief ${id}\`：它打印这次为什么叫你来、进展、最近的经过、截止和出处、你要读的手册。`,
    `2. 按手册做，最后跑 \`${command} report ${id} --file <你写的 json>\`；它说哪里不对就只改那几处再交，最多 3 次。`,
  ].join("\n");
}

export function roleOf(policy, name) {
  const role = policy.roles[name ?? policy.role] ?? policy.roles[policy.role];
  if (!role) throw new Error(`没有这个档位：${name}`);
  return role;
}

const idOf = (made) => made.id ?? made.scheduleId;

export async function create(run, { id, policy, workspaceId, atMs, command, role }) {
  const r = roleOf(policy, role);
  const made = await json(run, [
    "schedule", "create", promptOf(id, command),
    "--cron", cronOf(atMs, policy.tz), "--timezone", policy.tz, "--name", nameOf(id),
    "--provider", r.provider, ...(r.thinking ? ["--thinking", r.thinking] : []), ...(r.mode ? ["--mode", r.mode] : []),
    "--workspace", workspaceId, "--deliver", `affairs:${id}`,
  ]);
  return idOf(made);
}

export const reschedule = (run, scheduleId, atMs, tz) => json(run, ["schedule", "update", scheduleId, "--cron", cronOf(atMs, tz), "--timezone", tz]);
export const pause = (run, scheduleId) => json(run, ["schedule", "pause", scheduleId]);
export const resume = (run, scheduleId) => json(run, ["schedule", "resume", scheduleId]);
// run-once does not return until the look has ended; it is started, and its failure within a few seconds is heard.
export const runOnce = (run, scheduleId) => json(run, ["schedule", "run-once", scheduleId], { detachAfterMs: 5000 });
export const remove = (run, scheduleId) => json(run, ["schedule", "delete", scheduleId]);
export function changeRole(run, scheduleId, policy, name) {
  const role = roleOf(policy, name);
  return json(run, ["schedule", "update", scheduleId, "--provider", role.provider, ...(role.thinking ? ["--thinking", role.thinking] : []), ...(role.mode ? ["--mode", role.mode] : [])]);
}
export const inspect = (run, scheduleId) => json(run, ["schedule", "inspect", scheduleId]);

/**
 * Makes the schedule say what the log says: the next time, and paused once the affair is over. Returns what it changed.
 * A plan that is gone or ended is not made again here (the workspace it ran in may be archived): that is told, not fixed.
 */
export async function sync(run, state, policy, now = Date.now) {
  if (!state.scheduleId) return { changed: [], problem: "还没有计划" };
  let plan;
  try {
    plan = await inspect(run, state.scheduleId);
  } catch (error) {
    return { changed: [], problem: `计划读不到：${error.message}` };
  }
  if (plan.status === "completed" || plan.status === "ended") return { changed: [], problem: "计划已经结束了" };
  const changed = [];
  // Over, held (all plans paused by hand) or stopped by the breaker: the plan stays paused whatever the log says about the next time.
  const wantPaused = state.status !== "watching" || state.held || state.breaker;
  if (wantPaused && plan.status === "active") {
    await pause(run, state.scheduleId);
    changed.push("paused");
  } else if (!wantPaused) {
    if (plan.status === "paused") {
      await resume(run, state.scheduleId);
      changed.push("resumed");
    }
    const atMs = state.next ? Date.parse(state.next.at) : null;
    if (atMs && atMs > now() && plan.cadence?.expression !== cronOf(atMs, policy.tz)) {
      await reschedule(run, state.scheduleId, atMs, policy.tz);
      changed.push("rescheduled");
    }
  }
  return { changed, problem: "" };
}

export { parseLocal };
