import type { Item, Observation } from "../shared/model";

// Which flag keys an item is about. The vocabulary is every key in every flag file (sources of
// kind "flags"); an item names a key when the key appears as a whole identifier in its own text
// or among the identifiers its linked commits brought in. Deterministic and cheap: a set
// intersection per item. Ranking the hits and asking when unsure is the rule's business.
//
// A structured entry's identifier-like string values, alone or in a list (say the name of a version
// check function)
// are aliases of its key. They count only when the item's own commits bring them in, never from
// its text, and are kept apart from direct hits so that a rule can tell inferred from read.

export interface FlagValue {
  /** The flag file's item key. */
  file: string;
  labels: Record<string, string>;
  present: boolean;
  section: string | null;
  /** The value as published: a number, a string, or the object for a structured entry. */
  value: unknown;
}

export interface FlagLink {
  key: string;
  inText: boolean;
  inDiff: boolean;
  /** Where it was found, for a person to check: a snippet of the text or the commit and its line. */
  evidence: string[];
  /** Hits through an alias, only from the item's commits; empty when none. */
  aliases: AliasHit[];
  files: FlagValue[];
  /** When its value last changed in any file, as observed; null when not since it was first read. */
  changedAt: string | null;
}

export interface AliasHit {
  /** The identifier the commit brought in. */
  name: string;
  /** Where it sits in the flag files: "<section>.<key>" and the property, e.g. a checker field. */
  entry: string;
  property: string;
  /** The property's whole value, e.g. [name, minimum version] for a checker. */
  value: unknown;
  /** Other keys with the same alias; a rule should not settle on an alias that is not unique. */
  sharedWith: string[];
  revision: string;
  branch: string | null;
  line: string;
}

export interface Vocabulary {
  files: Item[];
  /** key -> section -> file item key -> raw value */
  keys: Map<string, Map<string, string>>;
  sections: Map<string, string>;
  changedAt: Map<string, string>;
  /** alias -> the keys and properties that carry it */
  aliases: Map<string, Array<{ key: string; section: string; property: string; value: unknown }>>;
}

/** Looks like a name somebody chose: long enough, with an underscore, a digit or a camel hump. */
const NAMEY = /^(?=.{4,80}$)(?:.*[_0-9].*|.*[a-z][A-Z].*)$/;

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

function parsed(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function vocabularyOf(items: Record<string, Item>, recent: Record<string, Observation[]>): Vocabulary {
  const files = Object.values(items).filter((i) => i.kind === "flags").sort((a, b) => a.key.localeCompare(b.key));
  const keys = new Map<string, Map<string, string>>();
  const sections = new Map<string, string>();
  const changedAt = new Map<string, string>();
  const aliases = new Map<string, Array<{ key: string; section: string; property: string; value: unknown }>>();
  for (const file of files) {
    for (const [field, raw] of Object.entries(file.fields)) {
      const dot = field.indexOf(".");
      if (dot < 0) continue;
      const key = field.slice(dot + 1);
      sections.set(`${file.key}\0${key}`, field.slice(0, dot));
      const byFile = keys.get(key) ?? new Map<string, string>();
      byFile.set(file.key, raw);
      keys.set(key, byFile);
      const value = parsed(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const [property, v] of Object.entries(value)) {
        // A string, or the strings of a list (a checker is published as [name, minimum version]).
        for (const name of Array.isArray(v) ? v : [v]) {
          if (typeof name !== "string" || name === key || !NAMEY.test(name)) continue;
          const carriers = aliases.get(name) ?? [];
          if (!carriers.some((c) => c.key === key && c.property === property)) carriers.push({ key, section: field.slice(0, dot), property, value: v });
          aliases.set(name, carriers);
        }
      }
    }
    for (const obs of recent[file.key] ?? []) {
      for (const change of obs.changes) {
        // The core names a changed field "fields.<section>.<key>".
        if (!change.field.startsWith("fields.")) continue;
        const field = change.field.slice("fields.".length);
        const dot = field.indexOf(".");
        if (dot < 0) continue;
        const key = field.slice(dot + 1);
        const when = obs.seenAt;
        if (!changedAt.has(key) || Date.parse(changedAt.get(key)!) < Date.parse(when)) changedAt.set(key, when);
      }
    }
  }
  // A name that is itself a key is that key, not an alias of another.
  for (const name of [...aliases.keys()]) if (keys.has(name)) aliases.delete(name);
  return { files, keys, sections, changedAt, aliases };
}

/** What every flag file says about one key, found or not. */
export function flagOf(vocabulary: Vocabulary, key: string): FlagLink {
  const byFile = vocabulary.keys.get(key);
  return {
    key,
    inText: false,
    inDiff: false,
    evidence: [],
    aliases: [],
    files: vocabulary.files.map((file) => {
      const raw = byFile?.get(file.key);
      return {
        file: file.key,
        labels: { ...(file.labels ?? {}) },
        present: raw !== undefined,
        section: raw === undefined ? null : (vocabulary.sections.get(`${file.key}\0${key}`) ?? null),
        value: raw === undefined ? null : parsed(raw),
      };
    }),
    changedAt: vocabulary.changedAt.get(key) ?? null,
  };
}

function snippet(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 30), index + length + 30).replace(/\s+/g, " ").trim();
}

export function linksOf(item: Item, vocabulary: Vocabulary): FlagLink[] {
  if (vocabulary.keys.size === 0) return [];
  const found = new Map<string, FlagLink>();
  const link = (key: string) => {
    let hit = found.get(key);
    if (!hit) {
      hit = flagOf(vocabulary, key);
      found.set(key, hit);
    }
    return hit;
  };
  const text = item.text ?? "";
  for (const match of text.matchAll(IDENT)) {
    // In prose only a key that looks like a name counts: a key like "test" is also a word. Commits
    // keep only name-like tokens too (svn.ts), so such a key is not found at all; asking for the
    // key is how an issue about one gets it.
    if (!vocabulary.keys.has(match[0]) || !NAMEY.test(match[0])) continue;
    const hit = link(match[0]);
    if (!hit.inText) {
      hit.inText = true;
      hit.evidence.push(`单子文本：…${snippet(text, match.index!, match[0].length)}…`);
    }
  }
  for (const revision of item.revisions ?? []) {
    for (const [token, line] of revision.added) {
      if (!vocabulary.keys.has(token)) continue;
      const hit = link(token);
      hit.inDiff = true;
      if (hit.evidence.length < 4) hit.evidence.push(`${revision.id}${revision.branch ? `（${revision.branch}）` : ""}：+ ${line}`);
    }
  }
  for (const revision of item.revisions ?? []) {
    for (const [token, line] of revision.added) {
      const carriers = vocabulary.aliases.get(token);
      if (!carriers) continue;
      const keysOf = [...new Set(carriers.map((c) => c.key))];
      for (const carrier of carriers) {
        const hit = link(carrier.key);
        if (hit.aliases.some((a) => a.name === token) || hit.aliases.length >= 4) continue;
        hit.aliases.push({ name: token, entry: `${carrier.section}.${carrier.key}`, property: carrier.property, value: carrier.value, sharedWith: keysOf.filter((k) => k !== carrier.key), revision: revision.id, branch: revision.branch, line });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}
