import type { Annotation, Item } from "../shared/model";
import { DESK_SOURCE } from "../shared/model";

// A matter a person told the controller in a conversation ("盯一下体检，月底前要约上") has no outside
// system to read it from. The controller keeps what was said as annotations (kind `track`, and `note`
// for a line added later) and makes the item `desk:D<n>` from them in the same batch: the journal is the
// one place that knows it, and the item is only what those words say, worked out again when they change.

/** At most this many matters are followed at once: a person's own list, not a feed. */
export const DESK_OPEN_MAX = 30;
/** At most this many lines may be added to one matter. */
export const DESK_NOTES_MAX = 20;
/** What of the words a matter's `text` keeps (what a rule may search). */
const DESK_TEXT_BYTES = 4096;

const KEY = /^desk:D(\d+)$/;

export const deskKey = (n: number) => `desk:D${n}`;
export const isDeskKey = (key: string) => KEY.test(key);
/** How a matter is called to people: D12 (no hash: it is not a ticket number). */
export const deskNo = (key: string) => key.replace(/^desk:/, "");

/** The next key: one more than the largest told so far, among the names given (item keys and the cases of annotations). */
export function nextDeskKey(names: Iterable<string>): string {
  let max = 0;
  for (const name of names) {
    const m = KEY.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return deskKey(max + 1);
}

/** What the log of looks (the fact `desk.log`, JSON) says the look `n` chose for the next one: its time, as the rule wrote it; null when it is not there. */
export function nextLookOf(log: string | undefined, n: string): string | null {
  try {
    const entries = JSON.parse(log || "[]") as Array<{ n?: number; next?: string }>;
    return entries.find((e) => String(e.n) === n)?.next || null;
  } catch {
    return null;
  }
}

/** The last `count` looks the log (`desk.log`, JSON) tells of, oldest first. Text from a model: shown only clipped and escaped. */
export function passesOf(log: string | undefined, count: number): Array<{ n: number; at: string; looked: string; status: string; next: string }> {
  try {
    const entries = JSON.parse(log || "[]") as Array<{ n?: unknown; at?: unknown; looked?: unknown; status?: unknown; next?: unknown }>;
    return entries.slice(-count).map((e) => ({ n: Number(e.n) || 0, at: String(e.at ?? ""), looked: String(e.looked ?? ""), status: String(e.status ?? ""), next: String(e.next ?? "") }));
  } catch {
    return [];
  }
}

/** Whether two sets of words say the same: case, spaces and punctuation do not tell them apart. */
export const sameWords = (a: string, b: string): boolean => {
  const flat = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const [x, y] = [flat(a), flat(b)];
  return x !== "" && x === y;
};

/**
 * The item a matter is: from the words that told it and the lines added since (all of them, taken back or not: a line keeps its place
 * number whatever is taken back, so that a field does not change its meaning). `revoking`: annotations to read as taken back, for the
 * item that results from taking them back, before the journal has it.
 */
export function deskItem(track: Annotation, notes: readonly Annotation[], revoking: ReadonlySet<string> = new Set()): Item {
  const lines = [...notes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const withdrawn = track.revoked !== null || revoking.has(track.id);
  const fields: Record<string, string> = { said: track.said, domain: track.domain ?? "work", owner: track.by, createdAt: track.at };
  let last = track.at;
  const texts = [track.said];
  lines.forEach((n, i) => {
    if (n.revoked || revoking.has(n.id)) return;
    fields[`note.${i}`] = n.said;
    fields[`note.${i}.at`] = n.at;
    texts.push(n.said);
    if (Date.parse(n.at) > Date.parse(last)) last = n.at;
  });
  return {
    key: track.caseId,
    source: DESK_SOURCE,
    kind: "desk",
    title: track.title ?? track.said.slice(0, 20),
    url: null,
    status: withdrawn ? "withdrawn" : "open",
    closed: withdrawn,
    fields,
    people: { owner: [track.by] },
    parent: null,
    sourceUpdatedAt: last,
    observedAt: last,
    text: texts.join("\n").slice(0, DESK_TEXT_BYTES),
    lastHumanAt: last,
  };
}
