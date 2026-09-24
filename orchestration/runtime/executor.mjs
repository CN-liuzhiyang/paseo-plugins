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
//
// A request is { provider, thinking, mode, title, labels, prompt, cwd } plus,
// for ask, { schema, timeout }.

import { runPaseo, runPaseoJson } from "./paseo-cli.mjs";

/** Titles are truncated for Paseo; the events record the same truncated text. */
export const sentTitle = (title) => title.slice(0, 120);

function agentArgs({ provider, thinking, title, mode, labels }) {
  const args = ["--provider", provider];
  if (thinking) args.push("--thinking", thinking);
  if (title) args.push("--title", sentTitle(title));
  if (mode) args.push("--mode", mode);
  for (const [key, value] of Object.entries(labels ?? {})) args.push("--label", `${key}=${value}`);
  return args;
}

/**
 * The executor over the `paseo` CLI.
 *
 * @param {{ host?: string | null }} [options]
 */
export function paseoExecutor({ host = null } = {}) {
  const opts = (cwd) => ({ cwd, host: host ?? undefined });
  return {
    // `--output-schema` makes stdout the agent's structured output, with no
    // agent id in it; the runner finds the agent again by its labels.
    ask: (request) =>
      runPaseoJson(
        ["run", ...agentArgs(request), "--wait-timeout", request.timeout, "--output-schema", JSON.stringify(request.schema), request.prompt],
        opts(request.cwd),
      ),

    // Paseo rejects --output-schema with --background, so only unstructured
    // agents (the gate's carrier) are spawned.
    spawn: async (request) => {
      const started = await runPaseoJson(["run", "--background", ...agentArgs(request), request.prompt], opts(request.cwd));
      return { agentId: started.agentId };
    },

    // `-g`: ls lists only the current directory's agents otherwise. `-a`: an
    // agent whose parent was archived is archived with it. Several --label
    // flags are ANDed (cli/src/commands/agent/ls.ts).
    findAgent: async (labels) => {
      const args = ["ls", "-g", "-a"];
      for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
      const found = (await runPaseoJson(args, opts())) ?? [];
      return found[0]?.id ?? null;
    },

    // `inspect --json` is PascalCase, unlike `ls --json`. LastUsage is the
    // last turn, which for one structured call is the whole call. Codex
    // reports CostUsd 0 with real token counts; it is passed on as is.
    inspect: async (agentId) => {
      const detail = await runPaseoJson(["inspect", agentId], opts());
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
      return (await runPaseo(args, opts())).stdout;
    },

    deny: async (agentId, { message } = {}) => {
      const args = ["permit", "deny", agentId, "--all"];
      if (message) args.push("--message", message);
      await runPaseoJson(args, opts());
    },

    stop: async (agentId) => {
      await runPaseoJson(["stop", agentId], opts());
    },
  };
}
