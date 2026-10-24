import { z } from "zod";
import type { CommandSourceConfig } from "../config";
import type { Exec } from "../exec";
import type { Item, ObserveVerdict } from "../../shared/model";
import { VERDICTS } from "../observe";
import { cleanText } from "../untrusted";
import type { Poll, PollInput, Source } from "./source";

// An observing source: a configured command, run without a shell, that is handed what the rules
// asked to have watched and answers with what it found, as JSON. It runs only while something is
// asked to be watched (the engine decides when: observe.ts). What it does to find out is the
// deployment's: this side only checks what comes back, field by field, and keeps it as one item
// per request. Nothing it prints is shown as it is but its notes, cut short.
//
// stdin:  { "now": "<ISO>", "requests": [{ "key", "window": { "from", "to" }, "params": {…}, "last": { "verdict", "readAt", "freshUntil" } | null }] }
// stdout: { "results": [{ "key", "verdict", "freshUntil", "observedAt"?, "numbers": {…}, "notes": ["…"] }], "errors": ["…"], "meta"?: {…} }
// An error "auth" in `errors` says its credentials do not work: the source is down at once.
// Not one result for what was asked is a read that failed; a result missing for some keys only is
// a failure of those keys (Poll.missing), the others are taken.

export interface CommandRequest {
  /** Which request it is (observe.ts requestVersion): kept with what is read for it, not handed to the command. */
  version: string;
  key: string;
  window: { from: string; to: string };
  params: Record<string, unknown>;
  last: { verdict: ObserveVerdict; readAt: string; freshUntil: string | null } | null;
}

const instant = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "not an instant");
/** The most what a result found may take, as JSON in UTF-8: it is kept in the journal with every read. */
export const NUMBERS_BYTES = 16 * 1024;
/** Of a result's notes, how many are kept: what is past it is left out, not refused. */
export const NOTES_KEPT = 10;
// Not trusted: one clean line, cut short (untrusted.ts).
const clean = (text: string, max: number) => cleanText(text, max) ?? "";

const result = z
  .object({
    key: z.string().min(1).max(200),
    verdict: z.enum(VERDICTS),
    /** Up to when the data it read goes (the newest record it saw, say); null: it could not tell (nothing read). */
    freshUntil: instant.nullable(),
    /** When it read it, by its own clock: kept for the record; what counts is when the run started. */
    observedAt: instant.optional(),
    /** What it found, for the rule to read: any JSON object, not read here; kept as it came, within NUMBERS_BYTES. */
    numbers: z
      .record(z.string(), z.unknown())
      .refine((n) => Buffer.byteLength(JSON.stringify(n), "utf8") <= NUMBERS_BYTES, `numbers over ${NUMBERS_BYTES} bytes as JSON`)
      .default({}),
    /** Said for people: the first NOTES_KEPT kept, each cut short (below); strings still. */
    notes: z
      .array(z.string())
      .default([])
      .transform((n) => n.slice(0, NOTES_KEPT)),
  })
  .strict();

/** `meta`: about the run itself (how long it took, say); not kept. */
const output = z
  .object({
    results: z.array(result).max(500),
    errors: z.array(z.string().max(1000)).max(20).default([]),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export class CommandAuthError extends Error {
  readonly auth = true;
}

export function createCommandSource(config: CommandSourceConfig, deps: { exec: Exec }): Source {
  return {
    id: config.id,
    domain: config.domain,
    async poll(input: PollInput): Promise<Poll> {
      const requests = input.observe ?? [];
      if (requests.length === 0) return { snapshots: [], cursor: null, calls: 0, errors: [], more: false };
      const stdin = JSON.stringify({ now: input.now, requests: requests.map(({ version: _version, ...q }) => q) });
      const r = await deps.exec(config.command, [], {
        timeoutMs: config.timeoutSeconds * 1000,
        maxBytes: config.maxOutputBytes,
        input: stdin,
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (r.aborted) throw new Error("观察命令被停下了（检查停了）");
      if (r.timedOut) throw new Error(`观察命令 ${config.timeoutSeconds} 秒没跑完`);
      if (r.truncated) throw new Error(`观察命令的输出超过 ${config.maxOutputBytes} 字节`);
      if (r.code !== 0) throw new Error(`观察命令退出码 ${r.code ?? "无"}：${clean(r.stderr, 300) || "（没有输出错误）"}`);
      let parsed: z.output<typeof output>;
      try {
        const got = output.safeParse(JSON.parse(r.stdout));
        if (!got.success) throw new Error(got.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
        parsed = got.data;
      } catch (error) {
        throw new Error(`观察命令的输出不对：${clean((error as Error).message, 300)}`);
      }
      const errors = parsed.errors.map((e) => clean(e, 300));
      if (errors.includes("auth")) throw new CommandAuthError("观察命令说登录不了（auth）");
      // It says what went wrong for the whole run and found nothing for any request: that is a
      // read that failed (it counts towards telling the admin), not a set of answers.
      if (errors.length > 0 && parsed.results.every((res) => res.verdict === "insufficient-data")) throw new Error(`观察命令读不了：${errors.join("、")}`);
      const asked = new Map(requests.map((q) => [q.key, q]));
      const snapshots: Item[] = [];
      const seen = new Set<string>();
      for (const res of parsed.results) {
        const q = asked.get(res.key);
        if (!q) {
          errors.push(`${clean(res.key, 80)}: 没有要过它`);
          continue;
        }
        if (seen.has(res.key)) {
          errors.push(`${clean(res.key, 80)}: 给了两次结果`);
          continue;
        }
        seen.add(res.key);
        const fields: Record<string, string> = {
          request: q.version,
          verdict: res.verdict,
          freshUntil: res.freshUntil ?? "",
          "window.from": q.window.from,
          "window.to": q.window.to,
          numbers: JSON.stringify(res.numbers),
          ...(res.observedAt ? { observedAt: res.observedAt } : {}),
        };
        res.notes.forEach((note, i) => (fields[`notes.${i}`] = clean(note, 300)));
        snapshots.push({
          key: `${config.id}:${res.key}`,
          source: config.id,
          kind: "observation",
          title: res.key,
          url: null,
          status: res.verdict,
          closed: false,
          fields,
          people: {},
          parent: null,
          sourceUpdatedAt: null,
          observedAt: input.now,
        });
      }
      const missing: Record<string, string> = {};
      for (const q of requests) if (!seen.has(q.key)) missing[q.key] = "观察命令没给结果";
      // Nothing for anything asked: not a read.
      if (snapshots.length === 0) throw new Error(`观察命令没给要的结果${errors.length > 0 ? `：${errors.slice(0, 3).join("；")}` : ""}`);
      for (const [key, why] of Object.entries(missing)) errors.push(`${key}: ${why}`);
      return { snapshots, cursor: null, calls: 1, errors: errors.slice(0, 20), more: false, ...(Object.keys(missing).length > 0 ? { missing } : {}) };
    },
  };
}
