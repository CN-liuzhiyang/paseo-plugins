// Types for what a flow is written against: flow(), define(), the field
// builders, and `$`. They exist so that an editor catches a misspelled field
// of a step's answer, a phase id that was never declared, and a `mode` passed
// to $.ask -- before anything runs. They describe runtime/flow.mjs and
// runtime/run.mjs; the runtime checks the same things again when it runs.

/** A JSON Schema fragment that also carries, for the type checker only, the value it describes. */
export interface Field<T> {
  readonly type: string;
  readonly description?: string;
  /** Never present at runtime. */
  readonly __value?: T;
}

export type Fields = Record<string, Field<unknown>>;

/** The value a field map describes: every key present (R2). */
export type Shape<F extends Fields> = { -readonly [K in keyof F]: F[K] extends Field<infer T> ? T : never };

export function text(description?: string): Field<string>;
export function flag(description?: string): Field<boolean>;
export function count(description?: string): Field<number>;
export function choice<const V extends readonly string[]>(values: V, description?: string): Field<V[number]>;
export function list<T>(of: Field<T>, description?: string): Field<T[]>;
export function group<F extends Fields>(fields: F, description?: string): Field<Shape<F>>;

/** How far a step's effects may reach. Agents never get more than the workspace. */
export type Effects = "none" | "workspace";

/** A duration: 90s, 12m, 2h. */
export type Duration = `${number}${"s" | "m" | "h"}`;

export interface Step<Out, In> {
  readonly name: string;
  readonly effects: Effects;
  readonly schema: object;
  readonly fingerprint: string;
  readonly timeout: Duration | undefined;
  readonly title: string | undefined;
  readonly headline: string | null;
  for(input: In): string;
  /** Never present at runtime. */
  readonly __out?: Out;
}

export function define<F extends Fields, In = any>(definition: {
  name: string;
  effects: Effects;
  returns: F;
  prompt: (input: In) => string;
  timeout?: Duration;
  /** For people: the call's title in the events and on Paseo, unless $.ask passes its own. */
  title?: string;
  /** For people: the field of the answer that says it in one line. */
  headline?: keyof F & string;
}): Step<Shape<F>, In>;

export interface Phase<Id extends string = string> {
  readonly id: Id;
  readonly title: string;
}

/** Grants beyond the defaults. gate:allow does not exist on purpose. */
export type Grant = "gate:deny";

/** One thing wrong with an answer: where (a JSON pointer, "" for the whole answer) and what, written for the model that gave it. */
export interface Problem {
  at: string;
  say: string;
}

/** What a `check` returns: the problems found. Nothing, null or an empty list is a pass; a string is one problem with the whole answer. */
export type Problems = readonly Problem[] | string | null | undefined | void;

/** "/edits/4/old" from `pointer("edits", 4, "old")`; a "/" or "~" in a key is escaped. */
export function pointer(...segments: (string | number)[]): string;

/** What `$.ask` throws when the answer still does not pass after the corrections it was allowed. `rounds` counts the answers given, the first included. */
export class CheckFailed extends Error {
  readonly step: string;
  readonly problems: readonly Problem[];
  /** The answer as it stood after the last correction (null when none could be read). */
  readonly value: unknown;
  readonly rounds: number;
  /** The line a person reads where the run stopped. */
  readonly reason: string;
}

/** The answer is sent back to the agent that gave it, with only these problems, when it does not pass (CONVENTIONS.md "R6"). */
export interface AskOptions<Out = unknown> {
  role?: string;
  provider?: string;
  thinking?: string;
  title?: string;
  cwd?: string;
  timeout?: Duration;
  /**
   * Looks at an answer that fits the schema and returns what is wrong with it. The agent is asked, in the same session, to redo
   * only those places; the merged answer is looked at again. Still wrong after `fixes` rounds: `$.ask` throws `CheckFailed`
   * (a run that lets it through ends as stopped). A throw is a bug in the check and fails the call.
   */
  check?: (answer: Out, info: { round: number }) => Problems | Promise<Problems>;
  /** How many times the answer may be sent back: 0 to 5, default 2. 0 leaves a reply that does not fit the schema to the CLI's own retries. */
  fixes?: number;
  /**
   * "after": archive the call's agent once it has handed in its answer (not when the call failed). What it was given and what it
   * handed back are in the run's events, so the agent is not a place anyone needs to open. Absent: it is left for a person to archive.
   */
  archive?: "after";
  /**
   * In a run that carries another on, the answer the earlier run got to the same question is taken from the journal instead of asking
   * again. For a step with `effects: "workspace"` that happens only if this says the files are still as the answer left them.
   */
  reuse?: (answer: Out) => boolean | Promise<boolean>;
  /** Gone: the step's `effects` choose the mode, through runtime/fences.mjs. */
  mode?: never;
}

/** What `$.again` takes beyond the question. Naming who asks (role, provider, thinking, cwd) only makes sense for a new agent. */
export interface AgainOptions<Out = unknown> {
  /** A new agent instead of the one that answered: given the previous version in a file, and free to be another role. */
  fresh?: boolean;
  role?: string;
  provider?: string;
  thinking?: string;
  cwd?: string;
  title?: string;
  timeout?: Duration;
  /** Default: the previous call's. `null` turns it off, a function replaces it. */
  check?: ((answer: Out, info: { round: number }) => Problems | Promise<Problems>) | null;
  fixes?: number;
  /** Default: the previous call's. `null` turns it off. */
  archive?: "after" | null;
}

/** What a step's `probe` finds out about a step that may or may not have been done. */
export type ProbeResult<T> = { done: true; value: T } | { done: false };

export interface StepOptions<T, B = undefined> {
  /** What the step depends on: anything JSON. A run that carries this one on takes the step from the journal only if the key is the same. */
  key?: unknown;
  /** Looks at the value of an earlier run; false does the step again (a copy someone changed, a result that did not take effect). */
  still?: (value: T) => boolean | Promise<boolean>;
  /** The step cannot be taken back: it is written as begun before it acts, and never done again on a guess. */
  once?: boolean;
  /** With `once`: looks outside to see whether a step that began and left no word was done. Without one the run stops for a person (`orch.mjs settle`). */
  probe?: () => ProbeResult<T> | Promise<ProbeResult<T>>;
  /** With `once`: what authorises the step (a card), run before it is written as begun and handed to `fn`. It is not kept. */
  before?: () => B | Promise<B>;
  title?: string;
}

export interface GateEvidence {
  /** One line naming what this is, e.g. "要实现的修复 r7237410". */
  label: string;
  text: string;
  /** "diff" is shown as a diff (unified format); "text" as a file. Default "text". */
  kind?: "diff" | "text";
  /** A file name for syntax highlighting. */
  name?: string;
}

export interface GateRequest {
  /** The decision, as the person reads it on the card: "批准 hotfix #1 放进 …". Up to 120 characters. */
  title: string;
  /** The bytes being approved; the flow writes these after an approval. */
  content: string;
  /** The content's file name, for highlighting and the card. Default "content.txt". */
  name?: string;
  /** The card's description: a few short plain-text lines -- the result, the checks, what to look at. */
  summary?: string;
  /** Markdown above the card: everything a person needs to judge the content. */
  brief?: string;
  /** Shown above the card, folded, in order. */
  evidence?: GateEvidence[];
  timeout?: Duration;
  /** Where the receipt goes. Default <runDir>/gate/<callId>.receipt.txt. */
  holdPath?: string;
  /**
   * Approve *with a value* (a verification code, say). The card has a text field; "提交" is the approval and
   * carries the value, the dismiss button (不批) denies. Needs the orch-gate provider as the carrier.
   */
  input?: GateInput;
}

export interface GateInput {
  /** What the field is called on the card. */
  label: string;
  /** Default true: the value never appears in the run's events, logs or errors (shown as "<已用>"). */
  secret?: boolean;
  /** A regular expression the whole value must match. A wrong entry is sent back to the person, not counted as an answer. */
  pattern?: string;
  /** Said on the card and in the "wrong format" message, e.g. "6 位数字". */
  hint?: string;
}

export interface GateDecision {
  outcome: "allowed" | "denied" | "expired" | "mismatch" | "error";
  approved: boolean;
  agentId: string | null;
  sha256: string;
  askedAt: string;
  decidedAt: string;
  waitedMs: number;
  reason: string | null;
  agentReport: string;
  by: string;
  agentStatusAtDecision: string | null;
  /** How the answer came, as the answering client sent it -- a weak signal, not who answered. Null when not known. */
  answeredVia: "button" | "no-button" | "typed" | "form" | "dismiss" | null;
  /** Only on a gate that asked for a value (`input`): the value when approved, else null. In memory; see GateInput.secret. */
  input?: string | null;
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

type Task = PromiseLike<unknown> | (() => unknown);
type Result<T> = T extends () => infer R ? Awaited<R> : Awaited<T>;

export interface RunContext {
  readonly runId: string;
  /** The Paseo agent that started the run, or null from a terminal. */
  readonly caller: string | null;
  readonly cwd: string;
  readonly host: string | null;
  /** `<logDir>/runs/<runId>/`, for this run's files. Not created until something writes there. */
  readonly runDir: string;
  /** This run's events file. */
  readonly events: string;
  /** The first run of the line of runs this one belongs to (its own id when it carries nothing on): the line shares a journal. */
  readonly lineage: string;
  /** `<logDir>/runs/<lineage>/`: where the line's files may go, the same in every run of it. */
  readonly lineDir: string;
  /** Whether this run carries another on. */
  readonly resumed: boolean;
  /** Resolve a role, or throw if there is none by that name. */
  role(name: string): { role: string | null; provider: string; thinking: string | null };
}

/** A flow's name as `$.resumeWith` takes it: a literal with a slash, a backslash or a dot in it (a path, a file name) does not type-check. */
export type FlowName<N extends string> = N extends `${string}/${string}` | `${string}\\${string}` | `${string}.${string}` ? never : N;

/**
 * How a run that does not come to its end could be carried on: the flow to start, its input, a line for the person who will see
 * it, and whether it may call a model. Every field is required.
 */
export interface ResumePoint<N extends string = string> {
  /** A flow found by name (the shipped flows and `flowsDirs`), never a path. It may be the flow that is running. */
  flow: FlowName<N>;
  /** That flow's input, as its `inputs` ask for it. Nothing the run keeps secret: it would be written as "<已用>". */
  input: object;
  /** One line, at most 60 characters, for the person: where it picks up, and anything that is done again without asking. */
  from: string;
  /** "nothing": no model is called. "maybe": one may be. */
  spends: "nothing" | "maybe";
}

export interface Dollar<PhaseId extends string> {
  ask<Out, In>(step: Step<Out, In>, input: In, options?: AskOptions<Out>): Promise<Out>;
  /**
   * Say something more to the agent that gave `prev` (the object `$.ask` or `$.again` returned, as it is) and get the whole
   * answer again: the same agent, with its conversation, even if it was archived since. If it is gone, a new one is asked and
   * given the previous version. `$.again(prev, step, input)` asks another step of the same agent.
   */
  again<Out>(prev: Out, text: string, options?: AgainOptions<Out>): Promise<Out>;
  again<Out, In>(prev: unknown, step: Step<Out, In>, input: In, options?: AgainOptions<Out>): Promise<Out>;
  /**
   * A step done once for the line of runs: a run that carries this one on takes its value from the journal. The value is JSON (what comes
   * back is what a later run gets too), at most 1 MB. A step's name is its identity and is used once per run. Inside, `$.ask`, `$.gate` and
   * more steps work as anywhere; when the step is taken from the journal none of them runs.
   */
  step<T, B = undefined>(name: string, fn: (before: B) => T | Promise<T>, options?: StepOptions<T, B>): Promise<T>;
  do<T>(name: string, fn: () => T | Promise<T>, options?: { title?: string }): Promise<T>;
  gate(request: GateRequest): Promise<GateDecision>;
  phase<T>(id: PhaseId, fn: () => T | Promise<T>): Promise<T>;
  all<const T extends readonly Task[]>(tasks: T): Promise<{ -readonly [K in keyof T]: Settled<Result<T[K]>> }>;
  stop(reason: string, value?: unknown): never;
  /**
   * Say how this run could be carried on if it stops, fails, times out or is cut off. The last call wins; `null` takes it back. One that
   * does not fit is a warning and a caveat, not a failed run, and the one before it stands. A run that comes to done records none.
   */
  resumeWith<const N extends string>(point: ResumePoint<N> | null): Promise<void>;
  /** In a flow with `resume: "auto"`: only what differs from running this flow again with the same input (another flow is the whole point above). */
  resumeWith(point: { input?: object; from?: string; spends?: "nothing" | "maybe" }): Promise<void>;
  readonly log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  readonly ctx: RunContext;
}

export interface Flow<I extends Fields, R> {
  readonly name: string;
  readonly description: string;
  readonly phases: readonly Phase[];
  readonly inputs: object;
  readonly grants: readonly Grant[];
  run(input: Shape<I>, $: Dollar<string>): Promise<R>;
  readonly summarize: Summarize | null;
  readonly resume: "auto" | null;
  readonly wake: "problems" | null;
}

/**
 * The run's one line for people, from the value run.end records: what `run`
 * returned when done, the value given to $.stop when stopped -- so `any`.
 */
export type Summarize = (value: any, info: { outcome: "done" | "stopped" }) => string;

export function flow<I extends Fields, const P extends readonly Phase[], R>(definition: {
  name: string;
  description: string;
  phases: P;
  inputs: I;
  grants: readonly Grant[];
  run(input: Shape<I>, $: Dollar<P[number]["id"]>): Promise<R>;
  summarize?: Summarize;
  /**
   * "auto": a run that does not come to its end is carried on by running this flow again with the same input; what the earlier runs did is
   * taken from the journal. The flow promises that everything it cannot take back is in a `once` step.
   */
  resume?: "auto";
  /**
   * "problems": the steward (the session that watches the runs of flows, CONVENTIONS.md) is told only of runs that did not come to done.
   * Left out, it is told of every run. A session that asked to be told (`--notify`, a `--detach`ed run) is told either way.
   */
  wake?: "problems";
}): Flow<I, R>;

export function isFlow(value: unknown): value is Flow<Fields, unknown>;
export function describeFlow(flow: Flow<Fields, unknown>): object;
export function loadFlow(target: string | Flow<Fields, unknown>): Promise<{ flow: Flow<Fields, unknown>; source: string | null; text: string | null }>;
export function checkFlow(
  target: string | Flow<Fields, unknown>,
  options?: { roster?: object },
): Promise<{ ok: boolean; flow: object | null; steps: object[]; problems: string[]; warnings: string[]; notChecked: string[] }>;
export function scanSource(flow: Flow<Fields, unknown>, source: string): string[];
export const DEFAULT_GRANTS: readonly string[];
export const GRANTS: Record<Grant, string>;
export const NOT_CHECKED: readonly string[];
