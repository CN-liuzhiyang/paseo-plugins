// Roles: who a call runs as. One Markdown file per role, in roles/.
//
//   roles/planner.md
//   ---
//   provider: claude/claude-opus-5-5
//   thinking: xhigh
//   description: Root-cause analysis, design, planning.
//   ---
//   Optional standing instructions for this role.
//
// The shape borrows Claude Code's agent files because a role's instructions
// are prose and one file per role reads and diffs well. The semantics differ
// in one place that matters: the body is prepended to every prompt the role
// runs, because `paseo run` has no system-prompt flag. That is also the point
// -- instructions written once reach every provider. A project that targets
// two harnesses otherwise keeps each reviewer twice (.claude/agents/*.md and
// .codex/agents/*.toml), because each harness reads only its own format.
//
// Parsing is strict on purpose: a flat `key: value` subset of YAML, known keys
// only. A misspelled key that is silently ignored is a role that silently runs
// on default settings.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";

export const ROLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "roles");

/** The role a call runs as when it names neither a role nor a provider. */
export const DEFAULT_ROLE = "worker";

const NAME = /^[a-z][a-z0-9-]*$/;

const FIELDS = {
  provider: {
    required: true,
    // A bare family ("claude") runs whatever Paseo's default model is that
    // day, which is the churn roles exist to pin down.
    valid: (v) => /^[a-z][a-z0-9-]*\/[^\s"']+$/.test(v) || "must be <family>/<model>, e.g. claude/claude-opus-5-5",
  },
  description: { required: true, valid: () => true },
  // Thinking ids are per model, so only smoke.mjs can check the value itself.
  thinking: { required: false, valid: (v) => /^[a-z]+$/.test(v) || "must be a single thinking id, e.g. high" },
};

/**
 * Parse one role file. Throws with the file and line on anything it does not
 * understand rather than guessing.
 *
 * @returns {{ provider: string, description: string, thinking: string | null, instructions: string }}
 */
export function parseRole(name, source, where = `roles/${name}.md`) {
  if (!NAME.test(name)) throw new Error(`${where}: the file name is the role name and must match ${NAME}`);

  // Compared by code rather than written as an escape: a literal BOM in this
  // file would vanish under the first editor that strips BOMs, silently.
  const unmarked = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const text = unmarked.replace(/\r\n/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(text);
  if (!match) throw new Error(`${where}: must open with a frontmatter block between two --- lines`);
  const [, head, body = ""] = match;

  const fields = {};
  head.split("\n").forEach((line, i) => {
    const at = `${where}:${i + 2}`;
    if (!line.trim() || line.startsWith("#")) return;
    const pair = /^([a-z][a-z-]*):[ \t]*(.*)$/.exec(line);
    if (!pair) throw new Error(`${at}: expected \`key: value\` (no nesting, no lists): ${line}`);
    const [, key, raw] = pair;
    if (!Object.hasOwn(FIELDS, key)) {
      throw new Error(`${at}: unknown key "${key}"; known keys: ${Object.keys(FIELDS).join(", ")}`);
    }
    if (Object.hasOwn(fields, key)) throw new Error(`${at}: "${key}" appears twice`);
    const value = unquote(raw.trim(), at);
    if (!value) throw new Error(`${at}: "${key}" is empty`);
    const verdict = FIELDS[key].valid(value);
    if (verdict !== true) throw new Error(`${at}: "${key}" ${verdict}`);
    fields[key] = value;
  });

  for (const [key, spec] of Object.entries(FIELDS)) {
    if (spec.required && !Object.hasOwn(fields, key)) throw new Error(`${where}: missing required key "${key}"`);
  }

  return {
    provider: fields.provider,
    description: fields.description,
    thinking: fields.thinking ?? null,
    instructions: body.trim(),
  };
}

/** A value that opens a quote must close it; half a quote is a typo, not text. */
function unquote(value, at) {
  const q = value[0];
  if (q !== '"' && q !== "'") return value;
  if (value.length < 2 || value.at(-1) !== q) throw new Error(`${at}: opens a ${q} quote and does not close it`);
  return value.slice(1, -1);
}

/** The shipped roles, then any private directories named in config.json. */
export function rolesDirs() {
  return [ROLES_DIR, ...(loadConfig().rolesDirs ?? [])];
}

/**
 * Load every role from one or more directories. A name defined twice is an
 * error, not an override: which file wins would otherwise depend on the order
 * of a list in a config file nobody is looking at.
 *
 * @param {string | string[]} [dirs]
 * @returns {Promise<{ defaultRole: string, roles: Record<string, ReturnType<typeof parseRole>> }>}
 */
export async function loadRoster(dirs = rolesDirs()) {
  const roles = {};
  const origin = {};
  for (const dir of [dirs].flat()) {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".md")).sort();
    for (const file of files) {
      const name = file.slice(0, -".md".length);
      const where = path.join(dir, file);
      if (Object.hasOwn(roles, name)) throw new Error(`${where}: role "${name}" is already defined in ${origin[name]}`);
      roles[name] = parseRole(name, await readFile(where, "utf8"), where);
      origin[name] = where;
    }
  }
  if (!roles[DEFAULT_ROLE]) {
    throw new Error(`${[dirs].flat().join(", ")}: no ${DEFAULT_ROLE}.md, and calls that name neither a role nor a provider run as it`);
  }
  return { defaultRole: DEFAULT_ROLE, roles };
}
