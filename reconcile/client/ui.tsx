import * as pluginClient from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Linking, Platform, Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { go, jumpOf } from "./jump";

// The few building blocks the screen needs, trimmed from orchestration-ui/client/ui.tsx. Every
// color comes from the host theme.

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

type Theme = PluginSurfaceProps["theme"];
type Navigation = PluginSurfaceProps["navigation"];

export interface Ui {
  theme: Theme;
  compact: boolean;
  navigation: Navigation;
  /** The host this screen is on, and whether it has URLs to go to (the web and desktop app). */
  hostId: string | null;
  routes: boolean;
  styles: ReturnType<typeof makeStyles>;
  tone(tone: Tone): string;
}

const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("useUi outside UiProvider");
  return ui;
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
      gap: 6,
    } satisfies ViewStyle,
    row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" } satisfies ViewStyle,
    title: { color: c.foreground, fontSize: compact ? 20 : 24, fontWeight: "600" } satisfies TextStyle,
    heading: { color: c.foreground, fontSize: 16, fontWeight: "600" } satisfies TextStyle,
    text: { color: c.foreground, fontSize: 14, lineHeight: 20 } satisfies TextStyle,
    strong: { color: c.foreground, fontSize: 14, fontWeight: "600" } satisfies TextStyle,
    muted: { color: c.foregroundMuted, fontSize: 13, lineHeight: 18 } satisfies TextStyle,
    small: { color: c.foregroundMuted, fontSize: 12, lineHeight: 16 } satisfies TextStyle,
    mono: { color: c.foreground, fontSize: 12, lineHeight: 17, fontFamily: MONO } satisfies TextStyle,
    code: { backgroundColor: c.surface2, borderRadius: 6, padding: 10 } satisfies ViewStyle,
  };
}

export function UiProvider({ props, children }: { props: Pick<PluginSurfaceProps, "theme" | "layout"> & { navigation?: Navigation; host?: { id: string } }; children: ReactNode }) {
  const { theme, layout, navigation } = props;
  const hostId = props.host?.id ?? null;
  const routes = layout.platform === "web";
  const ui = useMemo<Ui>(() => {
    const c = theme.colors;
    const tones: Record<Tone, string> = {
      neutral: c.foregroundMuted,
      accent: c.accent,
      success: c.statusSuccess,
      warning: c.statusWarning,
      danger: c.statusDanger,
    };
    return { theme, compact: layout.compact, navigation, hostId, routes, styles: makeStyles(theme, layout.compact), tone: (tone) => tones[tone] };
  }, [theme, layout.compact, navigation, hostId, routes]);
  return <UiContext.Provider value={ui}>{children}</UiContext.Provider>;
}

export function Badge({ tone, label }: { tone: Tone; label: string }) {
  const ui = useUi();
  const color = ui.tone(tone);
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1, borderColor: color, alignSelf: "flex-start" }}>
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Banner({ tone, icon, title, children }: { tone: Tone; icon: string; title: string; children?: ReactNode }) {
  const ui = useUi();
  const color = ui.tone(tone);
  return (
    <View style={{ borderLeftWidth: 4, borderLeftColor: color, backgroundColor: ui.theme.colors.surface1, borderRadius: 8, padding: ui.compact ? 10 : 14, gap: 6 }}>
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

export function Fold({ label, initiallyOpen = false, children }: { label: string; initiallyOpen?: boolean; children: ReactNode }) {
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
      </Pressable>
      {open ? children : null}
    </View>
  );
}

export function Button({ icon, label, onPress, primary = false, disabled = false }: { icon?: string; label: string; onPress(): void; primary?: boolean; disabled?: boolean }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const fg = primary ? c.surface0 : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? c.foreground : c.border,
        backgroundColor: primary ? c.foreground : c.surface1,
        alignSelf: "flex-start",
        opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** Opens an agent in Paseo, or says why it cannot. */
export function OpenAgent({ agentId, label, primary = false }: { agentId: string; label: string; primary?: boolean }) {
  const ui = useUi();
  const open = ui.navigation?.openAgent;
  if (!open) return <Text style={ui.styles.small}>这个版本的 Paseo 不支持从插件打开 agent。</Text>;
  return <Button icon="MessageSquare" label={label} primary={primary} onPress={() => open({ agentId })} />;
}

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

// ---- going to a screen of another plugin, and to an outside address ----------------------------

export { openPluginScreenOf, pluginScreenRoute, type OpenPluginScreen } from "./jump";

/**
 * A button that opens another plugin's screen: by the host's own way when it has one, else (web and
 * desktop) by the route, which loads the page again, and says so beside it; else only says it cannot.
 */
export function ScreenLink({ plugin, screen, params = {}, label, primary = false }: { plugin: string; screen: string; params?: Record<string, string>; label: string; primary?: boolean }) {
  const ui = useUi();
  const jump = jumpOf({ navigation: ui.navigation, hostId: ui.hostId, routes: ui.routes, plugin, screen, params });
  if (jump.how === "none") return <Text style={ui.styles.small}>{label}：这个版本的 Paseo 不能从这里跳过去。</Text>;
  return (
    <View style={ui.styles.row}>
      {/* The UI's tsconfig has no DOM library; on the web the global has a location. */}
      <Button icon="ArrowUpRight" label={label} primary={primary} onPress={() => go(jump, { plugin, screen, params }, (url) => (globalThis as { location?: { assign(url: string): void } }).location?.assign(url))} />
      {jump.how === "route" ? <Text style={ui.styles.small}>（会重新载入页面）</Text> : null}
    </View>
  );
}

/** Opens an outside address by the host's own opener (the desktop app's browser), else `Linking`. */
export function openExternal(url: string): void {
  const open = (pluginClient as { openExternalUrl?: unknown }).openExternalUrl;
  void (typeof open === "function" ? (open as (u: string) => Promise<void>)(url) : Linking.openURL(url)).catch(() => {});
}

/** A colour with an alpha, for a tint behind text: `#rrggbb` and `#rgb` are understood, anything else is returned as it is. */
export function tint(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const hex = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
