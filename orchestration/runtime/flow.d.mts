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

export interface AskOptions {
  role?: string;
  provider?: string;
  thinking?: string;
  title?: string;
  cwd?: string;
  timeout?: Duration;
  /** Gone: the step's `effects` choose the mode, through runtime/fences.mjs. */
  mode?: never;
}

export interface GateRequest {
  title: string;
  content: string;
  brief?: string;
  timeout?: Duration;
  holdPath?: string;
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
  /** Resolve a role, or throw if there is none by that name. */
  role(name: string): { role: string | null; provider: string; thinking: string | null };
}

export interface Dollar<PhaseId extends string> {
  ask<Out, In>(step: Step<Out, In>, input: In, options?: AskOptions): Promise<Out>;
  do<T>(name: string, fn: () => T | Promise<T>, options?: { title?: string }): Promise<T>;
  gate(request: GateRequest): Promise<GateDecision>;
  phase<T>(id: PhaseId, fn: () => T | Promise<T>): Promise<T>;
  all<const T extends readonly Task[]>(tasks: T): Promise<{ -readonly [K in keyof T]: Settled<Result<T[K]>> }>;
  stop(reason: string, value?: unknown): never;
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
