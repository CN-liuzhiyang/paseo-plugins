import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// The gate request: what the orchestration runtime (../../orchestration/runtime/gate.mjs)
// writes next to the receipt path and points the carrier at. The prompt names the file and its
// sha256, and the prompt is in the run's event stream; the file names the content's sha256.
// Both are checked before a card is shown, so the card shows the bytes the runtime holds.

export interface GateEvidence {
  label: string;
  text: string;
  kind?: "diff" | "text";
  name?: string;
}

export interface GateRequest {
  v: 1;
  kind: "orchestration-gate/request";
  runId: string;
  callId: string;
  title: string;
  summary: string;
  brief: string;
  evidence: GateEvidence[];
  name: string;
  content: string;
  sha256: string;
  receipt: string;
  receiptPath: string;
  answerPath: string;
  timeout: string;
  help: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The runtime's "same content": line endings and trailing newlines aside (gate.mjs `canonical`). */
export const contentDigest = (content: string) => sha256(content.replace(/\r\n/g, "\n").replace(/\n+$/, ""));

/** `request: <path>` and `sha256: <hex>` lines of the carrier's prompt, or null. */
export function parsePointer(prompt: string): { path: string; sha256: string } | null {
  const file = /^request: (.+)$/m.exec(prompt)?.[1]?.trim();
  const hash = /^sha256: ([0-9a-f]{64})$/m.exec(prompt)?.[1];
  return file && hash ? { path: file, sha256: hash } : null;
}

const isString = (value: unknown): value is string => typeof value === "string";

function isEvidence(value: unknown): value is GateEvidence {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    isString(e.label) &&
    isString(e.text) &&
    (e.kind === undefined || e.kind === "diff" || e.kind === "text") &&
    (e.name === undefined || isString(e.name))
  );
}

export class RequestError extends Error {
  /** Where to record the failure, once the request was read far enough to know. */
  constructor(
    message: string,
    readonly answerPath: string | null = null,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/** Read and check the request a prompt points at. Throws RequestError on anything that does not hold. */
export async function readRequest(prompt: string): Promise<GateRequest> {
  const pointer = parsePointer(prompt);
  if (!pointer) throw new RequestError("the prompt does not name a gate request (request: / sha256: lines)");
  const text = await readFile(pointer.path, "utf8").catch((error: unknown) => {
    throw new RequestError(`cannot read the request ${pointer.path}: ${error instanceof Error ? error.message : String(error)}`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestError(`the request ${pointer.path} is not JSON`);
  }
  const r = (parsed ?? {}) as Record<string, unknown>;
  const answerPath = isString(r.answerPath) && r.answerPath !== "" ? r.answerPath : null;
  if (sha256(text) !== pointer.sha256) throw new RequestError("the request file does not match its sha256: it changed after the runtime wrote it", answerPath);
  const fields = ["runId", "callId", "title", "summary", "brief", "name", "content", "sha256", "receipt", "receiptPath", "answerPath", "timeout", "help"];
  const missing = fields.filter((key) => !isString(r[key]));
  if (r.v !== 1 || r.kind !== "orchestration-gate/request" || missing.length > 0 || !Array.isArray(r.evidence) || !r.evidence.every(isEvidence)) {
    throw new RequestError(`the request is not a v1 gate request${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}`, answerPath);
  }
  const request = parsed as GateRequest;
  if (contentDigest(request.content) !== request.sha256) throw new RequestError("the content does not match the sha256 the request names", answerPath);
  if (!request.receipt.includes(request.sha256)) throw new RequestError("the receipt does not name the content's sha256", answerPath);
  return request;
}
