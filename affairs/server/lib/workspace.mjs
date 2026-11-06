import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { json } from "./paseo.mjs";
import { localParts } from "./time.mjs";
import { localPathOf } from "./projects.mjs";

// Every affair gets a workspace of its own, all under one project named 事项 whose directory is the affairs root. The
// workspace's directory is wherever the affair's sessions have to work (a private matter: its own folder; a ticket:
// the repository the ticket's sessions need), set once at creation.

export const PROJECT_NAME = "事项";
const ARCHIVE_PREFIX = "✓ ";

export async function ensureProject(run, root) {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "project.json");
  const known = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).projectId : null;
  const projects = await json(run, ["project", "ls"]);
  const same = (p) => path.resolve(p.path ?? "").toLowerCase() === path.resolve(root).toLowerCase();
  const found = projects.find((p) => p.projectId === known) ?? projects.find(same);
  if (found) {
    if (found.name !== PROJECT_NAME) await json(run, ["project", "rename", found.projectId, PROJECT_NAME]);
    writeFileSync(file, JSON.stringify({ projectId: found.projectId }));
    return found.projectId;
  }
  const made = await json(run, ["project", "create", root]);
  await json(run, ["project", "rename", made.projectId, PROJECT_NAME]);
  writeFileSync(file, JSON.stringify({ projectId: made.projectId }));
  return made.projectId;
}

export async function createWorkspace(run, { projectId, workdir, title }) {
  mkdirSync(workdir, { recursive: true });
  const made = await json(run, ["workspace", "create", "--isolation", "local", "--project", projectId, "--path", workdir, "--title", title, "--no-background"]);
  return made.workspaceId;
}

export const renameWorkspace = (run, workspaceId, title) => json(run, ["workspace", "rename", workspaceId, title]);
export const archiveWorkspace = (run, workspaceId) => json(run, ["workspace", "archive", workspaceId]);

/** What the sidebar shows for an affair: the name; with the day when the next look is days away; ✓ once it is over. */
export function titleOf(state, now, policy) {
  const base = state.title;
  if (state.status !== "watching") return `${ARCHIVE_PREFIX}${base}`;
  // A question he has not answered shows in the sidebar: that is the one thing that needs him.
  if (state.asks.some((a) => a.state === "open")) return `${base} · 要你定`;
  // A date the person has not agreed to yet (a proposal waits for their answer) is not shown as if it were the plan.
  const proposed = state.asks.some((a) => a.state === "open" && a.proposal);
  const at = state.next && !proposed ? Date.parse(state.next.at) : NaN;
  if (Number.isFinite(at) && at - now > 3 * 86_400_000) {
    const p = localParts(at, policy.tz);
    return `${base} · ${p.mo}月${p.d}日`;
  }
  return base;
}

/** The first project's local checkout, otherwise the affair's own folder. */
export async function workdirOf(root, id, projects, policy) {
  if (!projects.length) return policy.workDir ? path.join(policy.workDir, id) : path.join(root, id);
  const dir = await localPathOf(projects[0], policy);
  if (!dir) throw new Error(`这台机器上没检出 ${projects[0]}`);
  return dir;
}
