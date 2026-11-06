import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cache = new Map();
const identity = (dir) => {
  const value = path.resolve(dir).replaceAll("\\", "/");
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const inside = (dir, root) => identity(dir) === identity(root) || identity(dir).startsWith(`${identity(root)}/`);
const registryFile = (policy) => policy.projects?.registry || path.join(process.env.PASEO_HOME || path.join(os.homedir(), ".paseo"), "projects", "projects.json");
const registry = (policy) => existsSync(registryFile(policy)) ? JSON.parse(readFileSync(registryFile(policy), "utf8")).filter((p) => !p.archivedAt) : [];

// Match Paseo's protocol/git-remote parser and server/project-key, including case-sensitive private forge paths.
export function keyOfRemote(remote) {
  const raw = String(remote).trim();
  const scp = raw.includes("://") ? null : /^[^@]+@([^:]+):(.+)$/.exec(raw);
  let host, repo, port = "";
  if (scp) [, host, repo] = scp;
  else {
    let url;
    try { url = new URL(raw); } catch { return ""; }
    if (!["https:", "http:", "ssh:"].includes(url.protocol)) return "";
    host = url.hostname;
    try { repo = decodeURIComponent(url.pathname); } catch { return ""; }
    if (url.port && url.port !== ({ "https:": "443", "http:": "80", "ssh:": "22" })[url.protocol]) port = `:${url.port}`;
  }
  host = host.trim().replace(/\.+$/, "").toLowerCase();
  repo = repo.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(host) || !repo) return "";
  if (host === "github.com") repo = repo.toLowerCase();
  return `remote:${host}${port}/${repo}`;
}

export function keyOfSvn(remote) {
  const url = new URL(remote.trim());
  return `svn:${url.host.toLowerCase()}${decodeURIComponent(url.pathname).replace(/\/$/, "")}`;
}

export const matchesProject = (actual, wanted) => actual === wanted || (wanted.startsWith("svn:") && actual.startsWith(`${wanted.replace(/\/$/, "")}/`));

async function command(dir, tool, args) {
  try { return (await exec(tool, args, { cwd: dir, timeout: 2000, windowsHide: true })).stdout.trim(); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === 1 || error.code === 2 || error.code === 128) return "";
    throw error;
  }
}

export async function keyOfDir(dir, policy = {}) {
  const file = registryFile(policy);
  const token = existsSync(file) ? statSync(file).mtimeMs : 0;
  const slot = `${file}:${token}:${identity(dir)}`;
  const old = cache.get(slot);
  if (old && Date.now() - old.at < 60_000) return old.key;
  const registered = registry(policy).filter((p) => p.kind === "git" && p.projectKey.startsWith("remote:") && inside(dir, p.rootPath)).sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
  let key = registered?.projectKey || "";
  if (!key) key = keyOfRemote(await command(dir, "git", ["remote", "get-url", "origin"]));
  if (!key) {
    const svn = await command(dir, "svn", ["info", "--show-item", "url"]);
    if (svn) key = keyOfSvn(svn);
  }
  key ||= `path:${os.hostname()}:${path.resolve(dir).replaceAll("\\", "/")}`;
  cache.set(slot, { key, at: Date.now() });
  return key;
}

export async function localPathOf(key, policy = {}) {
  if (key.startsWith(`path:${os.hostname()}:`)) {
    const dir = key.slice(`path:${os.hostname()}:`.length);
    return existsSync(dir) ? dir : "";
  }
  const found = registry(policy).filter((p) => p.projectKey === key && existsSync(p.rootPath));
  // A main checkout has a .git directory; a linked worktree has a .git file.
  found.sort((a, b) => Number(existsSync(path.join(b.rootPath, ".git")) && statSync(path.join(b.rootPath, ".git")).isDirectory()) - Number(existsSync(path.join(a.rootPath, ".git")) && statSync(path.join(a.rootPath, ".git")).isDirectory()));
  if (found.length) return found[0].rootPath;
  for (const parent of policy.projects?.searchDirs ?? []) {
    if (!existsSync(parent)) continue;
    for (const item of readdirSync(parent, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const dir = path.join(parent, item.name);
      if (await keyOfDir(dir, policy) === key) return dir;
    }
  }
  return "";
}
