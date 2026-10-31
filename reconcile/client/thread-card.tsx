import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import type { AskView } from "../shared/graph";
import type { ThreadData } from "../shared/thread";
import { AskPanel } from "./item";
import { UiProvider, useUi } from "./ui";

// What the controller puts in the conversation a matter was told in: a question to answer right there (the same panel as on the item's page,
// the same answer: whichever comes first counts) and, once it is over, one line saying how; and one line that tells how a confirmation ended.
// The controller replaces the item as the question changes, so this component holds nothing but what it just sent.

function Line({ text }: { text: string }) {
  const ui = useUi();
  return (
    <View style={[ui.styles.card, { paddingVertical: 8 }]}>
      <Text style={ui.styles.small} selectable>
        {text}
      </Text>
    </View>
  );
}

function Item({ data }: { data: ThreadData }) {
  const ui = useUi();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  if (data.shape === "line") return <Line text={data.text} />;
  if (data.state !== "open") return <Line text={`${data.no} ${data.header}：${data.line ?? ""}`} />;
  const ask: AskView = {
    commitmentId: data.commitmentId,
    round: data.round,
    header: data.header,
    question: data.question,
    brief: data.brief,
    options: data.options,
    allowOther: data.allowOther,
    confirm: data.confirm,
    askedAt: null,
    nextAskAt: null,
    nextAskWhat: null,
    maxRounds: 0,
    cardAgentId: null,
  };
  return (
    <View style={{ gap: 6 }}>
      <AskPanel ask={ask} onDone={setNote} />
      {note ? <Text style={[ui.styles.small, { color: ui.tone(note.ok ? "success" : "danger") }]}>{note.text}</Text> : null}
    </View>
  );
}

export function ThreadCard(props: PluginTimelineItemProps<ThreadData>) {
  return (
    <UiProvider props={props}>
      <Item data={props.item.data} />
    </UiProvider>
  );
}
