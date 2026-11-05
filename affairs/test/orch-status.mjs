// A stand-in for orchestration/runtime/orch.mjs that only answers `status`, with the real runtime's own function over the
// claim and events files a test wrote. ORCH_LOG_DIR says where they are.
import { pathToFileURL } from "node:url";
import path from "node:path";

const { runStatus } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../orchestration/runtime/status.mjs")).href);
const argv = process.argv.slice(2);
if (argv[0] !== "status") process.exit(2);
const at = argv.indexOf("--spawned-at");
console.log(JSON.stringify(runStatus({ dir: process.env.ORCH_LOG_DIR, runId: argv[1], spawnedAt: at > 0 ? Number(argv[at + 1]) : null })));
