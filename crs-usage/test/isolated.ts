// Run with node --import tsx test/isolated.ts. Only synthetic credentials are written.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { startFakeCrs, TEST_KEY, type Mode } from "./fake-crs";
const fake = await startFakeCrs();
const home = await mkdtemp(path.join(os.tmpdir(), "paseo-crs-isolated-"));
const pi = path.join(home, ".pi", "agent");
await mkdir(pi, { recursive: true });
await writeFile(
  path.join(pi, "models.json"),
  JSON.stringify({
    providers: {
      "crs-claude": { baseUrl: `${fake.origin}/claude` },
      "crs-codex": { baseUrl: `${fake.origin}/openai` },
    },
  }),
);
await writeFile(
  path.join(pi, "auth.json"),
  JSON.stringify({
    "crs-claude": { type: "api_key", key: TEST_KEY },
    "crs-codex": { type: "api_key", key: TEST_KEY },
  }),
);
// No plugin settings: exercise automatic discovery using only synthetic source homes.
// Start with `daemon run` and HOME/USERPROFILE=home, PI_CODING_AGENT_DIR=pi,
// CLAUDE_CONFIG_DIR=home/.claude, CODEX_HOME=home/.codex to isolate all credential reads.
await writeFile(
  path.join(home, "config.json"),
  JSON.stringify(
    {
      daemon: { listen: "127.0.0.1:16879", relay: { enabled: false } },
      features: {
        webUi: {
          enabled: true,
          distDir: path.join(
            process.env.LOCALAPPDATA!,
            "Programs",
            "PaseoFork",
            "resources",
            "app-dist",
          ),
        },
        voiceMode: { enabled: false },
      },
      pluginsEnabled: true,
      plugins: {
        "crs-usage": {
          source: "directory",
          path: fileURLToPath(new URL("..", import.meta.url)),
          enabled: true,
        },
      },
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ home, url: "http://127.0.0.1:16879", fake: fake.origin }));
createInterface({ input: process.stdin }).on("line", (line) => {
  fake.setMode(line.trim() as Mode);
  console.log(`fake mode: ${line.trim()}`);
});
process.on("SIGTERM", () => {
  void fake.close().then(() => process.exit());
});
