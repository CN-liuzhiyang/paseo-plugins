import { createWatch } from "./kit";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { chatPrompt } from "../server/lib/chat.mjs";
import { createEngine } from "../server/engine";
import { append, load, read } from "../server/lib/log.mjs";
import * as ops from "../server/lib/ops.mjs";
import { readOnce } from "../server/lib/readers.mjs";
import { stepLines } from "../server/lib/steps.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";
import { world } from "./kit";

const steps = [
  { id: "prepare", title: "准备", state: "done", who: "agent" },
  { id: "review", title: "确认", state: "now", who: "him", note: "选一个时间", since: "2026-11-02T09:00:00+08:00" },
  { id: "book", title: "预约", state: "todo", who: "agent" },
  { id: "attend", title: "赴约", state: "todo", who: "wait" },
];

function reader() {
  const w = world();
  const dir = path.join(w.dir, "readers");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "sample.mjs"), 'import {readFileSync} from "node:fs"; const {args} = JSON.parse(readFileSync(0,"utf8")); process.stdout.write(readFileSync(args.file,"utf8"));');
  w.ctx.policy.readers = { ...DEFAULT_POLICY.readers, dirs: [dir] };
  const file = path.join(w.dir, "reading.json");
  const set = (extra: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ value: { ready: true }, summary: "可以确认", ...extra }));
  set({ steps });
  return { w, file, set };
}

test("steps survive the real reader and log, and both briefs show only now and next", async () => {
  const { w, file } = reader();
  const made = await createWatch(w.ctx, { id: "dental", title: "预约", noWait: true });
  const id = made.id!;
  assert.equal((await ops.readTool(w.ctx, "sample", { file }, { forId: id })).ok, true);
  const saved = load(w.root, id);
  assert.deepEqual(saved.stepRead.steps, steps);
  assert.deepEqual(saved.reads[0].steps, steps);
  for (const ctx of [w.ctx, { ...w.ctx, by: "chat" }]) {
    const brief = await ops.brief(ctx, id, { chat: ctx.by === "chat" });
    assert.equal(brief.ok, true, brief.text);
    assert.match(brief.text, /## 走到哪一步/);
    assert.match(brief.text, /前面 1 步已完成/);
    assert.match(brief.text, /现在：第 2\/4 步 确认（你来做）/);
    assert.match(brief.text, /下一步：第 3\/4 步 预约（我来做）/);
    assert.doesNotMatch(brief.text, /第 1\/4|第 4\/4|可能过时/);
  }
});

test("no steps leaves both briefs and the folded reading metadata unchanged", async () => {
  const { w, file, set } = reader();
  set({});
  assert.deepEqual(await readOnce(w.ctx.policy, "sample", { file }), { ok: true, value: { ready: true }, summary: "可以确认" });
  assert.deepEqual(stepLines({}, w.now()), []);
  const made = await createWatch(w.ctx, { id: "other-2", title: "预约", noWait: true });
  await ops.readTool(w.ctx, "sample", { file }, { forId: made.id });
  assert.equal("stepRead" in load(w.root, made.id), false);
  for (const chat of [false, true]) {
    const got = await ops.brief({ ...w.ctx, by: chat ? "chat" : "look" }, made.id, { chat });
    assert.equal(got.ok, true, got.text);
    assert.doesNotMatch(got.text, /走到哪一步|步已完成|可能过时：/);
  }
});

test("steps expire after their own validity or 24 hours, and show blockers and completion", () => {
  const at = "2026-11-02T10:00:00+08:00";
  const now = Date.parse(at);
  const state = { stepRead: { at, steps } };
  assert.doesNotMatch(stepLines(state, now + 24 * 3_600_000).join("\n"), /可能过时/);
  assert.match(stepLines(state, now + 25 * 3_600_000).join("\n"), /可能过时：25 小时前读的/);
  assert.match(stepLines({ stepRead: { ...state.stepRead, validUntil: "2026-11-02T11:00:00+08:00" } }, now + 2 * 3_600_000).join("\n"), /可能过时：2 小时前读的/);
  assert.doesNotMatch(stepLines({ stepRead: { ...state.stepRead, validUntil: "2026-11-05T11:00:00+08:00" } }, now + 25 * 3_600_000).join("\n"), /可能过时/);
  const blocked = steps.map((s) => s.id === "review" ? { ...s, state: "blocked", note: "时间没定" } : s);
  assert.match(stepLines({ stepRead: { at, steps: blocked } }, now).join("\n"), /卡住了：时间没定/);
  const done = stepLines({ stepRead: { at, steps: steps.map((s) => ({ ...s, state: "done" })) } }, now).join("\n");
  assert.match(done, /全部 4 步已完成/);
  assert.doesNotMatch(done, /现在：|下一步：/);
  assert.deepEqual(stepLines({ stepRead: { at, steps: [] } }, now), []);
});

test("reader rejects malformed steps and does not log secrets in their notes", async () => {
  const { w, file, set } = reader();
  for (const extra of [{ steps: "wrong" }, { steps: [{ ...steps[0], state: "other" }] }, { steps, validUntil: "never" }]) {
    set(extra);
    assert.equal((await readOnce(w.ctx.policy, "sample", { file })).ok, false);
  }
  const made = await createWatch(w.ctx, { id: "other-3", title: "预约", noWait: true });
  set({ steps: [{ ...steps[0], note: "sk-abcdefghijklmnopqrstuvwxyz0123" }] });
  assert.equal((await ops.readTool(w.ctx, "sample", { file }, { forId: made.id })).ok, false);
  assert.equal(read(w.root, made.id).some((l: any) => l.kind === "read"), false);
});

test("watched steps refresh even with the same value; changed steps wake a look", async () => {
  const { w, file, set } = reader();
  const made = await createWatch(w.ctx, { id: "other-4", title: "预约", noWait: true });
  const id = made.id!;
  append(w.root, id, [{ kind: "watch", id: "w1", watch: { tool: "sample", args: { file }, every: 5 } }], { now: w.now() });
  const engine = createEngine({ ctx: w.ctx, paseo: null, deliver: null, log() {} });
  await engine.readPass();
  assert.deepEqual(load(w.root, id).stepRead.steps, steps);
  w.advance(6 * 60_000);
  await engine.readPass();
  const latest = read(w.root, id).filter((l: any) => l.kind === "watch.read").at(-1);
  assert.equal(latest.changed, false);
  assert.equal(load(w.root, id).stepRead.at, latest.at);
  w.advance(6 * 60_000);
  set({ steps: steps.map((s) => s.id === "review" ? { ...s, state: "done" } : s), validUntil: "2026-11-04T10:00:00+08:00" });
  await engine.readPass();
  const changed = read(w.root, id).filter((l: any) => l.kind === "watch.read").at(-1);
  assert.equal(changed.changed, true);
  assert.equal(load(w.root, id).stepRead.validUntil, "2026-11-04T10:00:00+08:00");
});

test("chat prompt embeds the matching private chat handbook and the next-step rule", () => {
  const w = world();
  const dir = path.join(w.dir, "books"); mkdirSync(dir);
  for (const name of ["handbook.chat.md", "affair.chat.md", "appointments.chat.md", "asked.chat.md"]) writeFileSync(path.join(dir, name), `embedded ${name}`);
  w.ctx.policy.handbookPath = path.join(dir, "handbook.md");
  w.ctx.policy.handbooksDir = dir;
  w.ctx.policy.chatHandbookByKind = { appointment: "appointments.chat.md" };
  const s = { ...load(w.root, "sample"), id: "sample", title: "预约", mode: "watch", modeExplicit: true, links: ["appointment:sample"] };
  const text = chatPrompt(w.ctx, s);
  for (const name of ["handbook.chat.md", "affair.chat.md", "appointments.chat.md"]) assert.ok(text.includes(`embedded ${name}`));
  assert.doesNotMatch(text, /asked\.chat\.md|只看里面/);
  assert.match(text, /按步骤主动说走到哪里、下一步谁做/);
  assert.ok(chatPrompt(w.ctx, { ...s, links: [] }).includes("embedded asked.chat.md"));
  w.ctx.policy.chatHandbookByKind = { appointment: "missing.chat.md" };
  assert.doesNotMatch(chatPrompt(w.ctx, s), /missing\.chat\.md/);
});
