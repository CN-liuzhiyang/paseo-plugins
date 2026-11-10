// A stand-in for the paseo CLI: keeps projects, workspaces and schedules in a JSON file and appends every call to a
// log, so a test can read what the code asked Paseo to do. Prints what the real CLI prints with --json.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const stateFile = process.env.FAKE_PASEO_STATE;
const callsFile = process.env.FAKE_PASEO_CALLS;
const args = process.argv.slice(2);
appendFileSync(callsFile, `${JSON.stringify(args)}\n`);
const db = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { projects: [], workspaces: [], schedules: [], n: 0 };
const save = () => writeFileSync(stateFile, JSON.stringify(db));
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = (value) => console.log(JSON.stringify(value));
const die = (message) => {
  console.error(`Error: ${message}`);
  process.exit(1);
};
const [group, action, first] = args;
const next = (prefix) => `${prefix}_${++db.n}`;

if (process.env.FAKE_PASEO_FAIL && args.join(" ").includes(process.env.FAKE_PASEO_FAIL)) die("fake failure");

if (group === "project" && action === "ls") out(db.projects);
else if (group === "project" && action === "create") {
  const p = { projectId: next("prj"), name: "root", kind: "non_git", path: first };
  db.projects.push(p);
  save();
  out(p);
} else if (group === "project" && action === "rename") {
  db.projects.find((p) => p.projectId === first).name = args[3];
  save();
  out({ projectId: first, name: args[3] });
} else if (group === "workspace" && action === "create") {
  const w = { workspaceId: next("wks"), project: flag("--project"), name: flag("--title"), cwd: flag("--path"), isolation: flag("--isolation") === "worktree" ? "worktree" : "local", background: false };
  if (w.isolation === "worktree") {
    // Like Paseo: a git worktree outside the source checkout, created by Paseo, the workspace staying with the source project.
    const source = flag("--path");
    w.source = source;
    w.cwd = path.join(path.dirname(stateFile), "paseo-worktrees", flag("--worktree-slug") ?? `wt-${db.n}`);
    const branch = flag("--new-branch") ?? flag("--branch");
    execFileSync("git", flag("--new-branch") ? ["worktree", "add", "-b", branch, w.cwd, flag("--base")] : ["worktree", "add", w.cwd, branch], { cwd: source, stdio: "pipe" });
  }
  db.workspaces.push(w);
  save();
  out(w);
} else if (group === "workspace" && action === "rename") {
  db.workspaces.find((w) => w.workspaceId === first).name = args[3];
  save();
  out({ workspaceId: first, name: args[3] });
} else if (group === "workspace" && action === "archive") {
  const w = db.workspaces.find((x) => x.workspaceId === first);
  w.archived = true;
  if (w.isolation === "worktree") execFileSync("git", ["worktree", "remove", "--force", w.cwd], { cwd: w.source, stdio: "pipe" });
  for (const s of db.schedules) if (s.workspace === first) s.status = "completed";
  save();
  out({ workspaceId: first, archived: true });
} else if (group === "schedule" && action === "create") {
  const s = { id: next("sch"), name: flag("--name"), prompt: first, cadence: { type: "cron", expression: flag("--cron"), timezone: flag("--timezone") }, provider: flag("--provider"), thinking: flag("--thinking"), mode: flag("--mode"), workspace: flag("--workspace"), delivery: flag("--deliver"), status: "active", runs: 0 };
  db.schedules.push(s);
  save();
  out({ id: s.id, name: s.name, status: s.status });
} else if (group === "schedule" && action === "ls") out(db.schedules);
else if (group === "schedule" && action === "channels") out(JSON.parse(process.env.FAKE_PASEO_CHANNELS ?? "[]"));
else if (group === "schedule") {
  const s = db.schedules.find((x) => x.id === first);
  if (!s) die(`Schedule not found: ${first}`);
  if (action === "update") {
    if (flag("--cron")) s.cadence = { type: "cron", expression: flag("--cron"), timezone: flag("--timezone") ?? s.cadence.timezone };
  } else if (action === "pause") s.status = "paused";
  else if (action === "resume") s.status = "active";
  else if (action === "delete") db.schedules = db.schedules.filter((x) => x.id !== first);
  else if (action === "run-once") {
    if (s.running) die("already running");
    // The look that ended is still counted as running for this many calls; said the way the CLI does, as pretty-printed JSON.
    if ((db.busy ?? Number(process.env.FAKE_PASEO_BUSY ?? 0)) > 0) {
      db.busy = (db.busy ?? Number(process.env.FAKE_PASEO_BUSY)) - 1;
      save();
      console.error(JSON.stringify({ error: { code: "schedule_conflict", message: `Schedule ${first} is already running` } }, null, 2));
      process.exit(1);
    }
    s.runs += 1;
  }
  save();
  out(s);
} else if (group === "logs") {
  // `paseo logs <id>`: the text of a session, from a file the test put in FAKE_PASEO_LOGS (a folder, one <id>.txt each).
  const file = `${process.env.FAKE_PASEO_LOGS ?? ""}/${action}.txt`;
  if (!process.env.FAKE_PASEO_LOGS || !existsSync(file)) die(`Agent not found: ${action}`);
  process.stdout.write(readFileSync(file, "utf8"));
} else if (group === "ls") {
  // `paseo ls -a --label k=v -q`: the short ids of sessions carrying every label. Only the calling session is known here, with the
  // labels the test gave it (the real `agent inspect` prints no labels, which is why the code asks this way).
  const labels = JSON.parse(process.env.FAKE_PASEO_LABELS ?? "{}");
  const pairs = args.flatMap((a, i) => (args[i - 1] === "--label" ? [a] : []));
  const mine = process.env.PASEO_AGENT_ID ?? "";
  if (mine && pairs.length && pairs.every((p) => labels[p.slice(0, p.indexOf("="))] === p.slice(p.indexOf("=") + 1))) console.log(mine.slice(0, 7));
} else if (group === "provider" && action === "ls") {
  // The card provider as the list shows it: "available" by default; FAKE_PASEO_GATE says another status, "missing" leaves it out.
  const status = process.env.FAKE_PASEO_GATE ?? "available";
  out(status === "missing" ? [{ provider: "claude", status: "available", enabled: "Enabled" }] : [{ provider: "claude", status: "available", enabled: "Enabled" }, { provider: "orch-gate", status, enabled: status === "disabled" ? "Disabled" : "Enabled" }]);
} else die(`unknown: ${args.join(" ")}`);
