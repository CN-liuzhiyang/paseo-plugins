import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Settings } from "./settings";

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

const defaultDir = fileURLToPath(new URL("../../orchestration/", import.meta.url));
const tail = (value: string) => Buffer.from(value).subarray(-2048).toString("utf8");
const head = (value: string) => Buffer.from(value).subarray(0, 2048).toString("utf8");

// No shell: on Windows invoke the real node executable, never node.cmd.
async function child(args: string[], signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string; aborted: boolean }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", aborted = false;
    let killing: Promise<void> = Promise.resolve();
    const abort = () => {
      aborted = true;
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
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    proc.stdout.setEncoding("utf8"); proc.stdout.on("data", (s: string) => { stdout += s; });
    proc.stderr.setEncoding("utf8"); proc.stderr.on("data", (s: string) => { stderr = tail(stderr + s); });
    proc.once("error", (error) => { signal.removeEventListener("abort", abort); reject(error); });
    proc.once("close", (code) => { signal.removeEventListener("abort", abort); void killing.then(() => resolve({ code, stdout, stderr, aborted })); });
  });
}

function json(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
const checkSchema = z.object({ ok: z.literal(true), flow: z.object({ inputs: z.object({ properties: z.record(z.string(), z.unknown()) }) }) });
const resultSchema = z.object({
  ok: z.boolean(), outcome: z.enum(["done", "stopped", "failed", "timeout"]), runId: z.string(),
  events: z.string(), durationMs: z.number().nonnegative(), cost: z.unknown(), caveats: z.array(z.string()), value: z.unknown(),
});

export async function runFlow(input: ActionInput, context: ActionContext, settings: Settings): Promise<{ text: string }> {
  const { flow, input: supplied } = paramsSchema.parse(input.params);
  if (!settings.allowedFlows.includes(flow)) throw new Error(`流程 ${flow} 不在允许清单里`);
  const id = `auto-${createHash("sha256").update(input.run.runId).digest("hex")}`;
  const orch = path.join(settings.orchestrationDir ?? defaultDir, "runtime", "orch.mjs");
  let stderr = "";
  try {
    const checked = await child([orch, "check", flow], context.signal);
    stderr = checked.stderr;
    const info = checkSchema.safeParse(json(checked.stdout));
    if (checked.aborted || checked.code !== 0 || !info.success) throw new Error("流程检查失败或已取消");
    const values = { ...supplied };
    if (Object.hasOwn(info.data.flow.inputs.properties, "automationPrompt")) values.automationPrompt = input.prompt;
    else delete values.automationPrompt;
    const dir = await mkdtemp(path.join(tmpdir(), "automation-flow-"));
    try {
      const file = path.join(dir, "input.json");
      await writeFile(file, JSON.stringify(values), { encoding: "utf8", mode: 0o600 });
      const result = await child([orch, "run", flow, "--input", `@${file}`, "--timeout", settings.defaultTimeout, "--run-id", id], context.signal);
      stderr = result.stderr;
      const raw = json(result.stdout);
      const parsed = resultSchema.safeParse(raw);
      if (result.aborted || result.code !== 0 || !parsed.success || !raw || typeof raw !== "object" || !Object.hasOwn(raw, "cost")) throw new Error("流程运行失败、已取消或输出无效");
      const data = parsed.data;
      if (!data.ok || data.runId !== id || !["done", "stopped"].includes(data.outcome)) throw new Error(`流程结果 ${data.outcome}`);
      return { text: `流程: ${flow}\nrunId: ${data.runId}\noutcome: ${data.outcome}\n耗时: ${data.durationMs}ms\ncost: ${JSON.stringify(data.cost)}\ncaveats: ${JSON.stringify(data.caveats)}\nvalue: ${head(JSON.stringify(data.value) ?? "null")}\n事件文件: ${data.events}` };
    } finally { await rm(dir, { recursive: true, force: true }); }
  } catch (error) {
    throw new Error(`runId ${id}: ${String(error)}; stderr: ${tail(stderr)}`);
  }
}
