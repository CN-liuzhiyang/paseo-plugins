// A step is one agent call's whole contract: what to ask, what must come
// back, and which constraints apply. They live in one object because they are
// one decision -- a prompt that asks for something the schema has no field for
// fails silently, and no test catches it.
//
// Field builders below emit plain JSON Schema. Nothing here is a type system;
// if a step needs something these cannot express, write the JSON Schema by
// hand and pass it as `returns`. The builders exist to remove repetition and
// two specific mistakes, not to wrap every schema in the world.

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
export function objectSchema(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new TypeError("returns must be a map of field name to field schema");
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) throw new TypeError("returns must declare at least one field");

  return {
    type: "object",
    properties: fields,
    required: keys,
    additionalProperties: false,
  };
}

// --- Step definition --------------------------------------------------

// "Do not write code" used to be here too. It contradicts any step whose
// answer is code (hotfix `draft` returns a Lua file through its schema); the
// line that matters is the one about files.
export const NO_EDITS_SUFFIX =
  "Do NOT edit, create, or delete any files. Everything you produce goes in your answer.";

/**
 * The input as a prompt function sees it. Reading a field the caller did not
 * pass throws, where a template literal would render the word "undefined"
 * into the prompt -- nothing notices, and the agent answers around the hole.
 * A field passed as `undefined` is a deliberate absence and reads normally
 * (advisor's optional `context`). Top level only.
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

/**
 * @param {{
 *   name: string,
 *   returns: Record<string, object> | object,
 *   prompt: (input: unknown) => string,
 *   readOnly?: boolean,
 *   timeout?: string,
 * }} definition
 */
export function define(definition) {
  const { name, returns, prompt, readOnly = false, timeout } = definition ?? {};

  // Fail at definition time. A malformed step found at call time has already
  // cost a process spawn, and possibly an agent.
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("step.define needs a name");
  if (typeof prompt !== "function") throw new TypeError(`step "${name}": prompt must be a function`);
  if (!returns || typeof returns !== "object") throw new TypeError(`step "${name}": returns is required`);

  // A full JSON Schema passes through; a field map gets built. `type` is the
  // discriminator because a field map can never have a `type` key that is a
  // string -- its values are schemas.
  const schema = typeof returns.type === "string" ? returns : objectSchema(returns);

  if (schema.type !== "object") {
    throw new TypeError(`step "${name}": returns must be an object schema; Codex rejects any other root`);
  }

  const fingerprint = createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 8);

  return {
    name,
    readOnly,
    schema,
    fingerprint,
    timeout,

    /**
     * Materialize into the arguments of an agent call. Kept separate from
     * `ask()` so a step stays usable with `agents.run()` directly. This is the
     * step's prompt, not necessarily what is sent: a role with instructions
     * has them prepended at call time. The audit records the text as sent.
     */
    for(input) {
      const body = prompt(strictInput(input, name));
      if (typeof body !== "string" || body.trim() === "") {
        throw new TypeError(`step "${name}": prompt returned no text`);
      }
      return {
        prompt: readOnly ? `${body}\n\n${NO_EDITS_SUFFIX}` : body,
        schema,
        step: name,
        fingerprint,
        readOnly,
        ...(timeout ? { timeout } : {}),
      };
    },
  };
}
