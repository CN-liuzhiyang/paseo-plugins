// Imported first by every test file (hermetic.test.mjs checks that none forgets), so that how a file is started -- `npm test`, or by itself --
// makes no difference. A run reads config.json for the steward it tells when it ends (wake.mjs), and the tests run runs: they must read an
// empty config of their own, not the one of the machine they are on -- there, a steward that is configured would be told by tests that
// know nothing of it, and could be started by one.

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
