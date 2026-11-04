import { localParts, speak } from "./time.mjs";

// What a person reads: the words of the card, the rows under it and the replies to the commands. Nothing here says
// 叫醒, 校验, 记录, 计划, 读数, 会话 or agent (a test holds it to that).

const pad = (n) => String(n).padStart(2, "0");

/** "18:08" for today, "11-01 18:08" otherwise. */
export function stamp(atIso, now, tz) {
  const t = Date.parse(atIso);
  const p = localParts(t, tz);
  return p.date === localParts(now, tz).date ? `${pad(p.h)}:${pad(p.mi)}` : `${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

/** How long ago, in the words he uses: 刚才 / 12 分钟前 / 3 小时前 / 2 天前. */
export function ago(atIso, now) {
  const m = Math.max(0, Math.round((now - Date.parse(atIso)) / 60_000));
  if (m < 1) return "刚才";
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
}

const isPicture = (a) => /^image\//i.test(a.mime);

/** What he sent, in his words: "发了一张图：a.png", "发了一个文件：b.pdf", "发了 2 张图、1 个文件：a.png、b.pdf". */
export function attachSummary(list) {
  const pics = list.filter(isPicture).length;
  const files = list.length - pics;
  const names = list.map((a) => a.name).join("、");
  if (list.length === 1) return `发了${pics ? "一张图" : "一个文件"}：${names}`;
  return `发了 ${[pics ? `${pics} 张图` : "", files ? `${files} 个文件` : ""].filter(Boolean).join("、")}：${names}`;
}

/** The things he sent that still count (the line was not taken back), oldest first. */
export const sentOf = (state) => (state.said ?? []).filter((m) => !m.undone && m.by === "user").flatMap((m) => (m.attachments ?? []).map((a) => ({ ...a, seq: m.seq, at: m.at })));

export const md = (ms, tz) => {
  const p = localParts(ms, tz);
  return `${pad(p.mo)}-${pad(p.d)}`;
};

/** The card on top of an affair's conversation. `budget` is the sentence for a day that has run out of looks, if so. */
export function cardOf(state, now, policy, { budget = "", trouble = "" } = {}) {
  if (state.system) return { title: state.title, waiting: "要补几处配置", now: state.goal, next: "补好后重启就不再提醒", open: true };
  const over = state.status !== "watching";
  const next = state.next;
  let nextText = "";
  // A look that has been going for three quarters of an hour is not going (its end was never heard).
  const looking = state.running && now - Date.parse(state.runningSince) < 45 * 60_000;
  if (!over && looking) nextText = "正在看一眼…";
  else if (!over && budget) nextText = budget;
  else if (!over && next) {
    const when = speak(Date.parse(next.at), now, policy.tz);
    nextText = next.remind ? `${when} ${next.remind}` : `${when} 看`;
  }
  return {
    title: state.title,
    waiting: over ? (state.status === "done" ? "办完了 ✓" : "不盯了") : next?.waitingFor || "刚交代，马上看",
    // An affair that ended says why, not what it last saw while it was still open.
    now: trouble || (state.status === "done" ? state.lines?.findLast((l) => l.kind === "status" && l.status === "done")?.evidence : "") || state.nowText || state.goal,
    next: nextText,
    open: !over,
  };
}

/** The lines under the card, oldest first. Each has a stable key so a line shown twice is one line. */
export function rowsOf(state, now, policy, { withChat = false } = {}) {
  const { tz } = policy;
  const rows = [];
  const add = (key, at, text, tone = "normal", detail = "", extra = {}) => rows.push({ key, at, text, tone, detail, own: key[0] === "s" || key[0] === "a", ...extra });
  const lines = state.lines ?? [];
  for (const l of lines) {
    const time = stamp(l.at, now, tz);
    if (l.kind === "report" && l.verdict !== "rejected" && l.entry && l.from !== "chat") {
      const costs = l.detail ?? "";
      // A look's sentence is the result only now; in the conversation it needs saying who looked.
      add(`r${l.seq}`, l.at, `${time}  ${/^\s*我看了一眼/.test(l.entry) ? l.entry : `看了一眼：${l.entry}`}`, "normal", costs);
    } else if (l.kind === "said" && l.by === "user" && !state.said.find((s) => s.seq === l.seq)?.undone) {
      // What he typed in the conversation is already on his screen; what he sent with it is drawn as his line too.
      const sent = state.said.find((s) => s.seq === l.seq)?.attachments ?? [];
      const summary = sent.length ? attachSummary(sent) : "";
      if ((l.via !== "workspace" && l.via !== "chat-session") || (withChat && l.via === "chat-session")) add(`s${l.seq}`, l.at, `${time}  你：${l.text}${summary && !l.text.includes(summary) ? `（${summary}）` : ""}`);
      else if (summary) add(`s${l.seq}`, l.at, `${time}  你：${summary}`);
    } else if (l.kind === "note" && l.by === "chat" && typeof l.text === "string") {
      add(`m${l.seq}`, l.at, `${time}  我记下：${l.text}`);
    } else if (l.kind === "answered") {
      add(`a${l.seq}`, l.at, `${time}  你：${l.answer}`, "normal", "", { ask: String(l.id) });
    } else if (l.kind === "status" && l.status === "done") {
      add(`d${l.seq}`, l.at, `${time}  办完了 ✓ ${l.evidence ?? ""}`.trim());
    } else if (l.kind === "status" && l.status === "stopped") {
      add(`d${l.seq}`, l.at, `${time}  不盯了。`);
    } else if (l.kind === "status" && l.status === "watching" && l.seq > 1) {
      add(`d${l.seq}`, l.at, `${time}  接着盯。`);
    } else if (l.kind === "flag" && l.what === "chain") {
      add(`f${l.seq}`, l.at, `${time}  ${l.detail}`, "red");
    } else if (l.kind === "next" && l.verdict === "appeal") {
      const cut = state.deadlines.filter((d) => Date.parse(d.at) > Date.parse(l.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
      const was = cut ? md(Date.parse(cut.at), tz) : "";
      add(`n${l.seq}`, l.at, `${time}  我把下次定在 ${md(Date.parse(l.next), tz)}${was ? `，比单子上写的 ${was} 晚` : ""}：${l.detail}。${was ? `不对就说「改回 ${was}」。` : ""}`, "red");
    }
  }
  return rows;
}

export const linkOf = (url, policy) => (url && policy.popoLink ? `在 Paseo 里看：${url}` : "在 Paseo 的「事项」里看。");

export const say = {
  started: (title, link) => `好，开始盯「${title}」。${link}`,
  noted: (title, text, link) => `记下了「${title}」：${text.replace(/[。.！!？?]+$/, "")}。${link}`,
  paused: (title, whenText) => `好，${title}先放到${whenText}。`,
  stopped: (title) => `好，不盯${title}了。要接着盯就说「接着盯${title}」。`,
  resumed: (title) => `好，接着盯「${title}」。`,
  restarted: (title, status) => `「${title}」之前${status === "done" ? "办完" : "不盯"}了，这次重新盯。`,
  stoppedByBreaker: (title) => `「${title}」看得太频繁，先停着了。等你点「接着看」。`,
  undone: (text) => `撤了：「${text}」。`,
  nothingToUndo: () => "没有可撤的话。",
  already: (title, whenText, link) => `「${title}」已经在盯了，下次 ${whenText} 看。${link}`,
  tooMany: (n) => `在盯的已经 ${n} 件了，先收掉几件再加。`,
  notFound: (word, names) => `没找到「${word}」。${names.length ? `在盯的有：${names.join("、")}。是哪件？` : "现在没有在盯的事。"}`,
  which: (names) => `是${names.map((n) => `「${n}」`).join("还是")}？`,
  budget: (title, text) => `「${title}」${text}。`,
  answeredAlready: (answer) => `这个问题你在 Paseo 里答过了（${answer}）。`,
  done: (title, evidence) => `${title}办完了 ✓ ${String(evidence).replace(/[。.！!？?]+$/, "")}。不对就回「还没完」。`,
  troubleRead: (title, what, ask) => `${title} 这两天没看成：${what}。${ask}`,
};
