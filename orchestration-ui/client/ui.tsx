import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";

// Small building blocks shared by the list and the detail view. Every color comes from the host
// theme; nothing here knows about runs.

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

type Theme = PluginSurfaceProps["theme"];
type Navigation = PluginSurfaceProps["navigation"];

export interface Ui {
  theme: Theme;
  compact: boolean;
  navigation: Navigation;
  styles: ReturnType<typeof makeStyles>;
  tone(tone: Tone): string;
  /** A tone as a faint wash over the current surface; works on light and dark themes alike. */
  tint(tone: Tone, alpha?: number): string;
}

const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("useUi outside UiProvider");
  return ui;
}

/** "#rgb", "#rrggbb" or "rgb(…)" with an alpha; anything else is returned as is. */
function withAlpha(color: string, alpha: number): string | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join("") : hex[1]!;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color.trim());
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})` : null;
}

export const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, Consolas, Menlo, monospace",
});

function makeStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  const pad = compact ? 12 : 20;
  return {
    pad,
    screen: { flex: 1, backgroundColor: c.surface0 } satisfies ViewStyle,
    content: { padding: pad, gap: compact ? 12 : 16, paddingBottom: pad * 3 } satisfies ViewStyle,
    card: {
      backgroundColor: c.surface1,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: compact ? 10 : 14,
      gap: 8,
    } satisfies ViewStyle,
    row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" } satisfies ViewStyle,
    title: { color: c.foreground, fontSize: compact ? 20 : 24, fontWeight: "600" } satisfies TextStyle,
    heading: { color: c.foreground, fontSize: 16, fontWeight: "600" } satisfies TextStyle,
    text: { color: c.foreground, fontSize: 14, lineHeight: 20 } satisfies TextStyle,
    strong: { color: c.foreground, fontSize: 14, fontWeight: "600" } satisfies TextStyle,
    muted: { color: c.foregroundMuted, fontSize: 13, lineHeight: 18 } satisfies TextStyle,
    small: { color: c.foregroundMuted, fontSize: 12, lineHeight: 16 } satisfies TextStyle,
    mono: { color: c.foreground, fontSize: 12, lineHeight: 17, fontFamily: MONO } satisfies TextStyle,
    code: {
      backgroundColor: c.surface2,
      borderRadius: 6,
      padding: 10,
    } satisfies ViewStyle,
    divider: { height: 1, backgroundColor: c.border } satisfies ViewStyle,
  };
}

export function UiProvider({ props, children }: { props: PluginSurfaceProps; children: ReactNode }) {
  const { theme, layout, navigation } = props;
  const ui = useMemo<Ui>(() => {
    const c = theme.colors;
    const tones: Record<Tone, string> = {
      neutral: c.foregroundMuted,
      accent: c.accent,
      success: c.statusSuccess,
      warning: c.statusWarning,
      danger: c.statusDanger,
    };
    return {
      theme,
      compact: layout.compact,
      navigation,
      styles: makeStyles(theme, layout.compact),
      tone: (tone) => tones[tone],
      tint: (tone, alpha = 0.12) => withAlpha(tones[tone], alpha) ?? c.surface2,
    };
  }, [theme, layout.compact, navigation]);
  return <UiContext.Provider value={ui}>{children}</UiContext.Provider>;
}

/**
 * Carries the context into content the host renders elsewhere: its Modal is not inside the
 * surface's tree, so anything using useUi() there needs the value handed across.
 */
export function ProvideUi({ ui, children }: { ui: Ui; children: ReactNode }) {
  return <UiContext.Provider value={ui}>{children}</UiContext.Provider>;
}

/** A pill with an icon and a word, colored by what it means. */
export function Badge({ tone, icon, label, solid = false }: { tone: Tone; icon?: string; label: string; solid?: boolean }) {
  const ui = useUi();
  const color = ui.tone(tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: solid ? color : "transparent",
        alignSelf: "flex-start",
      }}
    >
      {icon ? <Icon name={icon} size={12} color={solid ? ui.theme.colors.surface0 : color} /> : null}
      <Text style={{ color: solid ? ui.theme.colors.surface0 : color, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

/** A colored band that says one important thing: the outcome, an error, what is going on. */
export function Banner({ tone, icon, title, children }: { tone: Tone; icon: string; title: string; children?: ReactNode }) {
  const ui = useUi();
  const color = ui.tone(tone);
  return (
    <View
      style={{
        borderLeftWidth: 4,
        borderLeftColor: color,
        backgroundColor: ui.theme.colors.surface1,
        borderRadius: 8,
        padding: ui.compact ? 10 : 14,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={icon} size={18} color={color} />
        <Text style={{ color, fontSize: 15, fontWeight: "700", flexShrink: 1 }} selectable>
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

/** Evidence stays folded until asked for. */
export function Fold({
  label,
  hint,
  initiallyOpen = false,
  children,
}: {
  label: string;
  hint?: string;
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const ui = useUi();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "收起" : "展开"}${label}`}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={ui.theme.colors.foregroundMuted} />
        <Text style={ui.styles.muted}>{label}</Text>
        {hint ? <Text style={ui.styles.small}>{hint}</Text> : null}
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/** Label on the left, value on the right; stacks on compact layouts. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  const ui = useUi();
  return (
    <View style={{ flexDirection: ui.compact ? "column" : "row", gap: ui.compact ? 2 : 12, alignItems: "flex-start" }}>
      <Text style={[ui.styles.muted, { width: ui.compact ? undefined : 96 }]}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>{typeof children === "string" ? <Text style={ui.styles.text} selectable>{children}</Text> : children}</View>
    </View>
  );
}

export function LinkButton({ icon, label, onPress }: { icon: string; label: string; onPress(): void }) {
  const ui = useUi();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: ui.theme.colors.surface2,
      }}
    >
      <Icon name={icon} size={12} color={ui.theme.colors.foreground} />
      <Text style={{ color: ui.theme.colors.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

/** A real button: filled for the one thing to do, outlined otherwise. */
export function Button({
  icon,
  label,
  onPress,
  primary = false,
  wide = false,
}: {
  icon?: string;
  label: string;
  onPress(): void;
  primary?: boolean;
  wide?: boolean;
}) {
  const ui = useUi();
  const c = ui.theme.colors;
  const fg = primary ? c.surface0 : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? c.foreground : c.border,
        backgroundColor: primary ? c.foreground : c.surface1,
        alignSelf: wide ? "stretch" : "flex-start",
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** Opens an agent in Paseo; says why not when the run lives on another daemon or the host cannot. */
export function OpenAgent({
  agentId,
  remote,
  label = "在 Paseo 中打开这个 agent",
  primary = false,
  wide = false,
}: {
  agentId: string;
  remote: boolean;
  label?: string;
  primary?: boolean;
  wide?: boolean;
}) {
  const ui = useUi();
  const open = ui.navigation?.openAgent;
  if (remote) return <Text style={ui.styles.small}>这个 agent 在另一台主机上，这里打不开。</Text>;
  if (!open) return <Text style={ui.styles.small}>这个版本的 Paseo 不支持从插件打开 agent。</Text>;
  return <Button icon="ExternalLink" label={label} primary={primary} wide={wide} onPress={() => open({ agentId })} />;
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <LinkButton
      icon="Copy"
      label={label}
      onPress={() => {
        copyText(text).then(
          () => toast.show("已复制", { variant: "success" }),
          () => toast.error("复制不了：选中文字手动复制"),
        );
      }}
    />
  );
}

/**
 * An agent id: opens it in Paseo where the host can, and can always be copied. A run started
 * with --host lives on another daemon, which this host cannot open.
 */
export function AgentRef({ agentId, remote }: { agentId: string; remote: boolean }) {
  const ui = useUi();
  const open = ui.navigation?.openAgent;
  return (
    <View style={ui.styles.row}>
      <Text style={ui.styles.mono} selectable>
        {agentId}
      </Text>
      {open && !remote ? <LinkButton icon="ExternalLink" label="在 Paseo 中打开" onPress={() => open({ agentId })} /> : null}
      <CopyButton text={agentId} />
      {remote ? <Text style={ui.styles.small}>（在另一台主机上，这里打不开）</Text> : null}
    </View>
  );
}

/** Long text in a code-ish box, selectable, never truncated. */
export function Block({ text }: { text: string }) {
  const ui = useUi();
  return (
    <View style={ui.styles.code}>
      <Text style={ui.styles.mono} selectable>
        {text}
      </Text>
    </View>
  );
}

export function Section({ title, trailing, children }: { title: string; trailing?: ReactNode; children: ReactNode }) {
  const ui = useUi();
  return (
    <View style={{ gap: 8 }}>
      <View style={[ui.styles.row, { justifyContent: "space-between" }]}>
        <Text style={ui.styles.heading}>{title}</Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}
