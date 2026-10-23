import type { PaseoApi } from "@getpaseo/client";
import type { PluginOpenScreenInput, PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { RunDetail } from "./run-detail";
import { RunList } from "./run-list";
import { Button, UiProvider } from "./ui";

export const SCREEN_ID = "runs";

export interface SurfaceActions {
  openSettings(): void;
  openScreen(input: PluginOpenScreenInput): void;
  /** Opens the run in a workspace's 流程 tab. */
  openInWorkspace(workspaceId: string, runId: string, select: string | null): void;
  paseo: PaseoApi;
}

/**
 * The workspace of a run's agents: any agent the run asked carries orch-run=<runId>, and lives in
 * the caller's workspace. A directory query, so nothing gets loaded. Null for a run that asked no
 * agent, or one whose agents are gone.
 */
function useRunWorkspace(paseo: PaseoApi, runId: string): string | null {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    paseo.agents
      .list({ filter: { labels: { "orch-run": runId } }, page: { limit: 1 } })
      .then((result) => {
        if (!cancelled) setWorkspaceId(result.entries[0]?.agent.workspaceId ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [paseo, runId]);
  return workspaceId;
}

function OneRun({ runId, node, actions, onBack }: { runId: string; node: string | null; actions: SurfaceActions; onBack(): void }) {
  const workspaceId = useRunWorkspace(actions.paseo, runId);
  const [picked, setPicked] = useState<string | null>(node);
  return (
    <RunDetail
      runId={runId}
      initialSelect={node}
      onBack={onBack}
      onPick={setPicked}
      action={
        workspaceId ? (
          <Button icon="PanelsTopLeft" label="在 workspace 中打开" onPress={() => actions.openInWorkspace(workspaceId, runId, picked)} />
        ) : null
      }
    />
  );
}

/**
 * The sidebar screen: the list of runs, or one run. The run travels in the screen's params, so
 * going back, reloading or coming back from an agent lands on the same run. Read-only throughout.
 */
export function RunsSurface(props: PluginScreenProps & { actions: SurfaceActions }) {
  const { actions } = props;
  const runId = props.params.run ?? null;
  const open = (run: string | null) => actions.openScreen({ screenId: SCREEN_ID, params: run ? { run } : {} });
  return (
    <UiProvider props={props}>
      {runId === null ? (
        <RunList host={props.host.label} onOpen={open} onSettings={actions.openSettings} />
      ) : (
        <OneRun key={`${runId}:${props.params.node ?? ""}`} runId={runId} node={props.params.node ?? null} actions={actions} onBack={() => open(null)} />
      )}
    </UiProvider>
  );
}
