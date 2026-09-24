import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkProcess, type Probe } from "./alive";
import { readFrom, readHeadLine, readTailLines, splitComplete } from "./lines";
import { resolveLogDir } from "./logdir";
import { createRunIndex, readRun } from "./runs";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const scratch = mkdtemp(path.join(os.tmpdir(), "orchestration-ui-"));
after(async () => rm(await scratch, { recursive: true, force: true }));

const bytes = (text: string) => new TextEncoder().encode(text);

/** The fixtures' machine, with every pid answering as `answer` says. */
function probeFor(answer: "alive" | "EPERM" | "ESRCH"): Probe {
  return {
    hostname: "FIXTURE-HOST",
    kill: () => {
      if (answer !== "alive") throw Object.assign(new Error(answer), { code: answer });
      return true;
    },
  };
}

/** Copy a fixture into a runs directory under its run id, as the runtime names files. */
async function install(name: string, dir: string): Promise<string> {
  const text = await readFile(path.join(FIXTURES, `${name}.jsonl`), "utf8");
  const runId = JSON.parse(text.slice(0, text.indexOf("\n"))).runId as string;
  await writeFile(path.join(dir, `${runId}.jsonl`), text);
  return runId;
}

test("splitComplete keeps byte offsets and leaves the half line", () => {
  const { lines, consumed } = splitComplete(bytes('{"a":"中文"}\n\n{"b":2}\r\n{"c":'), 100);
  assert.deepEqual(
    lines.map((line) => [line.offset, line.text]),
    [
      [100, '{"a":"中文"}'],
      [100 + bytes('{"a":"中文"}\n\n').length, '{"b":2}'],
    ],
  );
  assert.equal(consumed, bytes('{"a":"中文"}\n\n{"b":2}\r\n').length);
});

test("readFrom resumes at the offset it returned, across a line appended in two writes", async () => {
  const file = path.join(await scratch, "grow.jsonl");
  await writeFile(file, '{"n":1}\n{"n":2,"s":"半');
  const first = await readFrom(file, 0);
  assert.deepEqual(first.lines.map((line) => JSON.parse(line.text).n), [1]);
  assert.equal(first.more, false);
  // The rest of the multi-byte line arrives later.
  await appendFile(file, '行"}\n{"n":3}\n');
  const second = await readFrom(file, first.nextOffset);
  assert.deepEqual(second.lines.map((line) => JSON.parse(line.text)), [{ n: 2, s: "半行" }, { n: 3 }]);
  assert.equal(second.nextOffset, second.size);
  // Past the end means the file was replaced.
  const reset = await readFrom(file, second.size + 10);
  assert.equal(reset.reset, true);
  assert.equal(reset.lines.length, 3);
});

test("readFrom returns a line longer than its budget whole, and says when more is waiting", async () => {
  const file = path.join(await scratch, "long.jsonl");
  const long = JSON.stringify({ prompt: "x".repeat(5000) });
  const tail = Array.from({ length: 2000 }, (_, n) => JSON.stringify({ n })).join("\n");
  await writeFile(file, `${long}\n${tail}\n`);
  const chunk = await readFrom(file, 0, 100);
  assert.equal(chunk.lines[0]!.text, long);
  assert.equal(chunk.more, true);
  const texts = chunk.lines.map((line) => line.text);
  for (let offset = chunk.nextOffset, more: boolean = chunk.more; more; ) {
    const next = await readFrom(file, offset, 100);
    texts.push(...next.lines.map((line) => line.text));
    offset = next.nextOffset;
    more = next.more;
  }
  assert.equal(texts.length, 2001);
  assert.equal(texts.at(-1), '{"n":1999}');
});

test("head and tail find whole lines through small windows", async () => {
  const file = path.join(await scratch, "ends.jsonl");
  const big = JSON.stringify({ kind: "run.end", value: "y".repeat(3000) });
  await writeFile(file, `{"kind":"run.start"}\n{"kind":"log"}\n${big}\n{"kind":"half`);
  assert.equal(await readHeadLine(file, 4), '{"kind":"run.start"}');
  const tail = await readTailLines(file, 16);
  assert.equal(tail.at(-1)!.text, big);
});

async function runsDir(name: string): Promise<string> {
  const dir = path.join(await scratch, name, "runs");
  await mkdir(dir, { recursive: true });
  return dir;
}

test("list summarizes every fixture and orders by start", async () => {
  const dir = await runsDir("list");
  const ids: Record<string, string> = {};
  for (const name of ["committee-done", "hotfix-stopped", "advisor-failed", "survey-unfinished"]) {
    ids[name] = await install(name, dir);
  }
  await writeFile(path.join(dir, "broken.jsonl"), "this is not json\n");
  await writeFile(path.join(dir, "notes.txt"), "ignored");
  // An hour after the unfinished run went quiet: its open call's 30m timeout is long past.
  const index = createRunIndex({ now: () => Date.parse("2026-09-24T04:10:00Z"), probe: { hostname: "elsewhere", kill: () => true } });
  const listed = await index.list(dir, 50, 15 * 60_000);
  assert.equal(listed.state, "ok");
  assert.equal(listed.total, 5);
  const byId = Object.fromEntries(
    listed.runs.map((run) => [Object.entries(ids).find(([, id]) => id === run.runId)?.[0] ?? run.runId, run]),
  );
  assert.equal(byId["committee-done"]!.status, "done");
  assert.equal(byId["committee-done"]!.costUsd, 0.82);
  assert.match(byId["committee-done"]!.costNote ?? "", /Codex/);
  assert.equal(byId["hotfix-stopped"]!.status, "stopped");
  assert.equal(byId["hotfix-stopped"]!.stop?.phaseTitle, "人工审批");
  assert.equal(byId["advisor-failed"]!.status, "failed");
  assert.equal(byId["advisor-failed"]!.error?.name, "TimeoutError");
  assert.equal(byId["survey-unfinished"]!.status, "lost");
  assert.match(byId["survey-unfinished"]!.activity ?? "", /没有 run\.end/);
  // Another machine's pid cannot be checked: the threshold decided.
  assert.equal(byId["survey-unfinished"]!.process, null);
  assert.equal(byId["broken"]!.status, "unreadable");
  // Finished runs are folded whole once, so the row has the detail view's sentence and phase strip.
  assert.deepEqual(
    byId["hotfix-stopped"]!.strip?.map((segment) => segment.state),
    ["done", "done", "done", "done", "stopped", "skipped"],
  );
  assert.equal(byId["advisor-failed"]!.hero?.title, "「第二意见」没拿到结果：paseo run 等了 10m 仍未返回");
  assert.equal(byId["committee-done"]!.inputLabel, "编排运行时的裁决者（assess）该不该默认用比成员便宜的模型？");
  assert.equal(byId["survey-unfinished"]!.needsYou, true);
  assert.equal(byId["committee-done"]!.needsYou, false);
  assert.deepEqual(
    listed.runs.filter((run) => run.startedAt).map((run) => run.runId),
    [ids["survey-unfinished"], ids["committee-done"], ids["hotfix-stopped"], ids["advisor-failed"]],
  );

  // Five minutes after its last event it is running again, and appending is picked up incrementally.
  const survey = ids["survey-unfinished"]!;
  const at = (now: string, probe: Probe) => createRunIndex({ now: () => Date.parse(now), probe });
  const find = async (index: ReturnType<typeof createRunIndex>) =>
    (await index.list(dir, 50, 15 * 60_000)).runs.find((run) => run.runId === survey)!;
  const soon = at("2026-09-24T03:15:00Z", { hostname: "elsewhere", kill: () => true });
  assert.equal((await find(soon)).status, "running");
  // On its own machine the pid decides, both ways, without waiting for the threshold.
  const gone = await find(at("2026-09-24T03:15:00Z", probeFor("ESRCH")));
  assert.equal(gone.status, "lost");
  assert.deepEqual(gone.process, { pid: 4242, alive: false });
  assert.match(gone.activity ?? "", /^运行进程（pid 4242）已退出，没有写出 run\.end。/);
  const there = await find(at("2026-09-24T09:15:00Z", probeFor("EPERM")));
  assert.equal(there.status, "running");
  assert.match(there.activity ?? "", /进程 pid 4242 还在/);
  const file = path.join(dir, `${survey}.jsonl`);
  await appendFile(
    file,
    'ue,"durationMs":100000,"output":{"answer":"ok"},"error":null,"agentId":null,"cost":{"usd":0,"inputTokens":1,"outputTokens":1}}\n' +
      JSON.stringify({ v: 1, seq: 11, ts: "2026-09-24T03:12:01.000Z", runId: survey, kind: "run.end", outcome: "done", value: null, durationMs: 121000, cost: null, caveats: [] }) +
      "\n",
  );
  await utimes(file, new Date(), new Date());
  const ended = await find(soon);
  assert.equal(ended.status, "done");
  // Finished is finished, even though that process is gone now.
  const after = await find(at("2026-09-24T03:15:00Z", probeFor("ESRCH")));
  assert.equal(after.status, "done");
  assert.equal(after.process, null);
});

test("list says when runs/ is missing", async () => {
  const listed = await createRunIndex().list(path.join(await scratch, "nowhere", "runs"), 10, 1);
  assert.equal(listed.state, "missing");
});

test("readRun hands over complete lines and reports broken ones", async () => {
  const dir = await runsDir("read");
  const source = await readFile(path.join(FIXTURES, "survey-unfinished.jsonl"), "utf8");
  await writeFile(path.join(dir, "r1.jsonl"), source.replace('{"v":1,"seq":1,', 'garbage\n{"v":1,"seq":1,'));
  const first = await readRun(dir, "r1", 0);
  assert.equal(first.state, "ok");
  assert.equal(first.events.length, 10);
  assert.equal(first.badLines.length, 1);
  assert.equal(first.process, null);
  const again = await readRun(dir, "r1", first.nextOffset, { check: true, probe: probeFor("ESRCH") });
  assert.equal(again.events.length, 0);
  assert.deepEqual(again.process, { pid: 4242, alive: false });
  assert.equal((await readRun(dir, "nope", 0)).state, "missing");
});

test("checkProcess: same machine only, EPERM means alive", () => {
  const start = { pid: 7, hostname: "fixture-host" };
  assert.deepEqual(checkProcess(start, probeFor("alive")), { pid: 7, alive: true });
  assert.deepEqual(checkProcess(start, probeFor("EPERM")), { pid: 7, alive: true });
  assert.deepEqual(checkProcess(start, probeFor("ESRCH")), { pid: 7, alive: false });
  assert.equal(checkProcess({ ...start, hostname: "other" }, probeFor("ESRCH")), null);
  assert.equal(checkProcess({ pid: null, hostname: "fixture-host" }, probeFor("ESRCH")), null);
  assert.equal(checkProcess(null, probeFor("ESRCH")), null);
  const odd: Probe = { hostname: "fixture-host", kill: () => { throw Object.assign(new Error("x"), { code: "EINVAL" }); } };
  assert.equal(checkProcess(start, odd), null);
});

test("logDir resolves like the runtime: settings, env, config, default", async () => {
  const home = path.join("H:", "home");
  const configFile = path.join(home, ".paseo-orchestration", "config.json");
  const files: Record<string, string> = { [configFile]: '\ufeff{"logDir":"D:/logs","rolesDirs":[]}' };
  const read = async (file: string) => {
    if (file in files) return files[file]!;
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  };
  const pick = async (override: string, env: NodeJS.ProcessEnv) => {
    const resolved = await resolveLogDir({ override, env, home, read });
    return resolved.ok ? [resolved.info.source, resolved.info.logDir] : ["error", resolved.detail];
  };
  assert.deepEqual(await pick("E:/mine", { ORCH_LOG_DIR: "F:/env" }), ["settings", "E:/mine"]);
  assert.deepEqual(await pick("", { ORCH_LOG_DIR: "F:/env" }), ["env", "F:/env"]);
  assert.deepEqual(await pick("", {}), ["config", "D:/logs"]);
  delete files[configFile];
  assert.deepEqual(await pick("", {}), ["default", path.join(home, ".paseo-orchestration", "logs")]);
  const [state, detail] = await pick("", { ORCH_CONFIG: "Z:/elsewhere.json" });
  assert.equal(state, "error");
  assert.match(detail!, /elsewhere\.json/);
  files[configFile] = "{nope";
  assert.equal((await pick("", {}))[0], "error");
});
