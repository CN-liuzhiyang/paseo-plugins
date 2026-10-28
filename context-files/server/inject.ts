import { isAbsolute } from "node:path";
import type { Settings } from "../shared/settings";

/** Providers that run no model: nothing to read a system prompt, so nothing is injected. */
export const NO_MODEL_PROVIDERS: ReadonlySet<string> = new Set(["orch-gate", "reconcile"]);

export const DISABLE_CLAUDE_MDS = "CLAUDE_CODE_DISABLE_CLAUDE_MDS";

export interface InjectInput {
  provider: string;
  cwd: string;
  /** The system prompt the request already carries (another plugin may have set it). */
  existing: string | undefined;
  /** The environment overrides of the create request. */
  env: Record<string, string> | undefined;
}

export type Reader = (path: string) => Promise<Buffer>;

const startMarker = (path: string) => `<!-- context-files: ${path} -->`;
const endMarker = (path: string) => `<!-- /context-files: ${path} -->`;

const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** "codex/gpt-5.4" and "codex" are the same provider. */
function providerId(provider: string): string {
  return provider.split("/")[0] ?? provider;
}

function isOff(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** Whether this creation request gets the files at all. */
export function wantsFiles(settings: Settings, input: InjectInput): boolean {
  const provider = providerId(input.provider);
  if (NO_MODEL_PROVIDERS.has(provider)) return false;
  if (settings.cwdPrefixes.length > 0) {
    const cwd = normalize(input.cwd);
    const inside = settings.cwdPrefixes.some((prefix) => {
      const p = normalize(prefix);
      return cwd === p || cwd.startsWith(`${p}/`);
    });
    if (!inside) return false;
  }
  if (settings.providers.map(providerId).includes(provider)) return true;
  return provider === "claude" && settings.claudeWhenClaudeMdDisabled && isOff(input.env?.[DISABLE_CLAUDE_MDS]);
}

/** Cut to at most `max` bytes without splitting a UTF-8 character. */
export function cutUtf8(bytes: Buffer, max: number): Buffer {
  if (bytes.length <= max) return bytes;
  let end = max;
  // Back up over continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

/** One file as a marked block, or why it was skipped. */
async function block(path: string, max: number, read: Reader): Promise<{ text: string } | { skipped: string }> {
  if (!isAbsolute(path)) return { skipped: "not an absolute path" };
  let bytes: Buffer;
  try {
    bytes = await read(path);
  } catch (error) {
    return { skipped: `cannot read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const cut = cutUtf8(bytes, max);
  let body = cut.toString("utf8").trim();
  if (cut.length < bytes.length) {
    body += `\n\n[context-files: cut after ${cut.length} of ${bytes.length} bytes]`;
  }
  if (body === "") return { skipped: "empty" };
  return { text: `${startMarker(path)}\n${body}\n${endMarker(path)}` };
}

export interface Injection {
  /** The new system prompt, or undefined when nothing is added. */
  systemPrompt: string | undefined;
  added: string[];
  skipped: { path: string; why: string }[];
}

/** Append the files after what the request already has; never replaces it, never throws. */
export async function inject(settings: Settings, input: InjectInput, read: Reader): Promise<Injection> {
  const added: string[] = [];
  const skipped: { path: string; why: string }[] = [];
  const blocks: string[] = [];
  for (const path of settings.files) {
    if (input.existing?.includes(startMarker(path))) {
      skipped.push({ path, why: "already in the system prompt" });
      continue;
    }
    const result = await block(path, settings.maxFileBytes, read);
    if ("text" in result) {
      blocks.push(result.text);
      added.push(path);
    } else {
      skipped.push({ path, why: result.skipped });
    }
  }
  if (blocks.length === 0) return { systemPrompt: undefined, added, skipped };
  const head = input.existing && input.existing.trim() !== "" ? [input.existing] : [];
  return { systemPrompt: [...head, ...blocks].join("\n\n"), added, skipped };
}
