// `orch.mjs list`: the flows that exist, as data. Nothing here talks to Paseo and nothing is spent.
//
//   node --test        (from orchestration/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { listFlows } from "../runtime/catalog.mjs";
import { FLOWS_DIR } from "../runtime/resolve.mjs";
import { tempDir } from "./temp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const tmp = () => tempDir("orch-catalog-");

const FLOW_MODULE = JSON.stringify(pathToFileURL(path.join(HERE, "..", "runtime", "flow.mjs")).href);

const FLOW_SOURCE = (name, extra = "") => `
import { flow, text, count, choice } from ${FLOW_MODULE};
export default flow({
  name: ${JSON.stringify(name)},
  description: "测试用：${name}",
  phases: [{ id: "one", title: "第一步" }],
  inputs: { itemNo: count("单号"), mode: choice(["a", "b"], "模式"), note: text("备注") },
  grants: [],
  async run() { throw new Error("listing must not run a flow"); },
});
${extra}
`;

const write = (dir, file, source) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), source);
};

test("catalog: a flow is listed with what a person choosing it needs, and its run() is never called", async () => {
  const dir = path.join(await tmp(), "mine");
  write(dir, "triage.mjs", FLOW_SOURCE("triage"));
  const entries = await listFlows([FLOWS_DIR, dir]);
  const mine = entries.find((e) => e.name === "triage");
  assert.equal(mine.origin, "config");
  assert.equal(mine.file, path.join(dir, "triage.mjs"));
  assert.equal(mine.description, "测试用：triage");
  assert.deepEqual(mine.phases, [{ id: "one", title: "第一步" }]);
  assert.deepEqual(
    mine.inputs.map((i) => [i.name, i.flag, i.kind]),
    [["itemNo", "--item-no", "count"], ["mode", "--mode", "choice"], ["note", "--note", "text"]],
  );
  assert.deepEqual(mine.inputs[1].choices, ["a", "b"]);
  assert.deepEqual([mine.problems, mine.error], [[], null]);
  // The shipped flows come with it, marked as shipped.
  assert.equal(entries.find((e) => e.name === "advisor").origin, "shipped");
});

test("catalog: a file that is not a usable flow is listed with why, not left out", async () => {
  const dir = path.join(await tmp(), "broken");
  write(dir, "syntax.mjs", "export default flow({ ");
  write(dir, "helper.mjs", "export const x = 1; export default { notAFlow: true };");
  write(dir, "badmeta.mjs", `import { flow } from ${FLOW_MODULE}; export default flow({ name: "Bad Name" });`);
  const entries = await listFlows([dir]);
  assert.deepEqual(entries.map((e) => e.name), ["badmeta", "helper", "syntax"]);
  for (const entry of entries) assert.ok(entry.error && entry.error.length > 0, entry.name);
  assert.match(entries[1].error, /not a flow/);
});

test("catalog: problems a check would find are shown, and a name that is not the file name is one", async () => {
  const dir = path.join(await tmp(), "p");
  write(dir, "other-name.mjs", FLOW_SOURCE("triage", '// $.phase("undeclared", 1)\n'));
  const [entry] = await listFlows([dir]);
  assert.equal(entry.name, "triage");
  assert.ok(entry.problems.some((p) => /not the file name/.test(p)));
  assert.ok(entry.problems.some((p) => /undeclared/.test(p)));
});

test("catalog: one name in two files is a problem on both; a directory that is not there lists nothing", async () => {
  const base = await tmp();
  write(path.join(base, "one"), "triage.mjs", FLOW_SOURCE("triage"));
  write(path.join(base, "two"), "triage.mjs", FLOW_SOURCE("triage"));
  const entries = await listFlows([path.join(base, "one"), path.join(base, "two"), path.join(base, "absent")]);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.problems.some((p) => /more than one file/.test(p))));
});

test("catalog: `orch.mjs list` prints it as JSON, and takes no argument", async () => {
  const orch = path.join(HERE, "..", "runtime", "orch.mjs");
  const dir = path.join(await tmp(), "cli");
  write(dir, "triage.mjs", FLOW_SOURCE("triage"));
  const config = path.join(path.dirname(dir), "config.json");
  writeFileSync(config, JSON.stringify({ flowsDirs: [dir] }));
  const { stdout } = await exec(process.execPath, [orch, "list"], { env: { ...process.env, ORCH_CONFIG: config } });
  const names = JSON.parse(stdout).flows.map((f) => f.name);
  assert.deepEqual(names, ["advisor", "again-smoke", "answer-smoke", "committee", "gate-smoke", "item-glance", "resume-smoke", "triage"]);
  await assert.rejects(exec(process.execPath, [orch, "list", "extra"], { env: { ...process.env, ORCH_CONFIG: config } }), (error) => error.code === 2);
});
