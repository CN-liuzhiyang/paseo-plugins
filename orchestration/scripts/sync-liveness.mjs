// Copies runtime/liveness.mjs (and its types) into each plugin that carries one, with a header that says not to
// edit the copy. Run it from orchestration/: `npm run sync:liveness`. `--check` changes nothing and exits 1 when a
// copy differs from what this would write (the plugins' tests say the same thing, for their own copy).
//
// Why a copy: a plugin is installed on its own and cannot import the runtime's modules, so a rule that more than
// one of them needs ("is this run alive") would be written twice and drift. It is written once, here, and copied.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(here, "..", "runtime");

/** The files that are copied, and the plugins' shared/ directories they go to. */
export const SOURCES = ["liveness.mjs", "liveness.d.mts"];
export const TARGETS = [path.resolve(here, "..", "..", "orchestration-ui", "shared"), path.resolve(here, "..", "..", "reconcile", "shared")];

/** What the copy of a file reads: the header, a blank line, then the file as it is. */
export const copyOf = (name, text) => `// 由运行时复制，别手改。来源：orchestration/runtime/${name}。要改就改那份，再在 orchestration/ 里跑 \`npm run sync:liveness\`。\n\n${text}`;

export function sync({ check = false } = {}) {
  const differing = [];
  for (const name of SOURCES) {
    const want = copyOf(name, readFileSync(path.join(runtime, name), "utf8"));
    for (const dir of TARGETS) {
      const file = path.join(dir, name);
      const have = existsSync(file) ? readFileSync(file, "utf8") : null;
      if (have === want) continue;
      differing.push(file);
      if (!check) writeFileSync(file, want);
    }
  }
  return differing;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const differing = sync({ check });
  if (differing.length === 0) console.log("every copy of liveness.mjs is current");
  else {
    console.log(`${check ? "out of date" : "written"}:\n${differing.map((f) => `  ${f}`).join("\n")}`);
    if (check) process.exit(1);
  }
}
