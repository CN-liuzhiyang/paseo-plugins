import { Pressable, Text, View } from "react-native";
import { formatTime } from "../shared/format";
import type { RunState } from "../shared/run";
import { Fold, MONO, useUi } from "./ui";

// The evidence layer: the events as the runtime wrote them, and whatever did not fit the contract.

/** Past this many rows the table shows the newest ones; the file itself has them all. */
const MAX_ROWS = 2_000;
/** Fields too long for a table cell; the drawer shows them in full. */
const LONG = new Set(["v", "seq", "ts", "runId", "kind", "prompt", "schema", "content", "brief", "fence", "flow", "schemaFingerprint"]);

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rest(event: Record<string, unknown>): string {
  const shown = Object.fromEntries(Object.entries(event).filter(([key]) => !LONG.has(key)));
  const text = JSON.stringify(shown);
  return text.length > 220 ? `${text.slice(0, 219)}…` : text;
}

export function EventsView({
  events,
  run,
  now,
  onSelect,
}: {
  events: readonly unknown[];
  run: RunState;
  now: number;
  onSelect(key: string): void;
}) {
  const ui = useUi();
  const c = ui.theme.colors;
  const rows = events.length > MAX_ROWS ? events.slice(-MAX_ROWS) : events;
  const unknown = Object.entries(run.unknownKinds);
  const cell = { fontFamily: MONO, fontSize: 11.5, lineHeight: 16, color: c.foregroundMuted, flexShrink: 0 } as const;
  return (
    <View style={{ gap: 8 }}>
      <Text style={ui.styles.small}>
        原始事件，按运行时写下的顺序。点带调用的一行，右边显示那个调用。契约见 orchestration/EVENTS.md。
      </Text>
      {run.problems.length > 0 || unknown.length > 0 ? (
        <Fold
          label="读取时的问题"
          hint={[
            run.problems.length ? `${run.problems.length} 处不合契约` : null,
            unknown.length ? `${unknown.length} 种不认识的事件（按契约忽略）` : null,
          ]
            .filter(Boolean)
            .join("，")}
          initiallyOpen
        >
          <View style={[ui.styles.card, { gap: 4 }]}>
            {run.problems.map((text, index) => (
              <Text key={index} style={{ color: ui.tone("warning"), fontSize: 13 }} selectable>
                {text}
              </Text>
            ))}
            {unknown.map(([kind, count]) => (
              <Text key={kind} style={ui.styles.muted}>
                不认识的事件 {kind} × {count}：按契约忽略
              </Text>
            ))}
          </View>
        </Fold>
      ) : null}
      {events.length > MAX_ROWS ? <Text style={ui.styles.small}>只列最近 {MAX_ROWS} 条，共 {events.length} 条。</Text> : null}
      <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
        {rows.map((event, index) => {
          if (!isObj(event)) return null;
          const callId = typeof event.callId === "string" ? event.callId : null;
          const kind = String(event.kind ?? "?");
          const level = event.kind === "log" ? event.level : null;
          return (
            <Pressable
              key={index}
              disabled={callId === null}
              onPress={() => callId && onSelect(callId)}
              style={({ pressed }) => ({
                flexDirection: "row",
                gap: 8,
                paddingVertical: 3,
                borderBottomWidth: 1,
                borderBottomColor: c.border,
                backgroundColor: pressed ? c.surface1 : "transparent",
              })}
            >
              <Text style={[cell, { width: 30, textAlign: "right" }]}>{String(event.seq ?? "")}</Text>
              <Text style={[cell, { width: ui.compact ? 58 : 72 }]}>{formatTime(typeof event.ts === "string" ? event.ts : null, now)}</Text>
              <Text style={[cell, { width: 82, color: c.foreground }]}>{kind}</Text>
              <Text
                style={[
                  cell,
                  { flex: 1, flexShrink: 1, minWidth: 0 },
                  level === "error" ? { color: ui.tone("danger") } : level === "warn" ? { color: ui.tone("warning") } : null,
                ]}
                numberOfLines={3}
                selectable
              >
                {rest(event)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
