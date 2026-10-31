// The tests run with a config of their own (hermetic.mjs), so what is configured on the machine they are on cannot change what they see.
// Every test file imports it first, which is why a file run by itself (`node --test test/<file>`) is as isolated as all of them under `npm test`.

import "./hermetic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../runtime/config.mjs";

test("the tests read an empty config, not the machine's", () => {
  assert.ok(process.env.ORCH_CONFIG, "ORCH_CONFIG is set by ./hermetic.mjs");
  assert.equal(readFileSync(process.env.ORCH_CONFIG, "utf8"), "{}");
  assert.deepEqual(loadConfig(), {});
});

test("every test file imports the empty config itself: none relies on how it was started", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((name) => name.endsWith(".test.mjs"));
  assert.ok(files.length > 20, "the test files were found");
  const without = files.filter((name) => !/^import "\.\/hermetic\.mjs";$/m.test(readFileSync(path.join(dir, name), "utf8")));
  assert.deepEqual(without, [], 'a test file that starts with `import "./hermetic.mjs";` cannot reach the steward of the machine it runs on');
});
