import assert from "node:assert/strict";
import { test } from "node:test";
import { isYes, sayCalls } from "../server/requests";
import type { World } from "./helpers";
import { converse, item, PERSONS, withDesk } from "./desk-kit";

// The shapes the commands had in a real conversation: the agent runs reconcile-say through `powershell.exe -NoProfile -Command "…"`
// (in the foreground or as a background task: the timeline shows the same command line either way). They are the same run as the bare
// command, and a line that only mentions reconcile-say is not one.

const SAY = "node D:/plugins/reconcile/bin/reconcile-say.mjs";
const MINE = { source: "chatapp", "chatapp-chat": "p2p:owner" };
const withAdmin = <T>(body: (w: World) => Promise<T>) => withDesk(body, { askHere: true, persons: PERSONS({ chats: [MINE], notify: [{ channel: "im", to: "p2p:owner", label: "IM" }] }) });
const ps = (inner: string) => `powershell.exe -NoProfile -Command "${inner}"`;

test("a shell asked to run a command line: the line it runs is read as a run, whatever the shell", () => {
  const confirm = { request: { cmd: "confirm", pending: "r_0123456789ab", said: "-" }, data: null };
  assert.deepEqual(sayCalls(ps(`${SAY} confirm --id r_0123456789ab --said -`)), [confirm]);
  assert.deepEqual(sayCalls(`pwsh -c "${SAY} confirm --id r_0123456789ab --said -"`), [confirm]);
  assert.deepEqual(sayCalls(`C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${SAY} confirm --id r_0123456789ab --said -"`), [confirm]);
  assert.deepEqual(sayCalls(`bash -c '${SAY} confirm --id r_0123456789ab --said -'`), [confirm]);
  assert.deepEqual(sayCalls(`bash -lc "${SAY} confirm --id r_0123456789ab --said -"`), [confirm]);
  assert.deepEqual(sayCalls(`cmd /c ${SAY} confirm --id r_0123456789ab --said -`), [confirm]);
  // single quotes inside double quotes: the words
  assert.deepEqual(sayCalls(ps(`${SAY} say --item D1 --kind drop --said '算了，年检那个事不用管了。'`)), [{ request: { cmd: "say", kind: "drop", item: "D1", said: "算了，年检那个事不用管了。" }, data: null }]);
  // a shell inside a shell
  assert.equal(sayCalls(ps(`bash -c '${SAY} confirm --id r_0123456789ab --said -'`)).length, 1);
});

test("a shell line that only mentions reconcile-say, or runs something else, is not a run", () => {
  assert.deepEqual(sayCalls(ps(`echo '${SAY} confirm --id r_0123456789ab --said -'`)), []);
  assert.deepEqual(sayCalls(ps("grep -n D1 C:/x/plan.md")), []);
  assert.deepEqual(sayCalls(`powershell.exe -NoProfile -File x.ps1 ${SAY}`), []);
  assert.deepEqual(sayCalls(`bash x.sh`), []);
  assert.deepEqual(sayCalls(ps(`${SAY} confirm --id r_0123456789ab --help`)), []);
});

test("what a person says to agree: a yes word first, then at most a short remark; not a question, not a no", () => {
  for (const yes of ["要", "要的", "要吧", "对，不再追踪了", "对", "好", "好的", "行", "嗯", "是", "可以", "ok", "OK！", "yes", "确认", "照办", "要，月底前约上", "好的，就这样", "嗯嗯"]) assert.equal(isYes(yes), true, yes);
  for (const no of ["", "不要", "不用了", "别", "没有", "算了", "取消", "等等", "先别", "好的，不过别太频繁", "要吗？先等等", "好像不太对", "对不起", "是不是", "要不要", "行不行", "好，你确定吗", "可以吗", "好的，但是先等一下", "要，不过晚点", "记下", "盯", "我觉得要，月底前约上，这样比较稳妥一点点点"]) assert.equal(isYes(no), false, no);
});

test("a drop said with --said - in the admin's own chat, run through powershell, takes effect at once on the message itself", () =>
  withAdmin(async (w) => {
    let c = converse(w, MINE, [{ kind: "person", text: "帮我盯一下年检，月底前要约上" }]);
    c.turn!.steps.push({ kind: "command", text: ps(`${SAY} track --title 年检 --domain personal --said -`) });
    w.say({ cmd: "track", said: "-", title: "年检", domain: "personal" });
    await w.engine.tick();
    const words = "算了，年检那个事不用管了。";
    c = converse(w, MINE, [{ kind: "person", text: words }]);
    c.turn!.steps.push({ kind: "command", text: ps(`${SAY} say --item D1 --kind drop --said -`) });
    const id = w.say({ cmd: "say", item: "D1", kind: "drop", said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(id)!.outcome, "applied", w.receipt(id)!.text);
    assert.match(w.receipt(id)!.text, /撤销：reconcile-say undo --id a_[0-9a-f]{12}/, "the way back is kept for the agent");
    const drop = Object.values(w.store.state.annotations).find((a) => a.kind === "drop")!;
    assert.deepEqual([drop.said, drop.how, drop.waived], [words, "own-words", true]);
    assert.equal(w.store.state.requests[id]!.waived, true);
  }));

test("the real conversation: words the agent copied, in the admin's own chat, run through powershell, are asked, confirmed and applied", () =>
  withAdmin(async (w) => {
    const run = (c: ReturnType<typeof converse>, line: string, request: Record<string, unknown>) => {
      c.turn!.steps.push({ kind: "command", text: line });
      return w.say(request);
    };
    // a matter told in the chat, as the agent runs it
    let c = converse(w, MINE, [{ kind: "person", text: "帮我盯一下年检，月底前要约上" }]);
    run(c, ps(`${SAY} track --title 年检 --domain personal --said -`), { cmd: "track", said: "-", title: "年检", domain: "personal" });
    await w.engine.tick();
    assert.equal(item(w, 1)?.title, "年检");
    // "算了，年检那个事不用管了。": --said - is read in the chat although drop is not let through on its own words there
    const words = "他说年检那个事不用管了";
    c = converse(w, MINE, [{ kind: "person", text: "算了，年检那个事不用管了。" }]);
    const id = run(c, ps(`${SAY} say --item D1 --kind drop --said '${words}'`), { cmd: "say", item: "D1", kind: "drop", said: words });
    await w.engine.tick();
    assert.equal(w.receipt(id)!.outcome, "asked", w.receipt(id)!.text);
    const question = w.store.state.requests[id]!.question!;
    assert.ok(question.includes(`「${words}」`), question);
    // the person agrees in their own words; the agent, not being sure, asks again; they say 要; the agent confirms in the background
    c = converse(w, MINE, [{ kind: "person", text: "要" }], question);
    const cid = run(c, ps(`${SAY} confirm --id ${id} --said -`), { cmd: "confirm", pending: id, said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(cid)!.outcome, "applied", w.receipt(cid)!.text);
    assert.equal(Object.values(w.store.state.annotations).find((a) => a.kind === "drop")?.said, words);
  }));

test("their 对，不再追踪了 is a yes, the same through powershell", () =>
  withAdmin(async (w) => {
    let c = converse(w, MINE, [{ kind: "person", text: "帮我盯一下年检，月底前要约上" }]);
    c.turn!.steps.push({ kind: "command", text: ps(`${SAY} track --title 年检 --domain personal --said -`) });
    w.say({ cmd: "track", said: "-", title: "年检", domain: "personal" });
    await w.engine.tick();
    c = converse(w, MINE, [{ kind: "person", text: "算了，年检那个事不用管了。" }]);
    c.turn!.steps.push({ kind: "command", text: ps(`${SAY} say --item D1 --kind drop --said '算了，年检那个事不用管了。'`) });
    const id = w.say({ cmd: "say", item: "D1", kind: "drop", said: "算了，年检那个事不用管了。" });
    await w.engine.tick();
    const question = w.store.state.requests[id]!.question!;
    assert.ok(question);
    c = converse(w, MINE, [{ kind: "person", text: "对，不再追踪了" }], question);
    c.turn!.steps.push({ kind: "command", text: ps(`${SAY} confirm --id ${id} --said -`) });
    const cid = w.say({ cmd: "confirm", pending: id, said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(cid)!.outcome, "applied", w.receipt(cid)!.text);
  }));

test("a confirm that was refused leaves the question to run out, and after 30 minutes it is a card", () =>
  withAdmin(async (w) => {
    let c = converse(w, MINE, [{ kind: "person", text: "帮我盯一下年检，月底前要约上" }]);
    c.turn!.steps.push({ kind: "command", text: ps(`${SAY} track --title 年检 --domain personal --said -`) });
    w.say({ cmd: "track", said: "-", title: "年检", domain: "personal" });
    await w.engine.tick();
    c = converse(w, MINE, [{ kind: "person", text: "算了，年检那个事不用管了。" }]);
    c.turn!.steps.push({ kind: "command", text: ps(`${SAY} say --item D1 --kind drop --said '他说年检不用管了'`) });
    const id = w.say({ cmd: "say", item: "D1", kind: "drop", said: "他说年检不用管了" });
    await w.engine.tick();
    const question = w.store.state.requests[id]!.question!;
    c = converse(w, MINE, [{ kind: "person", text: "不要" }], question);
    c.turn!.steps.push({ kind: "command", text: ps(`${SAY} confirm --id ${id} --said -`) });
    const cid = w.say({ cmd: "confirm", pending: id, said: "-" });
    await w.engine.tick();
    assert.equal(w.receipt(cid)!.outcome, "rejected");
    w.clock.now += 31 * 60_000;
    await w.engine.tick();
    assert.equal(w.store.state.requests[id]!.outcome, "proposed", w.store.state.requests[id]!.detail);
    assert.ok(Object.values(w.store.state.commitments).some((x) => x.origin.who === "confirm"));
  }));
