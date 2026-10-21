import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { CARD_KIND, CARD_VERSION, runCardSchema } from "./shared/card";
import { createFocusStore } from "./client/focus";
import { makeRunCard } from "./client/run-card";
import { makeRunsPanel } from "./client/run-panel";
import { OrchestrationSettings } from "./client/settings-screen";
import { RunsSurface, SCREEN_ID, type SurfaceActions } from "./client/surface";

const PANEL_ID = "runs";

export default function contribute(client: PluginClientContext) {
  const focus = createFocusStore();
  const openAll = () => client.openScreen({ screenId: SCREEN_ID });
  const openInWorkspace = (workspaceId: string, runId: string, select: string | null) => {
    focus.open(workspaceId, runId, select);
    client.openPanel(PANEL_ID, { workspaceId, location: "workspace" });
  };
  const actions: SurfaceActions = {
    openSettings: () => client.openSettings("orchestration-ui"),
    openScreen: (input) => client.openScreen(input),
    openInWorkspace,
    paseo: client.paseo,
  };
  const Screen = (props: PluginScreenProps) => <RunsSurface {...props} actions={actions} />;
  const cleanups = [
    client.addScreen({ id: SCREEN_ID, title: "编排运行", Component: Screen }),
    client.addSidebarHeaderItem({
      id: "runs",
      title: "编排运行",
      Component: ({ currentScreen, openScreen }: PluginSidebarItemProps) => (
        <SidebarRow icon="Workflow" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />
      ),
    }),
    client.addWorkspacePanel({
      id: PANEL_ID,
      context: "workspace",
      title: "编排运行",
      icon: "Workflow",
      locations: ["workspace"],
      Component: makeRunsPanel({ focus, openAll }),
    }),
    client.addSettingsScreen({ id: "orchestration-ui", title: "编排运行", icon: "Workflow", Component: OrchestrationSettings }),
    client.addCommandCenterItem({
      id: "open-runs",
      title: "打开编排运行",
      icon: "Workflow",
      keywords: ["orchestration", "flow", "run", "编排", "运行"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
    client.addTimelineRenderer({
      kind: CARD_KIND,
      version: CARD_VERSION,
      schema: runCardSchema,
      // In the conversation's workspace when the client knows it; the sidebar screen otherwise.
      Component: makeRunCard(({ runId, workspaceId, select }) => {
        if (workspaceId) {
          try {
            openInWorkspace(workspaceId, runId, select);
            return;
          } catch (error) {
            console.warn("orchestration-ui: cannot open the workspace tab, opening the run screen", error);
          }
        }
        client.openScreen({ screenId: SCREEN_ID, params: { run: runId, node: select } });
      }),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
