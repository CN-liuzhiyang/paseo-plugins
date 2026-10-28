import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

/**
 * An approve-with-a-value gate: the person's approval carries a string (a verification code, say). The
 * card asks for it in a form field; `pattern` (a regular expression the whole value must match) is checked
 * here, so a wrong entry is sent back to the person instead of spending the answer.
 */
export interface GateInput {
  label: string;
  secret: boolean;
  pattern: string | null;
  hint: string;
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
  /** Present only on an input gate; then `inputPath` is where the value goes (next to the request, never in the answer). */
  input?: GateInput;
  inputPath?: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The runtime's "same content": line endings and trailing newlines aside (gate.mjs `canonical`). */
export const contentDigest = (content: string) => sha256(content.replace(/\r\n/g, "\n").replace(/\n+$/, ""));

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/**
 * The carrier's prompt is exactly three lines -- `人闸 <callId> · 运行 <runId>：<title>`, `request: <path>`,
 * `sha256: <hex>` (gate.mjs prepareGate, which keeps the title to one line) -- or null. Nothing before,
 * between or after: a pointer cannot be slipped in through the title. When the run was started from
 * inside another agent's session, Paseo hands the prompt over wrapped as that agent's message
 * (`<paseo-system ...>` ... `</paseo-system>`, its text XML-escaped); that wrapper is taken off first.
 */
export function parsePointer(prompt: string): { path: string; sha256: string } | null {
  let text = prompt.replace(/\r\n/g, "\n").trim();
  const envelope = /^<paseo-system(?:\s+[a-z-]+="[^"<>]*")*>\n([\s\S]*)\n<\/paseo-system>$/.exec(text);
  if (envelope) text = envelope[1].replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name: string) => XML_ENTITIES[name]).trim();
  const lines = /^人闸 [^\n]*\nrequest: ([^\n]+)\nsha256: ([0-9a-f]{64})$/.exec(text);
  return lines ? { path: lines[1].trim(), sha256: lines[2] } : null;
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

/** The three lines the runtime's receiptFor (gate.mjs) gives; the provider writes this, never the file's own text. */
export function receiptFor(request: Pick<GateRequest, "title" | "runId" | "callId" | "sha256">): string {
  const decision = request.title.replace(/\s+/g, " ").trim();
  return [decision.startsWith("批准") ? decision : `批准：${decision}`, `人闸 ${request.callId} · 运行 ${request.runId}`, `内容 sha256 ${request.sha256}`].join("\n");
}

/** The longest value a card takes; the same bound in the runtime (gate.mjs INPUT_MAX_CHARS). */
export const INPUT_MAX_CHARS = 1000;
/** A secret shorter than this cannot be kept out of the run's logs by matching it, so it is not taken (gate.mjs MIN_SECRET_CHARS). */
export const MIN_SECRET_CHARS = 4;

/** Why `value` is not an acceptable input, or null: not empty, not over- or under-long, the whole of it matches the pattern. */
export function inputProblem(value: unknown, input: Pick<GateInput, "pattern" | "hint" | "secret">): string | null {
  if (typeof value !== "string" || value.trim() === "") return "没有填写";
  if (value.length > INPUT_MAX_CHARS) return `太长（最多 ${INPUT_MAX_CHARS} 个字符）`;
  if (input.secret && value.length < MIN_SECRET_CHARS) return `太短（至少 ${MIN_SECRET_CHARS} 个字符）`;
  if (input.pattern !== null && !new RegExp(`^(?:${input.pattern})$`).test(value)) {
    return input.hint.trim() !== "" ? `格式不对（要求：${input.hint.trim()}）` : "格式不对";
  }
  return null;
}

const isGateInput = (value: unknown): value is GateInput => {
  if (!value || typeof value !== "object") return false;
  const i = value as Record<string, unknown>;
  if (!isString(i.label) || i.label.trim() === "" || typeof i.secret !== "boolean" || !isString(i.hint)) return false;
  if (!(i.pattern === null || isString(i.pattern))) return false;
  try {
    if (isString(i.pattern)) new RegExp(`^(?:${i.pattern})$`);
  } catch {
    return false;
  }
  return true;
};

const REQUEST_SUFFIX = ".request.json";
const sameFile = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
/** `file` sits directly in `dir`. */
const insideDir = (dir: string, file: string) => sameFile(path.dirname(path.resolve(file)), dir);

/**
 * Read and check the request a prompt points at. Throws RequestError on anything that does not hold.
 *
 * Nothing in the request says who wrote it: the sha256 in the prompt comes from whoever sent the prompt.
 * So the files the provider writes are not taken from it. The answer goes next to the request, named
 * after it (`<callId>.request.json` -> `<callId>.answer.json`); the receipt must be a `*.receipt.txt`
 * in the same directory, and its text is the provider's own, from the title, run, call and sha256.
 * Both are created, never overwritten (the runtime removes them before it starts the carrier).
 */
export async function readRequest(prompt: string): Promise<GateRequest> {
  const pointer = parsePointer(prompt);
  if (!pointer) throw new RequestError("the prompt does not name a gate request (人闸 / request: / sha256: lines)");
  if (!pointer.path.endsWith(REQUEST_SUFFIX)) throw new RequestError(`the request ${pointer.path} is not named <callId>${REQUEST_SUFFIX}`);
  const dir = path.dirname(path.resolve(pointer.path));
  const callId = path.basename(pointer.path).slice(0, -REQUEST_SUFFIX.length);
  // Derived from the pointer alone, so a failure can be recorded before the file is trusted.
  const answerPath = path.join(dir, `${callId}.answer.json`);
  const text = await readFile(pointer.path, "utf8").catch((error: unknown) => {
    throw new RequestError(`cannot read the request ${pointer.path}: ${error instanceof Error ? error.message : String(error)}`, answerPath);
  });
  if (sha256(text) !== pointer.sha256) throw new RequestError("the request file does not match its sha256: it changed after the runtime wrote it", answerPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestError(`the request ${pointer.path} is not JSON`, answerPath);
  }
  const r = (parsed ?? {}) as Record<string, unknown>;
  const fields = ["runId", "callId", "title", "summary", "brief", "name", "content", "sha256", "receipt", "receiptPath", "answerPath", "timeout", "help"];
  const missing = fields.filter((key) => !isString(r[key]));
  if (r.v !== 1 || r.kind !== "orchestration-gate/request" || missing.length > 0 || !Array.isArray(r.evidence) || !r.evidence.every(isEvidence)) {
    throw new RequestError(`the request is not a v1 gate request${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}`, answerPath);
  }
  if ("input" in r && r.input !== undefined && !isGateInput(r.input)) throw new RequestError("the request's input is not { label, secret, pattern, hint } with a pattern that compiles", answerPath);
  const request = parsed as GateRequest;
  // Both go into the receipt's second line as they are; a line break would add a line of the caller's choosing.
  const broken = (["runId", "callId"] as const).filter((key) => /[\r\n\u0085\u2028\u2029]/.test(request[key]));
  if (broken.length > 0) throw new RequestError(`the request's ${broken.join(" and ")} must be one line`, answerPath);
  if (request.callId !== callId) throw new RequestError(`the request names call ${request.callId}, but its file is named for ${callId}`, answerPath);
  if (!sameFile(request.answerPath, answerPath)) throw new RequestError(`the answer path must be ${answerPath}, next to the request`, answerPath);
  if (!insideDir(dir, request.receiptPath) || !request.receiptPath.endsWith(".receipt.txt")) {
    throw new RequestError(`the receipt path must be a *.receipt.txt next to the request, not ${request.receiptPath}`, answerPath);
  }
  if (request.input !== undefined) {
    const inputPath = path.join(dir, `${callId}.input.json`);
    if (!isString(request.inputPath) || !sameFile(request.inputPath, inputPath)) {
      throw new RequestError(`an input gate's value goes to ${inputPath}, next to the request`, answerPath);
    }
    request.inputPath = inputPath;
  }
  if (contentDigest(request.content) !== request.sha256) throw new RequestError("the content does not match the sha256 the request names", answerPath);
  if (request.receipt !== receiptFor(request)) throw new RequestError("the receipt is not the one the title, run, call and sha256 give", answerPath);
  return { ...request, answerPath };
}
