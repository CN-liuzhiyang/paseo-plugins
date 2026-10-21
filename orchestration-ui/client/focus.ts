// Which run a workspace's 编排运行 tab shows, and which node in it. A panel is opened without
// params, so whoever opens it (a card, the sidebar screen) writes here first and the panel reads
// it; the panel writes back as the person picks, so leaving the tab and coming back -- or the
// host unmounting and remounting it -- lands on the same run and node. One store per plugin
// installation, kept for the life of the app.

export interface Focus {
  runId: string;
  select: string | null;
  /** Bumped by every open from outside, so asking again for the same run reselects its node. */
  nonce: number;
}

export function createFocusStore() {
  const focus = new Map<string, Focus>();
  const listeners = new Set<() => void>();
  let nonce = 0;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    get(workspaceId: string): Focus | null {
      return focus.get(workspaceId) ?? null;
    },
    /** From outside the panel: show this run, at this node. */
    open(workspaceId: string, runId: string, select: string | null) {
      nonce += 1;
      focus.set(workspaceId, { runId, select, nonce });
      notify();
    },
    /** From the panel: remember where the person is, without asking it to reselect. */
    remember(workspaceId: string, runId: string, select: string | null) {
      const current = focus.get(workspaceId);
      if (current?.runId === runId && current.select === select) return;
      focus.set(workspaceId, { runId, select, nonce: current?.runId === runId ? current.nonce : 0 });
      notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type FocusStore = ReturnType<typeof createFocusStore>;

/** The run a tab shows when nothing asked for one: one that needs you, then one running, then the newest. */
export function defaultRun<T extends { runId: string; needsYou: boolean; status: string }>(runs: readonly T[]): T | null {
  return (
    runs.find((run) => run.needsYou) ??
    runs.find((run) => run.status === "running" || run.status === "starting") ??
    runs[0] ??
    null
  );
}
