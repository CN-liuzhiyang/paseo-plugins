import { z } from "zod";

// What the plugin puts into an affair's chat as items of its own (the chat is a real session; these are rows beside
// its messages, drawn by the client): a line (what happened, or what he answered) and a question with buttons. Each is
// written under one id, so a new version replaces the last: an answered question becomes a line.

// A piece of text, with an address when it is a reference the person can open (an 易协作 ticket).
export const segmentSchema = z.object({ text: z.string(), href: z.string().optional() });
export type Segment = z.output<typeof segmentSchema>;

export const LINE_KIND = "affair-line";
export const LINE_VERSION = 1;

export const lineSchema = z.object({
  text: z.string(),
  tone: z.enum(["normal", "red", "warn"]),
  detail: z.string(),
  parts: z.array(segmentSchema).optional(),
});

export type Line = z.output<typeof lineSchema>;

export const ASK_KIND = "affair-ask";
export const ASK_VERSION = 1;

export const askSchema = z.object({
  /** The affair the question belongs to (the answer goes there). */
  affair: z.string(),
  id: z.string(),
  title: z.string(),
  line: z.string(),
  options: z.array(z.string()),
});

export type Ask = z.output<typeof askSchema>;
