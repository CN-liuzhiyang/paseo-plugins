import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Paseo's plugin compiler (packages/server/src/server/plugins/compiler.ts) refuses a bundle
// whose modules cross its boundaries, and it follows type-only imports too, which tsc and the
// tests do not notice. This walks the same graph from both entries with the same rules, so a
// mistake fails here instead of at `paseo plugin install`. `npm run check:bundle` runs the real
// compiler when a Paseo checkout is at hand.

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Owner = "client" | "server" | "shared";

function locate(file: string, root: string): Owner | "invalid" {
  const rel = path.relative(root, file);
  const first = rel.split(path.sep)[0];
  if (first === "client" || first === "server" || first === "shared") return first;
  if (/^index\.client\.tsx?$/.test(rel)) return "client";
  if (/^index\.server\.tsx?$/.test(rel)) return "server";
  return "invalid";
}

function forbiddenPackage(specifier: string, owner: Owner): string | null {
  const serverSdk = specifier.startsWith("@getpaseo/plugin/server");
  const clientSdk = specifier.startsWith("@getpaseo/plugin/client");
  const clientLib = /^((?:@types\/)?react(?:-dom|-native)?|use-sync-external-store|@tanstack\/react-query)(\/|$)/.test(specifier);
  if (owner !== "server" && (isBuiltin(specifier) || specifier === "@types/node")) return "Node";
  if (owner !== "server" && serverSdk) return "server-only";
  if (owner !== "client" && (clientSdk || clientLib)) return "client-only";
  return null;
}

function resolveRelative(specifier: string, importer: string): string | null {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, ".ts"), path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return candidates.find((c) => existsSync(c) && /\.[cm]?[jt]sx?$/.test(c)) ?? null;
}

/** Every boundary violation reachable from the entry, as one line each. */
function boundaryErrors(root: string, entry: string): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, inherited: Owner) => {
    const here = locate(file, root);
    const owner: Owner = here === "shared" ? "shared" : inherited;
    const key = `${owner}:${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName: specifier } of importedFiles) {
      const rel = path.relative(root, file);
      if (!specifier.startsWith(".")) {
        const kind = forbiddenPackage(specifier, owner);
        if (kind) errors.push(`${rel}: ${kind} module "${specifier}" in the ${owner} bundle`);
        continue;
      }
      const target = resolveRelative(specifier, file);
      if (!target) {
        errors.push(`${rel}: cannot resolve "${specifier}"`);
        continue;
      }
      const where = locate(target, root);
      if (where === "invalid") errors.push(`${rel}: "${specifier}" is outside client/, server/ and shared/`);
      else if (where !== "shared" && where !== owner) errors.push(`${rel}: ${where}-only module "${specifier}" in the ${owner} bundle`);
      else walk(target, owner);
    }
  };
  walk(entry, locate(entry, root) as Owner);
  return errors;
}

test("the client bundle reaches nothing in server/, and shared/ only shared and host modules", () => {
  assert.deepEqual(boundaryErrors(PLUGIN, path.join(PLUGIN, "index.client.tsx")), []);
});

test("the server bundle reaches nothing in client/", () => {
  assert.deepEqual(boundaryErrors(PLUGIN, path.join(PLUGIN, "index.server.ts")), []);
});

test("the walk catches what the compiler refuses: a type-only server import, node in shared, a file outside", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reconcile-bounds-"));
  try {
    for (const dir of ["client", "server", "shared", "lib"]) mkdirSync(path.join(root, dir));
    writeFileSync(path.join(root, "index.client.tsx"), 'import { a } from "./client/a";\nexport default a;\n');
    writeFileSync(path.join(root, "client", "a.tsx"), 'import type { S } from "../server/s";\nimport { t } from "../shared/t";\nexport const a: S = t;\n');
    writeFileSync(path.join(root, "server", "s.ts"), "export type S = string;\n");
    writeFileSync(path.join(root, "shared", "t.ts"), 'import { readFileSync } from "node:fs";\nimport { u } from "../lib/u";\nexport const t = String(readFileSync) + u;\n');
    writeFileSync(path.join(root, "lib", "u.ts"), 'export const u = "";\n');
    const errors = boundaryErrors(root, path.join(root, "index.client.tsx"));
    assert.equal(errors.length, 3, errors.join("\n"));
    assert.match(errors[0]!, /server-only module "..\/server\/s" in the client bundle/);
    assert.match(errors[1]!, /Node module "node:fs" in the shared bundle/);
    assert.match(errors[2]!, /outside client\/, server\/ and shared\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
