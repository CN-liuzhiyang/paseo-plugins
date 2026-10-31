import * as pluginClient from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { affairTarget, openPluginScreenOf, urlHost, type Affair, type AffairTarget } from "../shared/affair";
import { useUi } from "./ui";

// "属于：<label>": what a run is for, as whoever started it said. The words come from the run's
// file and are drawn as plain text; where they lead is decided by shared/affair.ts (a screen of
// another plugin, an outside address, or nowhere).

type OpenExternalUrl = (url: string) => Promise<void>;

/** The host's own way to open an outside address (the desktop app's browser opener); older hosts have none. */
function hostOpenExternalUrl(): OpenExternalUrl | null {
  const open = (pluginClient as { openExternalUrl?: unknown }).openExternalUrl;
  return typeof open === "function" ? (open as OpenExternalUrl) : null;
}

/**
 * Follows a target. A screen is opened by the host. A route is the fallback for hosts that cannot:
 * on the web and desktop app it is a path of this app and going to it loads the page again. An
 * outside address goes through the host's opener, which sends it to the system browser; `Linking`
 * is only for a host without one (on the web it would open a window of the app itself).
 */
export function follow(target: AffairTarget, openScreen: ReturnType<typeof openPluginScreenOf>): void {
  if (target.kind === "screen") {
    // A screen the host cannot open is toasted by the host, which then throws as well.
    try {
      openScreen?.({ pluginId: target.link.plugin, screenId: target.link.screen, params: target.link.params });
    } catch {}
  } else if (target.kind === "route") {
    // The UI's tsconfig has no DOM library; on the web the global has a location.
    const location = (globalThis as { location?: { assign(url: string): void } }).location;
    if (Platform.OS === "web") location?.assign(target.route);
  } else if (target.kind === "url") {
    const open = hostOpenExternalUrl();
    void (open ? open(target.url) : Linking.openURL(target.url)).catch(() => {});
  }
}

export function AffairLine({ affair }: { affair: Affair }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const openScreen = openPluginScreenOf(ui.navigation);
  const target = affairTarget(affair, { hostId: ui.hostId, routes: ui.routes, hostOpensScreens: openScreen !== null });
  const where = target.kind === "url" ? urlHost(target.url) : null;
  const hint = target.kind === "route" ? "会重新载入页面" : target.kind === "url" ? "在浏览器里打开" : null;
  const label = (
    <Text style={[ui.styles.text, { flexShrink: 1, fontWeight: "600" }, target.kind === "none" ? null : { color: c.accent }]} numberOfLines={ui.compact ? 2 : 1} selectable={target.kind === "none"}>
      {affair.label}
    </Text>
  );
  return (
    <View style={[ui.styles.row, { gap: 6, alignItems: "center" }]}>
      <Text style={ui.styles.muted}>属于：</Text>
      {target.kind === "none" ? (
        label
      ) : (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`属于：${affair.label}`}
          accessibilityHint={hint ?? "打开"}
          onPress={() => follow(target, openScreen)}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}
        >
          {label}
          <Icon name={target.kind === "url" ? "ExternalLink" : "ArrowUpRight"} size={13} color={c.accent} />
        </Pressable>
      )}
      {/* The label is whatever the caller wrote; where it goes is not. */}
      {where ? <Text style={ui.styles.small}>{where}</Text> : null}
      {target.kind === "route" ? <Text style={ui.styles.small}>（会重新载入页面）</Text> : null}
    </View>
  );
}

/** The affair as a small tag on a list row: just the words, the row itself is what opens. */
export function AffairTag({ label }: { label: string }) {
  const ui = useUi();
  return (
    <View
      style={{
        flexShrink: 1,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
        backgroundColor: ui.theme.colors.surface2,
      }}
    >
      <Text style={[ui.styles.small, { color: ui.theme.colors.foregroundMuted }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
