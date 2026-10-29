import { z } from "zod";

// What the controller puts into a conversation's timeline (the conversation a matter was told in): a question to answer there, and a line
// that tells how a confirmation turned out. The daemon keeps timeline items in memory only, so the controller puts the open questions there
// again after a restart; an item appended again under the same id replaces the one before it where it stands.

export const THREAD_KIND = "reconcile-thread";
export const THREAD_VERSION = 1;

const option = z.object({ id: z.string(), label: z.string(), description: z.string() });

export const threadSchema = z.discriminatedUnion("shape", [
  z.object({
    shape: z.literal("ask"),
    commitmentId: z.string(),
    /** The number of the question (D1-1): what the push prints on its last line. */
    no: z.string(),
    round: z.number().int().min(0),
    header: z.string(),
    question: z.string(),
    brief: z.string(),
    options: z.array(option),
    allowOther: z.boolean(),
    /** Whether some words were the person's own (a confirmation) is what it asks. */
    confirm: z.boolean(),
    /** open: to answer; the rest: over, and `line` says how. */
    state: z.enum(["open", "answered", "withdrawn", "expired"]),
    line: z.string().optional(),
  }),
  z.object({ shape: z.literal("line"), text: z.string() }),
]);
export type ThreadData = z.output<typeof threadSchema>;
export type AskThread = Extract<ThreadData, { shape: "ask" }>;

export interface ThreadItem {
  type: "plugin";
  id: string;
  kind: string;
  version: number;
  data: ThreadData;
}

/** The timeline item id of a question (one per question: appending again replaces it) and of the line that tells a confirmation's end. */
export const askItemId = (commitmentId: string) => `ask:${commitmentId}`;
export const lineItemId = (requestId: string) => `told:${requestId}`;
