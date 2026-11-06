import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsOf } from "../server/lib/events.mjs";
import { fold } from "../server/lib/log.mjs";
import { rowsOf } from "../server/lib/view.mjs";
import { linkContext } from "../server/lib/links.mjs";
import { DEFAULT_POLICY } from "../server/lib/policy.mjs";

const now = Date.parse("2026-11-02T12:00:00+08:00");
function story(visits: any[]) {
  const lines: any[] = [];
  const add = (line: any) => lines.push({ seq: lines.length + 1, at: new Date(now + lines.length * 60_000).toISOString(), ...line });
  add({ kind: "created", id: "sample", title: "预约" });
  add({ kind: "report", verdict: "pass", entry: "可以约了", changed: true });
  for (const v of visits) {
    add({ kind: "wake", why: v.why ?? ["time"] });
    for (const line of v.before ?? []) add(line);
    add({ kind: "report", verdict: "pass", entry: "仍然等确认", changed: false, ...v.report });
    for (const line of v.after ?? []) add(line);
    add({ kind: "wake.end", state: "ok" });
  }
  return { ...fold(lines), lines };
}
const chat = (s: any) => rowsOf(s, now, DEFAULT_POLICY).filter((r: any) => r.key.startsWith("r"));
const panel = (s: any) => eventsOf(s, now, DEFAULT_POLICY, linkContext(DEFAULT_POLICY, null), { labelOf: (tool: string) => ({ name: tool }) }).items;

test("only a scheduled, certainly unchanged look disappears from chat; the log stays whole", () => {
  const s = story([{}, {}, {}]);
  assert.equal(s.lines.filter((l: any) => l.kind === "report").length, 4);
  assert.equal(chat(s).length, 1);
  for (const why of [["ring"], ["ring:manual"], ["said:2"], ["answered:sample-1"], ["time", "ring:manual"], []]) {
    assert.equal(chat(story([{ why }])).length, 2, JSON.stringify(why));
  }
});

test("new questions, decisions, failures and uncertain reports remain visible", () => {
  const visible = [
    { report: { changed: true } },
    { report: { changed: undefined } },
    { report: { verdict: "fallback" } },
    { before: [{ kind: "read", tool: "sample", ok: false, reason: "暂时读不到" }] },
    { before: [{ kind: "read", tool: "sample", ok: true, value: 1 }] },
    { after: [{ kind: "asked", id: "q1", title: "明天约吗？", options: ["好"] }] },
    { after: [{ kind: "next", verdict: "ask", next: "2026-11-03T12:00:00+08:00" }] },
    { after: [{ kind: "next", verdict: "appeal", next: "2026-11-03T12:00:00+08:00" }] },
    { after: [{ kind: "status", status: "done" }] },
  ];
  for (const visit of visible) assert.equal(chat(story([visit])).length, 2, JSON.stringify(visit));
  const read = (value: number) => ({ kind: "read", tool: "sample", ok: true, value });
  assert.equal(chat(story([{ before: [read(1)] }, { before: [read(1)] }])).length, 2);
  assert.equal(chat(story([{ before: [read(1)] }, { before: [read(2)] }])).length, 3);
});

test("panel merges consecutive quiet looks, keeps latest time, and splits around changes or new questions", () => {
  const grouped = panel(story([{}, {}, {}]));
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].children.length, 3);
  assert.match(grouped[0].when, /12:09/);
  const changed = panel(story([{}, { report: { changed: true } }, {}, {}]));
  assert.equal(changed.length, 4);
  assert.equal(changed[0].children.length, 2);
  const asked = panel(story([{}, { after: [{ kind: "asked", id: "q1", title: "明天约吗？", options: ["好"] }] }, {}]));
  assert.equal(asked.filter((r: any) => r.kind === "look").length, 4);
  for (const row of [...grouped, ...changed, ...asked]) assert.doesNotMatch([row.label, row.sub, row.text, row.when].join(" "), /叫醒|校验|记录|计划|读数|会话|agent/i);
});
