import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { UsageScope } from "@getpaseo/plugin/server/usage";
import type { Settings } from "../shared/settings";
export type Locator = { kind: "pi" | "claude" | "codex"; dir: string; provider: string };
export type Discovered = { id: string; origin: string; providers: string[]; locators: Locator[] };
type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
export async function readObject(file: string): Promise<Json> {
  try {
    return record(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return {};
  }
}
async function readCodex(dir: string): Promise<Json> {
  try {
    return record(parseToml(await readFile(path.join(dir, "config.toml"), "utf8")));
  } catch {
    return {};
  }
}
export function originOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export function officialOrigin(origin: string): boolean {
  const host = new URL(origin).hostname.toLowerCase().replace(/\.$/, "");
  return ["api.anthropic.com", "api.openai.com"].some(
    (name) => host === name || host.endsWith(`.${name}`),
  );
}
export const identity = (origin: string, key: string) =>
  createHash("sha256")
    .update(JSON.stringify([origin, key]))
    .digest("hex");
function directory(value: string, home: string) {
  return value === "~"
    ? home
    : /^~[\\/]/.test(value)
      ? path.join(home, value.slice(2))
      : path.resolve(value);
}
async function readSource(locator: Locator): Promise<{ origin: string; key: string } | null> {
  let base: unknown;
  let key: unknown;
  if (locator.kind === "pi") {
    const [models, auth] = await Promise.all([
      readObject(path.join(locator.dir, "models.json")),
      readObject(path.join(locator.dir, "auth.json")),
    ]);
    base = record(record(models.providers)[locator.provider]).baseUrl;
    const credential = record(auth[locator.provider]);
    if (credential.type === "api_key") key = credential.key;
  } else if (locator.kind === "claude") {
    const env = record((await readObject(path.join(locator.dir, "settings.json"))).env);
    base = env.ANTHROPIC_BASE_URL;
    key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  } else {
    const config = await readCodex(locator.dir);
    // auth.json's API key belongs to the selected custom provider, never every configured provider.
    if (config.model_provider !== locator.provider) return null;
    const provider = record(record(config.model_providers)[locator.provider]);
    base = provider.base_url;
    const auth = await readObject(path.join(locator.dir, "auth.json"));
    key =
      (typeof provider.env_key === "string" ? auth[provider.env_key] : null) ?? auth.OPENAI_API_KEY;
  }
  const origin = originOf(base);
  return origin && !officialOrigin(origin) && typeof key === "string" && key.trim()
    ? { origin, key }
    : null;
}
function allowed(settings: Settings, provider: string, origin: string) {
  return (
    (!settings.providerNames.length || settings.providerNames.includes(provider)) &&
    (!settings.allowedOrigins.length ||
      settings.allowedOrigins.some((value) => originOf(value) === origin))
  );
}
export async function discover(
  settings: Settings,
  scope: UsageScope,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Promise<Discovered[]> {
  const env = scope.kind === "session" ? scope.env : hostEnv;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const locators: Locator[] = [];
  if (scope.kind === "global" || scope.provider === "pi") {
    const dir = directory(
      env.PI_CODING_AGENT_DIR ||
        (scope.kind === "global" ? settings.piConfigDir : "") ||
        path.join(home, ".pi", "agent"),
      home,
    );
    const models = await readObject(path.join(dir, "models.json"));
    const selected = scope.kind === "session" ? scope.model?.split("/")[0] : undefined;
    for (const provider of Object.keys(record(models.providers))) {
      if (scope.kind === "session" && provider !== selected) continue;
      locators.push({ kind: "pi", dir, provider });
    }
  }
  if (scope.kind === "global" || scope.provider === "claude")
    locators.push({
      kind: "claude",
      dir: directory(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), home),
      provider: "claude",
    });
  if (scope.kind === "global" || scope.provider === "codex") {
    const dir = directory(env.CODEX_HOME || path.join(home, ".codex"), home);
    const config = await readCodex(dir);
    if (typeof config.model_provider === "string")
      locators.push({ kind: "codex", dir, provider: config.model_provider });
  }
  const grouped = new Map<string, Discovered>();
  for (const locator of locators) {
    const source = await readSource(locator);
    if (!source || !allowed(settings, locator.provider, source.origin)) continue;
    const id = identity(source.origin, source.key);
    const entry = grouped.get(id) ?? { id, origin: source.origin, providers: [], locators: [] };
    const name = locator.provider.split(source.key).join("[redacted]").slice(0, 120);
    if (!entry.providers.includes(name)) entry.providers.push(name);
    entry.locators.push(locator);
    grouped.set(id, entry);
  }
  return [...grouped.values()];
}
export async function readCredential(
  entry: Discovered,
  settings: Settings,
): Promise<string | null> {
  // Re-read before any HTTP request so removal, rotation and optional filters apply immediately.
  for (const locator of entry.locators) {
    const source = await readSource(locator);
    if (
      source &&
      allowed(settings, locator.provider, source.origin) &&
      identity(source.origin, source.key) === entry.id
    )
      return source.key;
  }
  return null;
}
