import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CARD_KIND, CARD_VERSION, LINE_KIND, LINE_VERSION, cardSchema, lineSchema } from "./shared/card";
import { AffairCard, AffairLine } from "./client/card";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addTimelineRenderer({ kind: CARD_KIND, version: CARD_VERSION, schema: cardSchema, Component: AffairCard }),
    client.addTimelineRenderer({ kind: LINE_KIND, version: LINE_VERSION, schema: lineSchema, Component: AffairLine }),
  ];
  return () => cleanups.forEach((cleanup) => void cleanup());
}
