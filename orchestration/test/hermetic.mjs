// Loaded before every test file (`npm test`: node --import ./test/hermetic.mjs --test ...). A run reads config.json for the steward it tells
// when it ends (wake.mjs), and the tests run runs: they must read an empty config of their own, not the one of the machine they are on --
// there, a steward that is configured would turn up in the events of tests that know nothing of it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "orch-config-"));
const file = path.join(dir, "config.json");
writeFileSync(file, "{}");
process.env.ORCH_CONFIG = file;
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Left in the temp directory, which is the system's to clear.
  }
});
