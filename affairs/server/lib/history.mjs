// `affair history`: finding what was said in an earlier chat of an affair, from the text `paseo logs <session>` prints.
// Pure parsing and wording here; the command that runs paseo and reads the log of the affair is in ops.mjs.
//
// What `paseo logs <session> --filter text` prints (measured on archived sessions, 2026-11-03): "[User] what he said" on
// one line and the session's words under it; a message another session sent starts with "[Message received] <sender>".
// Tool calls ("[Shell] <command>", one line each, only without the filter) and the plugins' rows are not in it. So the only
// thing taken from it is his questions and the words answered.

const USER = /^\[User\]\s?(.*)$/;
/** Any other block head ("[Message received] …", and whatever else the CLI marks a block with): not his question, and it ends the answer above it. */
const OTHER = /^\[[A-Za-z][A-Za-z ]{0,28}\](?:\s|$)/;

export const ASK_MAX = 300;
export const REPLY_MAX = 1200;
export const TOTAL_DEFAULT = 1500;
export const TOTAL_LIMIT = 3000;

/** Letters and digits only, lower case: what two texts are compared by. */
export const normalize = (text) => String(text ?? "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

/**
 * His questions, each with the words answered, in order. Only the first line of what he said is the question (a
 * multi-line message cannot be told from the answer under it in this text).
 * @returns {Array<{ ask: string, reply: string }>}
 */
export function parseLogs(text) {
  const turns = [];
  let current = null;
  let skipping = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const user = USER.exec(line);
    if (user) {
      current = { ask: user[1].trim(), reply: [] };
      turns.push(current);
      skipping = false;
    } else if (OTHER.test(line)) {
      current = null;
      skipping = true;
    } else if (current && !skipping) {
      current.reply.push(line);
    }
  }
  return turns.map((t) => ({ ask: t.ask, reply: t.reply.join("\n").trim() }));
}

/** The last three turns, keeping the end of each answer within a shared 1500-character budget. */
export function handoffTurns(entries) {
  const turns = [];
  let current = null;
  for (const { item } of entries) {
    if (item.type === "user_message") {
      current = String(item.messageId ?? item.clientMessageId ?? "").startsWith("affair-flow:") ? null : { ask: item.text, reply: "" };
      if (current) turns.push(current);
    } else if (item.type === "assistant_message" && current) current.reply += (current.reply ? "\n" : "") + item.text;
  }
  return turns.slice(-3).map(({ ask, reply }, i, selected) => ({
    ask: [...ask].slice(0, 100).join(""),
    reply: [...(reply || "（没有文字回复）")].slice(-(600 - 200 * (selected.length - 1 - i))).join(""),
  }));
}

export function handoffSection(line) {
  return ["## 上一段对话停在哪", ...(line.error
    ? [`上一段对话的结尾读不到：${line.error}，用 history 查。`]
    : [...(line.turns.length ? line.turns.flatMap((t) => [`他问：${t.ask}`, `你答：${t.reply}`]) : ["（没有找到问答）"]),
      "最后一句如果是在等他回答或授权，他这次说的话很可能是在回它；改过的东西以现场为准再核一下。"]), ""];
}

const cut = (text, max) => ([...text].length > max ? { text: [...text].slice(0, max).join(""), left: [...text].length - max } : { text, left: 0 });

/** One question and its answer within the limits: the question up to 300 characters, the answer up to 1200, both within `total`. */
export function oneTurn(turn, total) {
  const ask = cut(turn.ask, Math.min(ASK_MAX, total));
  const reply = cut(turn.reply || "（没有文字回复）", Math.max(0, Math.min(REPLY_MAX, total - [...ask.text].length)));
  const left = ask.left + reply.left;
  return { ask: ask.text, reply: reply.text, left };
}

export const clampMax = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), TOTAL_LIMIT) : TOTAL_DEFAULT;
};

/** Turns whose question has every word in it, newest chat first and, within a chat, the later question first. */
export function findTurns(chats, terms) {
  const words = terms.map(normalize).filter(Boolean);
  const hits = [];
  chats.forEach((chat, ci) => {
    chat.turns.forEach((turn, ti) => {
      const ask = normalize(turn.ask);
      if (words.length && words.every((w) => ask.includes(w))) hits.push({ chat, turn, ci, ti });
    });
  });
  return hits.sort((a, b) => b.ci - a.ci || b.ti - a.ti);
}

export const sayHistory = {
  none: () => "这件事还没有换过对话，现在这段就是全部。",
  notFound: (q) => `以前的对话里没找到「${q}」。他说过的话都在记录里：affair show <编号> --log；随手记的在 brief 的「最近记下的」里。都没有就直接问他，别猜。`,
  unreadable: (chats) => chats.map((c) => `以前的对话 ${c.agentId.slice(0, 4)}…（${c.when}）读不到：${c.why}，没查。`).join("\n"),
};
