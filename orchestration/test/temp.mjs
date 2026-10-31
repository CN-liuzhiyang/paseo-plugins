// A temporary directory that is gone when the test file's process ends, whichever way the tests end.
// `node --test` runs every file in its own process, so the exit of that process is where this file's directories are removed.

import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const made = new Set();

process.on("exit", () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A handle some test left open keeps a file on Windows; the rest are still removed.
    }
  }
});

export async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  made.add(dir);
  return dir;
}
