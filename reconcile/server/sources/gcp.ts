import type { GcpSourceConfig } from "../config";
import type { Exec } from "../exec";
import type { Item, Revision } from "../../shared/model";
import type { Poll, PollInput, Source } from "./source";
import type { SvnReader } from "./svn";

// A project tracker, read through its command-line tool's gateway (the path, tool and target
// of the call are configured, see GcpSourceConfig.gateway). Pull only:
// there is no webhook. One poll lists the issues assigned to the user that changed since the
// cursor's date (the list is precise to the minute, so the cursor overlaps a day and dedupes by
// each issue's updated_on), then reads the full record of each changed or watched issue. Calls
// are slow (about six seconds each), so a poll stops at its call budget and leaves the rest
// pending for the next one.
//
// Not every listed row is worth a full read: the core decides per row (PollInput.decide) from
// what the list shows -- status and the configured columns -- so a cold issue touched by an
// automation costs nothing, and one touched by someone costs one look at its history. A full
// read is the record, the linked commits (read from version control, see svn.ts) and the
// history's last change by a person.

interface Cursor {
  since: string | null; // YYYY-MM-DD
  seen: Record<string, string>; // issue id -> updated_on last read in full, or decided not worth reading
  pending: number[];
  watchedAt: Record<string, number>; // watched issue id -> when last read in full
  incomplete: Record<string, number>; // issue id -> full reads in a row that missed a linked commit
}

/** A full read that could not get everything (a linked commit): the issue is read again next time. */
class IncompleteError extends Error {}

/**
 * An issue whose linked commits could not all be read this many reads in a row is kept with what
 * was read, marked incomplete (a branch the account cannot read would otherwise hold it, and the
 * list's window, for good).
 */
const MAX_INCOMPLETE = 3;

/** At most this many pages of the list in one poll, of PER_PAGE rows. */
const MAX_PAGES = 10;
const PER_PAGE = 100;

export class GcpError extends Error {
  constructor(
    message: string,
    readonly auth: boolean,
  ) {
    super(message);
  }
}

const AUTH = /登录|login|token|unauthor|401|未授权|过期/i;

/** The tool result inside the tool's envelope. The tool may print banner lines before the JSON. */
export function unwrap(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/);
  // The JSON is what is left from the first line it parses from; a banner like "[cli] …" does not.
  let value: unknown;
  let found = false;
  for (let i = 0; i < lines.length && !found; i++) {
    if (!/^\s*[{[]/.test(lines[i]!)) continue;
    try {
      value = JSON.parse(lines.slice(i).join("\n"));
      found = true;
    } catch {
      // a banner line, or broken JSON: the next candidate
    }
  }
  if (!found) {
    const text = stdout.trim();
    if (text === "" || lines.every((line) => /^\[[^\]]*\]/.test(line.trim()) || line.trim() === "")) throw new GcpError("the tracker tool printed nothing", AUTH.test(text));
    throw new GcpError(`the tracker tool did not print JSON: ${text.slice(0, 200)}`, AUTH.test(text));
  }
  // { ok, data: { data: { data: [ { type: "text", text: "<tool JSON>" } ] } } }
  let node: unknown = value;
  for (let depth = 0; depth < 6; depth++) {
    if (Array.isArray(node)) {
      const text = node.find((part) => part && typeof part === "object" && (part as { type?: string }).type === "text") as { text?: string } | undefined;
      if (!text?.text) throw new GcpError("the gateway answered without a text part", false);
      const inner = JSON.parse(text.text) as { res_code?: number; res_msg?: string; data?: unknown };
      if (inner.res_code !== 1) throw new GcpError(`tracker: ${inner.res_msg ?? "res_code " + inner.res_code}`, AUTH.test(inner.res_msg ?? ""));
      return inner.data;
    }
    if (node && typeof node === "object") {
      const record = node as { ok?: boolean; message?: string; data?: unknown };
      if (record.ok === false) throw new GcpError(`gateway: ${record.message ?? JSON.stringify(record).slice(0, 200)}`, AUTH.test(JSON.stringify(record)));
      if (!("data" in record)) break;
      node = record.data;
      continue;
    }
    break;
  }
  throw new GcpError("unexpected gateway answer", false);
}

type Field = { name?: string; value?: unknown; field_format?: string; key?: string };

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function fieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(fieldText).filter((v) => v !== "").join(", ");
  if (typeof value === "object") {
    const record = value as { name?: string; value?: unknown; title?: string };
    if (typeof record.name === "string") return record.name;
    if (typeof record.title === "string") return record.title;
    if ("value" in record) return fieldText(record.value);
  }
  return "";
}

function userNames(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (Array.isArray(value)) return value.map((u) => (u && typeof u === "object" ? String((u as { name?: string }).name ?? "") : String(u))).filter((n) => n !== "");
  return [];
}

const SKIP = new Set(["description", "subject"]);
const MAX_FIELD = 500;
const MAX_TEXT = 20_000;

/** An issue's full record (get_issue_base) as an item. */
export function normalizeIssue(sourceId: string, host: string, data: unknown, observedAt: string): Item {
  const record = data as { base?: Record<string, unknown>; core_fields?: unknown; cf_fields?: unknown };
  const base = record.base;
  if (!base || typeof base.id !== "number") throw new GcpError("get_issue_base answered without base.id", false);
  const fields: Record<string, string> = {};
  const people: Record<string, string[]> = {};
  const all: Field[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object" && "name" in value) all.push(value as Field);
  };
  collect(record.core_fields);
  collect(record.cf_fields);
  for (const field of all) {
    if (!field.name || (field.key && SKIP.has(field.key))) continue;
    if (field.field_format === "user") {
      people[field.name] = userNames(field.value);
      continue;
    }
    let text = fieldText(field.value);
    if (field.field_format === "editor" || /<\/?[a-z][^>]*>/i.test(text)) text = stripHtml(text);
    fields[field.name] = text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}…` : text;
  }
  const parentId = typeof base.parent_id === "number" ? base.parent_id : null;
  const description = all.find((f) => f.key === "description")?.value ?? base.description;
  const text = [String(base.subject ?? ""), typeof description === "string" ? stripHtml(description) : "", ...Object.values(fields)].join("\n").slice(0, MAX_TEXT);
  return {
    key: `${sourceId}:${base.id}`,
    source: sourceId,
    kind: "issue",
    title: String(base.subject ?? ""),
    url: `https://${host}/issues/${base.id}`,
    status: fieldText(base.status),
    closed: base.is_closed === true,
    fields,
    people,
    parent: parentId === null ? null : `${sourceId}:${parentId}`,
    sourceUpdatedAt: typeof base.updated_on === "string" ? base.updated_on : null,
    observedAt,
    text,
  };
}

type Journal = { created_on?: string; is_auto_flow?: boolean; notes?: string | null; author?: { type?: string; name?: string } | null };

/** The newest change in an issue's history made by a person: not the API user, not an automatic flow, not a rule's note. */
export function lastHuman(data: unknown, automationNotePrefixes: string[]): string | null {
  const list = (data as { list?: Journal[] } | null)?.list ?? [];
  let newest: string | null = null;
  for (const j of list) {
    if (!j.created_on || j.is_auto_flow || j.author?.type === "APIUser") continue;
    if (automationNotePrefixes.some((p) => (j.notes ?? "").startsWith(p))) continue;
    if (!newest || Date.parse(j.created_on) > Date.parse(newest)) newest = j.created_on;
  }
  return newest;
}

function cursorOf(value: unknown): Cursor {
  const v = (value ?? {}) as Partial<Cursor>;
  return {
    since: typeof v.since === "string" ? v.since : null,
    seen: v.seen ?? {},
    pending: Array.isArray(v.pending) ? v.pending : [],
    watchedAt: v.watchedAt ?? {},
    incomplete: v.incomplete ?? {},
  };
}

type Changeset = { revision?: string; committed_on?: string; comments?: string; committer?: string | { name?: string } };

export function createGcpSource(
  config: GcpSourceConfig,
  deps: { exec: Exec; localDate(ms: number): string; addDays(date: string, n: number): string; svn?: SvnReader | null },
): Source {
  const timeoutMs = config.timeoutSeconds * 1000;
  async function call(tool: string, args: unknown): Promise<unknown> {
    const { gateway } = config;
    const body = JSON.stringify({ tool: gateway.tool, params: { mcpTarget: gateway.target, gcpHost: config.gcpHost, toolName: tool, arguments: args } });
    const result = await deps.exec(config.command, ["call", "POST", gateway.path, "--body", body], { timeoutMs });
    if (result.timedOut) throw new GcpError(`${tool} timed out after ${config.timeoutSeconds}s`, false);
    if (result.code !== 0 && result.stdout.trim() === "") {
      const why = (result.stderr || `exit ${result.code}`).trim().slice(0, 300);
      throw new GcpError(`${tool}: ${why}`, AUTH.test(why));
    }
    return unwrap(result.stdout);
  }
  const svn = deps.svn ?? null;
  const columnNames = Object.keys(config.columns);

  return {
    id: config.id,
    domain: config.domain,
    async poll(input: PollInput): Promise<Poll> {
      const cursor = cursorOf(input.cursor);
      let calls = 0;
      const budget = () => input.callsLeft - calls;
      const today = deps.localDate(input.nowMs);
      const since = cursor.since ?? deps.addDays(today, -config.lookbackDays);
      svn?.beginPoll();
      // The list, page by page. It answers page, per_page, total_count and total_page (seen on the
      // real service, 2026-10-23; its "pages" is the choice of per_page values, not a count). A full
      // page is followed by the next whatever total_page says, and a count that does not add up is
      // reported.
      type Row = Record<string, unknown> & { id: number; updated_on?: string };
      const rows: Row[] = [];
      const errors: string[] = [];
      let pages = 1;
      let total: number | null = null;
      let listedAll = true;
      for (let page = 1; page <= pages; page++) {
        if (page > MAX_PAGES || (page > 1 && budget() < 1)) {
          listedAll = false;
          errors.push(`列表有 ${pages} 页，这次只读了 ${page - 1} 页`);
          break;
        }
        const listed = (await call("list_issues", {
          project_id: config.projectId,
          set_filter: 1,
          filter_mode: "simple",
          filters: {
            status_id: { operator: "*", values: [] },
            assigned_to_id: { operator: "=", values: ["me"] },
            updated_on: { operator: ">=", values: [since] },
          },
          c: ["subject", "status", "updated_on", ...columnNames],
          per_page: PER_PAGE,
          page,
        })) as { list?: Row[]; total_page?: number; total_count?: number };
        calls++;
        const list = Array.isArray(listed?.list) ? listed.list : [];
        rows.push(...list);
        if (typeof listed?.total_page === "number") pages = listed.total_page;
        if (typeof listed?.total_count === "number") total = listed.total_count;
        if (list.length >= PER_PAGE && pages <= page) pages = page + 1;
      }
      if (listedAll && total !== null && total !== rows.length) errors.push(`列表说有 ${total} 条，读到 ${rows.length} 条`);
      const seen = { ...cursor.seen };
      const incomplete = { ...cursor.incomplete };
      const full = new Set(cursor.pending);
      const people: number[] = [];
      const rowUpdated = new Map(rows.map((r) => [r.id, r.updated_on ?? ""]));
      for (const row of rows) {
        const changed = cursor.seen[String(row.id)] !== row.updated_on;
        const columns: Record<string, string> = {};
        for (const [column, field] of Object.entries(config.columns)) columns[field] = fieldText(row[column]);
        const decision = input.decide
          ? input.decide({ key: `${config.id}:${row.id}`, title: fieldText(row.subject), status: fieldText(row.status), updatedOn: row.updated_on ?? "", changed, columns })
          : changed
            ? "full"
            : "skip";
        if (decision === "full") full.add(row.id);
        else if (decision === "people" && config.journals) people.push(row.id);
        else seen[String(row.id)] = row.updated_on ?? "";
      }
      // Watched issues may not be assigned to the user, so the list may not show their changes.
      const watchedAt = { ...cursor.watchedAt };
      const watched = new Set([...config.watch, ...input.watch.map(Number).filter(Number.isInteger)]);
      for (const id of watched) {
        if (rowUpdated.has(id)) continue;
        if (input.nowMs - (watchedAt[String(id)] ?? 0) >= config.watchEveryMinutes * 60_000) full.add(id);
      }

      const snapshots: Item[] = [];
      const left: number[] = [];
      // Read but not completely: tried again at the next regular poll, not right away.
      const later: number[] = [];
      const costOfFull = 1 + (svn ? 1 : 0) + (config.journals ? 1 : 0);

      async function readFull(id: number): Promise<void> {
        const data = await call("get_issue_base", { id });
        calls++;
        const item = normalizeIssue(config.id, config.gcpHost, data, input.now);
        if (svn) {
          const changesets = ((await call("get_issue_changesets", { id })) as { list?: Changeset[] } | null)?.list ?? [];
          calls++;
          const revisions: Revision[] = [];
          const failed: string[] = [];
          for (const c of changesets.slice(0, config.changes!.maxRevisions)) {
            if (!c.revision) continue;
            const author = typeof c.committer === "string" ? c.committer : (c.committer?.name ?? "");
            try {
              const revision = await svn.read(c.revision, { at: c.committed_on ?? "", author, summary: (c.comments ?? "").split(/\r?\n/)[0]!.slice(0, 200) });
              if (revision) revisions.push(revision);
            } catch (error) {
              failed.push(`${c.revision}: ${(error as Error).message}`);
            }
          }
          // Without one of its commits the issue would be judged on less than it has: not kept,
          // unless that has happened MAX_INCOMPLETE times in a row.
          if (failed.length > 0) {
            const times = (incomplete[String(id)] ?? 0) + 1;
            incomplete[String(id)] = times;
            if (times < MAX_INCOMPLETE) throw new IncompleteError(failed.join("; "));
            item.incomplete = failed.map((f) => f.slice(0, 200));
            errors.push(`#${id} 连续 ${times} 次有提交读不到，先按读到的算：${failed.join("; ")}`);
          } else delete incomplete[String(id)];
          item.revisions = revisions;
        }
        if (config.journals) {
          item.lastHumanAt = lastHuman(await call("get_issue_journals", { id }), config.journals.automationNotePrefixes);
          calls++;
        }
        snapshots.push(item);
        seen[String(id)] = rowUpdated.get(id) ?? item.sourceUpdatedAt ?? "";
        if (watched.has(id)) watchedAt[String(id)] = input.nowMs;
      }

      for (const id of full) {
        if (budget() < costOfFull) {
          left.push(id);
          continue;
        }
        try {
          await readFull(id);
        } catch (error) {
          if (error instanceof IncompleteError) {
            errors.push(`#${id} 的提交没读全，下次再读：${error.message}`);
            later.push(id);
            continue;
          }
          calls++;
          if (error instanceof GcpError && error.auth) throw error;
          errors.push(`#${id}: ${(error as Error).message}`);
          left.push(id);
        }
      }
      let peopleLeft = 0;
      for (const id of people) {
        if (budget() < 1) {
          peopleLeft++;
          continue;
        }
        try {
          const human = lastHuman(await call("get_issue_journals", { id }), config.journals!.automationNotePrefixes);
          calls++;
          if (human && input.humanSince && Date.parse(human) >= Date.parse(input.humanSince)) {
            if (budget() < costOfFull) left.push(id);
            else await readFull(id).catch((error: unknown) => {
              if (!(error instanceof IncompleteError)) throw error;
              errors.push(`#${id} 的提交没读全，下次再读：${error.message}`);
              later.push(id);
            });
          } else {
            seen[String(id)] = rowUpdated.get(id) ?? "";
          }
        } catch (error) {
          calls++;
          if (error instanceof GcpError && error.auth) throw error;
          errors.push(`#${id}: ${(error as Error).message}`);
          peopleLeft++;
        }
      }
      const next: Cursor = {
        // Unread rows keep the list's window open so they are listed again.
        since: left.length === 0 && later.length === 0 && peopleLeft === 0 && listedAll ? deps.addDays(today, -1) : since,
        seen,
        pending: [...left, ...later].filter((id) => !watched.has(id)),
        watchedAt,
        incomplete,
      };
      return { snapshots, cursor: next, calls, errors, more: left.some((id) => !watched.has(id)) || peopleLeft > 0 || !listedAll };
    },
  };
}
