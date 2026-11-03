import { existsSync } from "node:fs";
import path from "node:path";
import { dayStart } from "./limits.mjs";
import { localParts } from "./time.mjs";
import { roleOf } from "./schedule.mjs";

// The chat session of an affair: when it is replaced, what it is started with. Pure: the log and the clock in, a
// decision or a text out. The plugin (server/chat.ts) does the Paseo side.

const MIN = 60_000;
const HOUR = 3_600_000;

/** When he last spoke or the chat last answered: the later of the chat's last finished turn and his last line in it. */
export function lastActivity(s) {
  const spoke = s.said.filter((m) => m.via === "chat-session").map((m) => Date.parse(m.at));
  return Math.max(s.chatTurn ? Date.parse(s.chatTurn.at) : 0, ...spoke, s.chats.length ? Date.parse(s.chats[s.chats.length - 1].at) : 0);
}

/**
 * Why the chat should be replaced by a new one now, or "" when it should be kept. The price of a chat is the context it
 * carries: warm it is cheap to go on, cold it is paid for again whole (and a long one is vague too), so the new one reads
 * the brief instead. Never while he is typing, and not more than maxPerDay times a day.
 */
export function rotationReason(s, now, policy) {
  const c = policy.chat;
  if (!s.chatId || !s.chatTurn) return "";
  const tokens = s.chatTurn.tokens;
  const idle = now - lastActivity(s);
  if (idle < c.typingMinutes * MIN) return "";
  const since = dayStart(now, policy.tz, policy.limits.dayStartHour);
  if (s.chats.filter((x) => x.why.startsWith("rotate") && Date.parse(x.at) >= since).length >= c.maxPerDay) return "";
  if (tokens >= c.hardContext && idle >= c.idleMinutes * MIN) return "rotate:long";
  if (tokens >= c.coldContext && idle >= c.coldMinutes * MIN) return "rotate:cold";
  // Overnight: after the hour, a chat that began before it and has been quiet since, long enough to matter.
  const p = localParts(now, policy.tz);
  const nightStart = now - (p.h * 60 + p.mi - c.nightHour * 60) * MIN;
  const began = Date.parse(s.chats[s.chats.length - 1]?.at ?? "");
  if (p.h * 60 + p.mi >= c.nightHour * 60 && began < nightStart && tokens >= c.nightContext && idle >= c.nightIdleHours * HOUR) return "rotate:night";
  return "";
}

/** The words the chat session starts with. It is told what to run and what each thing is for; the rest is in the handbooks. */
export function chatPrompt(ctx, s) {
  const cmd = ctx.command;
  const handbooks = [ctx.policy.handbookPath, ctx.policy.handbooksDir ? path.join(ctx.policy.handbooksDir, "affair.md") : ""].filter((f) => f && existsSync(f));
  return [
    `你是事项 ${s.id}「${s.title}」的对话：他在这里跟你聊这件事，你也能替他办。到点的「看一眼」是另外的小会话，不是你；它的结果会作为一行出现在这段对话里，但你看不到，要知道就跑 brief。`,
    `每次他开口，先跑：${cmd} brief ${s.id} --chat（上次读完以后新的事、没答的问题、记住的、引用怎么写）。读完再回他。没有新的它会只写一行。`,
    `命令只有这几个，别的不碰（不要改 schedule，不要直接改事项的文件，不要用 paseo 命令）：`,
    `- 得出一个结论、他做了一个决定，当场记一句（${"≤120 字"}，别攒到最后，这段对话随时会换新）：${cmd} note ${s.id} --mine --said "<一句>" [--said-seq <他说的那一行的编号>]`,
    `- 状态、记住的、下次、问题、办完：${cmd} report ${s.id} --from chat --file <json>（每项都可以不写；改下次时间要过检查，只有他说过的才算数）`,
    `- 他答了问题（点了按钮，或直接说了）：${cmd} answer <问题编号> --said "<他的原话或选项>"`,
    `- 他要改时间：${cmd} pause ${s.id} --until "YYYY-MM-DD HH:mm" --said-seq <他说的那一行>；不盯了：stop；接着盯：resume；撤他上一句：undo`,
    `- 他提到「上次」「之前说的」而 brief 里找不到：先 ${cmd} history ${s.id} --q <词> 查，查不到就问他，别猜`,
    `他在这里发的图只在这段对话里看得到，之后的「看一眼」看不到它。要让后面用上，把要点用 note --mine 记成文字（比如短信里的时间地点）；别抄密码、令牌、证件号。`,
    `回他的话说人话：不用「叫醒、校验、记录、计划、读数、会话」这些词；说「我看一眼」「记下了」。提到单号照原样写，要链接就用 brief 里「引用怎么写」那一节的写法，不要自己猜地址。`,
    handbooks.length ? `手册（有空读，里面「你是这件事的对话」一节说得更细）：${handbooks.join("　")}` : "",
  ].filter(Boolean).join("\n");
}

/** What a new chat session is made with: the same model as this affair's looks, a cache lifetime that suits turns far apart, no first message. */
export function chatCreateOptions(ctx, s) {
  const role = roleOf(ctx.policy, s.roleName || undefined);
  return {
    title: s.title,
    config: {
      provider: role.provider,
      ...(role.thinking ? { thinkingOptionId: role.thinking } : {}),
      ...(role.mode ? { modeId: role.mode } : {}),
      systemPrompt: chatPrompt(ctx, s),
    },
    env: { AFFAIR_ID: s.id, CLAUDE_CODE_PROMPT_CACHE_TTL: ctx.policy.chat.cacheTtl },
    labels: { "affairs.chat": s.id, "affairs.affair": s.id },
  };
}

/** The one line a new chat starts with (it is drawn, not said: the model does not see it); nothing when it replaces one that broke. */
export function noticeFor(why, title) {
  if (why === "first") return `开始盯「${title}」。我先去看一眼，有结果写在这里。`;
  if (why === "migrate") return "现在可以在这里直接跟我聊这件事了；右边的「进展」是最新的情况。";
  if (why.startsWith("rotate")) return "接着聊。之前聊出来的要点我都记下了，右边的「进展」里能看到。";
  return "";
}
