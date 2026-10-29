// The executor: the only part of the runtime that talks to Paseo.
//
// The runner (run.mjs) decides what to call and records it; an executor only
// carries it out. The interface is the handful of things the runner needs,
// in its own words rather than CLI verbs, so a test can hand in a fake and
// run a whole flow without spending anything, and so moving execution into
// the daemon one day replaces this file and nothing else.
//
//   ask(request)          run an agent to completion; resolves to its structured output
//   spawn(request)        start an agent without waiting; resolves to { agentId }
//   findAgent(labels)     id of the agent carrying every one of these labels, or null
//   inspect(agentId)      { status, usage: { usd, inputTokens, outputTokens } | null }
//   transcript(agentId, { tail, filter })   the agent's timeline as text
//   deny(agentId, { message })              deny every pending permission request
//   stop(agentId)                           interrupt it
//   archiveAgent(agentId)                   archive it (soft-delete; refused while it is still running)
//   providerAvailable(family)               true when Paseo lists it as available and enabled
//   listWorkspaces()                        [{ workspaceId, name, cwd }], hidden ones too
//   createWorkspace({ cwd, title })         { workspaceId } of a new background workspace on cwd
//
// A request is { provider, thinking, mode, title, labels, prompt, cwd } plus,
// for ask, { schema, timeout }, and `workspace` (a workspace id) when the agent
// is to be started in that workspace. A workspace's agents all work in the
// workspace's own directory: `paseo run --workspace` ignores --cwd.

import { runPaseo, runPaseoJson } from "./paseo-cli.mjs";
import { cutTitle } from "./workspaces.mjs";

/** Titles are truncated for Paseo; the events record the same truncated text. */
export const sentTitle = (title) => title.slice(0, 120);

/** Listing or making a workspace is a quick call; one that hangs would hold the affair's lock. */
const WORKSPACE_CALL_TIMEOUT_MS = 60_000;

function agentArgs({ provider, thinking, title, mode, labels, workspace }) {
  const args = ["--provider", provider];
  if (workspace) args.push("--workspace", workspace);
  if (thinking) args.push("--thinking", thinking);
  if (title) args.push("--title", sentTitle(title));
  if (mode) args.push("--mode", mode);
  for (const [key, value] of Object.entries(labels ?? {})) args.push("--label", `${key}=${value}`);
  return args;
}

/**
 * The executor over the `paseo` CLI.
 *
 * @param {{ host?: string | null, cli?: { runPaseo: typeof runPaseo, runPaseoJson: typeof runPaseoJson } }} [options]
 *   `cli`: how a command is run -- a test hands in a recorder to see the arguments the CLI would get
 */
export function paseoExecutor({ host = null, cli = { runPaseo, runPaseoJson } } = {}) {
  const runJson = cli.runPaseoJson;
  const runText = cli.runPaseo;
  // Locally the agent's directory is the CLI's own. On another host it is a
  // path there, which this process cannot start in, so it goes as --cwd.
  const opts = (cwd) => ({ cwd: host ? undefined : cwd, host: host ?? undefined });
  const where = (cwd) => (host && cwd ? ["--cwd", cwd] : []);
  return {
    // `--output-schema` makes stdout the agent's structured output, with no
    // agent id in it; the runner finds the agent again by its labels.
    ask: (request) =>
      runJson(
        ["run", ...agentArgs(request), ...where(request.cwd), "--wait-timeout", request.timeout, "--output-schema", JSON.stringify(request.schema), request.prompt],
        opts(request.cwd),
      ),

    // Paseo rejects --output-schema with --background, so only unstructured
    // agents (the gate's carrier) are spawned.
    spawn: async (request) => {
      const started = await runJson(["run", "--background", ...agentArgs(request), ...where(request.cwd), request.prompt], opts(request.cwd));
      return { agentId: started.agentId };
    },

    // `-g`: ls lists only the current directory's agents otherwise. `-a`: an
    // agent whose parent was archived is archived with it. Several --label
    // flags are ANDed (cli/src/commands/agent/ls.ts).
    findAgent: async (labels) => {
      const args = ["ls", "-g", "-a"];
      for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
      const found = (await runJson(args, opts())) ?? [];
      return found[0]?.id ?? null;
    },

    // `inspect --json` is PascalCase, unlike `ls --json`. LastUsage is the
    // last turn, which for one structured call is the whole call. Codex
    // reports CostUsd 0 with real token counts; it is passed on as is.
    inspect: async (agentId) => {
      const detail = await runJson(["inspect", agentId], opts());
      const usage = detail?.LastUsage ?? null;
      return {
        status: detail?.Status ?? null,
        usage: usage
          ? { usd: usage.CostUsd ?? null, inputTokens: usage.InputTokens ?? null, outputTokens: usage.OutputTokens ?? null }
          : null,
      };
    },

    transcript: async (agentId, { tail = 50, filter = "text" } = {}) => {
      const args = ["logs", agentId, "--filter", filter];
      if (tail) args.push("--tail", String(tail));
      return (await runText(args, opts())).stdout;
    },

    deny: async (agentId, { message } = {}) => {
      const args = ["permit", "deny", agentId, "--all"];
      if (message) args.push("--message", message);
      await runJson(args, opts());
    },

    stop: async (agentId) => {
      await runJson(["stop", agentId], opts());
    },

    // No --force: an agent still running is refused (exit code 1), not interrupted. A call that handed in its answer
    // has stopped; one that has not is left as it is, and the runner says so in a caveat (run.mjs).
    archiveAgent: async (agentId) => {
      await runJson(["archive", agentId], opts());
    },

    // `provider ls --json` rows are { provider, status: "available" | ..., enabled: "Enabled" | "Disabled" }
    // (cli/src/commands/provider/ls.ts). Plugin providers are listed with the rest.
    providerAvailable: async (family) => {
      const rows = (await runJson(["provider", "ls"], opts())) ?? [];
      return rows.some((row) => row.provider === family && row.status === "available" && row.enabled === "Enabled");
    },

    // `workspace ls --json` rows are { workspaceId, project, name, isolation, cwd, background }.
    // `--background` includes hidden ones, and the affair's workspace is one: `create` is given `--background` (2026-10-29), because the
    // place a person follows an affair is its page in the reconcile plugin, not a workspace in the sidebar that grows by one for every
    // matter. Hiding only keeps it out of the sidebar and the default lists: the permission requests of the agents in it still raise
    // the app's notifications, and its links and Ctrl+K still open it. Which it is, is decided when it is made and cannot be changed.
    // Neither is for another host: runs with --host keep their agents where Paseo puts them (workspaces.mjs).
    listWorkspaces: async () => {
      const rows = (await runJson(["workspace", "ls", "--background"], { ...opts(), timeoutMs: WORKSPACE_CALL_TIMEOUT_MS })) ?? [];
      return rows.map((row) => ({ workspaceId: row.workspaceId, name: row.name, cwd: row.cwd }));
    },

    createWorkspace: async ({ cwd, title }) => {
      const made = await runJson(
        ["workspace", "create", "--isolation", "local", "--path", cwd, "--title", cutTitle(title), "--background"],
        { ...opts(), timeoutMs: WORKSPACE_CALL_TIMEOUT_MS },
      );
      if (typeof made?.workspaceId !== "string") throw new Error("paseo workspace create returned no workspaceId");
      return { workspaceId: made.workspaceId };
    },
  };
}
