// An agent's answer, read back and corrected in place.
//
// A flow's `check` (and the step's schema) can say that an answer is wrong at
// one place or two. Sending the whole prompt again to say so costs the whole
// answer; this module cuts the correction down to those places: a message that
// lists them, a schema that holds only them, and the merge of what comes back
// into the answer already in hand. The runner (run.mjs) does the sending.
//
// A place is a JSON pointer (RFC 6901): "/edits/4/old", "" for the whole answer.

import { objectSchema } from "./step.mjs";

/** More places than this are cheaper to ask for again as a whole answer than to list. */
export const MAX_PLACES = 8;
/** A value shown in a correction message is cut here: the agent wrote it, it only needs to recognise it. */
const NOW_LIMIT = 300;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const kindOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

// --- Pointers -------------------------------------------------------------

/** `pointer("edits", 4, "old")` is "/edits/4/old"; a "/" or "~" inside a key is escaped. */
export const pointer = (...segments) => segments.map((s) => `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

/** The keys a pointer names, in order. Throws on a string that is not a pointer. */
export function segmentsOf(at) {
  if (typeof at !== "string" || (at !== "" && !at.startsWith("/"))) throw new TypeError(`a problem's "at" is a JSON pointer such as "/edits/4/old", or "" for the whole answer; got ${JSON.stringify(at)}`);
  return at === "" ? [] : at.slice(1).split("/").map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** A pointer as a person (or a model) reads a place: `edits[4].old`. */
export function pathOf(at) {
  const segments = segmentsOf(at);
  if (segments.length === 0) return "the whole answer";
  return segments.map((s, i) => (/^\d+$/.test(s) ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? (i === 0 ? s : `.${s}`) : `[${JSON.stringify(s)}]`)).join("");
}

// --- Reading what the agent wrote ------------------------------------------

/**
 * The JSON in an agent's reply: a fenced block, else the first object or array that parses, else the whole text.
 * Undefined when there is none. (The CLI's own reading, so what it refused is read the same way here.)
 */
export function extractJson(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1]?.trim();
  for (const candidate of [fenced, firstJson(text), text.trim()]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // The next reading.
    }
  }
  return undefined;
}

function firstJson(text) {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close && (depth -= 1) === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

/**
 * The reply of a CLI call that refused it as not fitting the schema (`--max-retries 0`): its text, and the CLI's own
 * complaints as problems. Null for any other failure, and for a reply with nothing in it (an agent that never answered).
 */
export function schemaFailure(error) {
  if (error?.code !== "OUTPUT_SCHEMA_FAILED") return null;
  const text = error.details?.lastResponse;
  if (typeof text !== "string" || text.trim() === "") return null;
  const errors = (Array.isArray(error.details.validationErrors) ? error.details.validationErrors : []).flatMap((e) => {
    if (typeof e === "string") {
      const m = /^(\(root\)|\/\S*?): ([\s\S]*)$/.exec(e);
      return [m ? { at: m[1] === "(root)" ? "" : m[1], say: m[2] } : { at: "", say: e }];
    }
    return isObject(e) && typeof e.message === "string" ? [{ at: typeof e.instancePath === "string" ? e.instancePath : "", say: e.message }] : [];
  });
  // The extra fields are dropped before the answer is looked at again (stripUndeclared), so these say nothing now.
  return { text, errors: errors.filter((e) => !/additional propert/i.test(e.say)) };
}

/**
 * `value` without the fields an object schema does not declare (additionalProperties: false), and where they were.
 * A model that adds a field says something the flow has no place for; sending the answer back for it costs more than it is worth.
 */
export function stripUndeclared(schema, value, at = "") {
  if (schema?.type === "object" && isObject(value) && isObject(schema.properties)) {
    const out = {};
    const dropped = [];
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties, key)) {
        const inner = stripUndeclared(schema.properties[key], entry, `${at}${pointer(key)}`);
        out[key] = inner.value;
        dropped.push(...inner.dropped);
      } else if (schema.additionalProperties === false) dropped.push(`${at}${pointer(key)}`);
      else out[key] = entry;
    }
    return { value: out, dropped };
  }
  if (schema?.type === "array" && Array.isArray(value) && isObject(schema.items)) {
    const parts = value.map((item, i) => stripUndeclared(schema.items, item, `${at}${pointer(i)}`));
    return { value: parts.map((p) => p.value), dropped: parts.flatMap((p) => p.dropped) };
  }
  return { value, dropped: [] };
}

// --- Finding the problems --------------------------------------------------

/**
 * Where `value` does not fit `schema`, as problems { at, say }. Understands what the builders make (step.mjs) and the plain
 * keywords around them; a keyword it does not know is not checked here (the CLI checks the whole schema when it takes the reply).
 */
export function problemsOf(schema, value, at = "") {
  if (!isObject(schema)) return [];
  const kind = kindOf(value);
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  const fits = (type) => (type === "integer" ? Number.isInteger(value) : type === "number" ? kind === "number" && Number.isFinite(value) : type === kind);
  if (types.length > 0 && !types.some(fits)) return [{ at, say: `expected ${types.join(" or ")}, got ${kind === "number" && !Number.isFinite(value) ? String(value) : kind}` }];
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    return [{ at, say: `${JSON.stringify(value)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}` }];
  }
  if (kind === "array" && isObject(schema.items)) return value.flatMap((item, i) => problemsOf(schema.items, item, `${at}${pointer(i)}`));
  if (kind === "object" && isObject(schema.properties)) {
    const problems = (schema.required ?? []).filter((key) => !Object.hasOwn(value, key)).map((key) => ({ at: `${at}${pointer(key)}`, say: "is missing" }));
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties, key)) problems.push(...problemsOf(schema.properties[key], entry, `${at}${pointer(key)}`));
      else if (schema.additionalProperties === false) problems.push({ at: `${at}${pointer(key)}`, say: "is not a field the schema declares" });
    }
    return problems;
  }
  return [];
}

/**
 * What a flow's `check` returned, as problems: a list of { at, say }, a string (the whole answer), or nothing at all.
 * Anything else is the check's own mistake and throws.
 */
export function normalizeProblems(raw) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item) => {
    if (typeof item === "string" && item.trim() !== "") return { at: "", say: item.trim() };
    if (isObject(item) && typeof item.say === "string" && item.say.trim() !== "") {
      const at = item.at ?? "";
      segmentsOf(at);
      return { at, say: item.say.trim() };
    }
    throw new TypeError(`check returns a list of { at, say } (or a string, or nothing); got ${JSON.stringify(item)}`);
  });
}

// --- Asking for the correction ----------------------------------------------

/**
 * Where a problem's pointer lands in the schema and the value: the pointer itself, or its nearest ancestor that the schema
 * can be walked down to (an array's index, an object's declared key) -- a place inside a `oneOf`, or past the end of a list,
 * is asked for as the thing that holds it. `moved` says the pointer had to climb.
 */
function locate(schema, value, at) {
  const segments = segmentsOf(at);
  const kept = [];
  let sub = schema;
  let node = value;
  for (const segment of segments) {
    if (sub?.type === "object" && isObject(sub.properties) && Object.hasOwn(sub.properties, segment) && isObject(node)) {
      sub = sub.properties[segment];
      node = node[segment];
    } else if (sub?.type === "array" && isObject(sub.items) && /^(0|[1-9]\d*)$/.test(segment) && Array.isArray(node) && Number(segment) < node.length) {
      sub = sub.items;
      node = node[Number(segment)];
    } else break;
    kept.push(segment);
  }
  return { at: pointer(...kept), schema: sub, moved: kept.length < segments.length };
}

const isWithin = (inner, outer) => {
  const a = segmentsOf(inner);
  const b = segmentsOf(outer);
  return a.length >= b.length && b.every((s, i) => a[i] === s);
};

/**
 * The correction to ask for. Problems that sit inside one another are one place (the outer one, with what was said about
 * each). Up to MAX_PLACES places are asked for as `{ f1, f2, ... }`, each with the sub-schema of its place; more, or a
 * problem with the whole answer, are asked for as the whole answer. `moves` lists the pointers that had to climb.
 *
 * @returns {{ whole: boolean, items: { key: string, at: string, say: string, schema: object, now: unknown }[],
 *   problems: { at: string, say: string }[], schema: object, moves: { from: string, to: string }[] }}
 */
export function planFix(schema, value, problems) {
  const moves = [];
  const located = problems.map((p) => {
    const found = locate(schema, value, p.at);
    if (found.moved) moves.push({ from: p.at, to: found.at });
    return { ...found, say: p.say };
  });
  const places = [];
  for (const p of located) {
    const outer = places.find((q) => isWithin(p.at, q.at));
    if (outer) outer.says.push(p.say);
    else {
      const inner = places.filter((q) => isWithin(q.at, p.at));
      for (const q of inner) places.splice(places.indexOf(q), 1);
      places.push({ ...p, says: [p.say, ...inner.flatMap((q) => q.says)] });
    }
  }
  if (places.some((p) => p.at === "") || places.length > MAX_PLACES) {
    return { whole: true, items: [], problems: located.map((p) => ({ at: p.at, say: p.say })), schema, moves };
  }
  const items = places.map((p, i) => ({ key: `f${i + 1}`, at: p.at, say: p.says.join("; "), schema: p.schema, now: valueAt(value, p.at) }));
  return {
    whole: false,
    items,
    problems: items.map(({ at, say }) => ({ at, say })),
    schema: objectSchema(Object.fromEntries(items.map((i) => [i.key, i.schema]))),
    moves,
  };
}

function valueAt(value, at) {
  let node = value;
  for (const segment of segmentsOf(at)) node = node?.[segment];
  return node;
}

const shown = (v) => {
  if (v === undefined) return "(missing)";
  const text = JSON.stringify(v);
  return [...text].length > NOW_LIMIT ? `${[...text].slice(0, NOW_LIMIT).join("")}…` : text;
};

/**
 * The message for a correction: only the problems, never the answer again. The schema of the reply is not in it -- the CLI
 * adds the one it is given (`--output-schema`).
 */
export function fixPrompt(plan, { unread = false } = {}) {
  if (plan.whole) {
    const lines = plan.problems.map((p) => `- ${p.at === "" ? "" : `${pathOf(p.at)}: `}${p.say}`);
    return [
      unread ? "I could not read a JSON answer from your last reply." : `Your last answer has ${plan.problems.length} problem${plan.problems.length === 1 ? "" : "s"}.`,
      "Send the whole answer again, with the problems fixed and everything else as it was.",
      ...lines,
    ].join("\n");
  }
  const n = plan.items.length;
  const lines = plan.items.flatMap((i) => [`${i.key} = ${pathOf(i.at)}: ${i.say}`, `     now: ${shown(i.now)}`]);
  return [
    `Your last answer needs ${n} fix${n === 1 ? "" : "es"}. Everything else in it stands; do not repeat it.`,
    ...lines,
    `Reply with JSON only: ${plan.items.map((i) => i.key).join(", ")} and nothing else, each the corrected value of its place.`,
  ].join("\n");
}

/**
 * The answer with a correction's reply merged in. A place is taken as the reply gives it when it fits its own sub-schema;
 * one that does not is left as it was, and the next look finds it again. A whole answer is taken as it comes.
 */
export function applyFix(value, plan, reply) {
  if (plan.whole) return reply === undefined ? value : reply;
  if (!isObject(reply)) return value;
  const merged = structuredClone(value);
  for (const item of plan.items) {
    if (!Object.hasOwn(reply, item.key) || problemsOf(item.schema, reply[item.key]).length > 0) continue;
    const segments = segmentsOf(item.at);
    const parent = segments.slice(0, -1).reduce((node, s) => node[s], merged);
    parent[segments.at(-1)] = reply[item.key];
  }
  return merged;
}

// --- The call that could not be corrected -------------------------------------

/**
 * Thrown by `$.ask` when the answer still does not pass after the corrections it was allowed. A flow can catch it and decide;
 * left alone it ends the run as `stopped`, which can be carried on. `rounds` counts the answers given, the first included.
 */
export class CheckFailed extends Error {
  constructor({ step, problems, value, rounds, phase }) {
    super(`${step}: the answer still does not pass after ${rounds} round(s): ${problems.map((p) => `${p.at} ${p.say}`.trim()).join("; ")}`);
    this.name = "CheckFailed";
    this.step = step;
    this.problems = problems;
    this.value = value;
    this.rounds = rounds;
    this.phase = phase;
  }

  /** The line a person reads where the run stopped. */
  get reason() {
    const first = this.problems[0];
    return `${this.step}：核对 ${this.rounds} 轮还不过：${`${first.at} ${first.say}`.trim()}`;
  }
}
