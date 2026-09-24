// Fences: which provider mode a call runs in, per blast radius, and whether
// that mode actually holds the line or only asks the model to.
//
// A step declares `effects` (step.mjs); the gate's carrier needs `ask-human`.
// This table turns those into a Paseo `--mode` per provider family. It is data
// on purpose: the old rule lived in an if statement keyed on family names, and
// scripts passed provider words like "auto" themselves. Now a script names a
// blast radius and a role, and nothing else.
//
// A family missing here, or a level a family cannot provide, is an error --
// fail closed. Running a call in whatever mode Paseo defaults to is how a
// structured call ends up waiting on a permission nobody will answer, after
// the tokens are spent.
//
// Where each value comes from (paths relative to paseo/packages/server/src/server/agent/providers):
//
//   claude  plan | default | acceptEdits | auto | bypassPermissions   (claude/agent.ts DEFAULT_MODES)
//   pi      no modes (pi/agent.ts)
//   codex   auto | auto-review | full-access, plus a `read-only` preset that
//           the mode list does not show but the validator accepts
//           (codex-app-server-agent.ts CODEX_MODES and MODE_PRESETS).
//           `auto` is approvalPolicy on-request + sandbox workspace-write.
//
// `enforced` is true only where the provider itself blocks the thing, not
// where the prompt asks. A false here becomes a caveat on the run.

export const FENCES = {
  claude: {
    none: {
      mode: "auto",
      enforced: false,
      note:
        "Claude auto mode: a classifier approves tool calls, writes included; not editing is a request in the prompt. " +
        "plan would be read-only but raises a permission request every turn, which fails unattended calls " +
        "after the spend (measured 2026-09-22)",
    },
    workspace: {
      mode: "auto",
      enforced: false,
      note:
        "Claude auto mode: writes anywhere the classifier allows, not only the workspace; staying inside it is a " +
        "request in the prompt. default and acceptEdits stop at the first unanswered permission request " +
        "(measured 2026-09-23 on a hotfix draft)",
    },
    "ask-human": {
      mode: "default",
      enforced: true,
      // Paseo describes it as "Prompts for permission the first time a tool
      // is used"; the carrier uses one tool once, so that is every write.
      note: "Claude Always Ask: the carrier's one Write waits for a person's answer (measured 2026-09-23 with the gate)",
    },
  },
  codex: {
    none: {
      mode: "auto",
      enforced: false,
      note:
        "Codex auto is sandbox workspace-write; not editing is a request in the prompt. Codex's hidden read-only " +
        "preset exists in the source but has not been run unattended here",
    },
    workspace: {
      mode: "auto",
      enforced: false,
      note:
        "Codex auto: sandbox workspace-write, on-request approval (source). Whether the sandbox holds on Windows " +
        "has not been measured, and inside a Paseo agent the workspace is the caller's, not the requested cwd",
    },
    // No ask-human: on-request only asks when a command leaves the sandbox,
    // so writes inside the workspace would land without a person.
  },
  // The private relay-* roles run here. Pi has no modes at all -- setMode
  // throws "Pi does not expose selectable modes" (pi/agent.ts) -- so no
  // --mode is passed, and its permission requests are only extension
  // questions, not tool calls: tools run unasked. Source, not measured here.
  pi: {
    none: {
      mode: null,
      enforced: false,
      note: "Pi has no modes and does not ask before tool calls (source); not editing is a request in the prompt",
    },
    workspace: {
      mode: null,
      enforced: false,
      note: "Pi has no modes and does not ask before tool calls (source); staying in the workspace is a request in the prompt",
    },
  },
};

export const LEVELS = ["none", "workspace", "ask-human"];

/**
 * The fence one call runs behind.
 *
 * @param {string} provider `<family>/<model>`
 * @param {"none" | "workspace" | "ask-human"} level
 * @returns {{ mode: string | null, enforced: boolean, note: string }}
 */
export function fenceFor(provider, level) {
  if (!LEVELS.includes(level)) throw new TypeError(`unknown fence level "${level}"; levels: ${LEVELS.join(", ")}`);
  const family = String(provider).split("/")[0];
  const table = FENCES[family];
  if (!table) {
    throw new Error(
      `No fence for provider family "${family}" (${provider}). Add it to runtime/fences.mjs with a mode per level ` +
        `and where that mode comes from; running it on Paseo's default mode is not an option.`,
    );
  }
  const fence = table[level];
  if (!fence) {
    throw new Error(`${family} has no "${level}" fence: ${level === "ask-human" ? "its modes cannot hold every write for a person" : "not declared"} (runtime/fences.mjs)`);
  }
  return { ...fence };
}
