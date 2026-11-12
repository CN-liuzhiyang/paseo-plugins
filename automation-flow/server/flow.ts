import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { timeoutMs, type Settings } from "./settings";

export const paramsSchema = z.object({
  flow: z.string().regex(/^[a-z][a-z0-9-]*$/),
  input: z.record(z.string(), z.unknown()).optional(),
});
export type ActionInput = {
  params: z.output<typeof paramsSchema>;
  prompt: string;
  run: { automationId: string; automationName: string | null; runId: string };
  trigger: unknown;
  cwd: string | null;
};
export type ActionContext = { signal: AbortSignal };
export type ActionRegistration = {
  id: string; label?: string; description?: string; params: typeof paramsSchema;
  defaultTimeoutMs?: number;
  run(input: ActionInput, context: ActionContext): Promise<{ text: string; agentId?: string | null }>;
};

const tail = (value: string) => Buffer.from(value).subarray(-2048).toString("utf8");
const head = (value: string) => Buffer.from(value).subarray(0, 2048).toString("utf8");

const TRIGGER_DATA_LIMIT = 16 * 1024;

// Event payloads are untrusted. Ordinary JSON objects pass through; data whose serialized form
// exceeds 16KB becomes a marked preview, so a flow cannot mistake it for the full object.
function boundedData(data: Record<string, unknown>): unknown {
  const encoded = JSON.stringify(data);
  const bytes = Buffer.byteLength(encoded);
  if (bytes <= TRIGGER_DATA_LIMIT) return data;
  for (let size = 8 * 1024; ; size = Math.floor(size / 2)) {
    const preview = { truncated: true, bytes, preview: Buffer.from(encoded).subarray(0, size).toString("utf8") };
    if (Buffer.byteLength(JSON.stringify(preview)) <= TRIGGER_DATA_LIMIT) return preview;
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === "string" ? value : undefined;

// Mirrors the host's RunTrigger: event carries the event inline, manual may carry one under `event`
// (with `id` rather than `eventId`), clock carries none and is not passed.
export function automationTrigger(raw: unknown): Record<string, unknown> | undefined {
  const t = record(raw);
  if (!t || (t.type !== "event" && t.type !== "manual")) return undefined;
  const event = t.type === "manual" ? record(t.event) ?? {} : t;
  const data = record(event.data);
  const fields = {
    type: t.type, source: t.type === "event" ? text(t.source) : undefined, event: text(event.event),
    eventId: text(t.type === "manual" ? event.id : event.eventId), subject: text(event.subject),
    data: data && boundedData(data),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

// orch prints its result JSON even when it exits 1; its outcome and error say why.
function failureDetails(raw: unknown): string {
  const value = record(raw);
  if (!value) return "";
  const message = text(record(value.error)?.message);
  const parts = [text(value.outcome) && `outcome: ${value.outcome}`, message && `error: ${message}`].filter(Boolean);
  return parts.length ? `: ${head(parts.join("; "))}` : "";
}

// No shell: on Windows invoke the real node executable, never node.cmd.
type ChildResult = { code: number | null; stdout: string; stderr: string; aborted: boolean; overflow: boolean };
async function child(args: string[], signal: AbortSignal): Promise<ChildResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0, stderr = "", aborted = false, overflow = false, stopping = false;
    let killing: Promise<void> = Promise.resolve();
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (!proc.pid) return;
      if (process.platform === "win32") {
        killing = new Promise<void>((done) => {
          const killer = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(proc.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => { proc.kill(); done(); });
          killer.once("close", () => done());
        });
      } else {
        try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
      }
    };
    const abort = () => { aborted = true; stop(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    proc.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) { overflow = true; stop(); }
      else chunks.push(chunk);
    });
    proc.stderr.setEncoding("utf8"); proc.stderr.on("data", (s: string) => { stderr = tail(stderr + s); });
    proc.once("error", (error) => { signal.removeEventListener("abort", abort); reject(error); });
    proc.once("close", (code) => { signal.removeEventListener("abort", abort); void killing.then(() => resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), stderr, aborted, overflow })); });
  });
}

function json(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
const checkSchema = z.object({ ok: z.literal(true), flow: z.object({ inputs: z.object({ properties: z.record(z.string(), z.unknown()) }) }) });
const resultSchema = z.object({
  ok: z.boolean(), outcome: z.enum(["done", "stopped", "failed", "timeout"]), runId: z.string(),
  events: z.string(), durationMs: z.number().nonnegative(), cost: z.unknown(), caveats: z.array(z.string()), value: z.unknown(),
});

export async function runFlow(input: ActionInput, context: ActionContext, settings: Settings, execute = child): Promise<{ text: string }> {
  const started = Date.now();
  const { flow, input: supplied } = paramsSchema.parse(input.params);
  if (!settings.allowedFlows.includes(flow)) throw new Error(`流程 ${flow} 不在允许清单里`);
  const id = `auto-${createHash("sha256").update(input.run.runId).digest("hex")}`;
  if (!settings.orchestrationDir) throw new Error(`runId ${id}: 无法获取插件目录，请在 automation-flow 设置中指定 orchestrationDir`);
  const orch = path.join(settings.orchestrationDir, "runtime", "orch.mjs");
  let stderr = "";
  try {
    const checked = await execute([orch, "check", flow], context.signal);
    stderr = checked.stderr;
    if (checked.overflow) throw new Error("流程检查 stdout 超过 1MB");
    const checkOutput = json(checked.stdout);
    const info = checkSchema.safeParse(checkOutput);
    if (checked.aborted || checked.code !== 0 || !info.success) {
      const problems = z.object({ problems: z.array(z.unknown()) }).safeParse(checkOutput);
      throw new Error(`流程检查失败或已取消${problems.success ? `: ${head(JSON.stringify(problems.data.problems))}` : ""}`);
    }
    const values = { ...supplied };
    if (Object.hasOwn(info.data.flow.inputs.properties, "automationPrompt")) values.automationPrompt = input.prompt;
    else delete values.automationPrompt;
    delete values.automationTrigger;
    const trigger = automationTrigger(input.trigger);
    if (trigger && Object.hasOwn(info.data.flow.inputs.properties, "automationTrigger")) values.automationTrigger = trigger;
    const dir = await mkdtemp(path.join(tmpdir(), "automation-flow-"));
    try {
      const file = path.join(dir, "input.json");
      await writeFile(file, JSON.stringify(values), { encoding: "utf8", mode: 0o600 });
      const remainingSeconds = Math.max(1, Math.floor((timeoutMs(settings.defaultTimeout) - (Date.now() - started) - 60000) / 1000));
      const result = await execute([orch, "run", flow, "--input", `@${file}`, "--timeout", `${remainingSeconds}s`, "--run-id", id], context.signal);
      stderr = result.stderr;
      if (result.overflow) throw new Error("流程运行 stdout 超过 1MB");
      const raw = json(result.stdout);
      if (result.aborted) throw new Error("流程运行失败：已取消");
      const parsed = resultSchema.safeParse(raw);
      if (result.code !== 0 || !parsed.success || !record(raw) || !Object.hasOwn(raw as object, "cost")) {
        const details = failureDetails(raw);
        throw new Error(details ? `流程运行失败（退出码 ${result.code}）${details}` : `流程运行失败：退出码 ${result.code}，输出不是预期的 JSON`);
      }
      const data = parsed.data;
      if (!data.ok || data.runId !== id || !["done", "stopped"].includes(data.outcome)) throw new Error(`流程结果 ${data.outcome}${failureDetails(raw)}`);
      const events = path.win32.basename(path.posix.basename(data.events));
      return { text: `流程: ${flow}\nrunId: ${data.runId}\noutcome: ${data.outcome}\n耗时: ${data.durationMs}ms\ncost: ${head(JSON.stringify(data.cost) ?? "null")}\ncaveats: ${head(JSON.stringify(data.caveats))}\nvalue: ${head(JSON.stringify(data.value) ?? "null")}\n事件文件: ${events}` };
    } finally { await rm(dir, { recursive: true, force: true }); }
  } catch (error) {
    throw new Error(`runId ${id}: ${String(error)}; stderr: ${tail(stderr)}`);
  }
}
