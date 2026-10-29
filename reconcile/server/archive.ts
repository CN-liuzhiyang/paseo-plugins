import type { Conversation } from "./requests";

// The agent of a call that a flow asked to have archived once it had handed in (`$.ask(..., { archive: "after" })`, orchestration/EVENTS.md
// `call.archive`) and that the runtime could not archive itself: the CLI does not find an agent of a background workspace, and the affair's
// workspace is one. The host's own archive does, so this plugin does it, for the runs it started.
//
// Which agent to archive is read from a run's event file, and a file is not trusted (anyone who can write the log directory can write it): an
// agent is archived only when the host shows it to be the one that call started -- the labels the runtime puts on it, `orch-run` and
// `orch-call`, are the run's and the call's -- and when it is not running.

export type ArchiveOutcome =
  /** Archived now. */
  | { done: "archived" }
  /** The host does not know the agent (gone already): nothing to archive. */
  | { done: "gone" }
  /** The agent is not the one of this call (its labels say another run or call): left alone, for good. */
  | { done: "not-theirs"; why: string }
  /** The agent is running: not archived now (archiving it would interrupt it); it may be later. */
  | { done: "running" };

export interface ArchiverDeps {
  /** The agent as the host shows it (labels, whether it is running); null when the host has no such agent. */
  conversation(agentId: string): Promise<Conversation | null>;
  archive(agentId: string): Promise<void>;
}

export type AgentArchiver = (agentId: string, of: { runId: string; callId: string }) => Promise<ArchiveOutcome>;

export function createAgentArchiver(deps: ArchiverDeps): AgentArchiver {
  return async (agentId, of) => {
    const agent = await deps.conversation(agentId);
    if (!agent) return { done: "gone" };
    const run = agent.labels["orch-run"];
    const call = agent.labels["orch-call"];
    if (run !== of.runId || call !== of.callId) {
      return { done: "not-theirs", why: `labels are orch-run=${JSON.stringify(run ?? null)} orch-call=${JSON.stringify(call ?? null)}, not this call's` };
    }
    // `running` is what the host says of the agent; a host that did not say is told by the turn it names.
    if (agent.running ?? agent.turn !== null) return { done: "running" };
    await deps.archive(agentId);
    return { done: "archived" };
  };
}
