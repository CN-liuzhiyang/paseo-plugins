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
    const dir = await mkdtemp(path.join(tmpdir(), "automation-flow-"));
    try {
      const file = path.join(dir, "input.json");
      await writeFile(file, JSON.stringify(values), { encoding: "utf8", mode: 0o600 });
      const remainingSeconds = Math.max(1, Math.floor((timeoutMs(settings.defaultTimeout) - (Date.now() - started) - 60000) / 1000));
      const result = await execute([orch, "run", flow, "--input", `@${file}`, "--timeout", `${remainingSeconds}s`, "--run-id", id], context.signal);
      stderr = result.stderr;
      if (result.overflow) throw new Error("流程运行 stdout 超过 1MB");
      const raw = json(result.stdout);
      const parsed = resultSchema.safeParse(raw);
      if (result.aborted || result.code !== 0 || !parsed.success || !raw || typeof raw !== "object" || !Object.hasOwn(raw, "cost")) throw new Error("流程运行失败、已取消或输出无效");
      const data = parsed.data;
      if (!data.ok || data.runId !== id || !["done", "stopped"].includes(data.outcome)) throw new Error(`流程结果 ${data.outcome}`);
      const events = path.win32.basename(path.posix.basename(data.events));
      return { text: `流程: ${flow}\nrunId: ${data.runId}\noutcome: ${data.outcome}\n耗时: ${data.durationMs}ms\ncost: ${head(JSON.stringify(data.cost) ?? "null")}\ncaveats: ${head(JSON.stringify(data.caveats))}\nvalue: ${head(JSON.stringify(data.value) ?? "null")}\n事件文件: ${events}` };
    } finally { await rm(dir, { recursive: true, force: true }); }
  } catch (error) {
    throw new Error(`runId ${id}: ${String(error)}; stderr: ${tail(stderr)}`);
  }
}
