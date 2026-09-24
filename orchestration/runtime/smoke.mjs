// Run this after a Paseo upgrade, and before committing runtime changes.
//
// `paseo-cli.mjs` reaches past `paseo.cmd` into the install layout, so an
// upgrade that moves Paseo.exe breaks the launch path. The schema checks guard
// the invariant that R2 in CONVENTIONS.md depends on; the roster checks catch
// model and thinking ids that moved; the fence checks catch a role nobody can
// run. The unit tests (npm test) cover the runner on a fake executor; this is
// what only a real Paseo can answer.
//
//   node runtime/smoke.mjs          fast checks, no agent spend
//   node runtime/smoke.mjs --agent  also runs two haiku agents end to end, as flows

import { runPaseo, runPaseoJson } from "./paseo-cli.mjs";
import { loadRoster, parseRole, bindRole, ROLES_DIR } from "./roster.mjs";
import { parseConfig } from "./config.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { define, text, choice, list } from "./step.mjs";
import { flow, checkFlow } from "./flow.mjs";
import { fenceFor, FENCES } from "./fences.mjs";
import { runFlow } from "./run.mjs";
import { readEvents, checkEvents } from "./events.mjs";
import { carrierPrompt, fitBrief } from "./gate.mjs";
import { COMMITTEES } from "../flows/committee.mjs";

const FLOWS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "flows");
const wantAgent = process.argv.includes("--agent");
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// --- Launch path ------------------------------------------------------

const status = await runPaseoJson(["status"]);
check("daemon reachable", status.localDaemon === "running", `${status.hostname} ${status.daemonVersion}`);

// Non-ASCII, quoted, spaced arguments must survive the spawn. `inspect` echoes
// the id it could not find, so a mangled argument is visible for free.
const probe = '中文测试-"quoted"-with space';
const { stdout, stderr } = await runPaseo(["inspect", probe]);
check("argument encoding intact", `${stdout}${stderr}`.includes(probe));

// --- Step contract ----------------------------------------------------

function sampleDef() {
  return { name: "sample", effects: "none", returns: { a: text("first"), b: choice(["x", "y"]), c: list(text()) }, prompt: ({ v }) => `do ${v}` };
}
const sample = define(sampleDef());

check(
  "schema requires every field",
  JSON.stringify(sample.schema.required) === JSON.stringify(["a", "b", "c"]),
  sample.schema.required.join(","),
);
check("schema forbids extra properties", sample.schema.additionalProperties === false);
check("fingerprint is stable", sample.fingerprint === define(sampleDef()).fingerprint);
check("effects none appends the no-edits line", sample.for({ v: "z" }).includes("Do NOT edit"));
check("effects workspace does not", !define({ ...sampleDef(), effects: "workspace" }).for({ v: "z" }).includes("Do NOT edit"));

check("define rejects a missing prompt", throws(() => define({ name: "x", effects: "none", returns: { a: text() } })));
check("define rejects empty returns", throws(() => define({ name: "x", effects: "none", returns: {}, prompt: () => "p" })));
check("define rejects a non-object root", throws(() => define({ name: "x", effects: "none", returns: text(), prompt: () => "p" })));
check("define rejects a step without effects", throws(() => define({ name: "x", returns: { a: text() }, prompt: () => "p" })));
check("define rejects a headline that names no field", throws(() => define({ ...sampleDef(), headline: "z" })));
check("choice rejects an empty list", throws(() => choice([])));

const reads = define({ name: "reads", effects: "none", returns: { a: text() }, prompt: ({ a, b }) => `${a} ${b}` });
check("step refuses input missing a field its prompt reads", throws(() => reads.for({ a: "x" })));
const whole = define({ name: "whole", effects: "none", returns: { a: text() }, prompt: (input) => JSON.stringify(input) });
check(
  "explicit undefined and whole-input prompts still work",
  !throws(() => reads.for({ a: "x", b: undefined })) && whole.for({ a: 1 }).startsWith('{"a":1}'),
);

// --- Gate brief ---------------------------------------------------------

const briefed = carrierPrompt("C:/hold/a.lua", "local x = 1", "Ticket #1: checks passed");
check(
  "gate: the brief comes first, the content is intact",
  briefed.startsWith("Ticket #1") && briefed.includes("<<<CONTENT\nlocal x = 1\nCONTENT>>>"),
);
check("gate: no brief, no notes section", !carrierPrompt("C:/hold/a.lua", "x").includes("notes above"));
const cut = fitBrief("C:/hold/a.lua", "y".repeat(2_000), "z".repeat(5_000), 4_000);
check(
  "gate: a long brief is cut to fit, never the content",
  cut.length < 5_000 && carrierPrompt("C:/hold/a.lua", "y".repeat(2_000), cut).length <= 4_000,
  `${cut.length} characters kept`,
);

// --- Role files -------------------------------------------------------
//
// The parser's job is to refuse. Each case below is a file that a lenient
// parser would load into a role running on settings nobody wrote.

const role = (head, body = "") => `---\n${head}\n---\n${body}`;
const bom = String.fromCharCode(0xfeff);
const parsed = parseRole("probe", `${bom}${role("provider: claude/x\r\ndescription: 'd'", "\r\n  Be terse.\r\n")}`);
check(
  "roles: parser reads fields, quotes, BOM, CRLF, body",
  parsed.provider === "claude/x" && parsed.description === "d" && parsed.thinking === null && parsed.instructions === "Be terse.",
  JSON.stringify(parsed),
);

const refusals = {
  "misspelled key": () => parseRole("r", role("provder: claude/x\ndescription: d")),
  "missing provider": () => parseRole("r", role("description: d")),
  "bare family": () => parseRole("r", role("provider: claude\ndescription: d")),
  "nested value": () => parseRole("r", role("provider: claude/x\ndescription: d\n  extra: y")),
  "duplicate key": () => parseRole("r", role("provider: claude/x\nprovider: codex/y\ndescription: d")),
  "no frontmatter": () => parseRole("r", "provider: claude/x"),
  "bad file name": () => parseRole("Planner", role("provider: claude/x\ndescription: d")),
  "unclosed quote": () => parseRole("r", role('provider: "claude/x\ndescription: d')),
  "inherited key": () => parseRole("r", role("provider: claude/x\ndescription: d\nconstructor: y")),
};
const accepted = Object.entries(refusals).filter(([, fn]) => !throws(fn)).map(([name]) => name);
check(`roles: parser refuses ${Object.keys(refusals).length} malformed files`, accepted.length === 0, accepted.join(", "));

// A private roles directory adds roles; it must not silently replace a shipped one.
const extra = await mkdtemp(path.join(os.tmpdir(), "orch-roles-"));
await writeFile(path.join(extra, "worker.md"), role("provider: claude/x\ndescription: d"));
const shadowed = await loadRoster([ROLES_DIR, extra]).then(() => "loaded", (error) => error.message);
await rm(extra, { recursive: true, force: true });
check("roles: a name defined in two directories is refused", shadowed.includes("already defined"), shadowed);

// --- Machine config ---------------------------------------------------

const configRefusals = {
  "misspelled key": '{"paseoInstalDir": "C:/x"}',
  "wrong shape": '{"rolesDirs": "C:/x"}',
  "not an object": '["C:/x"]',
  "not JSON": "{paseoInstallDir: 1}",
};
const configAccepted = Object.entries(configRefusals)
  .filter(([, source]) => !throws(() => parseConfig(source, "probe")))
  .map(([name]) => name);
check(`config: parser refuses ${Object.keys(configRefusals).length} malformed files`, configAccepted.length === 0, configAccepted.join(", "));
check("config: parser reads a BOM-prefixed file", parseConfig(`${bom}{"logDir": "C:/logs"}`, "probe").logDir === "C:/logs");

// Binding rules: `role: ""` must not quietly mean "no role", and moving a
// role that pins thinking to another model must not quietly drop the pin.
const pinned = {
  defaultRole: "a",
  roles: { a: { provider: "claude/m1", description: "d", thinking: "high", instructions: "" } },
};
const bindRefusals = {
  "empty role name": () => bindRole(pinned, { role: "" }),
  "thinking pin across models": () => bindRole(pinned, { role: "a", provider: "codex/m2" }),
  "inherited name": () => bindRole(pinned, { role: "constructor" }),
};
const bindAccepted = Object.entries(bindRefusals).filter(([, fn]) => !throws(fn)).map(([name]) => name);
check(`roles: binding refuses ${Object.keys(bindRefusals).length} ambiguous calls`, bindAccepted.length === 0, bindAccepted.join(", "));

// --- Roster against the daemon ----------------------------------------
//
// A model id that no longer exists fails at call time, after a process spawn
// and with nothing useful in the error. Model ids churn, so check them here
// where it is free. So are thinking ids, per model: opus-5-5 has no "off",
// and a model swap carries the old role's thinking level over unless someone
// looks. This check exists because the committee proposed it about this
// repository on its first real run.

const roster = await loadRoster();
const wanted = new Map();
for (const [name, entry] of Object.entries(roster.roles)) {
  const [family, ...rest] = entry.provider.split("/");
  if (!wanted.has(family)) wanted.set(family, []);
  wanted.get(family).push({ name, id: rest.join("/"), thinking: entry.thinking });
}

for (const [family, entries] of wanted) {
  const available = await runPaseoJson(["provider", "models", family]).catch(() => null);
  if (!available) {
    check(`roles: provider "${family}" reachable`, false, "could not list models");
    continue;
  }
  const models = new Map(available.map((m) => [m.id, m]));
  const problems = entries.flatMap((e) => {
    const model = models.get(e.id);
    if (!model) return [`${e.name}: no model ${e.id}`];
    if (e.thinking && !(model.thinkingOptionIds ?? []).includes(e.thinking)) {
      return [`${e.name}: ${e.id} has no thinking "${e.thinking}" (has ${(model.thinkingOptionIds ?? []).join(",") || "none"})`];
    }
    return [];
  });
  check(`roles: ${family} models and thinking ids exist`, problems.length === 0, problems.join("; ") || `${entries.length} checked`);
}

const unknownMembers = Object.entries(COMMITTEES).flatMap(([name, members]) =>
  members.filter((m) => !roster.roles[m]).map((m) => `${name}:${m}`),
);
check("roles: committees name real roles", unknownMembers.length === 0, unknownMembers.join(", "));

// Every role needs a fence to run behind, and the gate's carrier needs the
// ask-human one. A role without one is refused at its first call, which is
// free, but finding out here is freer.
const unfenced = Object.entries(roster.roles).flatMap(([name, entry]) =>
  ["none", "workspace"].filter((level) => throws(() => fenceFor(entry.provider, level))).map((level) => `${name}:${level}`),
);
check("fences: every role can run a none and a workspace step", unfenced.length === 0, unfenced.join(", ") || Object.keys(FENCES).join(", "));
check("fences: the gate's carrier (fast) can ask a person", !throws(() => fenceFor(roster.roles.fast.provider, "ask-human")));

// --- Flows -------------------------------------------------------------

for (const name of ["committee", "advisor"]) {
  const checked = await checkFlow(path.join(FLOWS, `${name}.mjs`), { roster });
  check(`flows: ${name} passes check`, checked.ok && checked.warnings.length === 0, [...checked.problems, ...checked.warnings].join("; "));
}

// --- Real agents ------------------------------------------------------

if (wantAgent) {
  // Both go through the runner and the real executor, and are checked the way
  // a reader of the events would check them.
  const add = define({
    name: "add",
    effects: "none",
    timeout: "5m",
    returns: { answer: text("The sum, as digits.") },
    prompt: ({ a, b }) => `Compute ${a} + ${b}.`,
  });
  const adder = flow({
    name: "smoke-add",
    description: "smoke: one real agent through a step",
    phases: [],
    inputs: {},
    grants: [],
    run: (_, $) => $.ask(add, { a: 1, b: 1 }, { role: "fast" }),
  });
  const answered = await runFlow(adder, { roster });
  check("agent round trip via a flow", answered.outcome === "done" && String(answered.value?.answer).includes("2"), JSON.stringify(answered.value ?? answered.error));
  const events = readEvents(answered.events);
  const problems = checkEvents(events, { strict: true, complete: true });
  check("events conform to EVENTS.md", problems.length === 0, problems.join("; ") || answered.events);
  const end = events.find((e) => e.kind === "call.end");
  check("call.end names its agent", typeof end?.agentId === "string", end?.agentId);
  check("call.end has its cost", typeof end?.cost?.usd === "number", JSON.stringify(end?.cost));

  // The prompt alone gives no reason to write this marker; only the role's
  // instructions do. Seeing it proves the body reached the model.
  const marker = "ROLE-INSTRUCTIONS-SEEN";
  const mark = define({ name: "mark", effects: "none", timeout: "5m", returns: { marker: text() }, prompt: () => "Fill in the fields." });
  const marked = await runFlow(
    flow({ name: "smoke-role", description: "smoke: role instructions", phases: [], inputs: {}, grants: [], run: (_, $) => $.ask(mark, {}) }),
    {
      roster: {
        defaultRole: "probe",
        roles: { ...roster.roles, probe: { ...roster.roles.fast, instructions: `Whatever the task, set the field "marker" to exactly ${marker}.` } },
      },
    },
  );
  check("role instructions reach the agent", marked.value?.marker === marker, JSON.stringify(marked.value ?? marked.error));
  const spent = (answered.cost?.totalUsd ?? 0) + (marked.cost?.totalUsd ?? 0);
  console.log(`\nruns ${answered.runId}, ${marked.runId}; spent $${spent.toFixed(4)}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
