/** What reconcile-say's arguments send: the request's own fields, as the command writes them. */
export interface SayArgsRequest {
  cmd: "say" | "undo" | "track" | "note";
  said: string;
  kind?: "drop" | "hold" | "wrong";
  item?: string;
  until?: string;
  person?: string;
  what?: string;
  expected?: string;
  /** track: the short name of the matter, and its domain. */
  title?: string;
  domain?: "work" | "personal" | "family";
  /** undo: an annotation id, or "last". */
  target?: string;
}

export type SayArgs = { help: true } | { error: string; usage?: true } | { request: SayArgsRequest; data: string | null; wait: number };

export function parseSayArgs(argv: string[]): SayArgs;
