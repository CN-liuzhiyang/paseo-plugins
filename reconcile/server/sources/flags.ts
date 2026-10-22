import type { FlagsSourceConfig } from "../config";
import type { Item } from "../../shared/model";
import type { Poll, PollInput, Source } from "./source";

// Switch and rollout files published over HTTP as JSON: one item per file, whose fields are the
// configured sections flattened to "<section>.<key>" = the value (JSON text for objects). A
// change in a value is then an ordinary field change of that item, which is what wakes the
// cases linked to that key. The cost is one GET per file, whatever the number of cases.

export interface FetchResult {
  status: number;
  text: string;
  lastModified: string | null;
}

export type FetchText = (url: string, timeoutMs: number) => Promise<FetchResult>;

export const fetchText: FetchText = async (url, timeoutMs) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: abort.signal, redirect: "follow" });
    return { status: response.status, text: await response.text(), lastModified: response.headers.get("last-modified") };
  } finally {
    clearTimeout(timer);
  }
};

/** "<section>.<key>" -> value, for the sections asked for; section "" is the top level's scalars, as "<key>". */
export function flatten(document: unknown, sections: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!document || typeof document !== "object") return fields;
  for (const section of sections) {
    if (section === "") {
      for (const [key, value] of Object.entries(document)) if (value === null || typeof value !== "object") fields[key] = String(value);
      continue;
    }
    const entries = (document as Record<string, unknown>)[section];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [key, value] of Object.entries(entries)) {
      fields[`${section}.${key}`] = value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
    }
  }
  return fields;
}

export function createFlagsSource(config: FlagsSourceConfig, deps: { fetchText: FetchText }): Source {
  return {
    id: config.id,
    domain: config.domain,
    async poll(input: PollInput): Promise<Poll> {
      const snapshots: Item[] = [];
      const errors: string[] = [];
      let calls = 0;
      for (const file of config.files) {
        if (input.callsLeft - calls <= 0) break;
        calls++;
        try {
          const result = await deps.fetchText(file.url, config.timeoutSeconds * 1000);
          if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
          const document = JSON.parse(result.text.replace(/^﻿/, ""));
          const modified = result.lastModified ? Date.parse(result.lastModified) : Number.NaN;
          snapshots.push({
            key: `${config.id}:${file.id}`,
            source: config.id,
            kind: config.itemKind ?? "flags",
            title: file.id,
            url: file.url,
            status: "ok",
            closed: false,
            fields: flatten(document, config.sections),
            people: {},
            parent: null,
            sourceUpdatedAt: Number.isNaN(modified) ? null : new Date(modified).toISOString(),
            observedAt: input.now,
            labels: { ...file.labels },
          });
        } catch (error) {
          errors.push(`${file.id}: ${(error as Error).message}`);
        }
      }
      if (snapshots.length === 0 && errors.length > 0) throw new Error(errors.join("; "));
      return { snapshots, cursor: null, calls, errors, more: false };
    },
  };
}
