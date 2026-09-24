// A flow: the one format an orchestration script has.
//
//   export default flow({
//     name: "committee",
//     description: "...",
//     phases: [{ id: "analyze", title: "独立分析" }],
//     inputs: { question: text("要讨论的问题") },
//     grants: [],
//     async run({ question }, $) { ... },
//   });
//
// Everything but `run` is plain data, checked here when the module is
// imported, so a reader -- `orch check`, a UI drawing the skeleton or a start
// form -- gets it without running anything. This file is what a flow imports;
// it pulls in nothing that talks to Paseo. Running is run.mjs.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { objectSchema, assertBuilderSchema, definedSteps } from "./step.mjs";
import { loadRoster } from "./roster.mjs";
import { FENCES } from "./fences.mjs";

export { define, text, flag, count, choice, list, group } from "./step.mjs";

const FLOW = Symbol.for("paseo-orchestration.flow");

export const isFlow = (value) => Boolean(value?.[FLOW]);

/**
 * Grants a flow can ask for, beyond the defaults, split by blast radius.
 *
 * The defaults are what the calling agent could already do itself: start
 * agents, steer them, wait on them, read them. A flow never lists them.
 * `gate:deny` closes a gate's permission card on a person's behalf when the
 * gate expires -- the conservative direction, so a flow may ask for it.
 * `gate:allow` would answer one in a person's place, and no flow gets it.
 */
export const DEFAULT_GRANTS = ["spawn", "send", "wait", "read"];
export const GRANTS = {
  "gate:deny": "close an expired or abandoned gate card by denying it (every $.gate needs this)",
};

/** Inputs share a namespace with the runner's own flags. */
const RESERVED_INPUTS = ["input", "timeout", "help"];

const ID = /^[a-z][a-z0-9-]*$/;
const INPUT_NAME = /^[a-z][a-zA-Z0-9]*$/;

function fail(name, message) {
  throw new TypeError(`flow ${name ? `"${name}"` : "(unnamed)"}: ${message}`);
}

/**
 * Declare a flow. Throws on any malformed metadata, at import time.
 *
 * @template T
 * @param {{ name: string, description: string, phases: { id: string, title: string }[],
 *           inputs: Record<string, object>, grants: string[],
 *           run: (input: object, $: object) => Promise<T> }} definition
 */
export function flow(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("flow() needs a definition object");
  const { name, description, phases, inputs, grants, run } = definition;

  const unknown = Object.keys(definition).filter((key) => !["name", "description", "phases", "inputs", "grants", "run"].includes(key));
  if (unknown.length > 0) fail(name, `unknown key ${unknown.join(", ")}`);
  if (typeof name !== "string" || !ID.test(name)) fail(name, `name must match ${ID}`);
  if (typeof description !== "string" || description.trim() === "") fail(name, "description is required");

  // Every key is required, like every schema field (R2): a flow that means
  // "no phases" or "no extra grants" says [] rather than leaving it out.
  if (!Array.isArray(phases)) fail(name, "phases is required: a list of { id, title }, [] for none");
  const ids = new Set();
  for (const phase of phases) {
    if (!phase || typeof phase !== "object" || Object.keys(phase).some((k) => k !== "id" && k !== "title")) {
      fail(name, `a phase is { id, title }, got ${JSON.stringify(phase)}`);
    }
    if (typeof phase.id !== "string" || !ID.test(phase.id)) fail(name, `phase id must match ${ID}, got ${JSON.stringify(phase.id)}`);
    if (typeof phase.title !== "string" || phase.title.trim() === "") fail(name, `phase "${phase.id}" needs a title`);
    if (ids.has(phase.id)) fail(name, `phase "${phase.id}" is declared twice`);
    ids.add(phase.id);
  }

  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    fail(name, "inputs is required: a map of input name to field (text, count, ...), {} for none");
  }
  for (const [key, schema] of Object.entries(inputs)) {
    if (!INPUT_NAME.test(key)) fail(name, `input "${key}" must be camelCase (${INPUT_NAME}); the CLI flag is its kebab-case form`);
    if (RESERVED_INPUTS.includes(key)) fail(name, `input "${key}" collides with the runner's own --${key}`);
    try {
      assertBuilderSchema(schema, `inputs.${key}`);
    } catch (error) {
      fail(name, error.message);
    }
  }

  if (!Array.isArray(grants)) fail(name, "grants is required: extra grants beyond the defaults, [] for none");
  for (const grant of grants) {
    if (grant === "gate:allow") fail(name, "gate:allow is never granted: answering a gate is a person's decision");
    if (DEFAULT_GRANTS.includes(grant)) fail(name, `"${grant}" is a default grant; do not list it`);
    if (!Object.hasOwn(GRANTS, grant)) fail(name, `unknown grant "${grant}"; grants: ${Object.keys(GRANTS).join(", ")}`);
  }

  if (typeof run !== "function") fail(name, "run must be an async function (input, $) => value");

  return Object.freeze({
    [FLOW]: true,
    name,
    description,
    phases: Object.freeze(phases.map((p) => Object.freeze({ id: p.id, title: p.title }))),
    inputs: objectSchema(inputs, { allowEmpty: true }),
    grants: Object.freeze([...grants]),
    run,
  });
}

/** The metadata as run.start carries it: everything but `run`. */
export const describeFlow = (f) => ({
  name: f.name,
  description: f.description,
  phases: f.phases.map((p) => ({ ...p })),
  inputs: f.inputs,
  grants: [...f.grants],
});

/**
 * What can be found in a flow's source text without running it. A text scan,
 * so it sees only the plain spellings -- `$.phase("id"` and `.gate(` -- and a
 * flow that aliases them is not covered; the runtime refuses the same things
 * when they happen. Both are here so they surface before the first spend.
 */
export function scanSource(f, source) {
  const problems = [];
  const declared = new Set(f.phases.map((p) => p.id));
  for (const match of source.matchAll(/\.phase\(\s*["'`]([^"'`]+)["'`]/g)) {
    if (!declared.has(match[1])) problems.push(`$.phase("${match[1]}") is not declared in phases`);
  }
  if (/\.gate\s*\(/.test(source) && !f.grants.includes("gate:deny")) {
    problems.push('the flow calls $.gate but does not declare grants: ["gate:deny"]');
  }
  return [...new Set(problems)];
}

/**
 * A flow module's default export, with its path and source text. A flow
 * value passes through (source and text are null then).
 */
export async function loadFlow(target) {
  if (isFlow(target)) return { flow: target, source: null, text: null };
  if (typeof target !== "string") throw new TypeError("loadFlow needs a path or a flow() value");
  const file = path.resolve(target);
  const module = await import(pathToFileURL(file).href);
  if (!isFlow(module.default)) throw new TypeError(`${file}: the default export is not a flow(...)`);
  return { flow: module.default, source: file, text: await readFile(file, "utf8") };
}

/** What `orch check` cannot see. Kept next to the checks so the two lists move together. */
export const NOT_CHECKED = [
  "role and provider names passed to $.ask: they resolve when the call is made (a flow that takes a role as input checks it with $.ctx.role before its first ask)",
  "prompts: rendering one needs an input; a prompt that reads a field its caller does not pass throws at call time, before the call starts",
  "steps defined inside run(), and steps of a module that was already imported in this process",
  "phase ids and gates spelled other than $.phase(\"id\", ...) and .gate(...): the scan is textual",
  "whether a structured answer fits the flow's use of it: Paseo enforces the schema, the flow's logic is not run",
];

/**
 * Everything about a flow that costs nothing to check: importing it runs its
 * flow() and define() calls, which validate metadata and steps; the source
 * scan finds undeclared phases and a gate without its grant; the roster says
 * which roles have no fence to run behind.
 *
 * @returns {Promise<{ ok: boolean, flow: object | null, steps: object[], problems: string[], warnings: string[], notChecked: string[] }>}
 */
export async function checkFlow(target, { roster } = {}) {
  const before = definedSteps().length;
  let loaded;
  try {
    loaded = await loadFlow(target);
  } catch (error) {
    return { ok: false, flow: null, steps: [], problems: [error.message], warnings: [], notChecked: NOT_CHECKED };
  }
  const { flow: f, text } = loaded;
  const steps = definedSteps()
    .slice(before)
    .map((s) => ({ name: s.name, effects: s.effects, timeout: s.timeout ?? null, fingerprint: s.fingerprint }));
  const problems = text === null ? [] : scanSource(f, text);
  const warnings = steps.filter((s) => s.timeout === null).map((s) => `step "${s.name}" declares no timeout (R7); it gets the 30m default`);

  const roles = roster ?? (await loadRoster());
  for (const [name, entry] of Object.entries(roles.roles)) {
    const family = entry.provider.split("/")[0];
    if (!FENCES[family]) warnings.push(`role "${name}" runs on ${family}, which has no fence in runtime/fences.mjs: any $.ask on it will be refused`);
  }

  return { ok: problems.length === 0, flow: describeFlow(f), steps, problems, warnings, notChecked: NOT_CHECKED };
}
