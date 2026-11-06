import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stepFields, stepProblem } from "./steps.mjs";

// Reading tools: one file per tool, <name>.mjs, in a private directory (policy.readers.dirs, searched first) or in the
// public one beside the command. A tool reads stdin {"args": {...}} and prints {"value": <JSON, up to 1 KB>, "summary":
// "one sentence"}; when it cannot read it exits non-zero and says why in one line on stderr. The first line of the file
// is a comment saying what it reads; that is what `affair brief` lists. A line `// label: 外网版本` in the first few lines is the
// name a person reads for it in the panel.
// Optional top-level steps describe the checklist (see handbook.md); validUntil is its ISO expiry, otherwise 24 hours.

const HERE = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return "";
  }
})();
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_VALUE = 1024;

export const publicDir = (policy) => policy.readers.publicDir || (policy.binPath ? path.join(path.dirname(policy.binPath), "..", "readers") : HERE ? path.join(HERE, "..", "..", "readers") : "");

/** Private directories first, so a private tool of the same name wins. */
export const readerDirs = (policy) => [...policy.readers.dirs, publicDir(policy)].filter((d) => d && existsSync(d));

export function findReader(policy, name) {
  if (!NAME.test(name)) return null;
  for (const dir of readerDirs(policy)) {
    const file = path.join(dir, `${name}.mjs`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** @returns {Array<{ name: string, what: string, label: string, file: string }>} `label` is what a person calls the thing it reads, from a `// label: …` line near the top of the file ("" when it has none). */
export function listReaders(policy) {
  const seen = new Map();
  for (const dir of readerDirs(policy)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name.replace(/\.mjs$/, "");
      if (!entry.isFile() || !entry.name.endsWith(".mjs") || !NAME.test(name) || seen.has(name)) continue;
      const file = path.join(dir, entry.name);
      const head = readFileSync(file, "utf8").split(/\r?\n/, 6);
      const first = head[0] ?? "";
      const label = head.map((l) => /^\/\/\s*label\s*[:：]\s*(.+?)\s*$/.exec(l)?.[1]).find(Boolean) ?? "";
      seen.set(name, { name, what: first.startsWith("//") ? first.replace(/^\/\/\s*/, "") : "", label, file });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
/** What "the value changed" compares: the value alone, whatever the order its keys came in. */
export const hashOf = (value) => createHash("sha1").update(JSON.stringify(canon(value ?? null))).digest("hex").slice(0, 12);

/**
 * Runs a tool once.
 * @returns {Promise<{ ok: true, value: any, summary: string, steps?: any[], validUntil?: string } | { ok: false, reason: string, missing?: boolean }>}
 */
export function readOnce(policy, name, args = {}) {
  const file = findReader(policy, name);
  if (!file) return Promise.resolve({ ok: false, missing: true, reason: `没有叫「${name}」的读取工具；有的：${listReaders(policy).map((r) => r.name).join("、") || "（没有）"}` });
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(process.env.AFFAIR_NODE || "node", [file], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, AFFAIR_PUBLIC_READERS: publicDir(policy) } });
    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, reason: `${policy.readers.timeoutSeconds} 秒没读完` });
    }, policy.readers.timeoutSeconds * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => done({ ok: false, reason: `起不来：${e.message}` }));
    child.on("close", (code) => {
      if (code !== 0) return done({ ok: false, reason: err.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 200) || `退出码 ${code}` });
      let parsed;
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        return done({ ok: false, reason: `输出不是 JSON：${out.trim().slice(0, 80)}` });
      }
      if (!parsed || typeof parsed !== "object" || !("value" in parsed) || typeof parsed.summary !== "string" || !parsed.summary.trim()) return done({ ok: false, reason: "输出要是 {value, summary}，summary 是一句话" });
      if (JSON.stringify(parsed.value ?? null).length > MAX_VALUE) return done({ ok: false, reason: `value 超过 ${MAX_VALUE} 字节：只放有意义的值（版本号、状态、比例），别放时间戳和整份数据` });
      const problem = stepProblem(parsed);
      if (problem) return done({ ok: false, reason: problem });
      done({ ok: true, value: parsed.value, summary: parsed.summary.trim().slice(0, 200), ...stepFields(parsed) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ args }));
  });
}
