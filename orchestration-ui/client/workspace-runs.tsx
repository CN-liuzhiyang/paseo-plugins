import { useAgent } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { inWorkspace, supersededRuns } from "../shared/bar";
import type { RunSummary } from "../shared/rpc";
import { useRunList, type RunList } from "./data";

// The runs that belong to one workspace: the runtime put their agents there, or the agent that
// started them lives there. Whether an agent lives in a workspace is only known to the app, so a
// small probe per caller reports it; the caller renders `probes` somewhere in its tree.

/** Reports whether one caller lives in this workspace; renders nothing. */
function Member({ caller, workspaceId, report }: { caller: string; workspaceId: string; report(caller: string, inside: boolean): void }) {
  const where = useAgent(caller, (agent) => agent.workspaceId);
  useEffect(() => report(caller, where === workspaceId), [caller, where, workspaceId, report]);
  return null;
}

export interface WorkspaceRuns {
  data: RunList | null;
  error: string | null;
  /** This workspace's runs, newest first as the daemon lists them. */
  mine: RunSummary[];
  /** Runs some later run carries on, over every run, not only this workspace's. */
  superseded: ReadonlySet<string>;
  /** Render these once, anywhere; they draw nothing. */
  probes: ReactNode;
}

export function useWorkspaceRuns(workspaceId: string, keep?: (run: RunSummary) => boolean): WorkspaceRuns {
  const { data, error } = useRunList();
  const [members, setMembers] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback((caller: string, inside: boolean) => {
    setMembers((before) => {
      if (before.has(caller) === inside) return before;
      const next = new Set(before);
      if (inside) next.add(caller);
      else next.delete(caller);
      return next;
    });
  }, []);
  const runs = data?.runs;
  const mine = useMemo(() => (runs ?? []).filter((run) => inWorkspace(run, workspaceId, members) || keep?.(run) === true), [runs, workspaceId, members, keep]);
  const superseded = useMemo(() => supersededRuns(runs ?? []), [runs]);
  const callers = useMemo(() => [...new Set((runs ?? []).flatMap((run) => (run.caller ? [run.caller] : [])))], [runs]);
  const probes = callers.map((caller) => <Member key={caller} caller={caller} workspaceId={workspaceId} report={report} />);
  return { data, error, mine, superseded, probes };
}
