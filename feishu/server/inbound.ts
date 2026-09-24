import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LarkMessage } from "./lark";

// Turns a Feishu message into what its agent is sent. Without this, a screenshot reached the
// agent as `[Image: img_v3_...]`, a key it had no way to open. The agent should get what a
// person in the chat sees: the picture itself, the file on disk, the message being replied to,
// and in a group, who is speaking.

/** An image as Paseo's `send` and `create` take it. */
export interface PromptImage {
  data: string;
  mimeType: string;
}

export interface Incoming {
  /** The text the agent is sent. */
  prompt: string;
  images: PromptImage[];
  /** The message as a person would summarise it, for the card: no paths, attachments as tags. */
  summary: string;
  /** Why an attachment did not reach the agent, if one did not; shown on the card. */
  problems: string[];
}

export interface IncomingDeps {
  /** `im +messages-mget --download-resources`, with `dir` as where the files go. */
  fetch(messageIds: string[], dir: string): Promise<LarkMessage[]>;
  /** `im +messages-mget` downloading nothing: who wrote what the group said before. */
  lookup?(messageIds: string[]): Promise<LarkMessage[]>;
  /** Where this message's attachments are kept. */
  mediaDir(chatId: string, messageId: string): string;
  readFile?: (path: string) => Promise<Buffer>;
  /** Where a failed download is explained; the card only says that it failed. */
  log?: (line: string) => void;
  /** How long to wait before fetching again when an attachment did not download. */
  retryDelayMs?: number;
}

/** A group message the bot was not @-ed in, kept as context for the next one it is. */
export interface Overheard {
  messageId: string;
  /** As the event has it: readable text, with attachment markers and `@_user_N` keys. */
  content: string;
  mentions: unknown;
  at: number;
}

// Claude drops any other image type without a word (Paseo's claude provider keeps these four).
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
// The Anthropic API takes up to 5 MB per image once base64-encoded, and 32 MB per request.
const MAX_IMAGE_BYTES = 3_750_000;
const MAX_TOTAL_IMAGE_BYTES = 15_000_000;
const MAX_IMAGES = 10;
const MAX_QUOTED_CHARS = 1_500;
// What the group said before an @: enough to follow the conversation, not a transcript.
const MAX_OVERHEARD_LINE = 300;
const MAX_OVERHEARD_CHARS = 3_000;
// On the server, both images of a picture-and-text message came back missing when fetched the
// moment the event arrived, yet downloaded fine minutes later: one retry, a moment later.
const RETRY_DELAY_MS = 1_500;

// Markers lark-cli leaves in rendered content where an attachment was.
const MARKERS: Array<{ pattern: RegExp; kind: "image" | "file" | "audio" | "video" | "sticker" }> = [
  { pattern: /\[Image: ([\w-]+)\]/g, kind: "image" },
  { pattern: /!\[[^\]]*\]\((img_[\w-]+)\)/g, kind: "image" },
  { pattern: /<file key="([\w-]+)"[^>]*\/>/g, kind: "file" },
  { pattern: /<audio key="([\w-]+)"[^>]*\/>/g, kind: "audio" },
  { pattern: /<(?:video|media) key="([\w-]+)"[^>]*\/>/g, kind: "video" },
  { pattern: /<sticker key="([\w-]+)"[^>]*\/>/g, kind: "sticker" },
];
const ANY_MARKER = /\[Image: |!\[[^\]]*\]\(img_|<(?:file|audio|video|media|sticker) key=/;

// Types whose event content already is the whole message.
const PLAIN_TYPES = new Set(["text", "post"]);

/**
 * `command` is removed from the start of the message's own text: `/new <text>` starts a fresh
 * agent on the text, and the agent should not see the command, which Claude would take for one
 * of its own.
 */
export async function readIncoming(
  event: Record<string, unknown>,
  deps: IncomingDeps,
  options: { command?: RegExp; overheard?: Overheard[] } = {},
): Promise<Incoming> {
  const messageId = String(event.message_id);
  const chatId = String(event.chat_id);
  const content = typeof event.content === "string" ? event.content : "";
  const type = typeof event.message_type === "string" ? event.message_type : "text";
  const replyTo = typeof event.reply_to === "string" && event.reply_to !== "" ? event.reply_to : null;
  const group = event.chat_type === "group";

  // Most messages are a few typed words in a single chat: nothing to fetch.
  const uncommand = (text: string) => (options.command ? text.replace(options.command, "").trim() : text);
  if (PLAIN_TYPES.has(type) && !replyTo && !group && !ANY_MARKER.test(content)) {
    const text = uncommand(stripMentions(content, event.mentions));
    return { prompt: text, images: [], summary: text, problems: [] };
  }

  const dir = deps.mediaDir(chatId, messageId);
  const ids = replyTo ? [messageId, replyTo] : [messageId];
  const problems: string[] = [];
  const fetchOnce = async (): Promise<{ messages: LarkMessage[]; error: string | null }> => {
    try {
      await mkdir(dir, { recursive: true });
      return { messages: await deps.fetch(ids, dir), error: null };
    } catch (error) {
      return { messages: [], error: error instanceof Error ? error.message : String(error) };
    }
  };
  let result = await fetchOnce();
  let missing = undownloaded(result.messages, messageId, content);
  if (result.error !== null || missing.length > 0) {
    deps.log?.(`${messageId} attachments incomplete (${result.error ?? missing.join(", ")}), fetching again`);
    await new Promise((done) => setTimeout(done, deps.retryDelayMs ?? RETRY_DELAY_MS));
    result = await fetchOnce();
    missing = undownloaded(result.messages, messageId, content);
    if (result.error !== null || missing.length > 0) {
      deps.log?.(`${messageId} attachments still incomplete (${result.error ?? missing.join(", ")})`);
    }
  }
  const fetched = result.messages;
  if (result.error !== null) problems.push(`没能从飞书取到消息的附件：${result.error}`);
  const byId = new Map(fetched.map((message) => [message.message_id, message]));
  const main = byId.get(messageId) ?? { message_id: messageId, msg_type: type, content };
  const parent = replyTo ? byId.get(replyTo) : undefined;

  const images: PromptImage[] = [];
  const read = deps.readFile ?? readFile;
  const render = async (message: LarkMessage) => {
    const resources = new Map((message.resources ?? []).map((resource) => [resource.key, resource]));
    let text = message.msg_type === "interactive" ? cardText(message.content) : message.content;
    let summary = text;
    for (const { pattern, kind } of MARKERS) {
      const found = [...text.matchAll(pattern)];
      for (const [marker, key] of found) {
        const resource = resources.get(key);
        const name = /name="([^"]*)"/.exec(marker)?.[1] ?? "";
        // lark-cli documents these as under ./lark-im-resources/; resolved against where it ran.
        const path = resource && !resource.error && resource.local_path ? resolve(dir, resource.local_path) : undefined;
        let shown: string;
        if (kind === "image") {
          const attached = path ? await attachImage(path, images, read) : "没能下载";
          if (attached === null) shown = `[图片 ${images.length}]`;
          else {
            shown = path ? `[图片（${attached}，文件在 ${path}）]` : `[图片（${attached}）]`;
            problems.push(`有一张图片没附上：${attached}`);
          }
        } else if (kind === "sticker") {
          shown = "[表情]";
        } else {
          const label = { file: "文件", audio: "语音", video: "视频" }[kind];
          const title = name === "" ? label : `${label} ${name}`;
          if (path) shown = `[${title}，在 ${path}]`;
          else {
            shown = `[${title}（没能下载）]`;
            problems.push(`${title} 没能下载`);
          }
        }
        // Replacer functions: a `$` in a path is not a replacement pattern.
        text = text.replace(marker, () => shown);
        const tag = kind === "image" ? "图片" : kind === "sticker" ? "表情" : name || "附件";
        summary = summary.replace(marker, () => `[${tag}]`);
      }
    }
    return { text: stripMentions(text, event.mentions).trim(), summary: summary.trim() };
  };

  // The quoted message first, so image numbers follow the order the text reads in.
  const quoted = parent ? await render(parent) : null;
  const rendered = await render(main);
  const body = { text: uncommand(rendered.text), summary: uncommand(rendered.summary) };
  const speaker = group ? `${main.sender?.name || "某人"}：` : "";
  const heard = await overheardBlock(options.overheard ?? [], deps.lookup);
  const parts: string[] = heard === "" ? [] : [heard];
  if (parent && quoted) {
    const who = parent.sender?.sender_type === "app" ? "你之前的回复" : `${parent.sender?.name || "某人"} 的消息`;
    const lines = clip(quoted.text, MAX_QUOTED_CHARS).split("\n").map((line) => `> ${line}`);
    parts.push(`[回复 ${who}]\n${lines.join("\n")}`);
  } else if (replyTo) {
    parts.push("[回复了一条消息，但没能取到它的内容]");
  }
  parts.push(`${speaker}${body.text === "" ? "（空消息）" : body.text}`);
  return {
    prompt: parts.join("\n\n"),
    images,
    summary: body.summary === "" ? "[消息]" : body.summary,
    problems,
  };
}

/** The attachments that did not reach disk, as `message/key (why)`; stickers are never downloaded. */
function undownloaded(messages: LarkMessage[], messageId: string, eventContent: string): string[] {
  const missing: string[] = [];
  if (!messages.some((message) => message.message_id === messageId) && ANY_MARKER.test(eventContent)) {
    missing.push(`${messageId} (message not returned)`);
  }
  for (const message of messages) {
    const resources = new Map((message.resources ?? []).map((resource) => [resource.key, resource]));
    for (const { pattern, kind } of MARKERS) {
      if (kind === "sticker") continue;
      for (const [, key] of message.content.matchAll(pattern)) {
        const resource = resources.get(key);
        if (resource && !resource.error && resource.local_path) continue;
        const why = !resource ? "not returned" : resource.error ? "error" : "no path";
        missing.push(`${message.message_id}/${key} (${why})`);
      }
    }
  }
  return missing;
}

/**
 * What the group said since the bot was last @-ed, one line per message, oldest first, the
 * oldest dropped first when it runs long. The event carries open_ids, not names, so names are
 * looked up; attachments stay tags, since the agent is told what was said, not handed every
 * picture posted in the chat.
 */
export async function overheardBlock(overheard: Overheard[], lookup?: IncomingDeps["lookup"]): Promise<string> {
  if (overheard.length === 0) return "";
  const names = new Map<string, string>();
  if (lookup) {
    try {
      for (const message of await lookup(overheard.map((entry) => entry.messageId))) {
        if (message.sender?.name) names.set(message.message_id, message.sender.name);
      }
    } catch {
      // The lines still read without names.
    }
  }
  const lines: string[] = [];
  let used = 0;
  for (const entry of [...overheard].reverse()) {
    const said = clip(tagged(entry.content, entry.mentions), MAX_OVERHEARD_LINE);
    const line = `${names.get(entry.messageId) ?? "某人"}：${said}`;
    if (used + line.length > MAX_OVERHEARD_CHARS) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.length === 0 ? "" : `[群里在这之前的消息，没有 @ 你]\n${lines.join("\n")}`;
}

/** Content on one line, attachments as tags and mentions as the names a person sees. */
function tagged(content: string, mentions: unknown): string {
  let text = content;
  for (const { pattern, kind } of MARKERS) {
    text = text.replace(pattern, (marker) => {
      if (kind === "image") return "[图片]";
      if (kind === "sticker") return "[表情]";
      const label = { file: "文件", audio: "语音", video: "视频" }[kind];
      const name = /name="([^"]*)"/.exec(marker)?.[1] ?? "";
      return name === "" ? `[${label}]` : `[${label} ${name}]`;
    });
  }
  if (Array.isArray(mentions)) {
    for (const mention of mentions) {
      const { key, name } = (mention ?? {}) as { key?: unknown; name?: unknown };
      if (typeof key !== "string" || key === "") continue;
      text = text.split(key).join(typeof name === "string" && name !== "" ? `@${name}` : "");
    }
  }
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** Attaches the image, or says why not. */
async function attachImage(
  path: string,
  images: PromptImage[],
  read: (path: string) => Promise<Buffer>,
): Promise<string | null> {
  if (images.length >= MAX_IMAGES) return `一条消息最多附 ${MAX_IMAGES} 张`;
  let bytes: Buffer;
  try {
    bytes = await read(path);
  } catch {
    return "文件读不出来";
  }
  const mimeType = sniffImage(bytes);
  if (!mimeType || !IMAGE_TYPES.includes(mimeType)) return "格式不支持";
  if (bytes.length > MAX_IMAGE_BYTES) return "图片太大";
  const attached = images.reduce((sum, image) => sum + (image.data.length * 3) / 4, 0);
  if (attached + bytes.length > MAX_TOTAL_IMAGE_BYTES) return "这条消息的图片合起来太大";
  images.push({ data: bytes.toString("base64"), mimeType });
  return null;
}

/** The image type from its first bytes; a file name or Feishu's say-so is not trusted. */
export function sniffImage(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** The words on a card, when a message being replied to is one (this bot's cards are). */
export function cardText(content: string): string {
  let card: unknown;
  try {
    card = JSON.parse(content);
  } catch {
    return content;
  }
  const texts: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const element = node as Record<string, unknown>;
    if (typeof element.content === "string" && element.content.trim() !== "") texts.push(element.content.trim());
    for (const [key, value] of Object.entries(element)) {
      if (key !== "content") walk(value);
    }
  };
  walk(card);
  return texts.join("\n");
}

/** Removes the `@_user_1` placeholders Feishu puts where a message mentions someone. */
export function stripMentions(content: string, mentions: unknown): string {
  let stripped = content;
  if (Array.isArray(mentions)) {
    for (const mention of mentions) {
      const key = (mention as { key?: unknown } | null)?.key;
      if (typeof key === "string" && key !== "") stripped = stripped.split(key).join("");
    }
  }
  return stripped.trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}……` : text;
}
