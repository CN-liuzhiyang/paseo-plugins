import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UsageScope } from "@getpaseo/plugin/server/usage";
import type { Settings } from "../shared/settings";
export type Locator = { dir: string; provider: string };
export type Discovered = { id: string; origin: string; providers: string[]; locators: Locator[] };
type Json = Record<string, unknown>;
export async function readObject(file: string): Promise<Json> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return record(value);
  } catch {
    return {};
  }
}
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
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
export const identity = (origin: string, key: string) =>
  createHash("sha256")
    .update(JSON.stringify([origin, key]))
    .digest("hex");
function directory(settings: Settings, scope: UsageScope): string {
  const env = scope.kind === "session" ? scope.env : process.env;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const value =
    env.PI_CODING_AGENT_DIR ||
    (scope.kind === "global" ? settings.piConfigDir : "") ||
    path.join(home, ".pi", "agent");
  return value === "~"
    ? home
    : /^~[\\/]/.test(value)
      ? path.join(home, value.slice(2))
      : path.resolve(value);
}
export async function discover(settings: Settings, scope: UsageScope): Promise<Discovered[]> {
  if (!settings.allowedOrigins.length && !settings.providerNames.length) return [];
  if (scope.kind === "session" && scope.provider !== "pi") return [];
  const dir = directory(settings, scope);
  const [models, auth] = await Promise.all([
    readObject(path.join(dir, "models.json")),
    readObject(path.join(dir, "auth.json")),
  ]);
  const allowed = new Set(settings.allowedOrigins.map(originOf).filter(Boolean));
  const grouped = new Map<string, Discovered>();
  const modelProvider = scope.kind === "session" ? scope.model?.split("/")[0] : undefined;
  if (scope.kind === "session" && !modelProvider) return [];
  for (const [provider, config] of Object.entries(record(models.providers))) {
    if (modelProvider && provider !== modelProvider) continue;
    const origin = originOf(record(config).baseUrl);
    if (!origin || (!allowed.has(origin) && !settings.providerNames.includes(provider))) continue;
    const credential = record(auth[provider]);
    if (
      credential.type !== "api_key" ||
      typeof credential.key !== "string" ||
      !credential.key.trim()
    )
      continue;
    const id = identity(origin, credential.key);
    const entry = grouped.get(id) ?? { id, origin, providers: [], locators: [] };
    entry.providers.push(provider.split(credential.key).join("[redacted]").slice(0, 120));
    entry.locators.push({ dir, provider });
    grouped.set(id, entry);
  }
  return [...grouped.values()];
}
export async function readCredential(
  entry: Discovered,
  settings: Settings,
): Promise<string | null> {
  // Re-discover locators so config removal and allowlist changes apply before HTTP.
  for (const locator of entry.locators) {
    const entries = await discover(settings, {
      kind: "session",
      provider: "pi",
      model: `${locator.provider}/unused`,
      env: { PI_CODING_AGENT_DIR: locator.dir },
    });
    if (!entries.some((current) => current.id === entry.id)) continue;
    const auth = await readObject(path.join(locator.dir, "auth.json"));
    const credential = record(auth[locator.provider]);
    if (typeof credential.key === "string" && identity(entry.origin, credential.key) === entry.id)
      return credential.key;
  }
  return null;
}
