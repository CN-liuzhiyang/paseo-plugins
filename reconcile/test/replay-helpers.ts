import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCapsule, type Capsule, type Expect } from "../server/capsule";
import { conclude } from "../server/observe";
import { judge, loadRules, makeContext, outputCheck, recordingContext, type LoadedRule } from "../server/rules";
import { createCalendar, type CalendarYear } from "../server/time";
import type { Item, Note } from "../shared/model";
import { at, issue, TZ } from "./helpers";

// What the capsule and replay tests share: a small rule that reads from every part of its
// context, written to a temp dir and loaded the way the controller does, and a way to judge with
// it on hand-made inputs and keep the capsule. All names, ids and times are made up.

export interface DemoParams {
  grace?: number;
  verb?: string;
  ask?: boolean;
  watch?: boolean;
  /** Also look up this item (the capsule will not have it when it was made without). */
  peek?: string;
  /** Throw from the rule. */
  boom?: boolean;
  /** Name a stage the rule does not declare. */
  badStage?: boolean;
  /** What the question rests on besides its own source. */
  uses?: string[];
}

/** A rule file's text that reads a bit of everything and says what it saw in a fact. */
export function demoRuleText(params: DemoParams = {}): string {
  const p = JSON.stringify({ grace: 1, verb: "外放", ask: true, watch: false, ...params });
  return [
    "export default {",
    '  name: "demo-replay",',
    '  description: "reads a bit of everything",',
    '  applies: { source: "gcp-demo" },',
    `  params: ${p},`,
    '  stages: ["open", "waiting", "finished"],',
    "  assess(kase, ctx) {",
    "    const item = kase.primary;",
    "    const p = ctx.params;",
    '    if (p.boom) throw new Error("boom");',
    "    const notes = ctx.notes(item.key);",
    '    const peer = ctx.item("gcp-demo:2");',
    "    const peek = p.peek ? ctx.item(p.peek) : null;",
    '    const due = ctx.addWorkdays(ctx.now, p.grace, "10:00");',
    '    const watch = ctx.observation("watch-demo", "k1");',
    "    const seen = [",
    '      item.title, p.verb, "peer=" + (peer ? peer.status : "none"), "peek=" + (peek ? peek.status : "none"),',
    '      "sibs=" + ctx.siblings(item.key).length, "obs=" + ctx.observations(item.key).length,',
    '      "flag=" + ctx.flag("demo_switch").files.length, "named=" + ctx.naming("demo_switch").length,',
    '      "mine=" + ctx.commitments(item.key).length, "fresh=" + ctx.fresh("gcp-demo"), "flagsOf=" + ctx.flagsOf(item.key).length,',
    '      "watch=" + (watch ? watch.verdict : "null"), "due=" + due, "gap=" + ctx.workdaysBetween(ctx.now, due),',
    '      "at=" + ctx.at("2026-10-23", "09:30"), "local=" + ctx.local(due),',
    '    ].join(" ");',
    '    const facts = [{ field: "seen", value: seen, evidence: "what the rule read" }, { field: "plan", value: notes.plan ? notes.plan.value : "none", evidence: "notes" }];',
    '    const asks = !p.ask ? [] : [{',
    '      key: "ask:" + item.key + ":" + due.slice(0, 10), title: item.title + " " + p.verb + "了吗？", domain: "work", owner: "owner",',
    "      trigger: { at: due }, backstop: { at: ctx.addWorkdays(due, 5, \"10:00\") },",
    '      ask: { header: "#" + item.key.slice(item.key.indexOf(":") + 1), question: p.verb + "了吗？", options: [{ id: "yes", label: "是", description: "已经" }, { id: "no", label: "否", description: "还没有" }], allowOther: true },',
    '      brief: "看到 " + p.verb, nag: { everyWorkdays: 1, at: "10:00", max: 2 }, level: "push", ...(p.uses ? { uses: p.uses } : {}),',
    "    }];",
    "    const observe = !p.watch ? undefined : [{",
    '      source: "watch-demo", key: "k1", window: { from: ctx.now, to: ctx.addWorkdays(ctx.now, 1, "10:00") }, reread: [60], params: { n: 1 },',
    "    }];",
    "    return {",
    '      stage: p.badStage ? "nowhere" : peer && peer.closed ? "waiting" : "open",',
    '      health: "on-track", headline: item.title + "：" + p.verb, next: { actor: "system", what: "wait" },',
    "      facts, commitments: asks, observe,",
    "    };",
    "  },",
    "};",
    "",
  ].join("\n");
}

const dirs: string[] = [];

/** A rule loaded from text, the way the controller loads one. */
export async function loadDemo(text: string, file = "demo.mjs"): Promise<LoadedRule> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-demo-rule-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, file), text);
  const set = await loadRules(dir);
  if (set.rules.length !== 1) throw new Error(`demo rule did not load: ${JSON.stringify(set.errors)}`);
  return set.rules[0]!;
}

export function cleanDemos(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface World0 {
  items?: Record<string, Item>;
  notes?: Record<string, Record<string, Note>>;
  years?: Record<string, CalendarYear>;
  trigger?: string[];
  expect?: Expect | null;
  /** What `ctx.observation("watch-demo", "k1")` is told, if anything. */
  watched?: boolean;
}

/** Judges item 1 with the rule on hand-made state, taping the calls, and keeps the capsule. */
export function capture(rule: LoadedRule, nowLocal: string, world: World0 = {}): Capsule {
  const items = world.items ?? { "gcp-demo:1": issue(1), "gcp-demo:2": issue(2, { status: "关闭", closed: true }) };
  const years = world.years ?? { "2026": { holidays: ["2026-10-01"], workdays: ["2026-10-10"] } };
  const nowMs = at(nowLocal);
  const ctx = makeContext(
    {
      nowMs,
      tz: TZ,
      calendar: createCalendar(years),
      items,
      recent: {},
      notes: world.notes ?? {},
      commitments: {},
      fresh: () => true,
      observed: (key) => (world.watched && key === "watch-demo:k1" ? conclude(null, null, null, { everyMs: 60_000, graceMs: 0, maxLagMs: 0, nowMs, tz: TZ }) : null),
    },
    rule.params,
  );
  const recorded = recordingContext(ctx);
  const primary = items["gcp-demo:1"]!;
  const kase = { id: primary.key, primary, items: [primary], flags: [] };
  const names = { known: ["gcp-demo", "flags-demo", "flags-demo:outer"], items: Object.keys(items), observing: ["watch-demo"] };
  const check = outputCheck({ known: (n) => names.known.includes(n), item: (k) => names.items.includes(k), observing: (id) => names.observing.includes(id) });
  const judged = judge(rule, kase, recorded.ctx, "fp-live", check);
  return buildCapsule({
    kase,
    calls: recorded.calls(),
    judged,
    rule,
    fingerprint: "fp-live",
    now: ctx.now,
    tz: TZ,
    calendar: years,
    names,
    trigger: world.trigger ?? ["stage"],
    origin: "live",
    seq: 12,
    instance: "test",
    expect: world.expect ?? null,
  });
}
