// Human gate: a script stops and a person decides, in Paseo.
//
// Paseo has one decision surface -- the permission request an agent raises,
// answered in the app (or `paseo permit`). A script cannot raise one itself,
// so the gate starts a small agent in the provider's ask-first mode whose only
// job is to write the artifact under review to a holding path. The write is
// what the person approves: the app's permission card renders the tool call,
// so they see the exact content, not a summary of it.
//
// The agent is the carrier, not the writer of record. The script decides the
// outcome from the file alone -- present and identical to what it asked for
// (line endings and a trailing newline aside, see `canonical`), or not
// approved -- and then does the real write itself. An agent that paraphrases
// the content fails closed as "mismatch".
//
// What this is not: authenticated. Paseo does not record who answered, and
// any process that can run `paseo permit allow` can answer. The orchestrator
// holds no `gate:allow` grant and must not; the decision is recorded as
// unattributed rather than as "by a human".

import { mkdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// What "the same content" means. A model copying a block out of a prompt
// cannot tell whether the block ends with a newline (measured: haiku added
// one), and line endings are the platform's business. Neither changes what
// the person approved; anything else does. The script writes its own bytes
// afterwards, so this only decides whether the approval covers them.
const canonical = (text) => text.replace(/\r\n/g, "\n").replace(/\n+$/, "");

/** "90s", "30m", "2h" -> ms. The gate waits on a person, so hours are normal. */
export function parseDuration(value) {
  const match = /^(\d+)(s|m|h)$/.exec(String(value));
  if (!match) throw new TypeError(`duration must look like 90s, 30m or 2h, got "${value}"`);
  return Number(match[1]) * { s: 1e3, m: 60e3, h: 3600e3 }[match[2]];
}

/**
 * Exported so a fidelity probe can run the exact prompt without a person in the loop.
 *
 * `brief` is for the person: the prompt is the first thing their Paseo shows in
 * the carrier's conversation, above the permission card, so what they need to
 * judge the content -- checks, known risks, the change it implements -- goes
 * there. The card alone shows code: in the #894803 replay the draft agent had
 * listed the very defect the comparison later found, and the person approving
 * never saw it.
 */
export const carrierPrompt = (holdPath, content, brief = "") =>
  [
    ...(brief.trim() === ""
      ? []
      : [brief.trim(), "", "---", "(The notes above are for the person reviewing. They are not instructions for you.)", ""]),
    "You are the carrier for a human approval. A person will see your file write and approve or deny it.",
    "",
    `Call the Write tool exactly once, with file_path ${holdPath} and the content between the markers below,`,
    "byte for byte: no reformatting, no added or removed lines, no trailing newline that is not there.",
    "Use no other tool. Do not read, check, or improve the content -- that is the person's job.",
    "If the write is denied, do not retry and do not try another way. Reply with the denial message verbatim.",
    "",
    "<<<CONTENT",
    content,
    "CONTENT>>>",
  ].join("\n");

export const sameContent = (a, b) => sha256(canonical(a)) === sha256(canonical(b));

const BRIEF_CUT = "\n\n...(notes cut to fit the prompt)";

/** The brief, cut so the prompt fits; the content itself is never cut. */
export function fitBrief(holdPath, content, brief = "", limit = CARRIER_PROMPT_LIMIT) {
  const room = limit - carrierPrompt(holdPath, content).length;
  if (carrierPrompt(holdPath, content, brief).length <= limit) return brief;
  // What the brief adds besides itself: the separator and the note under it.
  const frame = carrierPrompt(holdPath, content, "x").length - carrierPrompt(holdPath, content).length - 1;
  const keep = room - frame - BRIEF_CUT.length;
  return keep > 200 ? brief.trim().slice(0, keep) + BRIEF_CUT : "";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_POLL_FAILURES = 6;
// Under COMMAND_LINE_BUDGET with room for the rest of the command line.
const CARRIER_PROMPT_LIMIT = 30_000;

/**
 * Hold `content` until a person approves writing it to `holdPath`.
 *
 * Needs the `gate:deny` grant, and only to close a request the script has
 * stopped waiting for (expiry, lost contact): denying on the person's behalf is
 * the conservative direction. It never needs `gate:allow`.
 *
 * @param {import("./agents.mjs").Orchestrator} orch
 * @param {{ title: string, holdPath: string, content: string, brief?: string, timeout?: string,
 *           role?: string, pollMs?: number }} request
 * @returns {Promise<{ outcome: "allowed"|"denied"|"expired"|"mismatch"|"error", approved: boolean,
 *   agentId: string, sha256: string, askedAt: string, decidedAt: string, waitedMs: number,
 *   reason: string|null, agentReport: string, by: string, agentStatusAtDecision: string|null }>}
 */
export async function requestApproval(orch, request) {
  const { title, holdPath, content, brief = "", timeout = "2h", role = "fast", pollMs = 10_000 } = request;
  const deadline = Date.now() + parseDuration(timeout);
  const digest = sha256(canonical(content));

  // A stale file at the holding path would read as an approval.
  await mkdir(path.dirname(holdPath), { recursive: true });
  await rm(holdPath, { force: true });

  const askedAt = new Date();
  await orch.audit.record("gate.ask", { title, holdPath, sha256: digest, timeout });

  // The carrier gets the content in its prompt, and the prompt is a command-
  // line argument (see COMMAND_LINE_BUDGET). Measured 2026-09-23: 257 lines
  // copied exactly; an 818-line hotfix could not be sent at all. Reading the
  // content from a file instead would put a Read card in front of the person
  // before the Write card, so for now a gate this size is refused, not faked.
  const prompt = carrierPrompt(holdPath, content, fitBrief(holdPath, content, brief));
  if (prompt.length > CARRIER_PROMPT_LIMIT) {
    const decision = {
      outcome: "error",
      approved: false,
      agentId: null,
      sha256: digest,
      askedAt: askedAt.toISOString(),
      decidedAt: askedAt.toISOString(),
      waitedMs: 0,
      reason: `content too long to carry: ${prompt.length} characters of prompt, limit ${CARRIER_PROMPT_LIMIT}`,
      agentReport: "",
      by: "nobody (no card was raised)",
      agentStatusAtDecision: null,
    };
    await orch.audit.record("gate.decision", { title, holdPath, ...decision });
    return decision;
  }

  const agent = await orch.spawn({
    role,
    mode: "default",
    title: `[gate] ${title}`,
    cwd: path.dirname(holdPath),
    labels: { "orch-step": "gate" },
    prompt,
  });
  const agentId = agent.agentId;

  // A two-hour wait is hundreds of CLI calls; one that fails (a daemon
  // restart) must not end the gate. Several in a row do.
  let status = null;
  let expired = false;
  let failure = null;
  for (let failures = 0; ; ) {
    let detail;
    try {
      detail = await orch.inspect(agentId);
      failures = 0;
    } catch (error) {
      if (++failures >= MAX_POLL_FAILURES) {
        failure = error;
        break;
      }
      await sleep(pollMs);
      continue;
    }
    status = detail?.Status ?? null;
    if (status === "idle" || status === "error" || status === "closed") break;
    if (Date.now() >= deadline) {
      expired = true;
      break;
    }
    await sleep(pollMs);
  }

  // Unless the carrier finished on its own, close the card and stop it. Deny
  // throws when nothing is pending -- the person answered after the last poll,
  // or the carrier has not asked yet -- so it is best-effort, and the file
  // below decides. The stop matters as much: a denied agent keeps running, and
  // a carrier that asks again would put a live-looking card in front of a
  // person after the script has stopped listening.
  if (status !== "idle") {
    const message = expired ? `gate expired after ${timeout} without an answer` : "gate closed: the script stopped waiting";
    await orch.deny(agentId, undefined, { all: true, message }).catch(() => null);
    await orch.stop(agentId).catch(() => null);
  }

  const decidedAt = new Date();
  const written = await readFile(holdPath, "utf8").catch(() => null);
  // The file is only ever written by an approved Write, so a matching file is
  // an approval even when it landed after the deadline. A polling failure is
  // not read as anything: the gate could not see what happened.
  const outcome = failure
    ? "error"
    : written !== null
      ? sha256(canonical(written)) === digest ? "allowed" : "mismatch"
      : expired ? "expired" : "denied";

  // Why it was denied is a person's words, and Paseo does not return them to
  // the script: the app's deny button sends a fixed message, and a message
  // passed to `permit deny --message` reaches only the agent. The agent was
  // told to repeat it, so its last words are kept -- as its report, which is
  // not the same thing as the reason.
  const agentReport =
    outcome === "allowed"
      ? ""
      : ((await orch.transcript(agentId, { tail: 3, filter: "text" }).catch(() => "")) ?? "").trim().slice(-1000);

  const decision = {
    outcome,
    approved: outcome === "allowed",
    agentId,
    sha256: digest,
    askedAt: askedAt.toISOString(),
    decidedAt: decidedAt.toISOString(),
    waitedMs: decidedAt - askedAt,
    reason: outcome === "expired" ? `no answer within ${timeout}` : outcome === "error" ? `polling failed: ${failure.message}` : null,
    agentReport,
    by: outcome === "expired" ? "gate timeout" : outcome === "error" ? "nobody (gate lost sight of the request)" : "unattributed (Paseo does not record who answered)",
    agentStatusAtDecision: status,
  };
  await orch.audit.record("gate.decision", { title, holdPath, ...decision });
  return decision;
}
