import { z } from "zod";
import { segmentSchema } from "./card";

// What the 进展 panel shows for one affair: three blocks. Every piece of text may come with the pieces of it that
// are references the person can open.

const text = z.object({ text: z.string(), parts: z.array(segmentSchema).optional() });
const ask = z.object({ id: z.string(), title: z.string(), line: z.string(), options: z.array(z.string()) });
const source = z.object({ label: z.string(), status: z.string().optional(), full: z.string().optional(), at: z.string().optional(), href: z.string().nullable().optional() });
const material = z.object({ name: z.string(), who: z.string(), at: z.string() });

export const panelSchema = z.object({
  id: z.string(),
  title: z.string(),
  open: z.boolean(),
  mood: z.enum(["watching", "ask", "done", "error", "paused", "stopped"]),
  asks: z.array(ask),
  waiting: text,
  now: text,
  next: text,
  spent: z.string(),
  recent: z.array(text.extend({ key: z.string(), tone: z.enum(["normal", "red"]) })),
  facts: z.array(text),
  sources: z.object({ items: z.array(source), more: z.number() }),
  materials: z.object({ items: z.array(material), more: z.number() }),
});

export type PanelData = z.output<typeof panelSchema>;
