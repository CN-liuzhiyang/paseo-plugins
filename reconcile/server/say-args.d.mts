/** What reconcile-say's arguments send: the request's own fields, as the command writes them. */
export interface SayArgsRequest {
  cmd: "say" | "undo";
  said: string;
  kind?: "drop" | "hold" | "wrong";
  item?: string;
  until?: string;
  person?: string;
  what?: string;
  expected?: string;
  /** undo: an annotation id, or "last". */
  target?: string;
}

export type SayArgs = { help: true } | { error: string; usage?: true } | { request: SayArgsRequest; data: string | null; wait: number };

export function parseSayArgs(argv: string[]): SayArgs;
