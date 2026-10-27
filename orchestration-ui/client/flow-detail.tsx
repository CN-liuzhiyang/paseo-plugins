import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { standing, startCommand } from "../shared/flows";
import type { FlowInput, FlowRow } from "../shared/rpc";
import { useFlowList, useNow, useRunList } from "./data";
import { Row } from "./run-list";
import { Badge, Banner, Block, CopyButton, Fact, Section, useUi } from "./ui";

// One flow: what it is, what it takes, how to run it, and its runs. The page is read-only, like the rest of the
// plugin: it says how to start a flow, it does not start one.

const KIND_LABEL: Record<FlowInput["kind"], string> = {
  text: "文字",
  choice: "选一个",
  count: "数字",
  flag: "开关",
  list: "列表（重复写这个参数）",
  group: "一组（只能走 --input）",
};

export function FlowDetail({ name, onBack, onOpenRun }: { name: string; onBack(): void; onOpenRun(runId: string): void }) {
  const ui = useUi();
  const flows = useFlowList();
  const runs = useRunList();
  const mine = runs.data?.runs.filter((run) => run.flowName === name) ?? [];
  const live = mine.some((run) => run.status === "running" || run.status === "starting");
  const now = useNow(live);
  const flow = flows.data?.flows.find((f) => f.name === name) ?? null;

  return (
    <ScrollView style={ui.styles.screen} contentContainerStyle={ui.styles.content}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="返回流程列表"
        onPress={onBack}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" }}
      >
        <Icon name="ArrowLeft" size={16} color={ui.theme.colors.foregroundMuted} />
        <Text style={ui.styles.muted}>全部流程</Text>
      </Pressable>
      {!flows.data ? (
        <Text style={ui.styles.muted}>{flows.error ?? "正在读取……"}</Text>
      ) : !flow ? (
        <Banner tone="warning" icon="SearchX" title={`找不到流程 ${name}`}>
          <Text style={ui.styles.text}>列表里没有它：可能被改名或删掉了。</Text>
        </Banner>
      ) : (
        <Body flow={flow} orchPath={flows.data.orchPath} />
      )}
      <Section title={`运行记录 · ${mine.length}`}>
        {mine.length === 0 ? (
          <Text style={ui.styles.muted}>{runs.data ? "最近的运行记录里没有它。" : "正在读取……"}</Text>
        ) : (
          <View
            style={{
              borderWidth: 1,
              borderColor: ui.theme.colors.border,
              borderRadius: 12,
              overflow: "hidden",
              backgroundColor: ui.theme.colors.surface1,
            }}
          >
            {mine.map((run) => (
              <Row key={run.runId} run={run} now={now} onOpen={onOpenRun} />
            ))}
          </View>
        )}
      </Section>
    </ScrollView>
  );
}

function Body({ flow, orchPath }: { flow: FlowRow; orchPath: string | null }) {
  const ui = useUi();
  const look = standing(flow);
  const command = startCommand(flow, orchPath);
  return (
    <>
      <View style={{ gap: 6 }}>
        <View style={ui.styles.row}>
          <Text style={ui.styles.title}>{flow.name}</Text>
          <Badge tone={look.tone} label={look.label} />
        </View>
        {flow.description ? <Text style={ui.styles.text}>{flow.description}</Text> : null}
      </View>
      {flow.error ? (
        <Banner tone="danger" icon="TriangleAlert" title="这个文件现在不能当流程用">
          <Text style={ui.styles.text} selectable>
            {flow.error}
          </Text>
        </Banner>
      ) : null}
      {flow.problems.length > 0 ? (
        <Banner tone="warning" icon="TriangleAlert" title="源码有问题（orch check 也会这么说）">
          {flow.problems.map((problem) => (
            <Text key={problem} style={ui.styles.text} selectable>
              · {problem}
            </Text>
          ))}
        </Banner>
      ) : null}
      {flow.origin === "seen" ? (
        <Text style={ui.styles.muted}>
          这个流程只在运行记录里见过，运行时的流程列表里没有它：它是从列表之外的文件跑的，或者之后被改名、删掉了。下面只有它跑出来的记录。
        </Text>
      ) : null}
      {flow.phases.length > 0 ? (
        <Section title="经过的阶段">
          <View style={{ gap: 4 }}>
            {flow.phases.map((phase, index) => (
              <Text key={phase.id} style={ui.styles.text}>
                {index + 1}. {phase.title}
              </Text>
            ))}
          </View>
        </Section>
      ) : null}
      {flow.origin !== "seen" && !flow.error ? (
        <>
          <Section title={`输入 · ${flow.inputs.length}`}>
            {flow.inputs.length === 0 ? (
              <Text style={ui.styles.muted}>不需要输入。</Text>
            ) : (
              <View style={[ui.styles.card, { gap: 10 }]}>
                {flow.inputs.map((input) => (
                  <View key={input.name} style={{ gap: 2 }}>
                    <View style={ui.styles.row}>
                      <Text style={ui.styles.mono} selectable>
                        {input.flag}
                      </Text>
                      <Text style={ui.styles.small}>{KIND_LABEL[input.kind]}</Text>
                    </View>
                    {input.description ? <Text style={ui.styles.muted}>{input.description}</Text> : null}
                    {input.choices ? <Text style={ui.styles.small}>可选：{input.choices.join("、")}</Text> : null}
                  </View>
                ))}
              </View>
            )}
          </Section>
          <Section title="怎么跑" trailing={<CopyButton text={command} />}>
            <Block text={command} />
            <Text style={ui.styles.small}>这个页面只读，不能从这里启动。在终端里跑，或者让一个 agent 跑；跑起来就会出现在下面的运行记录里。</Text>
          </Section>
        </>
      ) : null}
      {flow.origin !== "seen" ? (
        <View style={[ui.styles.card, { gap: 8 }]}>
          {flow.file ? <Fact label="文件">{flow.file}</Fact> : null}
          <Fact label="额外授权">{flow.grants.length > 0 ? flow.grants.join("、") : "无"}</Fact>
        </View>
      ) : null}
    </>
  );
}
