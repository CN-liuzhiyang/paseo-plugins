// A card that asks for a value belongs in the `before` of the once step it authorises, not in the step's function: said when it
// happens (a caveat) and, where the source shows it, by `orch check` (a warning). Neither fails anything.
//
//   node --test        (from orchestration/)

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { runFlow } from "../runtime/run.mjs";
import { flow, checkFlow, scanOnceGates } from "../runtime/flow.mjs";
import { readEvents, checkEvents } from "../runtime/events.mjs";
import { loadRoster, ROLES_DIR } from "../runtime/roster.mjs";
import { fakeExecutor } from "./fake-executor.mjs";
import { tempDir } from "./temp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLOW_MJS = pathToFileURL(path.join(HERE, "..", "runtime", "flow.mjs")).href;

let roster;
before(async () => {
  roster = await loadRoster([ROLES_DIR]);
});

const GATE = '{ title: "approve", content: "x", timeout: "1m", input: { label: "code" } }';
const run = async (body, carrier = "input") => {
  const logDir = await tempDir("orch-oncegate-");
  const f = flow({ name: "once-gate", description: "d", phases: [], inputs: {}, grants: ["gate:deny"], run: (_, $) => body($) });
  const result = await runFlow(f, { roster, logDir, caller: null, gatePollMs: 5, executor: fakeExecutor({ carrier }), cwd: "C:/work" });
  const events = readEvents(result.events);
  assert.deepEqual(checkEvents(events, { strict: true, complete: true }), []);
  return { result, events };
};
const caveats = (events) => events.filter((e) => e.kind === "caveat").map((e) => e.text);

test("a card with a value asked inside a once step's function is a caveat; in its before, or without a value, it is not", async () => {
  const inside = await run(($) =>
    $.step("commit", async () => (await $.gate({ title: "approve", content: "x", timeout: "1m", input: { label: "code" } })).approved, { once: true }),
  );
  assert.equal(inside.result.outcome, "done", "said, not refused");
  assert.equal(inside.result.value, true);
  assert.equal(caveats(inside.events).filter((m) => /inside the act of the once step "commit"[\s\S]*put the card in the step's `before`/.test(m)).length, 1);
  assert.ok(inside.result.caveats.some((m) => /once step "commit"/.test(m)));

  const aside = await run(($) =>
    $.step("commit", (given) => given.approved, { once: true, before: () => $.gate({ title: "approve", content: "x", timeout: "1m", input: { label: "code" } }) }),
  );
  assert.deepEqual([aside.result.outcome, caveats(aside.events).filter((m) => /once step/.test(m))], ["done", []]);

  // A card that asks no value is asked again only if the person has not answered it; the same hole, but not the one a code makes.
  const plain = await run(($) => $.step("commit", async () => (await $.gate({ title: "approve", content: "x", timeout: "1m" })).approved, { once: true }), "approve");
  assert.deepEqual(caveats(plain.events).filter((m) => /once step/.test(m)), []);
  const light = await run(($) => $.step("prepare", async () => (await $.gate({ title: "approve", content: "x", timeout: "1m", input: { label: "code" } })).approved));
  assert.deepEqual(caveats(light.events).filter((m) => /once step/.test(m)), [], "a step that can be taken back may ask");
});

test("a card with a value asked in a step inside the once step's function is inside its act", async () => {
  const { events } = await run(($) =>
    $.step("outer", async () => $.step("inner", async () => (await $.gate({ title: "approve", content: "x", timeout: "1m", input: { label: "code" } })).approved), { once: true }),
  );
  assert.equal(caveats(events).filter((m) => /once step "outer"/.test(m)).length, 1);
});

test("scanOnceGates: an inline function with a card that asks for a value, in a once step", () => {
  const warn = (text) => scanOnceGates(text);
  const inside = `await $.step("commit", async () => { const g = await $.gate(${GATE}); return g; }, { once: true });`;
  assert.equal(warn(inside).length, 1);
  assert.match(warn(inside)[0], /once step "commit"[\s\S]*put the card in the step's `before`/);

  // The card where it belongs, a card without a value, a step that can be taken back, a step whose function is not written there.
  assert.deepEqual(warn(`await $.step("commit", (g) => commit(g), { once: true, before: () => $.gate(${GATE}) });`), []);
  assert.deepEqual(warn(`await $.step("commit", async () => $.gate({ title: "t", content: "c" }), { once: true });`), []);
  assert.deepEqual(warn(`await $.step("prepare", async () => $.gate(${GATE}), { key: 1 });`), []);
  assert.deepEqual(warn(`await $.step("prepare", async () => $.gate(${GATE}), { once: false });`), []);
  assert.deepEqual(warn(`await $.step("commit", commitIt, { once: true });`), []);
  assert.deepEqual(warn(`await $.step("commit", async () => 1);`), []);

  // Other text in the way: strings and templates with brackets, comments, a nested call, the options on another line.
  const noisy = [
    "await $.step(`commit ${(1)}`, async () => {",
    '  // ) a comment with a bracket and "a quote',
    '  const s = ")(" + `}{${"}"}`;',
    `  return await $.gate(${GATE});`,
    "}, {",
    "  once: true,",
    "});",
  ].join("\n");
  assert.equal(warn(noisy).length, 1);
  // One step is told once however many cards it asks.
  assert.equal(warn(`await $.step("c", async () => { await $.gate(${GATE}); await $.gate(${GATE}); }, { once: true });`).length, 1);
  // Unbalanced text is no warning and no crash.
  assert.deepEqual(warn(`await $.step("c", async () => { await $.gate(${GATE}`), []);
});

test("orch check warns about it, and still passes", async () => {
  const dir = await tempDir("orch-oncegate-flow-");
  mkdirSync(dir, { recursive: true });
  const write = (name, body) => {
    const file = path.join(dir, `${name}.mjs`);
    writeFileSync(
      file,
      `import { flow } from ${JSON.stringify(FLOW_MJS)};\nexport default flow({ name: ${JSON.stringify(name)}, description: "d", phases: [], inputs: {}, grants: ["gate:deny"], async run(_, $) {\n${body}\n} });\n`,
    );
    return file;
  };
  const bad = await checkFlow(write("bad", `return $.step("commit", async () => (await $.gate(${GATE})).approved, { once: true });`), { roster });
  assert.equal(bad.ok, true, bad.problems.join("; "));
  assert.equal(bad.warnings.filter((w) => /once step "commit"/.test(w)).length, 1);
  const good = await checkFlow(write("good", `return $.step("commit", (g) => g.approved, { once: true, before: () => $.gate(${GATE}) });`), { roster });
  assert.deepEqual(good.warnings.filter((w) => /once step/.test(w)), []);
  // The flows that ship say nothing of the kind.
  for (const name of ["resume-smoke", "gate-smoke", "committee", "advisor"]) {
    const shipped = await checkFlow(path.join(HERE, "..", "flows", `${name}.mjs`), { roster });
    assert.deepEqual(shipped.warnings.filter((w) => /once step/.test(w)), [], name);
  }
});
