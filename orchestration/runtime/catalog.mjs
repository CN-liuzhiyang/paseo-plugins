// The flows that exist, as data: what `orch.mjs list` prints and what a UI shows as "the flows".
//
// A flow is a module whose default export is flow(...) (flow.mjs). This reads the shipped flows/ and the
// `flowsDirs` of config.json -- the directories `orch.mjs run <name>` looks in -- imports every .mjs file in
// them, and reports each one's metadata. Importing runs flow() and define(), which validate the metadata, and
// nothing else: a flow's `run` is never called, so listing costs nothing and starts nothing. A file that does
// not import, or whose default export is not a flow, is listed as such rather than left out: a flow that
// is missing from the list should say why.
//
// Only what a person reading the list needs: the flow's own words (description, phases, inputs) and where it is
// from. Steps and roles are not here; `orch.mjs check <name>` has them.

import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isFlow, scanSource } from "./flow.mjs";
import { readFile } from "node:fs/promises";
import { FLOWS_DIR, flowsDirs } from "./resolve.mjs";

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** One input as a form or a command line would show it. */
function describeInput(name, field) {
  const kind = field.type === "array" ? "list" : field.enum ? "choice" : field.type === "string" ? "text" : field.type === "number" ? "count" : field.type === "boolean" ? "flag" : "group";
  return {
    name,
    flag: `--${kebab(name)}`,
    kind,
    description: field.description ?? "",
    ...(field.enum ? { choices: [...field.enum] } : {}),
  };
}

/**
 * @typedef {{ name: string, file: string, origin: "shipped" | "config", description: string,
 *             phases: { id: string, title: string }[], inputs: object[], grants: string[],
 *             problems: string[], error: string | null }} CatalogEntry
 */

/**
 * Every flow file in `dirs`, sorted by name. A name two files claim is a problem on both (`orch.mjs run` refuses it).
 *
 * @param {string[]} [dirs] defaults to the directories `run` looks in
 * @returns {Promise<CatalogEntry[]>}
 */
export async function listFlows(dirs = flowsDirs()) {
  const entries = [];
  for (const dir of dirs) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
    } catch {
      continue; // a directory that is not there lists nothing; `run` says so when a name is not found
    }
    for (const file of files) {
      const abs = path.resolve(dir, file);
      const stem = file.slice(0, -".mjs".length);
      const origin = path.resolve(dir) === path.resolve(FLOWS_DIR) ? "shipped" : "config";
      try {
        const module = await import(pathToFileURL(abs).href);
        if (!isFlow(module.default)) throw new TypeError("the default export is not a flow(...)");
        const f = module.default;
        const problems = scanSource(f, await readFile(abs, "utf8"));
        if (f.name !== stem) problems.push(`flow name "${f.name}" is not the file name "${stem}": \`run ${stem}\` finds it, a caller that knows "${f.name}" does not`);
        entries.push({
          name: f.name,
          file: abs,
          origin,
          description: f.description,
          phases: f.phases.map((p) => ({ id: p.id, title: p.title })),
          inputs: Object.entries(f.inputs.properties).map(([name, field]) => describeInput(name, field)),
          grants: [...f.grants],
          problems,
          error: null,
        });
      } catch (error) {
        entries.push({ name: stem, file: abs, origin, description: "", phases: [], inputs: [], grants: [], problems: [], error: String(error?.message ?? error) });
      }
    }
  }
  const claimed = new Map();
  for (const entry of entries) claimed.set(entry.name, (claimed.get(entry.name) ?? 0) + 1);
  for (const entry of entries) {
    if (claimed.get(entry.name) > 1) entry.problems.push(`flow "${entry.name}" is defined in more than one file; \`run ${entry.name}\` refuses it`);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}
