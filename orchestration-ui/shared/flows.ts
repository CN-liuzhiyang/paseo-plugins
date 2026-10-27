import type { FlowRow } from "./rpc";
import { RUN_STATUS_LABEL } from "./format";

// How a flow reads on the page. Pure, so the order and the words are tested without drawing anything.

export type Standing = {
  /** What the dot and the one word beside it say about the flow's newest run. */
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  label: string;
  /** Sort rank: lower is nearer the top. */
  rank: number;
};

/**
 * A flow cannot be used (its file does not import) or has things `orch check` would refuse: worth a mark, but not
 * at the top -- it is not asking anything of the person.
 */
export const isBroken = (flow: FlowRow) => flow.error !== null;

export function standing(flow: FlowRow): Standing {
  if (isBroken(flow)) return { tone: "danger", label: "不能用", rank: 4 };
  const run = flow.latest;
  if (!run) return { tone: "neutral", label: "还没跑过", rank: 3 };
  if (run.needsYou) return { tone: "warning", label: "需要你处理", rank: 0 };
  if (run.status === "running" || run.status === "starting") return { tone: "accent", label: RUN_STATUS_LABEL[run.status], rank: 1 };
  const tone = run.status === "done" ? "success" : run.status === "stopped" || run.status === "lost" ? "warning" : "danger";
  return { tone, label: `上次${RUN_STATUS_LABEL[run.status]}`, rank: 2 };
}

/** Needs you, then running, then by newest run, then never run, then broken; ties by name. */
export function sortFlows(flows: FlowRow[]): FlowRow[] {
  return [...flows].sort((a, b) => {
    const [x, y] = [standing(a), standing(b)];
    if (x.rank !== y.rank) return x.rank - y.rank;
    const [ta, tb] = [a.latest?.startedAt ?? "", b.latest?.startedAt ?? ""];
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** The phases as one line: 取数 → 分析 → 校验. */
export const phaseLine = (flow: FlowRow) => flow.phases.map((p) => p.title).join(" → ");

/** The command that starts it, with each input as a placeholder; the runtime's path as the plugin was told it. */
export function startCommand(flow: FlowRow, orchPath: string | null): string {
  const orch = orchPath && orchPath.trim() !== "" ? orchPath.trim() : "<paseo-plugins>/orchestration/runtime/orch.mjs";
  const flags = flow.inputs.map((input) => `${input.flag} <${input.kind === "choice" ? (input.choices ?? []).join("|") : input.name}>`);
  return ["node", orch, "run", flow.name, ...flags].join(" ");
}
