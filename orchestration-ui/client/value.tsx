import { Text, View } from "react-native";
import { Badge, Block, useUi } from "./ui";

// Structured output, drawn after the schema that shaped it: fields in schema order, labelled by
// field name, with the schema's description as the hint underneath. Fields the schema does not
// name still show, after the named ones. Without a schema the value's own shape is used.

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
    return (
      <Text style={ui.styles.text} selectable>
        {value}
      </Text>
    );
  }
  if (typeof value === "boolean") return <Text style={ui.styles.text}>{value ? "是" : "否"}</Text>;
  if (typeof value === "number") return <Text style={ui.styles.text}>{String(value)}</Text>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <Text style={ui.styles.muted}>（空）</Text>;
    const items = asSchema(shape?.items);
    if (value.every((item) => typeof item !== "object" || item === null)) {
      return (
        <View style={{ gap: 2 }}>
          {value.map((item, index) => (
            <View key={index} style={{ flexDirection: "row", gap: 6 }}>
              <Text style={ui.styles.muted}>•</Text>
              <View style={{ flex: 1 }}>
                <Value value={item} schema={items} depth={depth + 1} />
              </View>
            </View>
          ))}
        </View>
      );
    }
    return (
      <View style={{ gap: 6 }}>
        {value.map((item, index) => (
          <View
            key={index}
            style={{ borderLeftWidth: 2, borderLeftColor: ui.theme.colors.border, paddingLeft: 10, gap: 4 }}
          >
            <Text style={ui.styles.small}>#{index + 1}</Text>
            <Value value={item} schema={items} depth={depth + 1} />
          </View>
        ))}
      </View>
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
