// One run of a line writes at a time (line-lock.mjs), and a step that cannot be taken back is never started by a run that has ended: the
// lock itself, two runs of one line in one process and in two, a run that ends while a step waits for its `before` or is in the act, and
// `settle` while the line is held. The processes are real (line-child.mjs). Nothing here talks to Paseo.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFlow, RunRefused } from "../runtime/run.mjs";
import { flow } from "../runtime/flow.mjs";
import { Journal } from "../runtime/journal.mjs";
import { LineBusy, lineIo, lineLockFile, takeLine } from "../runtime/line-lock.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { settleRun, SettleRefused } from "../runtime/orch.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "line-child.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const make = (body) => flow({ name: "line-test", description: "d", phases: [], inputs: {}, grants: [], run: (_, $) => body($) });
const carry = (target, logDir, line, extra = {}) =>
  runFlow(target, { roster, caller: null, executor: fakeExecutor(), cwd: "C:/work", logDir, lineage: line, resumeOf: line, ...extra });
const until = async (test, what, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    await sleep(20);
  }
};
const dead = {
  hostname: os.hostname(),
  kill: () => {
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  },
};

test("a line is held by one at a time; a lock of a holder known to be gone is taken over, and one of a holder that may be alive is not", async () => {
  const dir = await tempDir("orch-line-");
  const first = takeLine({ dir, lineage: "A", runId: "r1" });
  assert.throws(() => takeLine({ dir, lineage: "A", runId: "r2" }), (error) => error instanceof LineBusy && /r1/.test(error.message) && error.message.includes(lineLockFile(dir, "A")));
  assert.doesNotThrow(() => takeLine({ dir, lineage: "B", runId: "r3" }).release(), "another line is free");

  // The holder's process is gone (as far as the machine that holds the lock can tell): the next run takes the line.
  const second = takeLine({ dir, lineage: "A", runId: "r4", probe: dead });
  assert.equal(JSON.parse(readFileSync(lineLockFile(dir, "A"), "utf8")).runId, "r4");
  first.release(); // The first holder's release does not take the second's lock away.
  assert.equal(existsSync(lineLockFile(dir, "A")), true);
  second.release();
  second.release();
  assert.equal(existsSync(lineLockFile(dir, "A")), false);
  assert.equal(existsSync(path.dirname(lineLockFile(dir, "A"))), false, "no empty directory is left");

  // A holder on another machine cannot be known to be gone, whatever its pid does here.
  mkdirSync(path.dirname(lineLockFile(dir, "C")), { recursive: true });
  writeFileSync(lineLockFile(dir, "C"), JSON.stringify({ pid: 4242, hostname: "somewhere-else", runId: "far", startedAt: "2026-01-01T00:00:00.000Z" }));
  assert.throws(() => takeLine({ dir, lineage: "C", runId: "r5", probe: dead }), LineBusy);
  // Nor one whose lock cannot be read: it may be in the middle of being written.
  writeFileSync(lineLockFile(dir, "D"), "{");
  assert.throws(() => takeLine({ dir, lineage: "D", runId: "r6", probe: dead }), LineBusy);
});

test("two runs of one line started together in one process: one works, the other is refused, and the step is done once", async () => {
  const logDir = await tempDir("orch-line-");
  let acts = 0;
  let arrived = 0;
  let release;
  const both = new Promise((resolve) => (release = resolve));
  const target = make(($) =>
    $.step("publish", () => ++acts, {
      once: true,
      before: async () => {
        if (++arrived === 1) setTimeout(release, 100);
        await both;
      },
    }),
  );
  const settled = await Promise.allSettled(["par-a", "par-b"].map((runId) => carry(target, logDir, "par-line", { runId })));
  const done = settled.filter((s) => s.status === "fulfilled");
  const refused = settled.filter((s) => s.status === "rejected");
  assert.equal(done.length, 1);
  assert.equal(done[0].value.outcome, "done");
  assert.equal(refused.length, 1);
  assert.ok(refused[0].reason instanceof RunRefused);
  assert.match(refused[0].reason.message, /being worked on by run par-/);
  assert.equal(acts, 1);
  assert.equal(existsSync(lineLockFile(logDir, "par-line")), false, "given back when the run is over");
  // And the refused one had not written anything: the line is free for the next run, which takes the step as done.
  assert.equal((await carry(target, logDir, "par-line")).value, 1);
  assert.equal(acts, 1);
});

test("a run of a line in another process holds it; when that process is gone the next run takes it and does not do the step again", async () => {
  const logDir = await tempDir("orch-line-");
  const dir = await tempDir("orch-line-work-");
  const child = spawn(process.execPath, [CHILD, logDir, "x-line", "x-a", dir], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    await until(() => existsSync(path.join(dir, "started.txt")), "the child to begin the step");
    let acts = 0;
    const target = make(($) => $.step("publish", () => ++acts, { once: true }));
    await assert.rejects(() => carry(target, logDir, "x-line"), (error) => error instanceof RunRefused && /x-a/.test(error.message));
    assert.equal(acts, 0);
    assert.throws(() => settleRun("x-a", ["publish", "--not-done"], { logDir }), SettleRefused);
    child.kill();
    await exited;
  } finally {
    child.kill();
  }
  // The child died inside the act: its lock is left, with a pid that is gone, and its journal says the step began.
  assert.equal(existsSync(lineLockFile(logDir, "x-line")), true);
  let acts = 0;
  const after = await carry(make(($) => $.step("publish", () => ++acts, { once: true })), logDir, "x-line");
  assert.equal(after.outcome, "stopped");
  assert.equal(acts, 0, "it began and was not heard from: not done on a guess");
  assert.equal(new Journal({ dir: logDir, lineage: "x-line" }).get("step:publish").state, "begun");
});

test("a run that ends while a step waits in its `before` does not start the act, whatever ended it", async () => {
  const logDir = await tempDir("orch-line-");
  const acts = [];
  const slow = (ms) => () => sleep(ms);

  const timedOut = await carry(make(($) => $.step("publish", () => acts.push("timeout"), { once: true, before: slow(1_500) })), logDir, "t-line", { timeout: "1s" });
  assert.equal(timedOut.outcome, "timeout");
  assert.equal(new Journal({ dir: logDir, lineage: "t-line" }).get("step:publish"), null, "not begun");
  // The wait is still going: the line is held, so a run that carries this one on cannot do the step in the meantime.
  await assert.rejects(() => carry(make(($) => $.step("publish", () => acts.push("resume"), { once: true })), logDir, "t-line"), RunRefused);
  await until(() => !existsSync(lineLockFile(logDir, "t-line")), "the line to be given back");
  assert.deepEqual(acts, [], "the waiting step woke up to a run that had ended");
  const resumed = await carry(make(($) => $.step("publish", () => acts.push("resume"), { once: true })), logDir, "t-line");
  assert.equal(resumed.outcome, "done");
  assert.deepEqual(acts, ["resume"], "done once, by the run that carried it on");

  // A stop in another branch ends the run the same way.
  const stopped = await carry(
    make(($) => Promise.all([$.step("announce", () => acts.push("stop"), { once: true, before: slow(300) }), (async () => $.stop("halt"))()])),
    logDir,
    "s-line",
  );
  assert.equal(stopped.outcome, "stopped");
  await until(() => !existsSync(lineLockFile(logDir, "s-line")), "the line to be given back");
  assert.deepEqual(acts, ["resume"]);
});

test("a step that cannot be taken back and is in the act when the run ends keeps the line until it returns; the run that follows takes its value", async () => {
  const logDir = await tempDir("orch-line-");
  let acts = 0;
  const target = make(($) =>
    $.step(
      "publish",
      async () => {
        acts += 1;
        await sleep(1_200);
        return { revision: 9 };
      },
      { once: true },
    ),
  );
  const first = await carry(target, logDir, "a-line", { timeout: "1s" });
  assert.equal(first.outcome, "timeout");
  assert.equal(new Journal({ dir: logDir, lineage: "a-line" }).get("step:publish").state, "begun");
  await assert.rejects(() => carry(target, logDir, "a-line"), (error) => error instanceof RunRefused && /being worked on/.test(error.message));
  assert.equal(acts, 1, "not started a second time while the first is acting");
  await until(() => !existsSync(lineLockFile(logDir, "a-line")), "the act to return");
  assert.equal(new Journal({ dir: logDir, lineage: "a-line" }).get("step:publish").state, "done", "the act wrote how it came out");
  const next = await carry(target, logDir, "a-line");
  assert.deepEqual(next.value, { revision: 9 });
  assert.equal(acts, 1);
});

test("a run refused before it starts does not keep the line", async () => {
  const logDir = await tempDir("orch-line-");
  await assert.rejects(() => carry(make(() => 1), logDir, "r-line", { redo: "nothing-by-that-name" }), RunRefused);
  assert.equal(existsSync(lineLockFile(logDir, "r-line")), false);
  assert.equal((await carry(make(() => 1), logDir, "r-line")).outcome, "done");
});

const failing = (code, times) => {
  let left = times;
  return (file) => {
    if (left-- > 0) throw Object.assign(new Error(`${code}: fake failure of open, '${file}'`), { code });
    return openSync(file, "wx");
  };
};

test("a lock the file system will not give for a moment is waited for, and when it stays so the line is reported as held, not the system's error", async () => {
  const dir = await tempDir("orch-line-");
  const real = lineIo.open;
  try {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      lineIo.open = failing(code, 2);
      const taken = takeLine({ dir, lineage: "slow", runId: "r1" });
      assert.equal(JSON.parse(readFileSync(lineLockFile(dir, "slow"), "utf8")).runId, "r1", `${code} twice, then it is taken`);
      taken.release();
    }
    lineIo.open = failing("EPERM", Infinity);
    assert.throws(
      () => takeLine({ dir, lineage: "slow", runId: "r2" }),
      (error) => error instanceof LineBusy && error.holder === null && /EPERM/.test(error.message),
    );
    assert.equal(existsSync(lineLockFile(dir, "slow")), false, "nothing was made");
    // Another error is still the system's own.
    lineIo.open = failing("EMFILE", 1);
    assert.throws(() => takeLine({ dir, lineage: "slow", runId: "r3" }), { code: "EMFILE" });
  } finally {
    lineIo.open = real;
  }
});

test("a lock that could not be written is not left to look like one being written", async () => {
  const dir = await tempDir("orch-line-");
  const real = lineIo.write;
  try {
    lineIo.write = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    assert.throws(() => takeLine({ dir, lineage: "full", runId: "r1" }), { code: "ENOSPC" });
    assert.equal(existsSync(lineLockFile(dir, "full")), false);
  } finally {
    lineIo.write = real;
  }
  takeLine({ dir, lineage: "full", runId: "r2" }).release();
});

test("a lock that cannot be read is a lock being written for a few seconds, and after that one left by a process that died making it", async () => {
  const dir = await tempDir("orch-line-");
  const old = new Date(Date.now() - 60_000);
  for (const [lineage, text] of [["empty", ""], ["torn", '{"pid":'], ["scrap", "not json at all"]]) {
    const file = lineLockFile(dir, lineage);
    mkdirSync(path.dirname(file), { recursive: true }); // a release takes the empty directory away
    writeFileSync(file, text);
    assert.throws(() => takeLine({ dir, lineage, runId: "r1" }), LineBusy, `${lineage}: just made`);
    utimesSync(file, old, old);
    const taken = takeLine({ dir, lineage, runId: "r2" });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).runId, "r2", `${lineage}: old enough, taken`);
    taken.release();
  }
  // A lock that reads, of a holder that may be alive, is never old enough.
  const live = takeLine({ dir, lineage: "alive", runId: "r3" });
  utimesSync(lineLockFile(dir, "alive"), old, old);
  assert.throws(() => takeLine({ dir, lineage: "alive", runId: "r4" }), LineBusy);
  live.release();
});
