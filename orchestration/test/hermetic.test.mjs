// The tests run with a config of their own (hermetic.mjs), so what is configured on the machine they are on cannot change what they see.
// Run them with `npm test`; a single file by itself needs `node --import ./test/hermetic.mjs --test test/<file>`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../runtime/config.mjs";

test("the tests read an empty config, not the machine's", () => {
  assert.ok(process.env.ORCH_CONFIG, "ORCH_CONFIG is set: run the tests with npm test");
  assert.equal(readFileSync(process.env.ORCH_CONFIG, "utf8"), "{}");
  assert.deepEqual(loadConfig(), {});
});
