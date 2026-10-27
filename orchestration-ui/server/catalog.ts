import { execFile } from "node:child_process";
import { z } from "zod";
import { flowRow } from "../shared/rpc";

// The flows that exist, asked of the runtime: `orch.mjs list` prints them as JSON (orchestration/runtime/catalog.mjs).
// It runs in the daemon's own node (this process is a fork of it; with ELECTRON_RUN_AS_NODE set, an app's binary is
// node too), reads nothing but flow files, and starts nothing. A plugin cannot import the runtime -- it is installed on
// its own -- so this is the one way it learns what a flow is.

const entry = flowRow.omit({ runCount: true, latest: true });
export type CatalogEntry = z.output<typeof entry>;
const listing = z.object({ flows: z.array(entry) });

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it could not be run at all (not found, not allowed), or that it ran out of time. */
  failure: string | null;
}
export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<Ran>;

export const nodeExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const code = e ? (typeof e.code === "number" ? e.code : null) : 0;
        const failure = !e ? null : e.killed ? `等了 ${Math.round(timeoutMs / 1000)} 秒没有结果` : typeof e.code === "number" ? null : (e.code ?? e.message);
        resolve({ code, stdout, stderr, failure });
      },
    );
  });

export type Catalog = { ok: true; flows: CatalogEntry[] } | { ok: false; detail: string };

const TIMEOUT_MS = 30_000;
const FRESH_MS = 10_000;

/**
 * What `orch.mjs list` says, remembered for a few seconds: the page asks every few seconds, and listing imports
 * every flow file. One ask at a time; a second caller shares it. A failure is remembered as briefly as a success.
 */
export function createCatalog({ exec = nodeExec, now = Date.now, execPath = process.execPath }: { exec?: Exec; now?: () => number; execPath?: string } = {}) {
  let remembered: { orchPath: string; at: number; result: Catalog } | null = null;
  let inflight: { orchPath: string; promise: Promise<Catalog> } | null = null;

  async function ask(orchPath: string): Promise<Catalog> {
    const ran = await exec(execPath, [orchPath, "list"], TIMEOUT_MS);
    if (ran.failure) return { ok: false, detail: `运行 ${orchPath} list 没成功：${ran.failure}` };
    if (ran.code !== 0) {
      // A node crash ends in a stack and a version line; the sentence that says what went wrong is the first with "Error" in it.
      const lines = (ran.stderr.trim() || ran.stdout.trim()).split("\n").map((l) => l.trim()).filter((l) => l !== "");
      const said = (lines.find((l) => /error|cannot find|usage/i.test(l)) ?? lines[0] ?? "").slice(0, 300);
      return { ok: false, detail: `${orchPath} list 退出码 ${ran.code}${said ? `：${said}` : ""}` };
    }
    let value: unknown;
    try {
      value = JSON.parse(ran.stdout);
    } catch (error) {
      return { ok: false, detail: `${orchPath} list 的输出不是 JSON（${(error as Error).message}）：这个 orch.mjs 可能太旧，没有 list 命令` };
    }
    const parsed = listing.safeParse(value);
    if (!parsed.success) return { ok: false, detail: `${orchPath} list 的输出和插件认的格式对不上：${parsed.error.issues[0]?.message ?? "?"}（${parsed.error.issues[0]?.path.join(".")}）` };
    return { ok: true, flows: parsed.data.flows };
  }

  return {
    async get(orchPath: string): Promise<Catalog> {
      if (orchPath.trim() === "") return { ok: false, detail: "还没告诉插件 orch.mjs 在哪（设置里的 orchPath）" };
      const path = orchPath.trim();
      if (remembered && remembered.orchPath === path && now() - remembered.at < FRESH_MS) return remembered.result;
      if (inflight && inflight.orchPath === path) return inflight.promise;
      const promise = ask(path).then((result) => {
        remembered = { orchPath: path, at: now(), result };
        return result;
      });
      const mine = { orchPath: path, promise };
      inflight = mine;
      try {
        return await promise;
      } finally {
        if (inflight === mine) inflight = null;
      }
    },
  };
}
