import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { foldList, foldText } from "./fold";
import { Badge, Block, CopyButton, useUi } from "./ui";

// Structured output, drawn after the schema that shaped it: fields in schema order, labelled by
// field name, with the schema's description as the hint underneath. Fields the schema does not
// name still show, after the named ones. Without a schema the value's own shape is used.
// Long texts and long lists start folded (client/fold.ts), so one big field does not push the
// rest of the drawer out of sight.

function Toggle({ open, label, onPress }: { open: boolean; label: string; onPress(): void }) {
  const ui = useUi();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" }}
    >
      <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={ui.theme.colors.foregroundMuted} />
      <Text style={[ui.styles.small, { color: ui.theme.colors.foreground }]}>{label}</Text>
    </Pressable>
  );
}

/** One line of prose stays text; several lines (a diff, code, a report) read better monospaced. */
function LongText({ text }: { text: string }) {
  const ui = useUi();
  const fold = foldText(text);
  const [open, setOpen] = useState(false);
  const shown = fold.folded && !open ? fold.preview : text;
  const body =
    fold.lines > 1 ? (
      <Block text={shown} />
    ) : (
      <Text style={ui.styles.text} selectable>
        {shown}
      </Text>
    );
  if (!fold.folded) return body;
  return (
    <View style={{ gap: 4 }}>
      {body}
      <View style={[ui.styles.row, { gap: 10 }]}>
        <Toggle
          open={open}
          label={open ? "收起" : `展开全部 · 共 ${fold.lines > 1 ? `${fold.lines} 行 / ` : ""}${fold.chars} 字`}
          onPress={() => setOpen((value) => !value)}
        />
        <CopyButton text={text} label="复制全文" />
      </View>
    </View>
  );
}

function LongList({ length, gap, children }: { length: number; gap: number; children(shown: number): ReactNode }) {
  const fold = foldList(length);
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap }}>
      {children(fold.folded && !open ? fold.shown : length)}
      {fold.folded ? (
        <Toggle open={open} label={open ? "收起" : `展开其余 ${length - fold.shown} 项（共 ${length} 项）`} onPress={() => setOpen((value) => !value)} />
      ) : null}
    </View>
  );
}

type Schema = {
  type?: unknown;
  properties?: Record<string, Schema>;
  required?: unknown;
  items?: Schema;
  enum?: unknown;
  description?: unknown;
};

const MAX_DEPTH = 6;

function asSchema(value: unknown): Schema | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Schema) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function Value({ value, schema, depth = 0 }: { value: unknown; schema?: unknown; depth?: number }) {
  const ui = useUi();
  const shape = asSchema(schema);
  if (value === null || value === undefined) return <Text style={ui.styles.muted}>—</Text>;
  if (depth > MAX_DEPTH) return <Block text={JSON.stringify(value, null, 2)} />;
  if (typeof value === "string") {
    if (Array.isArray(shape?.enum)) return <Badge tone="neutral" label={value} />;
    return <LongText text={value} />;
  }
  if (typeof value === "boolean") return <Text style={ui.styles.text}>{value ? "是" : "否"}</Text>;
  if (typeof value === "number") return <Text style={ui.styles.text}>{String(value)}</Text>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <Text style={ui.styles.muted}>（空）</Text>;
    const items = asSchema(shape?.items);
    if (value.every((item) => typeof item !== "object" || item === null)) {
      return (
        <LongList length={value.length} gap={2}>
          {(shown) =>
            value.slice(0, shown).map((item, index) => (
              <View key={index} style={{ flexDirection: "row", gap: 6 }}>
                <Text style={ui.styles.muted}>•</Text>
                <View style={{ flex: 1 }}>
                  <Value value={item} schema={items} depth={depth + 1} />
                </View>
              </View>
            ))
          }
        </LongList>
      );
    }
    return (
      <LongList length={value.length} gap={6}>
        {(shown) =>
          value.slice(0, shown).map((item, index) => (
            <View
              key={index}
              style={{ borderLeftWidth: 2, borderLeftColor: ui.theme.colors.border, paddingLeft: 10, gap: 4 }}
            >
              <Text style={ui.styles.small}>#{index + 1}</Text>
              <Value value={item} schema={items} depth={depth + 1} />
            </View>
          ))
        }
      </LongList>
    );
  }
  if (isPlainObject(value)) return <Fields value={value} schema={shape} depth={depth} />;
  return <Block text={JSON.stringify(value, null, 2)} />;
}

function Fields({ value, schema, depth }: { value: Record<string, unknown>; schema: Schema | null; depth: number }) {
  const ui = useUi();
  const properties = asSchema(schema?.properties) ? (schema!.properties as Record<string, Schema>) : {};
  const required = Array.isArray(schema?.required) ? (schema!.required as unknown[]) : [];
  const named = Object.keys(properties);
  const keys = [...named, ...Object.keys(value).filter((key) => !named.includes(key))];
  const rows = keys.filter((key) => key in value || required.includes(key));
  if (rows.length === 0) return <Text style={ui.styles.muted}>（空对象）</Text>;
  return (
    <View style={{ gap: 10 }}>
      {rows.map((key) => {
        const field = asSchema(properties[key]);
        const description = typeof field?.description === "string" ? field.description : null;
        const missing = !(key in value);
        return (
          <View key={key} style={{ gap: 3 }}>
            <View style={ui.styles.row}>
              <Text style={[ui.styles.mono, { fontWeight: "600" }]}>{key}</Text>
              {description ? <Text style={ui.styles.small}>{description}</Text> : null}
              {!field && named.length > 0 ? <Text style={ui.styles.small}>（schema 里没有这个字段）</Text> : null}
            </View>
            {missing ? (
              <Text style={{ color: ui.tone("warning"), fontSize: 13 }}>缺少（schema 要求有）</Text>
            ) : (
              <View style={{ paddingLeft: depth > 0 ? 8 : 0 }}>
                <Value value={value[key]} schema={field} depth={depth + 1} />
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

export function Json({ value }: { value: unknown }) {
  return <Block text={JSON.stringify(value, null, 2) ?? "undefined"} />;
}
