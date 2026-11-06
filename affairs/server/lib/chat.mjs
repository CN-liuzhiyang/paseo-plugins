import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { commandCard } from "./commands.mjs";
import { primaryLink } from "./links.mjs";
import { workTexts } from "./workdir-git.mjs";
import { dayStart } from "./limits.mjs";
import { localParts } from "./time.mjs";
import { roleOf } from "./schedule.mjs";
import { modeOf } from "./mode.mjs";

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
  if (s.flowRunning) return "";
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

export function chatHandbooks(ctx, s) {
  const kind = primaryLink(s)?.split(":")[0];
  const dir = ctx.policy.handbooksDir;
  const publicFile = ctx.policy.handbookPath ? path.join(path.dirname(ctx.policy.handbookPath), "handbook.chat.md") : "";
  const driving = modeOf(s, ctx.policy) === "drive";
  const files = [publicFile, ...(dir ? [path.join(dir, "affair.chat.md"), ...(!driving ? [path.join(dir, ctx.policy.chatHandbookByKind?.[kind] || "asked.chat.md")] : [])] : []), ...(driving && publicFile ? [path.join(path.dirname(publicFile), "drive.chat.md")] : [])];
  return files.filter((f) => f && existsSync(f)).map((f) => readFileSync(f, "utf8")).join("\n\n");
}

export function chatPrompt(ctx, s) {
  const texts = workTexts(ctx, s);
  const driving = modeOf(s, ctx.policy) === "drive";
  return [
    `你是事项 ${s.id}「${s.title}」的对话，负责这件事。${driving ? "这件事由你来推，不排看一眼。" : "看一眼由另外的小会话完成。"}每轮先跑 ${ctx.command} brief ${s.id} --chat，再回他。`,
    "不替他答问题，不替他起流程。只有他这一轮明确说的话才能授权；一句话只能起一次流程。流程结束通知只汇报，不能当授权。试跑只在他明确说试跑时加 --trial。",
    "里程碑当场 report 新的 status，facts 新增、drop 删旧；note 只加结论，不改现在。回他之前核对现在，过时先补交。按步骤主动说走到哪里、下一步谁做。",
    "不手改 log.jsonl，不自己跑 schedule、orch 或 git；文档写 README 和同文件夹其他文件，用 affair save 保存。图片只在当前对话，后面要用的要点记 note，凭据不抄。",
    commandCard(ctx.command, s.id),
    `关联地址：${JSON.stringify(ctx.policy.links || {})}（按模板写 Markdown 链接，不猜地址）`,
    "## 现在的印象", texts.status, "## 这件事", texts.readme,
    "## 对话手册", chatHandbooks(ctx, s),
    ...(driving && ctx.policy.driveHandbook ? [`本机推进手册（用到时读）：${ctx.policy.driveHandbook}`] : []),
  ].join("\n");
}

/** What a new chat session is made with: the same model as this affair's looks, a cache lifetime that suits turns far apart, no first message. */
/**
 * Which model the chat of this affair runs on. By default the one its looks run on. policy.chat.role names another role for
 * every chat; a role may also carry a `chat` of its own ({ provider, thinking, mode, env }) that wins for the affairs of that role.
 */
export function chatRoleOf(policy, roleName, driving = false) {
  const look = roleOf(policy, roleName);
  const named = driving && policy.drive?.role ? roleOf(policy, policy.drive.role) : policy.chat.role ? roleOf(policy, policy.chat.role) : look;
  return { ...named, ...(look.chat ?? {}) };
}

export function chatCreateOptions(ctx, s) {
  const role = chatRoleOf(ctx.policy, s.roleName || undefined, modeOf(s, ctx.policy) === "drive");
  return {
    title: s.title,
    config: {
      provider: role.provider,
      ...(role.thinking ? { thinkingOptionId: role.thinking } : {}),
      ...(role.mode ? { modeId: role.mode } : {}),
      systemPrompt: chatPrompt(ctx, s),
    },
    // The cache lifetime is a Claude Code setting; a role that runs another provider says its own env (or none) and leaves this out.
    env: { AFFAIR_ID: s.id, ...(role.env ?? { CLAUDE_CODE_PROMPT_CACHE_TTL: ctx.policy.chat.cacheTtl }) },
    labels: { "affairs.chat": s.id, "affairs.affair": s.id },
  };
}

/** The one line a new chat starts with (it is drawn, not said: the model does not see it); nothing when it replaces one that failed. */
export function noticeFor(why, title) {
  if (why === "first") return `开始盯「${title}」。我先去看一眼，有结果写在这里。`;
  if (why === "migrate") return "现在可以在这里直接跟我聊这件事了；右边的「进展」是最新的情况。";
  if (why.startsWith("rotate")) return "接着聊。我记下的要点在右边的「进展」里，你说过的话都还在。";
  return "";
}
