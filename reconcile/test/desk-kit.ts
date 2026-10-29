import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIdOf } from "../server/flows";
import type { Conversation } from "../server/requests";
import { probeOf, makeWorld, TEST_POLICY, TZ, type World } from "./helpers";
import { finished, flowsOf } from "./flows-kit";

// Matters a person told in a conversation (desk items): a world with the example rule `desk.mjs`, a person's own conversation to say
// them from, and the runs of the look ("item-glance") told by the test as the runtime would. 2026-10-13 is a Tuesday.

const here = path.dirname(fileURLToPath(import.meta.url));
export const DESK_RULE = readFileSync(path.join(here, "..", "examples", "desk.mjs"), "utf8");
/** The example rule with params replaced (a JSON object merged into the ones it has). */
export const deskRule = (params: Record<string, unknown> = {}) => DESK_RULE.replace(/\n {2}params: \{\r?\n/, "\n  params: Object.assign({\n").replace(/\n {2}\},\r?\n {2}stages:/, `\n  }, ${JSON.stringify(params)}),\n  stages:`);

export const START = "2026-10-13 10:00";
export const ADMIN = { name: "测试用户", admin: true, tz: TZ, quiet: { work: "workdays 09:30-20:00", personal: "daily 09:00-22:00", family: "daily 09:00-22:00" }, pushPerDay: 8 };
export const PERSONS = (extra: Record<string, unknown> = {}) => ({ owner: { ...ADMIN, ...extra } });
/** policy.json with the one flow's own limits (byFlow) and the general ones narrow, to see which a look is counted in. */
export const POLICY = (byFlow: Record<string, unknown> | null = { "item-glance": { perDay: 10, usdPerDay: 3, perCasePerDay: 4, concurrent: 1 } }, general: Record<string, number> = {}) => ({
  ...TEST_POLICY,
  flows: { perDay: 9, usdPerDay: 50, perCasePerDay: 9, concurrent: 9, ...general, ...(byFlow ? { byFlow } : {}) },
});

export async function withDesk<T>(body: (w: World) => Promise<T>, options: { start?: string; persons?: unknown; policy?: unknown; params?: Record<string, unknown>; rule?: string; flows?: boolean } = {}): Promise<T> {
  const w = await makeWorld({
    start: options.start ?? START,
    flows: options.flows ?? true,
    config: {
      rules: { "desk.mjs": options.rule ?? deskRule(options.params) },
      persons: options.persons ?? PERSONS(),
      policy: options.policy ?? POLICY(),
    },
  });
  try {
    return await body(w);
  } finally {
    w.close();
  }
}

const quoted = (v: unknown) => `"${String(v).replace(/["\\]/g, "\\$&")}"`;
/** The command an agent runs for a request, as a POSIX shell would read it. */
export const commandFor = (r: Record<string, unknown>): string => {
  const flags = [
    ...(r.cmd === "undo" ? [r.target === "last" ? "--last" : `--id ${r.target}`] : []),
    ...["item", "kind", "title", "domain", "until", "person", "what", "expected", "ask"].filter((k) => r[k] !== undefined).map((k) => `--${k} ${quoted(r[k])}`),
  ];
  return `node D:/plugins/reconcile/bin/reconcile-say.mjs ${r.cmd} ${flags.join(" ")} --said ${quoted(r.said)}`;
};

let turns = 0;
const owned = new WeakSet<Conversation>();
/** The person's own conversation (as the Paseo app starts them: no source label), running a turn these messages of theirs started. */
export const own = (w: World, ...messages: string[]) => chat(w, {}, ...messages);
/** A conversation with these labels (a chat channel's, say), running a turn these messages started. */
export const chat = (w: World, labels: Record<string, string>, ...messages: string[]) => {
  const c: Conversation = { labels: { ...labels }, cwd: "/work", turn: { id: `t${++turns}`, steps: messages.map((text) => ({ kind: "person" as const, text })) } };
  owned.add(c);
  w.conversations.set("agent-me", c);
};
/** A request from the agent's conversation; its command is run in the turn first (the person's own words are what a check looks for). */
export const say = (w: World, request: Record<string, unknown>) => {
  const c = w.conversations.get("agent-me");
  if (c?.turn && owned.has(c)) c.turn.steps.push({ kind: "command", text: commandFor(request) });
  return w.say(request);
};
export const track = (said: string, title: string, domain?: string) => ({ cmd: "track", said, title, ...(domain ? { domain } : {}) });
export const note = (item: string, said: string) => ({ cmd: "note", item, said });
export const undoLast = (said: string) => ({ cmd: "undo", target: "last", said });

/** Says a matter from the person's own conversation, takes the round, and gives the receipt. */
export async function tell(w: World, said: string, title: string, domain = "personal") {
  own(w, said);
  const id = say(w, track(said, title, domain));
  await w.engine.tick();
  await w.engine.settled();
  return w.receipt(id)!;
}

export const idOf = (n: number, look: number, round = 0) => runIdOf("test", `desk:D${n}`, "look", "item-glance", `look-${look}`, round);
/** What a look comes back with: a proposal (the rule bounds it). */
export const proposal = (over: Record<string, unknown> = {}) => ({ status: "任务还没完成", looked: "读了飞书任务，没有预约记录", nextLook: "2026-10-15 10:00", nextWhy: "过两天再看", question: "", options: [], finished: "no", finishedWhy: "", ...over });
/** The look `look` of matter `n` comes back with this. */
export const comes = (w: World, n: number, look: number, value: unknown, costUsd = 0.01) => w.flows.probes.set(idOf(n, look), finished(value, { summary: "看了一眼：…" }, costUsd));
/** The look is still going. */
export const going = (w: World, n: number, look: number) => w.flows.probes.set(idOf(n, look), probeOf({ state: "running" }));

export const item = (w: World, n: number) => w.store.state.items[`desk:D${n}`];
export const assessed = (w: World, n: number) => w.store.state.assessments[`desk:D${n}`];
export const fact = (w: World, n: number, field: string) => w.store.state.notes?.[`desk:D${n}`]?.[`desk.${field}`]?.value ?? "";
export const looksOf = (w: World, n: number) => Object.values(flowsOf(w)).filter((r) => r.caseId === `desk:D${n}`).sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
export const commitmentsOf = (w: World, n: number) => Object.values(w.store.state.commitments).filter((c) => c.caseId === `desk:D${n}`);
/** The clock moves on by minutes, a round at every step. */
export async function pass(w: World, minutes: number, step = 5) {
  for (let m = 0; m < minutes; m += step) {
    w.clock.now += Math.min(step, minutes - m) * 60_000;
    await w.engine.tick();
    await w.engine.settled();
  }
}
