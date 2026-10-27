import type { FlowRow, RunSummary } from "../shared/rpc";
import type { Catalog } from "./catalog";

// The page's list of flows: what exists (the runtime's list) joined with how each has gone (the run files). A flow
// that no run file mentions is still a row: that is what the list is for. A run whose flow is not in the list (it
// was started from a file outside the flows directories, or the flow was renamed or removed) still shows its flow as
// a row, marked so, because its runs are there to be looked at.

const startedAt = (run: RunSummary) => run.startedAt ?? "";

export function flowRows(catalog: Catalog, runs: RunSummary[]): { state: "ok" | "fallback"; detail: string; flows: FlowRow[] } {
  const by = new Map<string, { count: number; latest: RunSummary }>();
  for (const run of runs) {
    if (run.flowName === null) continue;
    const seen = by.get(run.flowName);
    if (!seen) by.set(run.flowName, { count: 1, latest: run });
    else {
      seen.count += 1;
      if (startedAt(run) > startedAt(seen.latest)) seen.latest = run;
    }
  }
  const stats = (name: string) => {
    const s = by.get(name);
    return { runCount: s?.count ?? 0, latest: s?.latest ?? null };
  };

  const known = new Set<string>();
  const flows: FlowRow[] = [];
  if (catalog.ok) {
    for (const entry of catalog.flows) {
      known.add(entry.name);
      flows.push({ ...entry, ...stats(entry.name) });
    }
  }
  for (const [name, { latest }] of by) {
    if (known.has(name)) continue;
    flows.push({
      name,
      description: latest.description ?? "",
      origin: "seen",
      file: null,
      phases: [],
      inputs: [],
      grants: [],
      problems: [],
      error: null,
      ...stats(name),
    });
  }
  return catalog.ok ? { state: "ok", detail: "", flows } : { state: "fallback", detail: catalog.detail, flows };
}
