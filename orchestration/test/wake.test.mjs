// A run that ends tells whoever should know, and keeps the account (wake.mjs): who is told and who is not, the steward found or started,
// the message, the ledger, a delivery that fails or is late, and the runs whose process died. No Paseo is asked: a fake executor takes the
// messages and the processes that are killed are real.
//
//   npm test        (from orchestration/)

import "./hermetic.mjs";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runFlow, RunRefused } from "../runtime/run.mjs";
import { flow } from "../runtime/flow.mjs";
import { checkEvents, readEvents } from "../runtime/events.mjs";
import { claimFile } from "../runtime/claim.mjs";
import { parseConfig } from "../runtime/config.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { paseoExecutor } from "../runtime/executor.mjs";
import { parseRunArgs, parseResumeArgs, runWakeLost, UsageError } from "../runtime/orch.mjs";
import { duration, ledgerFile, readLedger, stewardTarget, unseenCount, wakeText, WAKE_TIMEOUT_MS } from "../runtime/wake.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

const run = promisify(execFile);
// Flows a resume point can name are found by name, so the one that has a manual lives in a directory the config points to.
const BASE = await tempDir("orch-wake-base-");
const FLOWS = path.join(BASE, "flows");
mkdirSync(FLOWS, { recursive: true });
const CONFIG = path.join(BASE, "config.json");
writeFileSync(CONFIG, JSON.stringify({ flowsDirs: [FLOWS] }));
process.env.ORCH_CONFIG = CONFIG;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.join(HERE, "..", "runtime", "orch.mjs");
const CHILD = path.join(HERE, "steps-child.mjs");
const FLOW_MJS = pathToFileURL(path.join(HERE, "..", "runtime", "flow.mjs")).href;

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const logs = () => tempDir("orch-wake-logs-");
const options = (extra = {}) => ({ roster, caller: null, gatePollMs: 5, agentProbeDelays: [5], cwd: "C:/work", stewards: {}, ...extra });
const make = (name, body, extra = {}) => flow({ name, description: "d", phases: [], inputs: {}, grants: [], run: (_, $) => body($), ...extra });
const finished = make("finished", async () => ({ n: 1 }), { summarize: () => "all of it" });
const stops = make("stops", async ($) => $.stop("the build did not pass: 3 errors", { part: 1 }), { resume: "auto" });
const breaks = make("breaks", async () => {
  throw new RangeError("bad range");
});

async function go(f, logDir, extra = {}) {
  const result = await runFlow(f, { ...options(), logDir, ...extra });
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  const wake = events.filter((e) => e.kind === "wake");
  assert.equal(wake.length, 1, "one wake per run");
  assert.equal(events.at(-1).kind, "run.end", "run.end is the last line");
  assert.equal(events.at(-2).kind, "wake", "the wake is the one before it");
  return { result, events, wake: wake[0] };
}
const withSteward = (executor, id = "steward-1", labels = {}) => executor.addAgent({ id, labels });
const ledger = (dir) => readLedger(dir);

// --- Who is told ------------------------------------------------------------------------------------------------------

test("nobody asked and no steward configured: nothing is sent, no account is kept, and the event says why", async () => {
  const dir = await logs();
  const executor = fakeExecutor();
  const { result, wake } = await go(finished, dir, { executor });
  assert.equal(result.outcome, "done");
  assert.deepEqual([wake.to, wake.via, wake.ok, wake.error, wake.started, wake.unseen, wake.ledger], [null, null, null, null, false, 0, false]);
  assert.match(wake.why, /no steward is configured for flow "finished"/);
  assert.deepEqual(executor.notifications, []);
  assert.equal(existsSync(ledgerFile(dir)), false);
});

test("a session that runs the flow in front of itself is not told: it reads the result off the command", async () => {
  const dir = await logs();
  const executor = fakeExecutor();
  withSteward(executor, "steward-1", { "orch-steward": "all" });
  const { wake } = await go(stops, dir, { executor, caller: "session-1", stewards: { "*": { agent: "steward-1" } } });
  assert.deepEqual([wake.to, wake.via, wake.ok], [null, null, null]);
  assert.match(wake.why, /in front of itself/);
  assert.deepEqual(executor.notifications, [], "the steward is not told either");
  assert.equal(wake.ledger, true, "but the account has it");
  assert.deepEqual(ledger(dir).map((e) => [e.flow, e.outcome, e.to, e.via, e.ok]), [["stops", "stopped", null, null, null]]);
});

test("--notify names the session to tell; a run started in the background tells its caller; both beat the steward", async () => {
  const dir = await logs();
  const executor = fakeExecutor();
  withSteward(executor, "steward-1");
  withSteward(executor, "agent-7");
  const stewards = { "*": { agent: "steward-1" } };

  const named = await go(stops, dir, { executor, stewards, notify: "agent-7" });
  assert.deepEqual([named.wake.to, named.wake.via, named.wake.ok], ["agent-7", "explicit", true]);
  assert.deepEqual(named.events[0].notify, { agent: "agent-7", via: "explicit" });
  assert.equal(executor.notifications.length, 1);
  const [sent] = executor.notifications;
  assert.equal(sent.agentId, "agent-7");
  assert.equal(sent.timeoutMs, WAKE_TIMEOUT_MS);
  assert.equal(readFileSync(sent.file, "utf8").replaceAll("\r", ""), sent.text, "the file the message went through holds it");
  assert.equal(sent.file, path.join(dir, "steward", "wake", `${named.result.runId}.txt`));

  const background = await go(stops, dir, { executor, stewards, caller: "session-2", detached: true });
  assert.deepEqual([background.wake.to, background.wake.via], ["session-2", "caller"]);
  assert.deepEqual(background.events[0].notify, { agent: "session-2", via: "caller" });
  // The caller of a run that is not in the background is not told; and a background run nobody started goes to the steward.
  const front = await go(stops, dir, { executor, stewards, caller: "session-2" });
  assert.equal(front.events[0].notify, null);
  assert.equal(front.wake.to, null);
  const unattended = await go(stops, dir, { executor, stewards, detached: true });
  assert.deepEqual([unattended.wake.to, unattended.wake.via], ["steward-1", "steward"]);

  await assert.rejects(runFlow(stops, { ...options(), logDir: dir, executor, notify: "--all" }), (error) => error instanceof RunRefused && /notify is the id of the session/.test(error.message));
  await assert.rejects(runFlow(stops, { ...options(), logDir: dir, executor, caller: "two words", detached: true }), RunRefused);
});

// --- The steward ------------------------------------------------------------------------------------------------------

test("a configured agent that is there is told; one that is gone or archived is a reason, not a failure; a flow's own entry beats *", async () => {
  const dir = await logs();
  const executor = fakeExecutor();
  withSteward(executor, "steward-1");
  executor.addAgent({ id: "steward-old", archived: true });
  const stewards = { "*": { agent: "steward-1" }, stops: { agent: "steward-old" }, breaks: { agent: "steward-missing" } };

  const star = await go(finished, dir, { executor, stewards });
  assert.deepEqual([star.wake.to, star.wake.via, star.wake.ok, star.wake.started], ["steward-1", "steward", true, false]);
  assert.equal(executor.notifications[0].agentId, "steward-1");

  const archived = await go(stops, dir, { executor, stewards });
  assert.deepEqual([archived.wake.to, archived.wake.ok], [null, null]);
  assert.match(archived.wake.why, /steward-old.*gone or archived.*no workspace is configured/);
  const missing = await go(breaks, dir, { executor, stewards });
  assert.match(missing.wake.why, /steward-missing.*gone or archived/);
  assert.equal(executor.notifications.length, 1, "nothing was sent to either");
  assert.deepEqual(ledger(dir).map((e) => [e.flow, e.via, e.ok]), [["finished", "steward", true], ["stops", null, null], ["breaks", null, null]]);
  assert.deepEqual(stewardTarget(stewards, "stops").label, "stops");
  assert.deepEqual([stewardTarget(stewards, "other").label, stewardTarget(stewards, "other").key], ["all", "*"]);
  assert.equal(stewardTarget({ stops: {} }, "other"), null);
  assert.equal(stewardTarget(undefined, "other"), null);
});

test("a workspace: the session with the label there is told; one with the label elsewhere, or archived, is not; none starts one", async () => {
  const dir = await logs();
  const workspaces = [{ workspaceId: "ws-ops", cwd: "C:/ops", title: "Ops" }];
  const executor = fakeExecutor({ workspaces });
  executor.addAgent({ id: "elsewhere", labels: { "orch-steward": "all" }, cwd: "C:/other" });
  executor.addAgent({ id: "retired", labels: { "orch-steward": "all" }, cwd: "C:/ops", archived: true });
  const stewards = { "*": { workspace: "ws-ops", guide: ["C:/guide/MANUAL.md"] } };

  const first = await go(stops, dir, { executor, stewards });
  assert.deepEqual([first.wake.via, first.wake.started, first.wake.ok], ["steward", true, true]);
  assert.equal(executor.notifications.length, 0, "a session started for this message was given it as its first");
  const started = executor.requests.at(-1);
  assert.equal(started.workspace, "ws-ops");
  assert.deepEqual(started.labels, { "orch-steward": "all" });
  assert.equal(started.provider, roster.roles.steward.provider);
  assert.equal(started.title, "Flow steward");
  assert.match(started.prompt, /负责会话（steward）/);
  assert.match(started.prompt, /先读：C:\/guide\/MANUAL\.md/);
  assert.ok(started.prompt.includes("[流程] stops 停了") && started.prompt.includes("原因：the build did not pass: 3 errors"), "the message that started it is in its prompt");
  assert.equal(first.wake.to, [...executor.agents.keys()].at(-1));

  const second = await go(finished, dir, { executor, stewards });
  assert.deepEqual([second.wake.to, second.wake.started, second.wake.ok], [first.wake.to, false, true], "the one it started is used after that");
  assert.equal(executor.notifications.length, 1);
  assert.equal(executor.requests.filter((r) => r.labels?.["orch-steward"]).length, 1, "and no second one is started");

  const missing = await go(stops, dir, { executor, stewards: { "*": { workspace: "ws-nowhere" } } });
  assert.match(missing.wake.why, /ws-nowhere.*is not there/);
});

test("a directory: its workspace is found or made, and the steward is started there once", async () => {
  const dir = await logs();
  const workspaces = [];
  const executor = fakeExecutor({ workspaces });
  const stewards = { stops: { cwd: "C:/ops", role: "fast" } };
  const first = await go(stops, dir, { executor, stewards });
  assert.deepEqual(workspaces.map((w) => [w.cwd, w.title]), [["C:/ops", "Flow steward"]], "made, and titled");
  assert.equal(executor.requests.at(-1).provider, roster.roles.fast.provider, "the role the config names");
  assert.equal(executor.requests.at(-1).workspace, workspaces[0].workspaceId);
  const second = await go(stops, dir, { executor, stewards });
  assert.equal(workspaces.length, 1, "the same workspace again");
  assert.deepEqual([second.wake.to, second.wake.started], [first.wake.to, false]);
  assert.equal(executor.notifications.length, 1);
  assert.equal(executor.notifications[0].agentId, first.wake.to);
  // A role that does not exist is a failed delivery, written down, and the run is what it was.
  const odd = await go(stops, await logs(), { executor, stewards: { "*": { cwd: "C:/ops", role: "no-such-role" } } });
  assert.equal(odd.result.outcome, "stopped");
  assert.equal(odd.wake.ok, false);
  assert.match(odd.wake.error, /Unknown role "no-such-role"/);
});

const stewardStarts = (executor) => executor.requests.filter((r) => r.labels?.["orch-steward"]).length;

test("runs that end together start one steward between them, not one each", async () => {
  const dir = await logs();
  const executor = fakeExecutor({ spawnDelayMs: 600 });
  const stewards = { "*": { cwd: "C:/ops" } };
  const ended = await Promise.all([1, 2, 3].map(() => go(stops, dir, { executor, stewards })));
  assert.equal(stewardStarts(executor), 1, "one session was started");
  assert.equal(ended.filter((e) => e.wake.started).length, 1, "and one run says it started it");
  assert.equal(new Set(ended.map((e) => e.wake.to)).size, 1, "the others were told the one that was started");
  assert.ok(ended.every((e) => e.wake.ok === true), ended.map((e) => e.wake.error).join());
  assert.equal(executor.notifications.length, 2, "it was given the first message as its first; the other two were told");
  assert.equal(readdirSync(path.join(dir, "steward")).filter((name) => name.endsWith(".lock")).length, 0, "no lock is left");
});

test("a delivery that gives up does not let go of the start: the next run waits for it and uses what it made", async () => {
  const dir = await logs();
  const executor = fakeExecutor({ spawnDelayMs: 700 });
  const stewards = { "*": { cwd: "C:/ops" } };
  const early = await go(stops, dir, { executor, stewards, wakeTimeoutMs: 100 });
  assert.deepEqual([early.wake.ok, early.wake.error], [false, "Error: no answer in 0.1s"], "the first stopped waiting");
  assert.equal(stewardStarts(executor), 1, "the session is being made");
  const next = await go(stops, dir, { executor, stewards, wakeTimeoutMs: 5_000 });
  assert.equal(stewardStarts(executor), 1, "and the next run did not start another");
  assert.deepEqual([next.wake.started, next.wake.ok], [false, true]);
  assert.equal(next.wake.to, [...executor.agents.keys()].at(-1));
  assert.equal(executor.notifications.length, 1);
});

test("a steward that was started and is not in the listing is found by the id written down; one that is gone is not", async () => {
  const dir = await logs();
  const executor = fakeExecutor();
  const stewards = { "*": { cwd: "C:/ops" } };
  const first = await go(stops, dir, { executor, stewards });
  assert.equal(first.wake.started, true);
  // The listing does not show it (as when the daemon is slow to list what it has just made); the id written down does.
  const listing = executor.listAgents;
  executor.listAgents = async (labels) => (labels["orch-steward"] ? [] : listing(labels));
  const second = await go(stops, dir, { executor, stewards });
  assert.deepEqual([second.wake.to, second.wake.started, second.wake.ok], [first.wake.to, false, true]);
  assert.equal(stewardStarts(executor), 1);
  // Archived, it is not used: a new one is started.
  executor.agents.get(first.wake.to).archived = true;
  const third = await go(stops, dir, { executor, stewards });
  assert.deepEqual([third.wake.started, third.wake.ok], [true, true]);
  assert.notEqual(third.wake.to, first.wake.to);
});

test("when a flow is told of: every run, or only those that did not come to done; a session that asked is told either way", async () => {
  const dir = await logs();
  const executor = fakeExecutor();
  withSteward(executor, "steward-1");
  withSteward(executor, "agent-7");
  const stewards = { "*": { agent: "steward-1" } };
  const quiet = (name, body) => make(name, body, { wake: "problems" });
  const done = await go(quiet("quiet-done", async () => 1), dir, { executor, stewards });
  assert.equal(done.wake.to, null);
  assert.match(done.wake.why, /wake: "problems"/);
  assert.equal(done.wake.ledger, true, "it is in the account all the same");
  const bad = await go(quiet("quiet-bad", async ($) => $.stop("no")), dir, { executor, stewards });
  assert.deepEqual([bad.wake.to, bad.wake.ok], ["steward-1", true]);
  const asked = await go(quiet("quiet-asked", async () => 1), dir, { executor, stewards, notify: "agent-7" });
  assert.deepEqual([asked.wake.to, asked.wake.via], ["agent-7", "explicit"]);
  assert.throws(() => flow({ name: "x", description: "d", phases: [], inputs: {}, grants: [], run: async () => 1, wake: "always" }), /wake is "problems"/);
  assert.equal(finished.wake, null);
});

// --- The message ------------------------------------------------------------------------------------------------------

test("the message is made of what run.start and run.end say: one line for a run that is done, the way to look and to go on for one that is not", async () => {
  const dir = await logs();
  const executor = fakeExecutor();
  withSteward(executor, "steward-1");
  const stewards = { "*": { agent: "steward-1" } };

  const handbook = path.join(FLOWS, "noted.mjs");
  writeFileSync(handbook.replace(/\.mjs$/, ".steward.md"), "# the manual\n");
  writeFileSync(
    handbook,
    `import { flow } from ${JSON.stringify(FLOW_MJS)};\nexport default flow({ name: "noted", description: "d", phases: [], inputs: {}, grants: [], resume: "auto", async run(_, $) { $.stop("waiting for the build\\nsecond line", { part: 1 }); } });\n`,
  );

  const ok = await go(finished, dir, { executor, stewards, affair: { label: "Item 12" } });
  const [okMessage] = executor.notifications.map((n) => n.text);
  assert.equal(okMessage.split("\n").length, 1);
  assert.match(okMessage, new RegExp(`^\\[流程\\] finished 跑完 · Item 12 · \\d+s · 运行 ${ok.result.runId}$`));

  const bad = await go(handbook, dir, { executor, stewards, affair: { label: "Item 12" } });
  const message = executor.notifications.at(-1).text;
  const lines = message.split("\n");
  assert.match(lines[0], /^\[流程\] noted 停了 · Item 12 · \d+s$/);
  assert.equal(lines[1], "原因：waiting for the build second line", "one line, the reason as run.end has it");
  assert.equal(lines[2], `运行 ${bad.result.runId} · 事件 ${bad.result.events}`);
  assert.match(lines[3], new RegExp(`^接着跑：node .*orch\\.mjs resume ${bad.result.runId}（`));
  assert.ok(lines[3].includes(bad.result.resume.from), "the words of the resume point, as run.end has them");
  assert.equal(lines[4], `手册：${handbook.replace(/\.mjs$/, ".steward.md")}`, "the manual next to the flow, where there is one");
  assert.equal(lines.length, 5, "the steward was told of the run before this one, so nothing is unheard of");

  await go(breaks, dir, { executor, stewards });
  const failed = executor.notifications.at(-1).text.split("\n");
  assert.equal(failed[1], "原因：RangeError: bad range");
  assert.ok(!failed.some((l) => l.startsWith("接着跑")) && !failed.some((l) => l.startsWith("手册")));
});

test("wakeText and duration, on their own", () => {
  const facts = { flow: "f", outcome: "failed", affair: null, durationMs: 5_760_000, usd: 0.41, runId: "r1", lineage: "r0", events: "E", reason: "x ".repeat(400), resume: null, manual: null, unseen: 0, ledger: "L" };
  const lines = wakeText(facts).split("\n");
  assert.equal(lines[0], "[流程] f 出错了 · 1h36m · $0.41");
  assert.ok([...lines[1]].length === 3 + 300 + 1 && lines[1].endsWith("…"), "a reason is cut");
  assert.equal(lines[2], "运行 r1（接着线 r0） · 事件 E");
  assert.equal(wakeText({ ...facts, outcome: "lost", usd: 0.001, durationMs: null, lineage: "r1", reason: "gone" }).split("\n")[0], "[流程] f 失联了 · <$0.01");
  assert.deepEqual([45_000, 95_000, 3_600_000, 90_000_000, -1, NaN].map(duration), ["45s", "1m35s", "1h", "1d1h", null, null]);
  // A run that ended with a call still going holds its line: carrying it on now would be refused, and the message says so -- and says that
  // a process that has gone may have cut the call off, which is not waited out but settled.
  const held = wakeText({ ...facts, working: 2 }).split("\n").find((line) => /还有 2 个调用没回来/.test(line));
  assert.ok(held, "the line is there");
  assert.match(held, /暂时被占着/);
  assert.match(held, /进程还在.*等它们回来/);
  assert.match(held, /进程已经退出.*截断.*settle/);
  assert.doesNotMatch(held, /等它们回来再接着跑$/, "it does not promise that they come back");
  assert.equal(wakeText({ ...facts, working: 0 }).includes("没回来"), false);
});

test("what a secret was cannot get into the message: the code a person typed is in no word of it", async () => {
  const dir = await logs();
  const executor = fakeExecutor({ carrier: "input" });
  withSteward(executor, "steward-1");
  const f = flow({
    name: "coded",
    description: "d",
    phases: [],
    inputs: {},
    grants: ["gate:deny"],
    run: async (_, $) => {
      const given = await $.gate({ title: "approve", content: "x", timeout: "1m", input: { label: "code" } });
      $.stop(`the code ${given.input} was refused`);
    },
  });
  const { result } = await go(f, dir, { executor, stewards: { "*": { agent: "steward-1" } } });
  assert.equal(result.outcome, "stopped");
  const sent = executor.notifications.map((n) => n.text).join("\n");
  assert.ok(sent.includes("was refused"));
  assert.equal(sent.includes("483921"), false);
  assert.equal(readFileSync(ledgerFile(dir), "utf8").includes("483921"), false);
});

// --- The account ------------------------------------------------------------------------------------------------------

test("the account has a line for every run of a flow with a steward, and the steward is told how many it has not heard of", async () => {
  const dir = await logs();
  const executor = fakeExecutor();
  withSteward(executor, "steward-1");
  withSteward(executor, "agent-7");
  const stewards = { "*": { agent: "steward-1" } };
  const affair = { label: "Item 12", key: "item-12" };

  await go(stops, dir, { executor, stewards, affair });
  assert.equal(executor.notifications.at(-1).text.includes("账里"), false, "nothing unheard of yet");
  await go(finished, dir, { executor, stewards, caller: "session-1" });
  await go(stops, dir, { executor, stewards, notify: "agent-7" });
  await go(breaks, dir, { executor, stewards, notify: "agent-7" });
  await go(stops, dir, { executor, stewards });
  const message = executor.notifications.at(-1);
  assert.equal(message.agentId, "steward-1");
  assert.match(message.text, /账里自上次以来还有 3 次运行/);
  assert.equal(unseenCount(readLedger(dir)), 0, "that told the steward of them all");

  const entries = readLedger(dir);
  assert.equal(entries.length, 5);
  const [first] = entries;
  assert.deepEqual(Object.keys(first).sort(), ["affair", "at", "durationMs", "flow", "lineage", "ok", "outcome", "runId", "started", "to", "usd", "v", "via", "why"]);
  assert.deepEqual([first.flow, first.outcome, first.why, first.to, first.via, first.ok], ["stops", "stopped", "the build did not pass: 3 errors", "steward-1", "steward", true]);
  assert.deepEqual(first.affair, { key: "key:item-12", label: "Item 12" });
  assert.deepEqual(entries.map((e) => e.via), ["steward", null, "explicit", "explicit", "steward"]);
  // A line that is not an entry says nothing, and a last line cut short is not read.
  writeFileSync(ledgerFile(dir), `not json\n${JSON.stringify({ runId: "a", via: "steward", ok: true })}\n{"runId":"b"}\n{"runId":"c`, "utf8");
  assert.equal(unseenCount(readLedger(dir)), 1);
  assert.equal(unseenCount([]), 0);
});

// --- A delivery that does not come off ---------------------------------------------------------------------------------

test("a message that cannot be delivered, or is too late, is a line in the events and nothing else", async () => {
  const dir = await logs();
  const refused = fakeExecutor({ notifyFails: "daemon is not running" });
  withSteward(refused, "steward-1");
  const stewards = { "*": { agent: "steward-1" } };
  const failed = await go(stops, dir, { executor: refused, stewards });
  assert.equal(failed.result.outcome, "stopped", "the outcome is what the flow made it");
  assert.deepEqual([failed.wake.to, failed.wake.ok], ["steward-1", false]);
  assert.match(failed.wake.error, /daemon is not running/);
  assert.equal(readLedger(dir)[0].ok, false);
  assert.equal(unseenCount(readLedger(dir)), 1, "a message that did not arrive leaves the run unheard of");

  const slow = fakeExecutor({ notifyDelayMs: 3_000 });
  withSteward(slow, "steward-1");
  const started = Date.now();
  const late = await go(finished, dir, { executor: slow, stewards, wakeTimeoutMs: 50 });
  assert.ok(Date.now() - started < 2_500, "the run did not wait for it");
  assert.equal(late.result.outcome, "done");
  assert.deepEqual([late.wake.ok, late.wake.error], [false, "Error: no answer in 0.05s"]);

  // The executor cannot be asked at all, or the config is not one: still a run that ended as it did.
  const base = fakeExecutor();
  withSteward(base, "steward-1");
  const bare = await go(finished, dir, { executor: { ...base, notify: undefined }, stewards });
  assert.deepEqual([bare.wake.to, bare.wake.ok], ["steward-1", false]);
  await assert.rejects(runFlow(finished, { ...options(), logDir: dir, executor: fakeExecutor(), wakeTimeoutMs: 0 }), /wakeTimeoutMs/);
});

// --- A run whose process died --------------------------------------------------------------------------------------------

async function diedRun(logDir, runId, notify) {
  const work = await tempDir("orch-wake-work-");
  const died = await run(process.execPath, [CHILD, logDir, runId, work, "backfill", ...(notify ? [notify] : [])]).then(() => assert.fail("it should have died"), (error) => error);
  assert.equal(died.code, 7);
  // What a run that was killed leaves: a claim nobody touches, of a process that is gone.
  const claim = claimFile(logDir, runId);
  writeFileSync(claim, JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname(), startedAt: "2026-10-30T00:00:00.000Z" }));
  const old = new Date(Date.now() - 300_000);
  utimesSync(claim, old, old);
}

test("wake-lost: a run whose process is known to be gone is told of once, to whom it asked, else to the steward", async () => {
  const dir = await logs();
  await diedRun(dir, "lost-1");
  await diedRun(dir, "lost-2", "agent-7");
  await diedRun(dir, "lost-alive");
  // That run's process is taken to be still there: its claim is a live one's.
  writeFileSync(claimFile(dir, "lost-alive"), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: "2026-10-30T00:00:00.000Z" }));
  const executor = fakeExecutor();
  withSteward(executor, "steward-1");
  withSteward(executor, "agent-7");
  const stewards = { "*": { agent: "steward-1" } };

  const dry = await runWakeLost(["--dry-run"], { logDir: dir, executor, roster, stewards });
  assert.deepEqual(dry.woken.map((w) => w.runId).sort(), ["lost-1", "lost-2"]);
  assert.deepEqual([executor.notifications.length, existsSync(ledgerFile(dir))], [0, false], "a dry run sends nothing and writes nothing");

  const done = await runWakeLost([], { logDir: dir, executor, roster, stewards });
  assert.deepEqual(done.woken.map((w) => [w.runId, w.to, w.via, w.ok]).sort(), [["lost-1", "steward-1", "steward", true], ["lost-2", "agent-7", "explicit", true]]);
  const texts = Object.fromEntries(executor.notifications.map((n) => [n.agentId, n.text]));
  assert.match(texts["steward-1"], /^\[流程\] commit-then-backfill 失联了/);
  assert.match(texts["steward-1"], /原因：进程没了，没有写出结局；最后一条事件在 /);
  assert.match(texts["steward-1"], /运行 lost-1 · 事件 /);
  assert.equal(readLedger(dir).filter((e) => e.outcome === "lost").length, 2);

  const again = await runWakeLost([], { logDir: dir, executor, roster, stewards });
  assert.deepEqual(again.woken, [], "each is told of once");
  assert.equal(executor.notifications.length, 2);
  await assert.rejects(runWakeLost(["--now"], { logDir: dir, executor, roster, stewards }), UsageError);
});

test("wake-lost: with no steward the lost run is entered in the account all the same, so that it is not looked at again; a run in front of a session is not told", async () => {
  const dir = await logs();
  await diedRun(dir, "lost-a");
  const executor = fakeExecutor();
  const first = await runWakeLost([], { logDir: dir, executor, roster, stewards: {} });
  assert.deepEqual(first.woken.map((w) => [w.runId, w.to, w.ok]), [["lost-a", null, null]]);
  assert.match(first.woken[0].why, /no steward is configured/);
  assert.deepEqual((await runWakeLost([], { logDir: dir, executor, roster, stewards: {} })).woken, []);
  assert.equal(executor.notifications.length, 0);
});

// --- The contract ---------------------------------------------------------------------------------------------------------

test("checkEvents knows the wake event: at most one, a recipient with its way, a failure with its reason", async () => {
  const dir = await logs();
  const { events } = await go(finished, dir, { executor: fakeExecutor() });
  const at = events.findIndex((e) => e.kind === "wake");
  const mutate = (patch) => {
    const copy = structuredClone(events);
    Object.assign(copy[at], patch);
    return checkEvents(copy, { strict: true, complete: true });
  };
  assert.deepEqual(mutate({}), []);
  assert.match(mutate({ to: "a" }).join(), /via is explicit \| caller \| steward when there is a recipient/);
  assert.match(mutate({ to: "a", via: "steward" }).join(), /ok is a boolean when there is a recipient/);
  assert.match(mutate({ to: "a", via: "steward", ok: false }).join(), /error is a string when delivering failed/);
  assert.deepEqual(mutate({ to: "a", via: "steward", ok: false, error: "x" }), []);
  assert.match(mutate({ via: "somebody" }).join(), /via is explicit/);
  assert.match(mutate({ started: true }).join(), /only a steward is started/);
  assert.match(mutate({ unseen: -1 }).join(), /unseen is not a non-negative integer/);
  const twice = structuredClone(events);
  twice.splice(at, 0, { ...twice[at] });
  twice.forEach((e, i) => (e.seq = i));
  assert.match(checkEvents(twice, { strict: true, complete: true }).join(), /a second wake/);
  const noted = structuredClone(events);
  noted[0].notify = { agent: "a", via: "friend" };
  assert.match(checkEvents(noted, { strict: true, complete: true }).join(), /notify is not null/);
});

test("config: stewards by flow name or *, each in exactly one place, with its role and guide", () => {
  const ok = parseConfig('{ "stewards": { "*": { "cwd": "D:/ops", "guide": ["D:/ops/GUIDE.md"], "role": "steward" }, "build-and-ship": { "agent": "a1" }, "w": { "workspace": "ws" } } }', "c");
  assert.deepEqual(Object.keys(ok.stewards), ["*", "build-and-ship", "w"]);
  const wrong = (stewards, pattern) => assert.throws(() => parseConfig(JSON.stringify({ stewards }), "c"), pattern);
  wrong([], /"stewards" has the wrong shape: it is an object/);
  wrong({ "Bad Name": { agent: "a" } }, /"Bad Name" is not a flow name or \*/);
  wrong({ "*": "a1" }, /"\*" is not an object/);
  wrong({ "*": {} }, /exactly one of agent, workspace, cwd/);
  wrong({ "*": { agent: "a", cwd: "D:/x" } }, /exactly one of agent, workspace, cwd/);
  wrong({ "*": { agent: "" } }, /agent is a non-empty string/);
  wrong({ "*": { agent: "a", model: "x" } }, /unknown key model/);
  wrong({ "*": { cwd: "D:/x", guide: "GUIDE.md" } }, /guide is a list of file paths/);
  wrong({ "*": { cwd: "D:/x", role: "" } }, /role is a non-empty string/);
});

// --- The command line ---------------------------------------------------------------------------------------------------

test("orch.mjs: --notify and --detach are flags of run and resume, and --detach is not an input", async () => {
  const f = flow({ name: "flags", description: "d", phases: [], inputs: {}, grants: [], run: async () => 1 });
  assert.deepEqual(await parseRunArgs(f, []), { input: {}, timeout: null, host: null, cwd: null });
  assert.deepEqual(await parseRunArgs(f, ["--notify", "agent-7"]), { input: {}, timeout: null, host: null, cwd: null, notify: "agent-7" });
  const detached = await parseRunArgs(f, ["--detach", "--timeout", "5m", "--run-id", "r-1"]);
  assert.deepEqual([detached.detach, detached.runId, detached.argv], [true, "r-1", ["--timeout=5m", "--run-id=r-1"]]);
  await assert.rejects(parseRunArgs(f, ["--notify", "-x"]), UsageError);
  assert.deepEqual(await parseResumeArgs(["--notify", "agent-7", "--detach"]), { timeout: null, host: null, cwd: null, notify: "agent-7", detach: true, argv: ["--notify=agent-7"] });
  assert.throws(() => flow({ name: "x", description: "d", phases: [], inputs: { detach: { type: "boolean" } }, grants: [], run: async () => 1 }), /detach/);
});

/** Run orch.mjs the way a person or another program would, where no Paseo can be reached: the CLI's install directory does not exist. */
function orch(args, { logDir, env = {} }) {
  const config = path.join(logDir, "config.json");
  writeFileSync(config, "{}");
  const full = { ...process.env, ORCH_LOG_DIR: logDir, ORCH_CONFIG: config, PASEO_INSTALL_DIR: path.join(logDir, "no-paseo-here"), ...env };
  if (!env.PASEO_AGENT_ID) delete full.PASEO_AGENT_ID;
  return { env: full, args: [ORCH, ...args] };
}

test("orch.mjs run --detach returns at once with the run's id, and the run goes on and tells the session that started it", async () => {
  const logDir = await logs();
  const file = path.join(await tempDir("orch-wake-flow-"), "background.mjs");
  writeFileSync(
    file,
    `import { flow } from ${JSON.stringify(FLOW_MJS)};\nexport default flow({ name: "background", description: "d", phases: [], inputs: {}, grants: [], async run() { await new Promise((r) => setTimeout(r, 300)); return 1; } });\n`,
  );
  const { env, args } = orch(["run", file, "--detach"], { logDir, env: { PASEO_AGENT_ID: "caller-agent" } });
  const started = Date.now();
  const { stdout } = await run(process.execPath, args, { env });
  const printed = JSON.parse(stdout);
  assert.deepEqual([printed.ok, printed.detached], [true, true]);
  assert.match(printed.runId, /^[0-9a-f-]{36}$/);
  assert.equal(printed.events, path.join(logDir, "runs", `${printed.runId}.jsonl`));
  assert.ok(Date.now() - started < 5000);

  // It ends by itself: the session that started it is told, which here cannot be done (there is no Paseo), and the event says so.
  let events = [];
  for (let i = 0; i < 100 && !events.some((e) => e.kind === "run.end"); i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      events = readEvents(printed.events);
    } catch {
      // Not there yet.
    }
  }
  assert.equal(events.at(-1)?.kind, "run.end", "the run ended without the process that started it");
  assert.deepEqual(events[0].notify, { agent: "caller-agent", via: "caller" });
  const wake = events.find((e) => e.kind === "wake");
  assert.deepEqual([wake.to, wake.via, wake.ok], ["caller-agent", "caller", false]);
  assert.match(wake.error, /Paseo install looks wrong/);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  assert.equal(readFileSync(path.join(logDir, "steward", "wake", `${printed.runId}.txt`), "utf8").startsWith("[流程] background 跑完"), true, "the message was written where the CLI reads it from");
});

test("orch.mjs run --notify and a run in the foreground: the session named is told, the one that ran it is not", async () => {
  const logDir = await logs();
  const file = path.join(await tempDir("orch-wake-flow-"), "foreground.mjs");
  writeFileSync(file, `import { flow } from ${JSON.stringify(FLOW_MJS)};\nexport default flow({ name: "foreground", description: "d", phases: [], inputs: {}, grants: [], async run() { return 1; } });\n`);
  const named = orch(["run", file, "--notify", "agent-7"], { logDir, env: { PASEO_AGENT_ID: "caller-agent" } });
  const one = JSON.parse((await run(process.execPath, named.args, { env: named.env })).stdout);
  const wakeOne = readEvents(one.events).find((e) => e.kind === "wake");
  assert.deepEqual([wakeOne.to, wakeOne.via], ["agent-7", "explicit"]);
  const plain = orch(["run", file], { logDir, env: { PASEO_AGENT_ID: "caller-agent" } });
  const two = JSON.parse((await run(process.execPath, plain.args, { env: plain.env })).stdout);
  const wakeTwo = readEvents(two.events).find((e) => e.kind === "wake");
  assert.deepEqual([wakeTwo.to, wakeTwo.ok], [null, null]);
  const bad = orch(["run", file, "--notify", "--"], { logDir });
  const refused = await run(process.execPath, bad.args, { env: bad.env }).then(() => assert.fail("expected exit 2"), (error) => error);
  assert.equal(refused.code, 2);
  const lost = orch(["wake-lost", "--dry-run"], { logDir });
  assert.deepEqual(JSON.parse((await run(process.execPath, lost.args, { env: lost.env })).stdout), { ok: true, dryRun: true, woken: [] });
});

test("the real executor: the wake-up is a steer into the turn, not waited for, to the local daemon even for a run on another host; the listing is of agents that are not archived", async () => {
  const calls = [];
  const cli = {
    runPaseoJson: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === "ls") return [{ id: "a1", name: "Flow steward", status: "idle", cwd: "C:/ops", provider: "claude" }, { id: "a2", cwd: null }];
      if (args[0] === "inspect") return { Status: "idle", Archived: true };
      return null;
    },
    runPaseo: async () => ({ stdout: "" }),
  };
  const executor = paseoExecutor({ host: "ssh://me@elsewhere", cli });
  const file = path.join(await tempDir("orch-wake-file-"), "deeper", "m.txt");
  await executor.notify("agent-7", "the message", { file, timeoutMs: 30_000 });
  assert.deepEqual(calls[0].args, ["send", "agent-7", "--prompt-file", file, "--behavior", "steer", "--no-wait"]);
  assert.deepEqual(calls[0].options, { timeoutMs: 30_000 }, "no --host: the steward is on this machine");
  assert.equal(readFileSync(file, "utf8"), "the message");
  assert.deepEqual(await executor.listAgents({ "orch-steward": "all" }), [
    { id: "a1", name: "Flow steward", status: "idle", cwd: "C:/ops" },
    { id: "a2", name: null, status: null, cwd: null },
  ]);
  assert.deepEqual(calls[1].args, ["ls", "-g", "--background", "--label", "orch-steward=all"]);
  assert.equal((await executor.inspect("a1")).archived, true);
});
