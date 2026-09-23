// Run this after a Paseo upgrade, and before committing runtime changes.
//
// `paseo-cli.mjs` reaches past `paseo.cmd` into the install layout, so an
// upgrade that moves Paseo.exe breaks the launch path. The schema checks guard
// the invariant that R2 in CONVENTIONS.md depends on.
//
//   node runtime/smoke.mjs          fast checks, no agent spend
//   node runtime/smoke.mjs --agent  also runs two haiku agents end to end

import { runPaseo, runPaseoJson } from "./paseo-cli.mjs";
import { evaluate } from "./orch.mjs";
import { Orchestrator } from "./agents.mjs";
import { Audit } from "./audit.mjs";
import { loadRoster, parseRole, ROLES_DIR } from "./roster.mjs";
import { parseConfig } from "./config.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { define, text, choice, list } from "./step.mjs";
import { COMMITTEES } from "../scripts/committee.mjs";

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

const sample = define({
  name: "sample",
  returns: { a: text("first"), b: choice(["x", "y"]), c: list(text()) },
  prompt: ({ v }) => `do ${v}`,
});

check(
  "schema requires every field",
  JSON.stringify(sample.schema.required) === JSON.stringify(["a", "b", "c"]),
  sample.schema.required.join(","),
);
check("schema forbids extra properties", sample.schema.additionalProperties === false);
check("fingerprint is stable", sample.fingerprint === define({ ...sampleDef(), name: "sample" }).fingerprint);
check("readOnly appends the suffix", define({ ...sampleDef(), readOnly: true }).for({ v: "z" }).prompt.includes("Do NOT edit"));
check("plain step does not", !sample.for({ v: "z" }).prompt.includes("Do NOT edit"));

check("define rejects a missing prompt", throws(() => define({ name: "x", returns: { a: text() } })));
check("define rejects empty returns", throws(() => define({ name: "x", returns: {}, prompt: () => "p" })));
check("define rejects a non-object root", throws(() => define({ name: "x", returns: text(), prompt: () => "p" })));
check("choice rejects an empty list", throws(() => choice([])));

const reads = define({ name: "reads", returns: { a: text() }, prompt: ({ a, b }) => `${a} ${b}` });
check("step refuses input missing a field its prompt reads", throws(() => reads.for({ a: "x" })));
const whole = define({ name: "whole", returns: { a: text() }, prompt: (input) => JSON.stringify(input) });
check(
  "explicit undefined and whole-input prompts still work",
  !throws(() => reads.for({ a: "x", b: undefined })) && whole.for({ a: 1 }).prompt === '{"a":1}',
);

function sampleDef() {
  return { name: "sample", returns: { a: text("first"), b: choice(["x", "y"]), c: list(text()) }, prompt: ({ v }) => `do ${v}` };
}

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

// Binding rules, checked without spawning anything: `role: ""` must not
// quietly mean "no role", and moving a role that pins thinking to another
// model must not quietly drop the pin.
const binder = new Orchestrator({
  grants: [], // a binding that wrongly passes stops at GrantError, never at a spawn
  roster: {
    defaultRole: "a",
    roles: {
      a: { provider: "claude/m1", description: "d", thinking: "high", instructions: "" },
    },
  },
});
const bindRefusals = {
  // `mode` is passed so these reach binding and nothing else: without it the
  // writable-step check would refuse them first and hide a binding regression.
  "empty role name": () => binder.ask(define({ ...sampleDef() }), { v: "z" }, { role: "", mode: "auto" }),
  "thinking pin across models": () =>
    binder.ask(define({ ...sampleDef() }), { v: "z" }, { role: "a", provider: "codex/m2", mode: "auto" }),
};
const bindAccepted = [];
for (const [name, call] of Object.entries(bindRefusals)) {
  const outcome = await call().then(() => "ran", (error) => (error.name === "GrantError" ? "reached spawn" : "refused"));
  if (outcome !== "refused") bindAccepted.push(`${name}: ${outcome}`);
}
check(`roles: binding refuses ${Object.keys(bindRefusals).length} ambiguous calls`, bindAccepted.length === 0, bindAccepted.join(", "));

// A step that may write must name its mode: left to Paseo, Claude asks a
// person, and an unattended structured call dies waiting (hotfix, 2026-09-23).
const writable = await binder.ask(define({ ...sampleDef() }), { v: "z" }, { role: "a" }).then(
  () => "ran",
  (error) => (error.name === "GrantError" ? "reached spawn" : "refused"),
);
check("a writable step without a mode is refused", writable === "refused", writable);

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

// --- Eval entry point -------------------------------------------------

const evaluated = await evaluate("return 1 + 1;", { name: "smoke" });
check("eval returns value", evaluated.ok && evaluated.value === 2, `auditId ${evaluated.auditId}`);
check("eval skips cost collection when no agent ran", evaluated.cost === null);

const refused = await evaluate("return await agents.archive('smoke-nonexistent');", { name: "smoke-grant" });
check("ungranted action refused", !refused.ok && refused.error.name === "GrantError");

const stepInScope = await evaluate("return typeof step.define === 'function' && typeof step.text === 'function';", {
  name: "smoke-inject",
});
check("step is in scope inside eval", stepInScope.ok && stepInScope.value === true);

// --- One real agent ---------------------------------------------------

if (wantAgent) {
  const answered = await evaluate(
    `const add = step.define({
       name: 'add',
       readOnly: true,
       returns: { answer: step.text('The sum, as digits.') },
       prompt: ({ a, b }) => \`Compute \${a} + \${b}.\`,
     });
     return await agents.ask(add, { a: 1, b: 1 }, { role: 'fast' });`,
    { name: "smoke-agent" },
  );
  check("agent round trip via step", answered.ok && String(answered.value?.answer).includes("2"), JSON.stringify(answered.value));
  check("cost collected", answered.cost?.agentCount >= 1, `${answered.cost?.agentCount} agent(s), $${answered.cost?.totalUsd}`);

  // The prompt alone gives no reason to write this marker; only the role's
  // instructions do. Seeing it proves the body reached the model.
  const marker = "ROLE-INSTRUCTIONS-SEEN";
  const probe = new Orchestrator({
    audit: new Audit({ script: "smoke-role" }),
    roster: {
      defaultRole: "probe",
      roles: { probe: { ...roster.roles.fast, instructions: `Whatever the task, set the field "marker" to exactly ${marker}.` } },
    },
  });
  const mark = define({ name: "mark", readOnly: true, returns: { marker: text() }, prompt: () => "Fill in the fields." });
  const marked = await probe.ask(mark, {}).catch((error) => ({ error: error.message }));
  check("role instructions reach the agent", marked.marker === marker, JSON.stringify(marked));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
