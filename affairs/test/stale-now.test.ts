import { createWatch } from "./kit";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as ops from "../server/lib/ops.mjs";
import { append, load } from "../server/lib/log.mjs";
import { world } from "./kit";

const HOUR = 3_600_000;
type W = ReturnType<typeof world>;
const chatOf = (w: W, id: string) => ({ ...w.ctx, by: "chat", chatFor: id });
const lookOf = (w: W) => ({ ...w.ctx, by: "look" });

const lookReport = (over: Record<string, unknown> = {}) => ({
  status: "飞书任务还是待办。",
  entry: "飞书里有「定期洗牙」，还没约。",
  facts: ["飞书任务 定期洗牙 未完成"],
  next: { at: "2026-11-03 09:30", waitingFor: "等你去约", waitingOn: "me", why: "他说今天最好搞定，明早再看一次", earlyIf: [] },
  ...over,
});

async function setup() {
  const w = world();
  const made = await createWatch(w.ctx, { id: "dental", title: "洗牙", goal: "约上洗牙", said: "帮我盯一下洗牙，今天最好要搞定", noWait: true });
  assert.equal(made.ok, true, made.text);
  const id = made.id as string;
  assert.equal((await ops.brief(lookOf(w), id)).ok, true);
  const r = await ops.report(lookOf(w), id, lookReport());
  assert.equal(r.ok, true, r.text);
  append(w.root, id, [{ kind: "wake.end", state: "ok", usd: 0.01 }], { now: w.now() });
  return { w, id };
}

const mine = (w: W, id: string, said: string) => ops.note(chatOf(w, id), id, { said, mine: true });
const chatBrief = async (w: W, id: string) => (await ops.brief(chatOf(w, id), id, { chat: true })).text;

test("note --mine: the receipt says how old the 'now' is when a note comes after it", async () => {
  const { w, id } = await setup();
  w.advance(3 * HOUR);
  const first = await mine(w, id, "已经提交了代码");
  assert.equal(first.ok, true);
  assert.equal(first.text, "记下了。\n注意：现在的情况还停在 3 小时前「飞书任务还是待办。」，这条之后如果有进展，请用 report 交回。");
  // A new "now" handed in names itself in the next reminder.
  await chatBrief(w, id);
  const r = await ops.report(chatOf(w, id), id, { status: "代码已提交，等审核。" }, { from: "chat" });
  assert.equal(r.ok, true, r.text);
  const second = await mine(w, id, "他说合并前再看一遍");
  assert.match(second.text, /^记下了。\n注意：现在的情况还停在 刚才「代码已提交，等审核。」/);
});

test("note --mine: no reminder when the 'now' was never written, and a hand-in that carries the old text along does not renew it", async () => {
  const w = world();
  const made = await createWatch(w.ctx, { id: "other-2", title: "洗牙", goal: "约上洗牙", said: "帮我盯一下洗牙，今天最好要搞定", noWait: true });
  const id = made.id as string;
  const plain = await mine(w, id, "先记一句");
  assert.equal(plain.text, "记下了。", "nothing written as the 'now' yet: the receipt is as before");
  assert.equal(load(w.root, id).nowAt, null);

  const { w: w2, id: id2 } = await setup();
  const at = load(w2.root, id2).nowAt;
  assert.ok(at);
  w2.advance(2 * HOUR);
  await chatBrief(w2, id2);
  // facts only: the "now" stays what the look wrote, and so does its time
  const r = await ops.report(chatOf(w2, id2), id2, { facts: ["多一条记住的"] }, { from: "chat" });
  assert.equal(r.ok, true, r.text);
  assert.equal(load(w2.root, id2).nowAt, at);
  assert.equal(load(w2.root, id2).nowText, "飞书任务还是待办。");
});

test("brief --chat: a line under the 'now' when notes came after it; nothing when none did", async () => {
  const { w, id } = await setup();
  const quiet = await chatBrief(w, id);
  assert.ok(quiet.includes("现在：飞书任务还是待办。"));
  assert.ok(!quiet.includes("这句是"), "no notes after the 'now': no extra line");

  w.advance(90 * 60_000);
  await mine(w, id, "代码提交了");
  await mine(w, id, "他拍板用第二种");
  const text = await chatBrief(w, id);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("现在："));
  assert.equal(lines[at + 1], "　↑ 这句是 2 小时前写的，之后记了 2 条，没有交回新的现在；有进展的话先用 report 交回。");
  // The rule itself is in the "how to note / how to hand in" part.
  assert.doesNotMatch(text, /怎么记、怎么交/);

  // Handed in: the line goes away.
  await ops.report(chatOf(w, id), id, { status: "代码提交了，他选了第二种。" }, { from: "chat" });
  assert.ok(!(await chatBrief(w, id)).includes("这句是"));
});

test("the chat's starting words carry the rule that a note does not change the 'now'", async () => {
  const { chatPrompt } = await import("../server/lib/chat.mjs");
  const { w, id } = await setup();
  const text = chatPrompt({ ...w.ctx, command: "affair" }, load(w.root, id));
  assert.match(text, /note 只加结论，不改现在/);
  assert.match(text, /里程碑当场 report 新的 status，facts 新增、drop 删旧/);
});
