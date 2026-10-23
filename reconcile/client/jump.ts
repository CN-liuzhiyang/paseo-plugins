// Going to a screen of another plugin (the flow's run view), kept free of react so that its three
// cases can be tested: the host opens it itself; the host cannot but the app is on the web, where the
// page's route is known; or nothing can be done from here and the screen only says so.

/**
 * The host's way to open a screen of any plugin: `navigation.openPluginScreen(pluginId, screenId,
 * params?)`, positional, which throws (and the host shows a toast) when it cannot. Hosts that predate
 * it do not offer it, so it is looked up, not assumed.
 */
export type OpenPluginScreen = (pluginId: string, screenId: string, params?: Record<string, string>) => void;

export function openPluginScreenOf(navigation: unknown): OpenPluginScreen | null {
  const owner = navigation as { openPluginScreen?: unknown } | null | undefined;
  const open = owner?.openPluginScreen;
  return typeof open === "function" ? (pluginId, screenId, params) => (open as OpenPluginScreen).call(owner, pluginId, screenId, params) : null;
}

/** The route of a plugin's screen as the Paseo app builds it: host, plugin, surface, then the params behind `param.`. */
export function pluginScreenRoute(hostId: string, plugin: string, screen: string, params: Record<string, string>): string {
  const path = `/h/${encodeURIComponent(hostId)}/plugin/${encodeURIComponent(plugin)}/surface/${encodeURIComponent(screen)}`;
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(`param.${key}`)}=${encodeURIComponent(value)}`)
    .join("&");
  return query ? `${path}?${query}` : path;
}

export type Jump = { how: "host"; open: OpenPluginScreen } | { how: "route"; route: string } | { how: "none" };

/** How to get to the screen from here: the host's own way first, else the route (only on the web), else not at all. */
export function jumpOf(input: { navigation: unknown; hostId: string | null | undefined; routes: boolean; plugin: string; screen: string; params?: Record<string, string> }): Jump {
  const open = openPluginScreenOf(input.navigation);
  if (open) return { how: "host", open };
  if (input.hostId && input.routes) return { how: "route", route: pluginScreenRoute(input.hostId, input.plugin, input.screen, input.params ?? {}) };
  return { how: "none" };
}

/**
 * Goes. The host's way may throw -- it also tells the person why with a toast, so nothing more is
 * shown here. The route way loads the page again, which the screen says beside the button.
 */
export function go(jump: Jump, target: { plugin: string; screen: string; params?: Record<string, string> }, assign: (url: string) => void): void {
  if (jump.how === "host") {
    try {
      jump.open(target.plugin, target.screen, target.params ?? {});
    } catch {
      // The host tells the person why it could not.
    }
  } else if (jump.how === "route") {
    assign(jump.route);
  }
}
