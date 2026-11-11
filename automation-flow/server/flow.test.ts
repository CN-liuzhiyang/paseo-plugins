import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import contribute from "../index.server";
import { paramsSchema, runFlow, type ActionInput, type ActionRegistration } from "./flow";
import { settingsDefinition } from "./settings";

const input = (flow = "example-sync"): ActionInput => ({ params: { flow, input: { test: 42 } }, prompt: "异常原文", run: { automationId: "a", automationName: null, runId: "run-123" }, trigger: {}, cwd: null });
const stub = `
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [command, flow, ...args] = process.argv.slice(2);
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
if (command === 'check') {
  writeFileSync(config.log, 'check:' + flow);
  if (config.checkDelay) await new Promise(resolve => setTimeout(resolve, config.checkDelay));
  if (config.problems) { console.log(JSON.stringify({ok:false,problems:config.problems})); process.exit(2); }
  if (config.checkOverflow) { process.stdout.write('x'.repeat(1100000)); }
  else console.log(JSON.stringify({ok:true,flow:{inputs:{properties:config.prompt ? {automationPrompt:{type:'string'}} : {}}}}));
} else {
  const get = (flag) => args[args.indexOf(flag)+1];
  const values = JSON.parse(readFileSync(get('--input').slice(1), 'utf8'));
  writeFileSync(config.log, JSON.stringify({values, timeout:get('--timeout'), runId:get('--run-id'), file:get('--input').slice(1)}));
  if (config.sleep) {
    const sub = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {stdio:'ignore'});
    writeFileSync(config.pid, String(sub.pid));
    setInterval(()=>{}, 1000);
  } else if (config.invalid) console.log('not json');
  else if (config.overflow) process.stdout.write('x'.repeat(1100000));
  else {
    console.log(JSON.stringify({ok:config.outcome !== 'failed',outcome:config.outcome || 'done',value:{hello:'world'},runId:config.wrongId ? 'wrong' : get('--run-id'),events:config.events || 'events.jsonl',cost:config.cost ?? null,caveats:config.caveats || [],durationMs:123}));
    if (config.exit) process.exitCode = config.exit;
  }
}`;
async function fixture(config: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "flow-test-"));
  await mkdir(path.join(dir, "runtime"));
  const log = path.join(dir, "log"), pid = path.join(dir, "pid");
  await writeFile(path.join(dir, "config.json"), JSON.stringify({ ...config, log, pid }));
  await writeFile(path.join(dir, "runtime", "orch.mjs"), stub);
  return { dir, log, pid, settings: { allowedFlows: ["example-sync"], orchestrationDir: dir, defaultTimeout: "30m" }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const signal = () => new AbortController().signal;

test("rejects names and injections before executing anything", async () => {
  const f = await fixture();
  try {
    for (const flow of ["../bad", "..", "a/b", "a\\b", "a b", "a;b", "UPPER", ""]) assert.equal(paramsSchema.safeParse({ flow }).success, false, flow);
    await assert.rejects(runFlow(input("other"), { signal: signal() }, f.settings), /流程 other 不在允许清单里/);
    await assert.rejects(readFile(f.log));
  } finally { await f.cleanup(); }
});
for (const prompt of [true, false]) test(`passes automationPrompt only when declared: ${prompt}`, async () => {
  const f = await fixture({ prompt });
  try {
    const result = await runFlow(input(), { signal: signal() }, f.settings);
    const log = JSON.parse(await readFile(f.log, "utf8"));
    assert.deepEqual(log.values, prompt ? { test: 42, automationPrompt: "异常原文" } : { test: 42 });
    assert.match(log.runId, /^auto-[a-f0-9]{64}$/); assert.ok(Number.parseInt(log.timeout) <= 1740 && Number.parseInt(log.timeout) >= 1738);
    assert.match(result.text, /events.jsonl/); assert.match(result.text, /outcome: done/);
    await assert.rejects(readFile(log.file));
  } finally { await f.cleanup(); }
});
for (const config of [{ outcome: "failed" }, { outcome: "timeout" }, { exit: 2 }, { invalid: true }]) test(`failure: ${JSON.stringify(config)}`, async () => {
  const f = await fixture(config);
  try { await assert.rejects(runFlow(input(), { signal: signal() }, f.settings), /runId auto-.*stderr:/); }
  finally { await f.cleanup(); }
});
test("abort kills the running process tree and removes input", async () => {
  const f = await fixture({ sleep: true }); const controller = new AbortController();
  try {
    const promise = runFlow(input(), { signal: controller.signal }, f.settings);
    let pid = 0;
    for (let i = 0; i < 100; i++) { try { pid = Number(await readFile(f.pid, "utf8")); break; } catch { await delay(50); } }
    assert.ok(pid, "stub started its child");
    const log = JSON.parse(await readFile(f.log, "utf8")); controller.abort();
    await assert.rejects(promise, /runId auto-/);
    await assert.rejects(readFile(log.file));
    if (process.platform === "win32") {
      const { execFileSync } = await import("node:child_process");
      const tasklist = execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe"), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
      assert.doesNotMatch(tasklist, new RegExp(`"${pid}"`));
    } else { assert.throws(() => process.kill(pid, 0)); }
  } finally { controller.abort(); await f.cleanup(); }
});
test("old host loads without registerAction", () => { assert.equal(typeof contribute({} as never), "function"); });
test("registers configured timeout and reads current allowlist", async () => {
  let action: ActionRegistration | undefined;
  let values = settingsDefinition.schema.parse({ defaultTimeout: "45m" });
  const server = { registerSettings: () => ({ read: async () => ({ status: "ready", values }) }), registerAction: (a: ActionRegistration) => { action = a; } };
  contribute(server as never); await delay(10);
  assert.ok(action); assert.equal(action.defaultTimeoutMs, 2700000);
  values = settingsDefinition.schema.parse({ allowedFlows: [] });
  await assert.rejects(action.run(input(), { signal: signal() }), /不在允许清单/);
  assert.equal(settingsDefinition.schema.safeParse({ defaultTimeout: "61m" }).success, false);
});

for (const code of [1, 2]) test(`rejects exit ${code} even with valid success JSON`, async () => {
  const f = await fixture({ exit: code });
  try { await assert.rejects(runFlow(input(), { signal: signal() }, f.settings), /流程运行失败/); }
  finally { await f.cleanup(); }
});
test("rejects mismatched runId", async () => {
  const f = await fixture({ wrongId: true });
  try { await assert.rejects(runFlow(input(), { signal: signal() }, f.settings), /流程结果/); }
  finally { await f.cleanup(); }
});
test("rejects valid JSON delivered after abort", async () => {
  const f = await fixture(); const controller = new AbortController();
  try {
    const execute = async (args: string[], abort: AbortSignal) => {
      if (args[1] === "check") return { code: 0, stdout: JSON.stringify({ ok: true, flow: { inputs: { properties: {} } } }), stderr: "", aborted: false, overflow: false };
      await new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve(), { once: true }));
      return { code: 0, stdout: JSON.stringify({ ok: true, outcome: "done", value: null, runId: args[args.indexOf("--run-id") + 1], events: "e", cost: null, caveats: [], durationMs: 1 }), stderr: "", aborted: true, overflow: false };
    };
    const promise = runFlow(input(), { signal: controller.signal }, f.settings, execute);
    await delay(100); controller.abort();
    await assert.rejects(promise, /流程运行失败/);
  } finally { controller.abort(); await f.cleanup(); }
});
test("stopped is successful", async () => {
  const f = await fixture({ outcome: "stopped" });
  try { assert.match((await runFlow(input(), { signal: signal() }, f.settings)).text, /outcome: stopped/); }
  finally { await f.cleanup(); }
});
test("reports check problems within 2KB", async () => {
  const f = await fixture({ problems: ["missing input", "x".repeat(5000)] });
  try { await assert.rejects(runFlow(input(), { signal: signal() }, f.settings), (e: Error) => e.message.includes("missing input") && Buffer.byteLength(e.message) < 2300); }
  finally { await f.cleanup(); }
});
for (const key of ["checkOverflow", "overflow"]) test(`rejects oversized stdout: ${key}`, async () => {
  const f = await fixture({ [key]: true });
  try { await assert.rejects(runFlow(input(), { signal: signal() }, f.settings), /stdout 超过 1MB/); }
  finally { await f.cleanup(); }
});
test("bounds result fields and removes event path", async () => {
  const f = await fixture({ events: "C:\\private\\events.jsonl", cost: { detail: "a".repeat(4000) }, caveats: ["b".repeat(4000)] });
  try {
    const { text } = await runFlow(input(), { signal: signal() }, f.settings);
    assert.ok(Buffer.byteLength(text) < 4500); assert.doesNotMatch(text, /private/); assert.match(text, /事件文件: events.jsonl/);
  } finally { await f.cleanup(); }
});
test("check time counts against timeout and minimum is one second", async () => {
  const f = await fixture({ checkDelay: 1100 });
  try {
    await runFlow(input(), { signal: signal() }, { ...f.settings, defaultTimeout: "120s" });
    const log = JSON.parse(await readFile(f.log, "utf8"));
    assert.ok(Number.parseInt(log.timeout) <= 58 && Number.parseInt(log.timeout) >= 55);
    await runFlow(input(), { signal: signal() }, { ...f.settings, defaultTimeout: "1s" });
    assert.equal(JSON.parse(await readFile(f.log, "utf8")).timeout, "1s");
  } finally { await f.cleanup(); }
});
for (const failed of ["invalid", "throws"]) test(`registers with default timeout when settings ${failed}`, async () => {
  let action: ActionRegistration | undefined;
  let fixed = false;
  const server = {
    registerSettings: () => ({ read: async () => {
      if (fixed) return { status: "ready", values: settingsDefinition.schema.parse({ allowedFlows: [] }) };
      if (failed === "throws") throw new Error("unavailable");
      return { status: "invalid", error: "bad settings" };
    } }),
    registerAction: (a: ActionRegistration) => { action = a; },
  };
  contribute(server as never); await delay(10);
  assert.ok(action); assert.equal(action.defaultTimeoutMs, 1800000);
  await assert.rejects(action.run(input(), { signal: signal() }), /bad settings|unavailable/);
  fixed = true;
  await assert.rejects(action.run(input(), { signal: signal() }), /不在允许清单/);
});
