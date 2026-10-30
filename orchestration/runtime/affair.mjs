// The affair a run belongs to: whatever the caller says this run is for, as
// run.start.affair carries it. The runtime knows no plugin and no kind of
// affair -- it checks the shape and records it; a reader (orchestration-ui)
// draws what it is given.
//
//   { label: "Release 2.4 · blocked", url: "https://example.com/r/24",
//     link: { plugin: "tracker", screen: "case", params: { id: "24" } },
//     key: "release-24" }
//
// `key` is for the runtime, not for a screen: what makes two runs the same
// affair, when the link (which may carry more than the item's identity, a stage
// say) or the url is not it. Runs of one affair share a Paseo workspace
// (workspaces.mjs); without a key the link is the identity, then the url.
//
// The label and the url are drawn on a screen and the file they sit in can be
// edited by anyone with the disk, so they are checked here as untrusted text:
// bounded, no control or direction-overriding characters, a url that is a
// plain http(s) address with no credentials in it. Anything else is refused
// before the run starts rather than cleaned up: the caller wrote it down as an
// intent, and a record that differs from it would be a second source of truth.

export const LABEL_LIMIT = 120;
export const URL_LIMIT = 2_048;
export const KEY_LIMIT = 256;
export const PARAMS_LIMIT = 16;
export const PARAM_VALUE_LIMIT = 256;

/** Plugin ids, screen ids and param keys: no separators, nothing that needs escaping in a route. */
export const AFFAIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Written as escapes on purpose: these are invisible characters, and a literal one in a source file
// is lost the first time an editor or a formatter strips it. The list is fixtures/affair-cases.json,
// which this file and orchestration-ui/shared/affair.ts are both tested against.
//   C0/C1 controls, line and paragraph separators (\p{Cc} \p{Zl} \p{Zp});
//   direction: U+061C, U+200E, U+200F, U+202A-202E, U+2066-2069;
//   nothing drawn: U+200B (zero width space), U+2060 (word joiner), U+FEFF, U+00AD (soft hyphen),
//   U+034F, U+180E, U+2800 (blank braille) and the Hangul fillers U+115F, U+1160, U+3164, U+FFA0;
//   the tag block U+E0000-E007F.
// U+200C, U+200D (joiners) and U+FE0F (emoji selector) are part of ordinary text and stay allowed.
const HIDDEN = String.raw`\u061C\u200B\u200E\u200F\u2060\u202A-\u202E\u2066-\u2069\u00AD\u034F\u180E\u2800\u115F\u1160\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}`;
const UNSAFE_TEXT = new RegExp(String.raw`[\p{Cc}\p{Zl}\p{Zp}${HIDDEN}]`, "u");
const UNSAFE_IN_URL = new RegExp(String.raw`[\p{Cc}\p{Zs}\p{Zl}\p{Zp}${HIDDEN}]`, "u");

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const length = (text) => [...text].length;

function onlyKeys(where, object, allowed, problems) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) problems.push(`${where}: unknown key "${key}"; keys: ${allowed.join(", ")}`);
  }
}

/** What is wrong with a text that will be drawn on a screen (a label, a resume point's `from`), or null. Exported for resume-point.mjs. */
export function textProblem(where, value, limit) {
  if (typeof value !== "string") return `${where} must be a string`;
  if (value.trim() === "") return `${where} must not be empty`;
  if (length(value) > limit) return `${where} is longer than ${limit} characters`;
  if (UNSAFE_TEXT.test(value)) return `${where} has a control or direction-changing character`;
  return null;
}

function urlProblem(where, value) {
  if (typeof value !== "string" || value === "") return `${where} must be a non-empty string`;
  if (value.length > URL_LIMIT) return `${where} is longer than ${URL_LIMIT} characters`;
  if (UNSAFE_IN_URL.test(value)) return `${where} has a space, control or direction-changing character`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return `${where} is not an absolute URL`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `${where} must be http or https, got ${parsed.protocol}`;
  if (parsed.username !== "" || parsed.password !== "") return `${where} must not carry credentials`;
  return null;
}

/**
 * What is wrong with an affair value: an empty list when it is `null` or fits
 * `{ label, url?, link?: { plugin, screen, params? }, key? }`.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function affairProblems(value) {
  if (value === null || value === undefined) return [];
  if (!isObject(value)) return ["affair must be an object { label, url?, link?, key? } or null"];
  const problems = [];
  onlyKeys("affair", value, ["label", "url", "link", "key"], problems);

  const label = textProblem("affair.label", value.label, LABEL_LIMIT);
  if (label) problems.push(label);
  if (value.key !== undefined) {
    const key = textProblem("affair.key", value.key, KEY_LIMIT);
    if (key) problems.push(key);
  }
  if (value.url !== undefined) {
    const url = urlProblem("affair.url", value.url);
    if (url) problems.push(url);
  }
  if (value.link !== undefined) {
    const link = value.link;
    if (!isObject(link)) {
      problems.push("affair.link must be an object { plugin, screen, params? }");
    } else {
      onlyKeys("affair.link", link, ["plugin", "screen", "params"], problems);
      for (const key of ["plugin", "screen"]) {
        if (typeof link[key] !== "string" || !AFFAIR_NAME.test(link[key])) problems.push(`affair.link.${key} must match ${AFFAIR_NAME}`);
      }
      if (link.params !== undefined) {
        if (!isObject(link.params)) {
          problems.push("affair.link.params must be an object of strings");
        } else {
          const entries = Object.entries(link.params);
          if (entries.length > PARAMS_LIMIT) problems.push(`affair.link.params has more than ${PARAMS_LIMIT} entries`);
          for (const [key, entry] of entries) {
            if (!AFFAIR_NAME.test(key)) problems.push(`affair.link.params key ${JSON.stringify(key)} must match ${AFFAIR_NAME}`);
            if (typeof entry !== "string") problems.push(`affair.link.params.${key} must be a string`);
            else if (length(entry) > PARAM_VALUE_LIMIT) problems.push(`affair.link.params.${key} is longer than ${PARAM_VALUE_LIMIT} characters`);
            else if (UNSAFE_TEXT.test(entry)) problems.push(`affair.link.params.${key} has a control or direction-changing character`);
          }
        }
      }
    }
  }
  return problems;
}

/** The affair as run.start records it: the value as given, or null. Throws a TypeError naming every problem. */
export function parseAffair(value) {
  const problems = affairProblems(value);
  if (problems.length > 0) throw new TypeError(problems.join("; "));
  return value ?? null;
}
