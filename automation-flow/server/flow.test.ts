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
  console.log(JSON.stringify({ok:true,flow:{inputs:{properties:config.prompt ? {automationPrompt:{type:'string'}} : {}}}}));
} else {
  const get = (flag) => args[args.indexOf(flag)+1];
  const values = JSON.parse(readFileSync(get('--input').slice(1), 'utf8'));
  writeFileSync(config.log, JSON.stringify({values, timeout:get('--timeout'), runId:get('--run-id'), file:get('--input').slice(1)}));
  if (config.sleep) {
    const sub = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {stdio:'ignore'});
    writeFileSync(config.pid, String(sub.pid));
    setInterval(()=>{}, 1000);
  } else if (config.invalid) console.log('not json');
  else if (config.exit) { console.error('refused'); process.exit(config.exit); }
  else console.log(JSON.stringify({ok:config.outcome !== 'failed',outcome:config.outcome || 'done',value:{hello:'world'},runId:get('--run-id'),events:'events.jsonl',cost:null,caveats:[],durationMs:123}));
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
    assert.match(log.runId, /^auto-[a-f0-9]{64}$/); assert.equal(log.timeout, "30m");
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
