import { z } from "zod";
import { segmentSchema } from "./card";

// What the 进展 panel shows for one affair: four blocks. Every piece of text may come with the pieces of it that
// are references the person can open.

const text = z.object({ text: z.string(), parts: z.array(segmentSchema).optional() });
const ask = z.object({ id: z.string(), title: z.string(), line: z.string(), options: z.array(z.string()) });
const source = z.object({ label: z.string(), status: z.string().optional(), full: z.string().optional(), at: z.string().optional(), href: z.string().nullable().optional() });
const material = z.object({
  /** The name in the folder (to ask for it). */
  name: z.string(),
  /** The name a person reads: without the time the folder put in front, with the time after it when two are called the same. */
  shown: z.string(),
  who: z.string(),
  at: z.string(),
  size: z.string(),
  kind: z.enum(["image", "text", "other"]),
  /** The type to write on a block that has no picture (MD, PDF). */
  ext: z.string(),
  /** A picture small enough to be fetched and drawn as a thumbnail. */
  thumb: z.boolean(),
  /** Changes when the file does, so a thumbnail is fetched once for each version. */
  version: z.string(),
  /** Where it is, as the host opens it. */
  path: z.string(),
});

const basisRow = z.object({ name: z.string(), href: z.string().optional(), text: z.string(), state: z.enum(["same", "changed", "new"]) });
const file = z.object({ name: z.string(), shown: z.string(), image: z.boolean(), path: z.string() });

// What kind of thing happened; the screen has a dot, a color and a title style for each (shared/look.ts).
export const EVENT_KINDS = ["look", "reply", "said", "answered", "asked", "note", "next", "read", "done", "stopped", "resumed", "flow", "error"] as const;

export const eventSchema = text.extend({
  key: z.string(),
  kind: z.enum(EVENT_KINDS),
  /** The small title: what it was. */
  label: z.string(),
  /** After the title, in grey: how it came out. */
  sub: z.string(),
  /** His words are drawn in a bubble. */
  bubble: z.boolean(),
  /** The sentence is plain grey (nothing new) or bold (something new). */
  calm: z.boolean(),
  strong: z.boolean(),
  tone: z.enum(["normal", "red", "warn"]),
  /** Counts for "有变化的". */
  changed: z.boolean(),
  /** Counts for "你说的". */
  yours: z.boolean(),
  day: z.string(),
  when: z.string(),
  whenFull: z.string(),
  meta: z.string().optional(),
  next: z.string().optional(),
  files: z.array(file),
  basis: z.object({ rows: z.array(basisRow), next: z.string().optional(), asked: z.string().optional() }).optional(),
  children: z.array(z.object({ when: z.string(), text: z.string() })).optional(),
});

/** The run started for this affair, as the block above the "现在" shows it. */
const flowBlock = z.object({
  name: z.string(),
  /** One sentence: what it is doing, or what it is waiting for him to do, or how it ended. */
  text: z.string(),
  /** What goes with it: the card he is asked to answer, the result of the run. */
  detail: z.string(),
  tone: z.enum(["normal", "red"]),
  /** How long, and what it cost. */
  meta: z.string(),
  /** Open the card to answer (approve), or the run's own page (detail). */
  action: z.object({ kind: z.enum(["approve", "detail", "resume"]), agentId: z.string().optional(), runId: z.string().optional(), expect: z.string().optional(), spends: z.string().optional() }).nullable(),
  /** Runs started before this one. */
  more: z.number(),
  /** Said when the "现在" below it is older than the end of the run. */
  stale: z.string(),
  /** A sentence about the run itself that belongs under its line (the same place stopped again). */
  note: z.string().optional(),
});

export const panelSchema = z.object({
  id: z.string(),
  title: z.string(),
  open: z.boolean(),
  mood: z.enum(["watching", "ask", "done", "error", "paused", "stopped"]),
  asks: z.array(ask),
  flow: flowBlock.nullable(),
  waiting: text,
  now: text,
  next: text,
  spent: z.string(),
  events: z.object({ total: z.number(), items: z.array(eventSchema) }),
  facts: z.array(text),
  sources: z.object({ items: z.array(source), more: z.number() }),
  materials: z.object({ items: z.array(material), more: z.number() }),
});

export type PanelData = z.output<typeof panelSchema>;
export type PanelEvent = z.output<typeof eventSchema>;
export type PanelMaterial = z.output<typeof material>;
