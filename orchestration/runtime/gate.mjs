// Human gate: a flow stops and a person decides, in Paseo. Flows reach it as
// `$.gate(...)` (run.mjs), which records the call and checks the grant.
//
// Paseo has one decision surface -- the permission request an agent raises,
// answered in the app (or `paseo permit`). A script cannot raise one itself,
// so the gate starts a carrier agent whose permission request is what the
// person answers. Two carriers, picked by the `gate` role's provider family:
//
//   provider  the orchestration-gate plugin's `orch-gate` provider: no model.
//             It reads a request file this module writes, shows the decision
//             as the card's title and description, the evidence above the card,
//             and the content in it; on an allow it writes the receipt itself.
//   model     an agent in the provider's ask-human mode (fences.mjs), told to
//             Write the receipt. The card is a Write card; the decision, brief,
//             evidence and content are in its prompt, which the script wrote.
//
// Either way the person approves a receipt, not a copy of the content: three
// lines naming the decision, the run and call, and the content's sha256. The
// script decides from the receipt file alone -- present and identical to what
// it expects, or not approved -- and the flow then writes the content it holds,
// the bytes that sha256 names. A carrier that paraphrases or writes anything
// else fails closed as "mismatch".
//
// What this is not: authenticated. Paseo does not record who answered, and
// any process that can run `paseo permit allow` can answer. The provider
// carrier records one weak signal (`answeredVia`): whether the answer carried
// one of the card's own button ids, which the app sends and `paseo permit`
// does not. It is what the answering client sent, not who it was.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// What "the same content" means. A model copying a block out of a prompt
// cannot tell whether the block ends with a newline (measured: haiku added
// one), and line endings are the platform's business. Neither changes what
// the person approved; anything else does.
const canonical = (text) => text.replace(/\r\n/g, "\n").replace(/\n+$/, "");

/** "90s", "30m", "2h" -> ms. The gate waits on a person, so hours are normal. */
export function parseDuration(value) {
  const match = /^(\d+)(s|m|h)$/.exec(String(value));
  if (!match) throw new TypeError(`duration must look like 90s, 30m or 2h, got "${value}"`);
  return Number(match[1]) * { s: 1e3, m: 60e3, h: 3600e3 }[match[2]];
}

export const sameContent = (a, b) => sha256(canonical(a)) === sha256(canonical(b));

/** The fingerprint a gate records for its content: the same one its receipt names. */
export const contentDigest = (content) => sha256(canonical(content));

/** Provider families whose carrier is the plugin provider rather than a model. */
export const PROVIDER_CARRIERS = ["orch-gate"];

/** "provider" or "model": which carrier a gate role's provider means. */
export const carrierKind = (provider) => (PROVIDER_CARRIERS.includes(String(provider).split("/")[0]) ? "provider" : "model");

/**
 * What the carrier writes when the person approves, and all the script will
 * accept as an approval. The title is the decision; the run and call make a
 * receipt from another gate useless; the digest names the bytes.
 */
export function receiptFor({ title, runId, callId, digest }) {
  const decision = title.replace(/\s+/g, " ").trim();
  return [decision.startsWith("批准") ? decision : `批准：${decision}`, `人闸 ${callId} · 运行 ${runId}`, `内容 sha256 ${digest}`].join("\n");
}

const lineCount = (text) => (text === "" ? 0 : canonical(text).split("\n").length);

/**
 * The line a card's description ends with: what each answer does. "The box
 * below" read as a box in the card (2026-10-21, a person looked for one), so it
 * names the message box at the bottom of the conversation. `deny` is the deny
 * button's label: 不批 on the provider's card, Deny on a Write card.
 */
export const answerHelp = (timeout, deny = "不批") =>
  `不批的话点「${deny}」；想说明理由，就在对话底部的消息框里写一句发出，按不批处理。${timeout} 内没人处理按不批。`;

// Under COMMAND_LINE_BUDGET (paseo-cli.mjs) with room for the rest of the
// command line. Only the model carrier's prompt carries the content; the
// provider carrier's prompt is a pointer.
const CARRIER_PROMPT_LIMIT = 30_000;
const BRIEF_CUT = "\n\n...(说明太长，后面的截掉了)";

/**
 * The model carrier's prompt: for the person first -- the decision, the
 * summary, the brief, the evidence, the content -- then the carrier's
 * instructions, which name the receipt and nothing else to write.
 *
 * The prompt is shown as plain text above a Write card that shows only the
 * receipt, so the person reads the content here; the script wrote all of it.
 * Brief and evidence are cut to fit, the content never is: `fits` is false
 * when the parts that cannot be cut are over the limit.
 */
export function carrierPrompt(gate, limit = CARRIER_PROMPT_LIMIT) {
  const { holdPath, title, summary = "", brief = "", evidence = [], name = "content.txt", content, receipt, timeout = "2h" } = gate;
  const build = (keptBrief, keptEvidence) =>
    [
      `【要你决定】${title}`,
      ...(summary.trim() === "" ? [] : [summary.trim()]),
      `批准：允许下面卡片里这次写入（Accept）。${answerHelp(timeout, "Deny")}`,
      ...(keptBrief.trim() === "" ? [] : ["", keptBrief.trim()]),
      ...keptEvidence.flatMap((e) => ["", `【证据】${e.label}`, e.text]),
      "",
      `【待批全文】${name}，${lineCount(content)} 行，sha256 ${contentDigest(content).slice(0, 12)}…`,
      content,
      "",
      "---",
      "（以下是给载体 agent 的指令，审批人不用看。）",
      "You are the carrier for a human approval. A person will see your file write and approve or deny it.",
      "",
      `Call the Write tool exactly once, with file_path ${holdPath} and the receipt between the markers below,`,
      "byte for byte: no reformatting, no added or removed lines. Write the receipt only -- not the content above.",
      "Use no other tool. Do not read, check, or improve anything -- that is the person's job.",
      "If the write is denied, do not retry and do not try another way. Reply with the denial message verbatim.",
      "",
      "<<<RECEIPT",
      receipt,
      "RECEIPT>>>",
    ].join("\n");

  const bare = build("", []);
  if (bare.length > limit) return { prompt: bare, fits: false };

  // Every evidence entry is at least named, with a note in place of a text
  // that does not fit; room for those notes is kept before the brief is cut.
  const kept = evidence.map((entry) => ({ label: entry.label, text: `（${entry.text.length} 字，放不下，没有带上）` }));
  const noted = build("", kept);
  if (noted.length > limit) kept.length = 0;
  let keptBrief = brief;
  if (build(brief, kept).length > limit) {
    const keep = limit - build("", kept).length - 2 - BRIEF_CUT.length;
    keptBrief = keep > 200 ? brief.trim().slice(0, keep) + BRIEF_CUT : "";
  }
  // Then, in order, each entry whose text fits replaces its note.
  for (const [i, entry] of evidence.entries()) {
    if (i >= kept.length) break;
    const whole = kept.map((e, j) => (j === i ? entry : e));
    if (build(keptBrief, whole).length <= limit) kept[i] = entry;
  }
  return { prompt: build(keptBrief, kept), fits: true };
}

/**
 * Everything one gate needs before its carrier starts: the digest, the
 * receipt, the prompt to send and record, and for the provider carrier the
 * request file it will read. Pure, so the runner can record the prompt in
 * call.start before anything happens.
 */
export function prepareGate(gate) {
  const { carrier, holdPath, title, content, runId, callId, timeout = "2h" } = gate;
  const digest = contentDigest(content);
  const receipt = receiptFor({ title, runId, callId, digest });
  const dir = path.dirname(holdPath);
  const answerPath = path.join(dir, `${callId}.answer.json`);
  const base = { carrier, holdPath, answerPath, digest, receipt, timeout };

  if (carrier === "model") {
    const { prompt, fits } = carrierPrompt({ ...gate, receipt });
    return { ...base, requestPath: null, requestText: null, prompt, fits };
  }

  const requestPath = path.join(dir, `${callId}.request.json`);
  const requestText = JSON.stringify(
    {
      v: 1,
      kind: "orchestration-gate/request",
      runId,
      callId,
      title,
      summary: gate.summary ?? "",
      brief: gate.brief ?? "",
      evidence: gate.evidence ?? [],
      name: gate.name ?? "content.txt",
      content,
      sha256: digest,
      receipt,
      receiptPath: holdPath,
      answerPath,
      timeout,
      help: answerHelp(timeout),
    },
    null,
    2,
  );
  const prompt = [`人闸 ${callId} · 运行 ${runId}：${title}`, `request: ${requestPath}`, `sha256: ${sha256(requestText)}`].join("\n");
  return { ...base, requestPath, requestText, prompt, fits: true };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_POLL_FAILURES = 6;

/** The `logs` command's text for an agent that has said nothing (cli/src/commands/agent/logs.ts). */
const NO_ACTIVITY = "No activity to display.";

/** What the carrier itself said, last three messages, cut to 1000 characters; "" if nothing or unreadable. */
async function carrierWords(io, agentId) {
  const said = ((await io.transcript(agentId, { tail: 3, filter: "assistant_message" }).catch(() => "")) ?? "").trim();
  return said === NO_ACTIVITY ? "" : said.slice(-1000);
}

/**
 * Whether the model carrier asked for anything at all: `paseo logs --filter tools` lists each tool call
 * as "[Name] ...". A carrier that made none never put a card in front of anyone. Null when unreadable.
 */
async function carrierAsked(io, agentId) {
  const tools = await io.transcript(agentId, { filter: "tools" }).catch(() => null);
  return typeof tools === "string" ? /^\[[^\]\n]+\]/m.test(tools) : null;
}

/** The provider carrier's record of how it was answered; null when there is none, an error record when unreadable. */
async function readAnswer(answerPath) {
  const text = await readFile(answerPath, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { error: "the answer record is not an object" };
  } catch {
    return { error: "the answer record is not JSON" };
  }
}

const VIA = ["button", "no-button", "typed"];

export const UNATTRIBUTED = "unattributed (Paseo does not record who answered)";
const CARRIER_ENDED = "nobody (the carrier ended without an answer)";

/**
 * Hold until a person approves the gate `prepared` describes (prepareGate).
 *
 * `io` is what the gate needs from the executor, already bound to this call:
 * `spawn(prompt)` starts the carrier and resolves to its agent id; `inspect`,
 * `deny`, `stop` and `transcript` take that id. Denying is only ever used to
 * close a request the script has stopped waiting for (expiry, lost contact):
 * the conservative direction, under the `gate:deny` grant the caller checks.
 * Nothing here can allow.
 *
 * @param {{ spawn: (prompt: string) => Promise<string>, inspect: Function, deny: Function, stop: Function,
 *           transcript: Function }} io
 * @param {ReturnType<typeof prepareGate>} prepared
 * @param {{ pollMs?: number }} [options]
 * @returns {Promise<{ outcome: "allowed"|"denied"|"expired"|"mismatch"|"error", approved: boolean,
 *   agentId: string|null, sha256: string, askedAt: string, decidedAt: string, waitedMs: number,
 *   reason: string|null, agentReport: string, by: string, agentStatusAtDecision: string|null,
 *   answeredVia: "button"|"no-button"|"typed"|null }>}
 */
export async function requestApproval(io, prepared, { pollMs = 10_000 } = {}) {
  const { carrier, holdPath, answerPath, requestPath, requestText, digest, receipt, prompt, fits, timeout } = prepared;
  const deadline = Date.now() + parseDuration(timeout);

  // A stale file at any of these paths would read as an answer.
  await mkdir(path.dirname(holdPath), { recursive: true });
  await rm(holdPath, { force: true });
  await rm(answerPath, { force: true });

  const askedAt = new Date();
  const decision = (fields) => {
    const decidedAt = new Date();
    return {
      approved: fields.outcome === "allowed",
      agentId: null,
      sha256: digest,
      askedAt: askedAt.toISOString(),
      decidedAt: decidedAt.toISOString(),
      waitedMs: decidedAt - askedAt,
      reason: null,
      agentReport: "",
      agentStatusAtDecision: null,
      answeredVia: null,
      ...fields,
    };
  };

  // The model carrier gets the content in its prompt, and the prompt is a
  // command-line argument. Measured 2026-09-23: an 818-line hotfix could not
  // be sent at all. A gate this size is refused, not faked.
  if (!fits) {
    return decision({
      outcome: "error",
      reason: `content too long to carry: ${prompt.length} characters of prompt, limit ${CARRIER_PROMPT_LIMIT}`,
      by: "nobody (no card was raised)",
    });
  }
  if (requestPath) await writeFile(requestPath, requestText, "utf8");

  const agentId = await io.spawn(prompt);

  // A two-hour wait is hundreds of CLI calls; one that fails (a daemon
  // restart) must not end the gate. Several in a row do.
  let status = null;
  let expired = false;
  let failure = null;
  for (let failures = 0; ; ) {
    let detail;
    try {
      detail = await io.inspect(agentId);
      failures = 0;
    } catch (error) {
      if (++failures >= MAX_POLL_FAILURES) {
        failure = error;
        break;
      }
      await sleep(pollMs);
      continue;
    }
    status = detail?.status ?? null;
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
    await io.deny(agentId, { message }).catch(() => null);
    await io.stop(agentId).catch(() => null);
  }

  const written = await readFile(holdPath, "utf8").catch(() => null);
  const answer = carrier === "provider" ? await readAnswer(answerPath) : null;
  const via = VIA.includes(answer?.via) ? answer.via : null;
  const base = { agentId, agentStatusAtDecision: status };

  // A polling failure is not read as anything: the gate could not see what happened.
  if (failure) return decision({ ...base, outcome: "error", reason: `polling failed: ${failure.message}`, by: "nobody (gate lost sight of the request)" });

  // The receipt is only ever written by an approved answer, so a matching one
  // is an approval even when it landed after the deadline.
  if (written !== null) {
    const allowed = canonical(written) === canonical(receipt);
    const outcome = allowed ? "allowed" : "mismatch";
    return decision({
      ...base,
      outcome,
      by: UNATTRIBUTED,
      answeredVia: via,
      agentReport: !allowed && carrier === "model" ? await carrierWords(io, agentId) : "",
    });
  }

  if (expired) return decision({ ...base, outcome: "expired", reason: `no answer within ${timeout}`, by: "gate timeout" });

  // The provider carrier says how it was answered, or why it could not ask.
  if (answer?.error) return decision({ ...base, outcome: "error", reason: `carrier: ${String(answer.error).slice(0, 500)}`, by: CARRIER_ENDED });
  if (answer?.behavior === "deny") {
    const words = via === "typed" ? answer.typed : via === "no-button" ? answer.message : null;
    return decision({
      ...base,
      outcome: "denied",
      by: UNATTRIBUTED,
      answeredVia: via,
      reason: typeof words === "string" && words.trim() !== "" ? words.trim().slice(0, 2000) : null,
    });
  }

  // No receipt and no answer: a carrier that was closed, failed, or (the
  // provider) finished without recording one. Nobody is known to have said no.
  if (status === "error" || status === "closed" || carrier === "provider") {
    return decision({ ...base, outcome: "error", reason: `the carrier ended (${status ?? "unknown"}) without an answer`, by: CARRIER_ENDED });
  }

  // The model carrier finished without a receipt. It is a denial only if it
  // asked: a model can decline to be the carrier (2026-10-21 probe: haiku, 1 in
  // 10 read a ⚠ in the summary and would not "approve on the person's behalf";
  // started from inside another agent's session, 2 in 2), and then nobody saw
  // a card, let alone said no.
  const asked = await carrierAsked(io, agentId);
  if (asked !== true) {
    const words = await carrierWords(io, agentId);
    const why = asked === false ? "the carrier made no write, so no card was raised" : "the carrier's timeline could not be read, so whether a card was raised is unknown";
    return decision({ ...base, outcome: "error", reason: words ? `${why}; it said: ${words}` : why, by: CARRIER_ENDED });
  }

  // The model carrier, denied: Paseo does not return the person's words to the
  // script. The app's deny button sends a fixed message, and a message passed
  // to `permit deny --message` reaches only the agent. The agent was told to
  // repeat it, so its last words are kept -- as its report, which is not the
  // same thing as the reason. Only what the carrier itself said counts: the
  // `assistant_message` entries (asked for "text" it returned its own prompt).
  return decision({ ...base, outcome: "denied", by: UNATTRIBUTED, agentReport: await carrierWords(io, agentId) });
}
