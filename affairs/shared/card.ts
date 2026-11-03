import { z } from "zod";

// The card on top of an affair's conversation: four sentences. The plugin writes it into the conversation's timeline
// under one id, so each new version replaces the last.

export const CARD_KIND = "affair-card";
export const CARD_VERSION = 1;
export const CARD_ID = "card";

// A piece of text, with an address when it is a reference the person can open (an 易协作 ticket).
export const segmentSchema = z.object({ text: z.string(), href: z.string().optional() });
export type Segment = z.output<typeof segmentSchema>;

export const cardSchema = z.object({
  title: z.string(),
  waiting: z.string(),
  now: z.string(),
  next: z.string(),
  open: z.boolean(),
  /** The same four sentences cut into pieces, for those that have a reference in them. */
  parts: z.object({ title: z.array(segmentSchema), waiting: z.array(segmentSchema), now: z.array(segmentSchema), next: z.array(segmentSchema) }).partial().optional(),
});

export type Card = z.output<typeof cardSchema>;

// One line under the card: what happened, or what was said. Drawn as a plugin item so that a line can be replaced
// (the app does not replace a message, only a plugin item with the same id).
export const LINE_KIND = "affair-line";
export const LINE_VERSION = 1;

export const lineSchema = z.object({
  text: z.string(),
  tone: z.enum(["normal", "red"]),
  detail: z.string(),
  parts: z.array(segmentSchema).optional(),
});

export type Line = z.output<typeof lineSchema>;
