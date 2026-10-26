import type { RunView } from "../shared/graph";
import type { RunProbe } from "../server/runs";
import { runIdOf, SUSPECT_MS } from "../server/flows";
import { at, issue, makeWorld, probeOf, TEST_POLICY, TZ, type World } from "./helpers";
import { set, START } from "./item-flow";

// The engine starts flows for items (batch 7b): a rule asks, the intent is written, the process is started, the runtime's
// files are read, and a run that comes to nothing is told. Everything here runs against a launcher that only records and
// a probe the test sets by run id -- no process is started, nothing is spent (the real runtime is in flows-orch.test.ts).

/** A rule that asks for runs as its item's `Runs` field says (JSON), and shows what it reads of the runs in `Watch` ("name:key,...") in its headline. */
export const RULE = `export const flows = {
  triage: { flow: "triage-flow", timeout: "30m", maxUsd: 1, notify: true },
  quick: { flow: "quick-flow", maxUsd: 0.5 },
};
export default {
  name: "flowrule", description: "x", applies: { source: "gcp-demo" }, params: {},
  stages: [{ id: "draft", label: "草稿" }, { id: "review", label: "评审" }, { id: "finished", label: "完成", end: true }],
  assess(kase, ctx) {
    const f = kase.primary.fields;
    const stage = f.Phase || "review";
    const seen = (f.Watch || "").split(",").filter(Boolean).map((w) => {
      const [n, k] = w.split(":");
      const r = ctx.run(n, k);
      return n + ":" + k + "=" + (r ? r.state + (r.value ? JSON.stringify(r.value) : "") : "-");
    });
    const out = { stage, health: "on-track", headline: "r " + seen.join(" "), next: { actor: f.Ball || "them", what: "等" }, facts: [], commitments: [] };
    if (f.Runs) out.run = JSON.parse(f.Runs);
    if (f.Ask) {
      out.commitments = [{
        key: "q:" + kase.id, title: "q", domain: "work", owner: "owner",
        trigger: { at: ctx.at(f.Ask, "10:00") },
        ask: { header: "H", question: "q? " + seen.join(" "), options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "B", description: "" }], allowOther: false },
        brief: "b " + (f.Word || "") + " " + seen.join(" "), nag: { everyWorkdays: 1, at: "10:00", max: 3 }, backstop: { at: ctx.at("2026-12-31", "18:00") }, level: "push" }];
    }
    return out;
  },
};`;

export const FLOW_OF = { triage: "triage-flow", quick: "quick-flow" } as const;
export const req = (key: string, input: Record<string, unknown> = { n: 1 }, flow: keyof typeof FLOW_OF = "triage", label = "初查") => ({ flow, key, input, label });
export const idFor = (n: number, key: string, name: keyof typeof FLOW_OF = "triage", round = 0) => runIdOf("test", `gcp-demo:${n}`, name, FLOW_OF[name], key, round);
export const asks = (w: World, n: number, reqs: unknown[], extra: Record<string, string> = {}) => set(w, n, { Runs: JSON.stringify(reqs), ...extra });

export async function withFlows<T>(body: (w: World) => Promise<T>, options: { start?: string; storeSkewMs?: number; policy?: unknown; persons?: unknown; rule?: string; mode?: "live" | "dry-run"; flows?: boolean; runs?: (caseId: string) => RunView[] } = {}): Promise<T> {
  const w = await makeWorld({
    start: options.start ?? START,
    storeSkewMs: options.storeSkewMs,
    mode: options.mode,
    runs: options.runs,
    flows: options.flows ?? true,
    config: { rules: { "flow.mjs": options.rule ?? RULE }, ...(options.policy ? { policy: options.policy } : {}), ...(options.persons ? { persons: options.persons } : {}) },
  });
  try {
    return await body(w);
  } finally {
    w.close();
  }
}

/** The clock moves on by `minutes` and the engine reconciles at every step of five. */
export async function advance(w: World, minutes: number, step = 5) {
  for (let m = 0; m < minutes; m += step) {
    w.clock.now += Math.min(step, minutes - m) * 60_000;
    await w.engine.tick();
    await w.engine.settled();
  }
}
export const first = async (w: World) => {
  await w.engine.tick();
  await w.engine.settled();
};
export const flowsOf = (w: World) => w.store.state.flows ?? {};
export const headline = (w: World, n: number) => w.store.state.assessments[`gcp-demo:${n}`]?.headline;
export const kinds = (w: World) => w.journal().filter((e) => e.type.startsWith("flow.")).map((e) => e.type);
export const running = (patch: Partial<RunProbe> = {}) => probeOf({ state: "running", ...patch });
export const finished = (value: unknown, over: Partial<NonNullable<RunProbe["end"]>> = {}, costUsd = 0.5) =>
  probeOf({ state: "ended", costUsd, end: { at: 0, outcome: "done", summary: "找到 2 处", stop: null, error: null, value, valueDropped: false, totalUsd: null, ...over } });

/** The clock moves on by some seconds and the engine reconciles once. */
export const look = async (w: World, seconds: number) => {
  w.clock.now += seconds * 1000;
  await first(w);
};

/** policy.json with the day's limits for flows set (the rest wide open). */
export const POLICY = (flows: { perDay?: number; usdPerDay?: number; perCasePerDay?: number; concurrent?: number }) => ({ ...TEST_POLICY, flows: { perDay: 9, usdPerDay: 50, perCasePerDay: 9, concurrent: 9, ...flows } });
/** persons.json with the one person told in a message when a run ends. */
export const OWNER = (extra: Record<string, unknown> = {}) => ({ owner: { name: "测试用户", admin: true, tz: TZ, quiet: { work: "workdays 09:30-20:00" }, pushPerDay: 8, notify: [{ channel: "chat", to: "u1" }], ...extra } });
/** The probe of a run that failed after spending $0.30. */
export const failedProbe = () => finished(null, { outcome: "failed", error: { name: "OutputMismatch", message: "m", headline: "回答不合格式", plain: "x", raw: "x" } as never }, 0.3);

