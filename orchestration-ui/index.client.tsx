import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { CARD_KIND, CARD_VERSION, runCardSchema } from "./shared/card";
import { makeFlowBar } from "./client/flow-bar";
import { createFocusStore } from "./client/focus";
import { makeRunCard } from "./client/run-card";
import { makeRunsPanel } from "./client/run-panel";
import { OrchestrationSettings } from "./client/settings-screen";
import { RunsSurface, SCREEN_ID, type SurfaceActions } from "./client/surface";

const PANEL_ID = "runs";
const BAR_ID = "flow-bar";

export default function contribute(client: PluginClientContext) {
  const focus = createFocusStore();
  // Which run the bar of each workspace has open; apart from the tab's, which also remembers a node.
  const barFocus = createFocusStore();
  const openAll = () => client.openScreen({ screenId: SCREEN_ID });
  const openInWorkspace = (workspaceId: string, runId: string, select: string | null) => {
    focus.open(workspaceId, runId, select);
    client.openPanel(PANEL_ID, { workspaceId, location: "workspace" });
  };
  const openBeside = (workspaceId: string, runId: string) => {
    barFocus.open(workspaceId, runId, null);
    client.openPanel(BAR_ID, { workspaceId, location: "explorer" });
  };
  const actions: SurfaceActions = {
    openSettings: () => client.openSettings("orchestration-ui"),
    openScreen: (input) => client.openScreen(input),
    openInWorkspace,
    paseo: client.paseo,
  };
  const Screen = (props: PluginScreenProps) => <RunsSurface {...props} actions={actions} />;
  const cleanups = [
    client.addScreen({ id: SCREEN_ID, title: "流程", Component: Screen }),
    client.addSidebarHeaderItem({
      id: "runs",
      title: "流程",
      Component: ({ currentScreen, openScreen }: PluginSidebarItemProps) => (
        <SidebarRow icon="Workflow" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />
      ),
    }),
    client.addWorkspacePanel({
      id: PANEL_ID,
      context: "workspace",
      title: "流程",
      icon: "Workflow",
      locations: ["workspace"],
      Component: makeRunsPanel({ focus, openAll }),
    }),
    // Beside the conversation on a wide screen; a host without Explorer panels simply does not list it.
    client.addWorkspacePanel({
      id: BAR_ID,
      context: "workspace",
      title: "流程",
      icon: "Workflow",
      locations: ["explorer"],
      Component: makeFlowBar({ focus: barFocus, actions: { openFull: openInWorkspace, openAll } }),
    }),
    client.addSettingsScreen({ id: "orchestration-ui", title: "流程", icon: "Workflow", Component: OrchestrationSettings }),
    client.addCommandCenterItem({
      id: "open-runs",
      title: "打开流程",
      icon: "Workflow",
      keywords: ["orchestration", "flow", "run", "流程", "编排", "运行"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
    client.addCommandCenterItem({
      id: "open-flow-bar",
      title: "打开流程栏",
      icon: "Workflow",
      keywords: ["flow", "run", "流程", "运行", "栏"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel(BAR_ID, { location: "explorer" });
      },
    }),
    // A phone has no Command Center, and the host lists no plugin panel in Explorer's + menu: this is how the bar is opened the first time there.
    client.addSlashCommand({
      name: "flows",
      description: "打开流程栏",
      argumentHint: "",
      context: "workspace",
      onSubmit({ openPanel }) {
        openPanel(BAR_ID, { location: "explorer" });
      },
    }),
    client.addTimelineRenderer({
      kind: CARD_KIND,
      version: CARD_VERSION,
      schema: runCardSchema,
      // Beside the conversation when it is wide, else the workspace's tab; the sidebar screen when the client does not know the workspace.
      Component: makeRunCard(({ runId, workspaceId, select, aside }) => {
        if (workspaceId) {
          if (aside) {
            try {
              openBeside(workspaceId, runId);
              return;
            } catch (error) {
              console.warn("orchestration-ui: cannot open the flow bar, opening the workspace tab", error);
            }
          }
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
