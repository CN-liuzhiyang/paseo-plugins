import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ASK_KIND, ASK_VERSION, LINE_KIND, LINE_VERSION, askSchema, lineSchema } from "./shared/card";
import { AffairAsk, AffairLine } from "./client/card";
import { PANEL_ID, installHeaders } from "./client/header";
import { Panel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addTimelineRenderer({ kind: LINE_KIND, version: LINE_VERSION, schema: lineSchema, Component: AffairLine }),
    client.addTimelineRenderer({ kind: ASK_KIND, version: ASK_VERSION, schema: askSchema, Component: AffairAsk }),
    client.addWorkspacePanel({ context: "workspace", id: PANEL_ID, title: "进展", icon: "Activity", locations: ["explorer"], Component: Panel }),
    installHeaders(client),
  ];
  return () => cleanups.forEach((cleanup) => void cleanup());
}
