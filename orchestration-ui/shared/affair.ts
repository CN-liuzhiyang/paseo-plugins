// The affair a run belongs to: run.start.affair (orchestration/EVENTS.md). Whoever started the run
// says what it is for -- a label, and where to go back to it -- and this plugin draws exactly that;
// it knows no other plugin and no kind of affair.
//
// The event file is data on a disk, so what is read from it is untrusted text that is about to be
// drawn: the label is cut and cleaned, the url must be a plain http(s) address, the link must have
// plain names. The runtime refuses a malformed affair before the run starts; a reader does not
// rely on that, and drops what does not fit instead of refusing the whole run.

export interface AffairLink {
  plugin: string;
  screen: string;
  params: Record<string, string>;
}

export interface Affair {
  label: string;
  url: string | null;
  link: AffairLink | null;
}

/**
 * Where pressing the affair goes. `none`: only the words.
 * - `screen`: the host opens the plugin's screen itself (`navigation.openPluginScreen`).
 * - `route`: the screen's path in this app, followed as an address: the page loads again.
 * - `url`: an outside address.
 */
export type AffairTarget =
  | { kind: "screen"; link: AffairLink }
  | { kind: "route"; route: string }
  | { kind: "url"; url: string }
  | { kind: "none" };

export const LABEL_LIMIT = 120;
const URL_LIMIT = 2048;
const PARAMS_LIMIT = 16;
const PARAM_VALUE_LIMIT = 256;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// What may not be drawn in a label, a param value or a url. Built from code points rather than
// written out, because most of these are invisible characters and a literal one in a source file is
// lost the first time an editor strips it. The list is orchestration/fixtures/affair-cases.json,
// which runtime/affair.mjs and this file are both tested against.
//   controls, line and paragraph separators (\p{Cc} \p{Zl} \p{Zp});
//   direction: 061C, 200E, 200F, 202A-202E, 2066-2069;
//   nothing drawn: 200B, 2060, FEFF, 00AD, 034F, 180E, 2800, the Hangul fillers 115F 1160 3164 FFA0;
//   the tag block E0000-E007F.
// The joiners 200C, 200D and the emoji selector FE0F are ordinary text and stay.
const HIDDEN_RANGES: Array<[number, number]> = [
  [0x061c, 0x061c], [0x200b, 0x200b], [0x200e, 0x200f], [0x2060, 0x2060], [0x202a, 0x202e], [0x2066, 0x2069],
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x180e, 0x180e], [0x2800, 0x2800], [0x115f, 0x115f], [0x1160, 0x1160],
  [0x3164, 0x3164], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xe0000, 0xe007f],
];
const BACKSLASH = String.fromCharCode(92);
const codePoint = (n: number) => `${BACKSLASH}u{${n.toString(16)}}`;
const HIDDEN = HIDDEN_RANGES.map(([a, b]) => (a === b ? codePoint(a) : `${codePoint(a)}-${codePoint(b)}`)).join("");
const UNSAFE = new RegExp(`[${BACKSLASH}p{Cc}${BACKSLASH}p{Zl}${BACKSLASH}p{Zp}${HIDDEN}]`, "gu");
const UNSAFE_IN_URL = new RegExp(`[${BACKSLASH}p{Cc}${BACKSLASH}p{Zs}${BACKSLASH}p{Zl}${BACKSLASH}p{Zp}${HIDDEN}]`, "u");

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(UNSAFE, " ").replace(/ {2,}/g, " ").trim();
  if (text === "") return null;
  const chars = [...text];
  return chars.length > LABEL_LIMIT ? `${chars.slice(0, LABEL_LIMIT - 1).join("")}…` : text;
}

function webUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "" || raw.length > URL_LIMIT || UNSAFE_IN_URL.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    return raw;
  } catch {
    return null;
  }
}

function linkOf(raw: unknown): AffairLink | null {
  if (!isObject(raw)) return null;
  const { plugin, screen, params } = raw;
  if (typeof plugin !== "string" || !NAME.test(plugin) || typeof screen !== "string" || !NAME.test(screen)) return null;
  const kept: Record<string, string> = {};
  if (isObject(params)) {
    for (const [key, value] of Object.entries(params).slice(0, PARAMS_LIMIT)) {
      if (!NAME.test(key) || typeof value !== "string" || [...value].length > PARAM_VALUE_LIMIT) continue;
      kept[key] = value.replace(UNSAFE, " ");
    }
  }
  return { plugin, screen, params: kept };
}

/** The affair in a run.start, or null when there is none or it has no usable label. */
export function affairOf(raw: unknown): Affair | null {
  if (!isObject(raw)) return null;
  const label = cleanLabel(raw.label);
  if (label === null) return null;
  return { label, url: webUrl(raw.url), link: linkOf(raw.link) };
}

/**
 * The route of a plugin's screen, as the Paseo app builds it (packages/app/src/plugins/routes.ts,
 * buildPluginSurfaceRoute): the host, the plugin, a `surface` and its id, then the screen's params
 * in the query, each key behind `param.` so it cannot meet the route's own segments.
 */
export function pluginScreenRoute(hostId: string, link: AffairLink): string {
  const path = `/h/${encodeURIComponent(hostId)}/plugin/${encodeURIComponent(link.plugin)}/surface/${encodeURIComponent(link.screen)}`;
  const query = Object.entries(link.params)
    .map(([key, value]) => `${encodeURIComponent(`param.${key}`)}=${encodeURIComponent(value)}`)
    .join("&");
  return query ? `${path}?${query}` : path;
}

/**
 * What pressing the affair does. A link wins over a url: it stays inside Paseo. The best way to
 * follow it is the host's own (`hostOpensScreens`: it can open a screen of any plugin, on any
 * client including the phone); without that a link is a route, which only a client with URLs
 * (`routes`: the web and desktop app) can follow, and needs the host's id. When neither holds a
 * url, if there is one, takes its place.
 */
export function affairTarget(
  affair: Affair,
  { hostId, routes, hostOpensScreens = false }: { hostId: string | null; routes: boolean; hostOpensScreens?: boolean },
): AffairTarget {
  if (affair.link && hostOpensScreens) return { kind: "screen", link: affair.link };
  if (affair.link && hostId && routes) return { kind: "route", route: pluginScreenRoute(hostId, affair.link) };
  if (affair.url) return { kind: "url", url: affair.url };
  return { kind: "none" };
}

/** The host name of a url, for showing where it goes next to a label that could say anything. */
export function urlHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export type OpenPluginScreen = (input: { pluginId: string; screenId: string; params?: Record<string, string> }) => void;

/**
 * The host's way to open a screen of any plugin, when it has one: `navigation.openPluginScreen`,
 * which hosts that predate it do not offer. Looked up rather than assumed, and called as a method
 * of the navigation object it came from.
 */
export function openPluginScreenOf(navigation: unknown): OpenPluginScreen | null {
  const owner = navigation as { openPluginScreen?: unknown } | null | undefined;
  const open = owner?.openPluginScreen;
  return typeof open === "function" ? (input) => (open as OpenPluginScreen).call(owner, input) : null;
}
