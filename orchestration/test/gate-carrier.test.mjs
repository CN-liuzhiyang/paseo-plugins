// `orch.mjs gate-carrier`: which provider answers a gate's card, from the roles the runtime itself reads. A plugin that starts runs
// asks it to know which provider has to be up before it starts one.
//
//   node --test test/gate-carrier.test.mjs        (from orchestration/)

import "./hermetic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp.mjs";

const ORCH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime", "orch.mjs");
const ask = (config) => spawnSync(process.execPath, [ORCH, "gate-carrier"], { encoding: "utf8", env: { ...process.env, ORCH_CONFIG: config } });

test("the gate role's provider is said, and whether it is a provider of Paseo or a model", async () => {
  const dir = await tempDir("orch-gatecarrier-");
  const config = path.join(dir, "config.json");
  writeFileSync(config, JSON.stringify({}));
  const out = ask(config);
  assert.equal(out.status, 0, out.stderr);
  const said = JSON.parse(out.stdout);
  assert.deepEqual([said.role, said.carrier, said.family], ["gate", "provider", "orch-gate"]);
});

test("when the roles cannot be read it says so by failing, and prints nothing", async () => {
  const dir = await tempDir("orch-gatecarrier-");
  const config = path.join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ rolesDirs: [path.join(dir, "not-there")] }));
  const out = ask(config);
  assert.notEqual(out.status, 0);
  assert.equal(out.stdout.trim(), "");
});
