import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_CHAT_UNDO_MS, adminChat, freshInChat, ownWords, type Conversation, type Request } from "../server/requests";
import type { World } from "./helpers";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../server/config";
import { TEST_POLICY } from "./helpers";
import { chat, commandFor, item, note, own, PERSONS, say, track, undoLast, withDesk } from "./desk-kit";

// The admin's own private chat (persons.json `chats`): there, telling a matter, adding a line to it and taking those back need no
// card. Only the one check of where the conversation came from is waived; each of the others still holds, and so does every other
// kind of thing said (stop following, hold off, "this is wrong") -- those still wait for the admin on a card.

const MINE = { source: "chatapp", "chatapp-chat": "p2p:owner" };
const ADMIN = () => PERSONS({ chats: [MINE] });
const SAID = "帮我盯一下体检，月底前要约上";
const why = (w: World, id: string) => w.store.state.requests[id]!.why ?? "";
const outcome = (w: World, id: string) => w.receipt(id)!.outcome;

const withAdmin = <T>(body: (w: World) => Promise<T>) => withDesk(body, { persons: ADMIN() });

// ---- what goes through ----------------------------------------------------------------------------------------

test("in the admin's own chat a matter is told, a line is added, and both are taken back, with no card", () =>
  withAdmin(async (w) => {
    chat(w, MINE, SAID);
    const told = say(w, track(SAID, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, told), "applied");
    assert.equal(w.cards.length, 0);
    assert.equal(Object.values(w.store.state.annotations)[0]!.how, "own-words");
    assert.equal(item(w, 1)!.title, "年度体检");

    chat(w, MINE, "约在下周三下午了");
    const added = say(w, note("D1", "约在下周三下午了"));
    await w.engine.tick();
    assert.equal(outcome(w, added), "applied");
    assert.equal(item(w, 1)!.fields["note.0"], "约在下周三下午了");

    chat(w, MINE, "刚才那句补充不要了");
    const noteBack = say(w, undoLast("刚才那句补充不要了"));
    await w.engine.tick();
    assert.equal(outcome(w, noteBack), "applied");
    assert.equal(item(w, 1)!.fields["note.0"], undefined);

    chat(w, MINE, "体检不用盯了");
    const trackBack = say(w, undoLast("体检不用盯了"));
    await w.engine.tick();
    assert.equal(outcome(w, trackBack), "applied");
    assert.equal(item(w, 1)!.closed, true);
    assert.equal(w.cards.length, 0, "not one card in all of it");
  }));

const MIN = 60_000;

test("taking back in the admin's chat needs no card only just after it was told, here: ten minutes; later it waits on a card that says which matter and when", () =>
  withAdmin(async (w) => {
    chat(w, MINE, SAID);
    say(w, track(SAID, "年度体检", "personal"));
    await w.engine.tick();
    // a few days on, in the same long chat, "that one is not wanted" (it may mean anything): the matter is not ended by it
    w.clock.now += 3 * 24 * 60 * MIN;
    chat(w, MINE, "刚才那个不要了");
    const late = say(w, undoLast("刚才那个不要了"));
    await w.engine.tick();
    assert.equal(outcome(w, late), "proposed");
    assert.equal(why(w, late), "要撤的是 3 天前记下的话，只有刚说完（10 分钟内）才免确认", "the log says why: how long ago it was told, not the sentence about the source label");
    assert.equal(item(w, 1)!.closed, false, "still followed");
    const card = Object.values(w.store.state.commitments).find((c) => c.key.startsWith("confirm:desk:D1:undo:"))!;
    assert.equal(card.ask.question, "要撤掉 D1「年度体检」（10-13 周二 10:00 交代的，撤掉就不再盯它）吗？", "which matter, and when it was told");
    assert.equal(w.receipt(late)!.text, "先不生效：「撤掉 D1「年度体检」（10-13 周二 10:00 交代的，撤掉就不再盯它）」已改成确认卡，等 测试用户 在卡上确认。");
    // and a yes on it ends the matter, as said
    await w.engine.tick();
    w.answer({ "确认 D1": "照办" });
    await w.engine.tick();
    assert.equal(item(w, 1)!.closed, true);
  }));

test("just after: a matter told ten minutes ago is taken back with no card, one told eleven minutes ago is not; the same for a line added; the limit is the one conversation", () =>
  withAdmin(async (w) => {
    chat(w, MINE, SAID);
    say(w, track(SAID, "年度体检", "personal"));
    await w.engine.tick();
    w.clock.now += 11 * MIN;
    chat(w, MINE, "刚才那个不要了");
    const eleven = say(w, undoLast("刚才那个不要了"));
    await w.engine.tick();
    assert.equal(outcome(w, eleven), "proposed", "eleven minutes is not just after");
    assert.equal(why(w, eleven), "要撤的是 11 分钟前记下的话，只有刚说完（10 分钟内）才免确认");

    chat(w, MINE, "另外盯一下续费，到期前要办好");
    say(w, track("另外盯一下续费，到期前要办好", "续费", "personal"));
    await w.engine.tick();
    w.clock.now += 10 * MIN;
    chat(w, MINE, "续费那个不用盯了");
    const ten = say(w, undoLast("续费那个不用盯了"));
    await w.engine.tick();
    assert.equal(outcome(w, ten), "applied", "ten minutes is");
    assert.equal(item(w, 2)!.closed, true);

    // (one question a day for each matter and kind: D1 has had its card)
    chat(w, MINE, "再盯一下报名，周五截止");
    say(w, track("再盯一下报名，周五截止", "报名", "personal"));
    await w.engine.tick();
    chat(w, MINE, "约在下周三下午了");
    say(w, note("D3", "约在下周三下午了"));
    await w.engine.tick();
    w.clock.now += 20 * MIN;
    chat(w, MINE, "刚才那句补充不要了");
    const oldNote = say(w, undoLast("刚才那句补充不要了"));
    await w.engine.tick();
    assert.equal(outcome(w, oldNote), "proposed", "a line added twenty minutes ago waits on a card too");
    assert.equal(Object.values(w.store.state.commitments).find((c) => c.key.startsWith("confirm:desk:D3:undo:"))!.ask.question, "要撤掉 D3 里 10-13 周二 10:21 补的那句「约在下周三下午了」吗？");
    assert.equal(item(w, 3)!.fields["note.0"], "约在下周三下午了", "still there");
  }));

test("taking back what another conversation told, even a minute ago, waits on a card, and the log says it was another conversation", () =>
  withAdmin(async (w) => {
    chat(w, MINE, SAID);
    say(w, track(SAID, "年度体检", "personal"));
    await w.engine.tick();
    w.clock.now += 1 * MIN;
    // a second conversation of the same chat, with its own turn
    const [told] = Object.keys(w.store.state.annotations);
    const elsewhere = "刚才那个不要了";
    chat(w, MINE, elsewhere);
    w.conversations.set("agent-other", w.conversations.get("agent-me")!);
    w.conversations.delete("agent-me");
    // ("last" is the newest of the conversation's own; this one has none, so it names the one it means)
    const request = { cmd: "undo", target: told, said: elsewhere };
    w.conversations.get("agent-other")!.turn!.steps.push({ kind: "command", text: commandFor(request) });
    const id = w.say({ ...request, via: "agent-other" });
    await w.engine.tick();
    assert.equal(outcome(w, id), "proposed");
    assert.equal(why(w, id), "要撤的是另一个对话里记下的话，只有在记下它的那个对话里、刚说完才免确认");
    assert.equal(item(w, 1)!.closed, false);
  }));

test("freshInChat: told in this very conversation, no longer ago than the limit", () => {
  const told = { via: "agent-me", at: "2026-10-13T10:00:00+08:00" };
  const at = Date.parse(told.at);
  assert.equal(freshInChat(told, "agent-me", at + ADMIN_CHAT_UNDO_MS), true);
  assert.equal(freshInChat(told, "agent-me", at + ADMIN_CHAT_UNDO_MS + 1), false);
  assert.equal(freshInChat(told, "agent-other", at), false, "another conversation");
  assert.equal(freshInChat(told, null, at), false, "none");
  assert.equal(freshInChat({ ...told, via: null }, null, at), false);
});

test("what went through on the waiver says so in the journal: on the words it kept and on the request; nothing of the kind where there was no source label to waive", () =>
  withAdmin(async (w) => {
    chat(w, MINE, SAID);
    const told = say(w, track(SAID, "年度体检", "personal"));
    await w.engine.tick();
    const [annotation] = Object.values(w.store.state.annotations);
    assert.equal(annotation!.waived, true);
    assert.equal(w.store.state.requests[told]!.waived, true);
    assert.equal(annotation!.how, "own-words");
    own(w, "约在下周三下午了");
    const added = say(w, note("D1", "约在下周三下午了"));
    await w.engine.tick();
    const second = Object.values(w.store.state.annotations).find((x) => x.kind === "note")!;
    assert.equal(second.waived, undefined, "in the person's own conversation (no source label) there was nothing to waive");
    assert.equal(w.store.state.requests[added]!.waived, undefined);
    // the page does not carry it
    assert.ok(w.statuses.length > 0 && !JSON.stringify(w.statuses[w.statuses.length - 1]).includes("waived"), "the page's list of what was said does not show it");
  }));

test("a conversation with more labels than the ones persons.json names is the same chat; fewer, or a different value, is not", () =>
  withAdmin(async (w) => {
    chat(w, { ...MINE, extra: "x" }, SAID);
    const more = say(w, track(SAID, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, more), "applied", "the host may add labels of its own");
  }));

test("adminChat: every key and value of one of the chats must be there; none configured, no source label, or an empty set is never a chat", () => {
  const chats: Array<Record<string, string>> = [{ source: "chatapp", "chatapp-chat": "p2p:owner" }, { source: "other", "other-chat": "p2p:x" }, { source: "alone" }];
  assert.equal(adminChat({ source: "chatapp", "chatapp-chat": "p2p:owner" }, chats), true);
  assert.equal(adminChat({ source: "other", "other-chat": "p2p:x", whatever: "1" }, chats), true, "the second set, with more labels besides");
  assert.equal(adminChat({ source: "alone", whatever: "1" }, chats), false, "a set that is only the source is every conversation of that plugin: it is no one's chat");
  assert.equal(adminChat({ "chatapp-chat": "p2p:owner", other: "x" }, [{ "chatapp-chat": "p2p:owner", other: "x" }]), false, "and a set without the source label is none either");
  assert.equal(adminChat({ source: "chatapp", "chatapp-chat": "p2p:someone" }, chats), false);
  assert.equal(adminChat({ source: "chatapp" }, chats), false, "one key short");
  assert.equal(adminChat({ "chatapp-chat": "p2p:owner" }, chats), false, "no source label: that is a conversation the person is in themselves, nothing to waive");
  assert.equal(adminChat({ source: "chatapp", "chatapp-chat": "p2p:owner" }, []), false);
  assert.equal(adminChat({ source: "chatapp" }, [{}]), false, "a chat with no labels would be every chat");
});

test("persons.json: a chat is named by its source and at least one label more; the source alone is every conversation of that plugin and does not load", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-chats-"));
  try {
    const write = (chats: unknown) => {
      writeFileSync(path.join(dir, "persons.json"), JSON.stringify(PERSONS({ chats })));
      writeFileSync(path.join(dir, "sources.json"), "[]");
      writeFileSync(path.join(dir, "policy.json"), JSON.stringify(TEST_POLICY));
    };
    write([MINE]);
    assert.deepEqual(loadConfig(dir).persons.owner!.chats, [MINE]);
    write([]);
    assert.deepEqual(loadConfig(dir).persons.owner!.chats, []);
    for (const bad of [[{ source: "chatapp" }], [{ "chatapp-chat": "p2p:owner" }], [MINE, { source: "chatapp" }], [{}]]) {
      write(bad);
      assert.throws(() => loadConfig(dir), /source/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- what still waits on a card -------------------------------------------------------------------------------------

test("from a group, another person's chat, or a chat short of one label, the same words wait on a card", () =>
  withAdmin(async (w) => {
    const others: Array<[string, Record<string, string>]> = [
      ["a group", { source: "chatapp", "chatapp-chat": "group:1234" }],
      ["another person's chat", { source: "chatapp", "chatapp-chat": "p2p:someone" }],
      ["a label short", { source: "chatapp" }],
      ["a channel nobody named", { source: "elsewhere", "chatapp-chat": "p2p:owner" }],
    ];
    let n = 0;
    for (const [what, labels] of others) {
      // other words each time: the same ones asked about on a card twice in a day are one card, not a new case
      const said = `${SAID}（${++n}）`;
      chat(w, labels, said);
      const id = say(w, track(said, `事${n}`, "personal"));
      await w.engine.tick();
      assert.equal(outcome(w, id), "proposed", what);
      assert.match(why(w, id), /^这是从「/, what);
    }
    assert.equal(item(w, 1), undefined);
  }));

test("stop following, hold off and 'this is wrong' said in the admin's chat still wait on a card, and so does taking one of them back", () =>
  withAdmin(async (w) => {
    chat(w, MINE, SAID);
    say(w, track(SAID, "年度体检", "personal"));
    await w.engine.tick();
    for (const [kind, extra] of [["drop", {}], ["hold", { until: "2026-10-20" }], ["wrong", { what: "不对", expected: "对" }]] as const) {
      const said = `说一句关于它的话：${kind}`;
      chat(w, MINE, said);
      const id = say(w, { cmd: "say", kind, item: "D1", said, ...extra });
      await w.engine.tick();
      assert.equal(outcome(w, id), "proposed", kind);
      assert.match(why(w, id), /^这是从「/, kind);
    }
    // the same said where the host does not say who typed it, then taken back there
    own(w, "说一句：不用追踪 D1 了");
    const dropped = say(w, { cmd: "say", kind: "drop", item: "D1", said: "说一句：不用追踪 D1 了" });
    await w.engine.tick();
    assert.equal(outcome(w, dropped), "applied");
    chat(w, MINE, "刚才那条不要了");
    const back = say(w, undoLast("刚才那条不要了"));
    await w.engine.tick();
    assert.equal(outcome(w, back), "proposed", "taking back a stop is not a thing the chat may do on its own");
    assert.match(why(w, back), /^这是从「/);
  }));

test("every other check holds in the admin's chat: words they did not say, a command not run, a turn they did not start, someone else's message in between, pasted text, a small part of a message", async () => {
    const cases: Array<[string, (c: Conversation, said: string) => void, RegExp]> = [
      ["words not in their message", (c) => (c.turn!.steps[0] = { kind: "person", text: "今天天气不错" }), /找不到这句原话/],
      ["the command was never run", (c) => (c.turn!.steps = c.turn!.steps.filter((s) => s.kind !== "command")), /找不到这次的 reconcile-say 调用/],
      ["not a turn they started", (c) => (c.turn!.steps = c.turn!.steps.filter((s) => s.kind !== "person")), /不是人发消息开始的/],
      ["another agent's message in between", (c) => c.turn!.steps.splice(1, 0, { kind: "agent" }), /别的 agent 的消息/],
      ["pasted text", (c, said) => (c.turn!.steps[0] = { kind: "person", text: `${said}\n第二行\n第三行\n第四行` }), /贴进来的一段/],
      ["a small part of a long message", (c, said) => (c.turn!.steps[0] = { kind: "person", text: `${said}，另外还有很多很多别的话要说，都不是这件事，比如我下周想去看看房子，还想问问装修的事情，顺便提醒我买点水果` }), /一小段/],
      ["a conversation that is not running", (c) => ((c as unknown as { turn?: unknown }).turn = undefined), /没在跑/],
      ["a conversation another agent made", (c) => (c.labels["paseo.parent-agent-id"] = "agent-x"), /不是人直接在用的/],
    ];
    // Six words at most wait on the admin at a time (and each is a card): two worlds.
    for (const chunk of [cases.slice(0, 4), cases.slice(4)]) {
      await withAdmin(async (w) => {
        let n = 0;
        for (const [what, spoil, expected] of chunk) {
          const said = `${SAID}（${++n}）`;
          chat(w, MINE, said);
          const c = w.conversations.get("agent-me")!;
          c.turn!.steps.push({ kind: "command", text: commandFor(track(said, `事${n}`, "personal")) });
          spoil(c, said);
          const id = w.say(track(said, `事${n}`, "personal"));
          await w.engine.tick();
          assert.equal(outcome(w, id), "proposed", what);
          assert.match(why(w, id), expected, what);
        }
        assert.equal(Object.keys(w.store.state.items).filter((k) => k.startsWith("desk:")).length, 0);
      });
    }
  });

test("a request with no conversation to look at is no one's words", () =>
  withAdmin(async (w) => {
    const none = w.say(track(SAID, "年度体检", "personal"));
    await w.engine.tick();
    assert.equal(outcome(w, none), "proposed");
    assert.match(why(w, none), /找不到说这句话的对话/);
  }));

test("ownWords itself: the source check is the only one the waiver drops", () => {
  const request = { v: 1, id: "r_000000000001", at: "x", via: "agent-me", cmd: "track", said: SAID, title: "年度体检" } as unknown as Request;
  const conversation = (labels: Record<string, string>): Conversation => ({
    labels,
    cwd: "/work",
    turn: { id: "t1", steps: [{ kind: "person", text: SAID }, { kind: "command", text: commandFor({ cmd: "track", said: SAID, title: "年度体检" }) }] },
  });
  assert.match(ownWords(request, conversation(MINE), null).why ?? "", /^这是从「/);
  assert.equal(ownWords(request, conversation(MINE), null, true).why, null);
  assert.equal(ownWords(request, conversation({}), null).why, null, "a conversation with no source label needs no waiver");
  assert.match(ownWords(request, { ...conversation(MINE), turn: undefined } as unknown as Conversation, null, true).why ?? "", /没在跑/, "waived or not, a conversation that is not running is not one");
});
