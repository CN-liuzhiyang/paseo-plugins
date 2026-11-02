import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { append, fold, listIds, logFile, read } from "../server/lib/log.mjs";
import { counts, dayStart, mayLook, tripped } from "../server/lib/limits.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { cronOf, isoLocal, parseLocal, speak } from "../server/lib/time.mjs";
import { iso, scratch } from "./kit";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => scratch("affairs-log-");

test("append only: what is there stays byte for byte, and seq runs on", () => {
  const root = tmp();
  append(root, "D1", [{ kind: "created", id: "D1", title: "洗牙" }]);
  const before = readFileSync(logFile(root, "D1"));
  append(root, "D1", [{ kind: "said", text: "还没约" }, { kind: "said", text: "约好了" }]);
  const after = readFileSync(logFile(root, "D1"));
  assert.ok(after.subarray(0, before.length).equals(before), "the old bytes are untouched");
  assert.deepEqual(read(root, "D1").map((l) => l.seq), [1, 2, 3]);
});

test("nothing in lib opens a log for writing from the start", () => {
  const libDir = path.join(HERE, "..", "server", "lib");
  for (const name of readdirSync(libDir)) {
    const text = readFileSync(path.join(libDir, name), "utf8");
    if (name === "log.mjs") assert.doesNotMatch(text, /writeFileSync\(\s*logFile|flag:\s*"w"|createWriteStream/);
    else assert.doesNotMatch(text, /logFile\(|appendFileSync/, `${name} goes through append()`);
  }
});

test("a half-written or foreign line is skipped, and the next append starts on a new line", () => {
  const root = tmp();
  append(root, "D1", [{ kind: "created", id: "D1", title: "洗牙" }]);
  appendFileSync(logFile(root, "D1"), '{"seq":2,"kind":"sa');
  assert.deepEqual(read(root, "D1").map((l) => l.seq), [1]);
  append(root, "D1", [{ kind: "said", text: "x" }]);
  assert.deepEqual(read(root, "D1").map((l) => l.seq), [1, 2]);
  writeFileSync(path.join(root, "D1", "log.jsonl"), `not json\n{"seq":"x"}\n${JSON.stringify({ seq: 1, kind: "created", id: "D1", title: "洗牙" })}\n`);
  assert.equal(fold(read(root, "D1")).title, "洗牙");
});

test("two writers at the same time lose nothing and share no seq", async () => {
  const root = tmp();
  const script = path.join(tmp(), "writer.mjs");
  writeFileSync(script, `import { append } from ${JSON.stringify(path.join(HERE, "..", "server", "lib", "log.mjs").replace(/\\/g, "/").replace(/^/, "file:///"))};
for (let i = 0; i < 40; i++) append(process.argv[2], "D1", [{ kind: "said", text: process.argv[3] + i }]);`);
  const run = (tag: string) => new Promise<void>((resolve, reject) => spawn(process.execPath, [script, root, tag]).on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}`)))));
  await Promise.all([run("a"), run("b")]);
  const lines = read(root, "D1");
  assert.equal(lines.length, 80);
  assert.deepEqual(lines.map((l) => l.seq), Array.from({ length: 80 }, (_, i) => i + 1));
  assert.equal(new Set(lines.map((l) => l.text)).size, 80);
});

test("fold: the state is only what the lines say", () => {
  const root = tmp();
  append(root, "D1", [
    { kind: "created", id: "D1", title: "洗牙", goal: "约上" },
    { kind: "said", text: "约在周三", by: "user" },
    { kind: "wake", why: ["said:2"], gapMinutes: null },
    { kind: "report", verdict: "pass", status: "约在周三", entry: "我看了一眼：约在周三", facts: ["周三"], changed: true },
    { kind: "next", next: "2026-11-04T20:00:00+08:00", waitingFor: "等周三", verdict: "pass" },
    { kind: "asked", id: "D1-1", title: "约上了吗？", options: ["是"] },
    { kind: "answered", id: "D1-1", answer: "是" },
    { kind: "status", status: "done", evidence: "勾掉了" },
  ]);
  const s = fold(read(root, "D1"));
  assert.deepEqual([s.title, s.status, s.nowText, s.next?.waitingFor, s.asks[0].state, s.running, s.pending], ["洗牙", "done", "约在周三", "等周三", "answered", true, ["answered:D1-1"]]);
  assert.deepEqual(listIds(root), ["D1"]);
});

test("time: local text, ISO with offset and cron agree in Asia/Shanghai", () => {
  const ms = parseLocal("2026-11-03 09:30", "Asia/Shanghai")!;
  assert.equal(isoLocal(ms, "Asia/Shanghai"), "2026-11-03T09:30:00+08:00");
  assert.equal(cronOf(ms, "Asia/Shanghai"), "30 9 3 11 *");
  assert.equal(parseLocal("2026-02-30 09:30", "Asia/Shanghai"), null);
  assert.equal(speak(ms, iso("2026-11-02 18:00"), "Asia/Shanghai"), "明天 9:30");
  assert.equal(speak(iso("2026-11-10 20:00"), iso("2026-11-02 18:00"), "Asia/Shanghai"), "11-10 周二 20:00");
});

test("limits: looks per day per affair and in all, money, the day's start, and the hourly breaker", () => {
  const root = tmp();
  const now = iso("2026-11-02 15:00");
  assert.equal(dayStart(now, "Asia/Shanghai", 8), iso("2026-11-02 08:00"));
  assert.equal(dayStart(iso("2026-11-02 07:00"), "Asia/Shanghai", 8), iso("2026-11-01 08:00"));
  const at = (ms: number) => ({ now: ms });
  for (let i = 0; i < 8; i++) append(root, "D1", [{ kind: "wake", why: ["time"] }], at(now - (i + 1) * 20 * 60_000));
  const p = DEFAULT_POLICY;
  assert.equal(mayLook(root, "D1", now, p).ok, false);
  assert.equal(mayLook(root, "D1", now, p, { force: true }).ok, true);
  assert.equal(mayLook(root, "D2", now, p).ok, true);
  assert.equal(mayLook(root, "D1", now + 18 * 3_600_000, p).ok, true, "the next day starts at eight");
  append(root, "D2", [{ kind: "wake", why: ["time"] }, { kind: "wake.end", usd: 0.6 }], at(now - 60_000));
  assert.match(mayLook(root, "D2", now, p).text!, /花到上限/);
  assert.equal(counts(root, now, p).total.looks, 9);
  assert.equal(tripped(root, now, p).tripped, false);
  for (let i = 0; i < 5; i++) append(root, "D3", [{ kind: "wake", why: ["said:1"] }], at(now - (i + 1) * 5 * 60_000));
  assert.equal(tripped(root, now, p).tripped, true, "an affair rung five times in an hour");
});
