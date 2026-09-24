// A step is one agent call's whole contract: what to ask, what must come
// back, and how far its effects may reach. They live in one object because
// they are one decision -- a prompt that asks for something the schema has no
// field for fails silently, and no test catches it.
//
// Field builders below emit plain JSON Schema. Nothing here is a type system;
// if a step needs something these cannot express, write the JSON Schema by
// hand and pass it as `returns`. The builders exist to remove repetition and
// two specific mistakes, not to wrap every schema in the world. The same
// builders describe a flow's inputs (flow.mjs), where `validate` below checks
// them before anything is spent.

import { createHash } from "node:crypto";

// --- Field builders ---------------------------------------------------
//
// `description` is an instruction to the model, not a comment for the reader.
// "The finding that would flip this verdict -- a falsifier, not a hedge" earns
// its place; "the confidence field" does not.

export const text = (description) => field({ type: "string" }, description);
export const flag = (description) => field({ type: "boolean" }, description);
export const count = (description) => field({ type: "number" }, description);
export const choice = (values, description) => {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("choice() needs a non-empty array of allowed values");
  }
  return field({ type: "string", enum: values }, description);
};
export const list = (of, description) => {
  if (!of || typeof of !== "object") throw new TypeError("list() needs an item schema, e.g. list(text())");
  return field({ type: "array", items: of }, description);
};
export const group = (fields, description) => field(objectSchema(fields), description);

function field(schema, description) {
  return description ? { ...schema, description } : schema;
}

/**
 * Build an object schema from a field map.
 *
 * Every property is required and `additionalProperties` is false, always.
 * This is not a style preference: Paseo's Codex provider rewrites incoming
 * schemas to exactly this shape (see codex-app-server-agent.ts, which unions
 * every property key into `required` and forces additionalProperties false),
 * while Claude passes the schema through as written. Emitting anything else
 * means one step behaves differently on two providers, and the divergence
 * shows up as an undefined field in a script branch rather than an error.
 *
 * A field that may legitimately have nothing to report should say so in its
 * own vocabulary -- an empty string, an empty list, a "none" enum value --
 * rather than being absent.
 */
export function objectSchema(fields, { allowEmpty = false } = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new TypeError("returns must be a map of field name to field schema");
  }
  const keys = Object.keys(fields);
  if (keys.length === 0 && !allowEmpty) throw new TypeError("returns must declare at least one field");

  return {
    type: "object",
    properties: fields,
    required: keys,
    additionalProperties: false,
  };
}

/**
 * Check a value against a schema made of the builders above. Returns a list
 * of problems, empty when the value fits. Only the builders' vocabulary is
 * understood; `flow()` refuses input schemas that use anything else, so an
 * input is never "valid" because this skipped a keyword it did not know.
 */
export function validate(schema, value, at = "input") {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  switch (schema.type) {
    case "string":
      if (kind !== "string") return [`${at}: expected a string, got ${kind}`];
      if (schema.enum && !schema.enum.includes(value)) return [`${at}: "${value}" is not one of ${schema.enum.join(", ")}`];
      return [];
    case "number":
      return kind === "number" && Number.isFinite(value) ? [] : [`${at}: expected a number, got ${kind === "number" ? value : kind}`];
    case "boolean":
      return kind === "boolean" ? [] : [`${at}: expected true or false, got ${kind}`];
    case "array":
      if (kind !== "array") return [`${at}: expected a list, got ${kind}`];
      return value.flatMap((item, i) => validate(schema.items, item, `${at}[${i}]`));
    case "object": {
      if (kind !== "object") return [`${at}: expected an object, got ${kind}`];
      const problems = schema.required.filter((key) => !Object.hasOwn(value, key)).map((key) => `${at}.${key}: missing`);
      for (const [key, entry] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties, key)) problems.push(`${at}.${key}: not declared`);
        else problems.push(...validate(schema.properties[key], entry, `${at}.${key}`));
      }
      return problems;
    }
    default:
      return [`${at}: schema type "${schema.type}" is not one the builders make`];
  }
}

/** Throws unless `schema` uses only what the builders emit. For input schemas. */
export function assertBuilderSchema(schema, at) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new TypeError(`${at}: not a schema`);
  const allowed = {
    string: ["type", "description", "enum"],
    number: ["type", "description"],
    boolean: ["type", "description"],
    array: ["type", "description", "items"],
    object: ["type", "description", "properties", "required", "additionalProperties"],
  }[schema.type];
  if (!allowed) throw new TypeError(`${at}: type "${schema.type}" is not one the builders make (text, count, flag, choice, list, group)`);
  const extra = Object.keys(schema).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new TypeError(`${at}: ${extra.join(", ")} is not something the builders emit`);
  if (schema.type === "array") assertBuilderSchema(schema.items, `${at}[]`);
  if (schema.type === "object") {
    for (const [key, entry] of Object.entries(schema.properties ?? {})) assertBuilderSchema(entry, `${at}.${key}`);
  }
}

// --- Effects ----------------------------------------------------------
//
// How far a step's effects may reach, declared per step, required, no
// default. An agent step is at most `workspace`: anything another person or
// system can see -- a commit, a push, a message, a write into someone else's
// tree -- is the script's job, done with `$.do` after `$.gate`. Which provider
// mode each value maps to, and whether that is enforced, is fences.mjs.

export const EFFECTS = ["none", "workspace"];

// "Do not write code" used to be here too. It contradicts any step whose
// answer is code (hotfix `draft` returns a Lua file through its schema); the
// line that matters is the one about files.
export const NO_EDITS_SUFFIX =
  "Do NOT edit, create, or delete any files. Everything you produce goes in your answer.";

export const WORKSPACE_SUFFIX =
  "You may create and edit files in your working directory, and only there. Do not commit, push, deploy, " +
  "or send anything to another system: that happens after a person approves, and not by you.";

const SUFFIX = { none: NO_EDITS_SUFFIX, workspace: WORKSPACE_SUFFIX };

/**
 * The input as a prompt function sees it. Reading a field the caller did not
 * pass throws, where a template literal would render the word "undefined"
 * into the prompt -- nothing notices, and the agent answers around the hole.
 * A field passed as `undefined` is a deliberate absence and reads normally.
 * Top level only.
 */
function strictInput(input, step) {
  if (input === null || typeof input !== "object") return input;
  return new Proxy(input, {
    get(target, key, receiver) {
      // Symbols, and the probes that JSON.stringify and await make, are not fields.
      if (typeof key === "symbol" || key in target || key === "toJSON" || key === "then") {
        return Reflect.get(target, key, receiver);
      }
      throw new TypeError(`step "${step}": the prompt reads input.${key}, which the caller did not pass`);
    },
  });
}

const STEP = Symbol.for("paseo-orchestration.step");
const DEFINED = [];

/** Steps defined so far in this process, in order. `orch check` lists them. */
export const definedSteps = () => [...DEFINED];

export const isStep = (value) => Boolean(value?.[STEP]);

/**
 * @param {{
 *   name: string,
 *   effects: "none" | "workspace",
 *   returns: Record<string, object> | object,
 *   prompt: (input: unknown) => string,
 *   timeout?: string,
 * }} definition
 */
export function define(definition) {
  const { name, returns, prompt, effects, timeout } = definition ?? {};

  // Fail at definition time, which for a flow is import time: `orch check`
  // and the runner both import before anything is spent.
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new TypeError(`step.define needs a lowercase name (a verb: analyze, assess), got ${JSON.stringify(name)}`);
  }
  if (Object.hasOwn(definition, "readOnly")) {
    throw new TypeError(`step "${name}": readOnly is gone; declare effects: "none" (or "workspace" if it may edit files)`);
  }
  if (!EFFECTS.includes(effects)) {
    throw new TypeError(`step "${name}": effects is required and must be ${EFFECTS.map((e) => `"${e}"`).join(" or ")}`);
  }
  const unknown = Object.keys(definition).filter((key) => !["name", "returns", "prompt", "effects", "timeout"].includes(key));
  if (unknown.length > 0) throw new TypeError(`step "${name}": unknown key ${unknown.join(", ")}`);
  if (typeof prompt !== "function") throw new TypeError(`step "${name}": prompt must be a function`);
  if (!returns || typeof returns !== "object") throw new TypeError(`step "${name}": returns is required`);
  if (timeout !== undefined && !/^\d+(s|m|h)$/.test(timeout)) {
    throw new TypeError(`step "${name}": timeout must look like 90s, 12m or 2h, got "${timeout}"`);
  }

  // A full JSON Schema passes through; a field map gets built. `type` is the
  // discriminator because a field map can never have a `type` key that is a
  // string -- its values are schemas.
  const schema = typeof returns.type === "string" ? returns : objectSchema(returns);

  if (schema.type !== "object") {
    throw new TypeError(`step "${name}": returns must be an object schema; Codex rejects any other root`);
  }

  const fingerprint = createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 8);

  const step = Object.freeze({
    [STEP]: true,
    name,
    effects,
    schema,
    fingerprint,
    timeout,

    /**
     * The step's prompt for one input, with the effects line appended. Not
     * necessarily what is sent: a role with instructions has them prepended
     * at call time, and the event log records the text as sent.
     */
    for(input) {
      const body = prompt(strictInput(input, name));
      if (typeof body !== "string" || body.trim() === "") {
        throw new TypeError(`step "${name}": prompt returned no text`);
      }
      return `${body}\n\n${SUFFIX[effects]}`;
    },
  });
  DEFINED.push(step);
  return step;
}
