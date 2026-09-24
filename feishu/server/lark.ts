import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface LarkCli {
  readonly path: string;
  readonly profile: string;
}

const CALL_TIMEOUT_MS = 30_000;
// Fetching a message downloads its attachments too; a long video takes a while.
const FETCH_TIMEOUT_MS = 120_000;

// lark-cli prints `{ ok: true, data }` on stdout, or `{ ok: false, error }` on
// stderr with a non-zero exit. A body goes over stdin, so a card never meets
// the command line's length limit or its quoting rules.
function run(
  cli: LarkCli,
  args: string[],
  options: { body?: unknown; cwd?: string; timeoutMs?: number; raw?: boolean; stderr?: (text: string) => void } = {},
): Promise<unknown> {
  const what = args.slice(0, 3).join(" ");
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(cli.path, ["--profile", cli.profile, ...args, "--as", "bot"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: options.cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? CALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        if (options.stderr && stderr.trim() !== "") options.stderr(stderr.trim().slice(-1_000));
        try {
          const parsed = JSON.parse(stdout) as { data?: unknown };
          resolve(options.raw ? parsed : parsed.data);
        } catch {
          reject(new Error(`lark-cli ${what}: unreadable output: ${stdout.slice(0, 300)}`));
        }
        return;
      }
      reject(new Error(`lark-cli ${what} exited ${code}: ${describeFailure(stderr)}`));
    });
    child.stdin.end(options.body === undefined ? "" : JSON.stringify(options.body));
  });
}

function call(cli: LarkCli, method: "POST" | "PATCH", path: string, body: unknown) {
  return run(cli, ["api", method, path, "--data", "-"], { body });
}

function describeFailure(stderr: string): string {
  try {
    const envelope = JSON.parse(stderr) as { error?: { code?: number; message?: string } };
    if (envelope.error?.message) {
      return envelope.error.code === undefined
        ? envelope.error.message
        : `${envelope.error.code} ${envelope.error.message}`;
    }
  } catch {
    // Not an envelope: fall through to the raw text.
  }
  return stderr.trim().slice(-500);
}

/** Replies to `messageId` with a card and returns the card's own message ID. */
export async function replyCard(cli: LarkCli, messageId: string, card: object): Promise<string> {
  const data = await call(cli, "POST", `/open-apis/im/v1/messages/${messageId}/reply`, {
    msg_type: "interactive",
    content: JSON.stringify(card),
  });
  const cardId = (data as { message_id?: unknown } | undefined)?.message_id;
  if (typeof cardId !== "string") throw new Error("Feishu returned no message_id for the card");
  return cardId;
}

/**
 * Sends a card to a chat as a new message and returns its message ID. Feishu sends at most one
 * message per `uuid` within an hour, so a repeated send with the same key is not a duplicate.
 */
export async function sendCard(cli: LarkCli, chatId: string, card: object, uuid?: string): Promise<string> {
  const data = await run(
    cli,
    ["api", "POST", "/open-apis/im/v1/messages", "--params", JSON.stringify({ receive_id_type: "chat_id" }), "--data", "-"],
    {
      body: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
        ...(uuid ? { uuid: uuid.slice(0, 50) } : {}),
      },
    },
  );
  const messageId = (data as { message_id?: unknown } | undefined)?.message_id;
  if (typeof messageId !== "string") throw new Error("Feishu returned no message_id for the card");
  return messageId;
}

/** Replaces a card sent by this bot in place. Feishu refuses cards older than 14 days. */
export async function patchCard(cli: LarkCli, cardId: string, card: object): Promise<void> {
  await call(cli, "PATCH", `/open-apis/im/v1/messages/${cardId}`, { content: JSON.stringify(card) });
}

/** One message as `im +messages-mget` renders it: content is readable text, not raw JSON. */
export interface LarkMessage {
  message_id: string;
  msg_type: string;
  content: string;
  deleted?: boolean;
  sender?: { id?: string; name?: string; sender_type?: string };
  /** Present with --download-resources; `error` marks one that did not download. */
  resources?: Array<{
    key: string;
    type: "image" | "file";
    local_path?: string;
    size_bytes?: number;
    error?: boolean;
  }>;
}

/**
 * Fetches messages with their sender names. With `downloadTo`, their images and files end up in
 * `<downloadTo>/lark-im-resources/`. lark-cli only writes under its working directory, and since
 * 1.0.93 refuses any directory inside a protected one such as /root, where Paseo's data lives on a
 * root daemon; so it runs in a fresh temporary directory and the files are moved over afterwards.
 * A download that fails still exits 0; what lark-cli said about it on stderr goes to `onStderr`.
 */
export async function fetchMessages(
  cli: LarkCli,
  messageIds: string[],
  downloadTo: string | null,
  onStderr?: (text: string) => void,
): Promise<LarkMessage[]> {
  const args = ["im", "+messages-mget", "--message-ids", messageIds.join(","), "--no-reactions", "--format", "json"];
  if (downloadTo === null) return messagesOf(await run(cli, args));
  const staging = await mkdtemp(path.join(os.tmpdir(), "paseo-feishu-"));
  try {
    const messages = messagesOf(
      await run(cli, [...args, "--download-resources"], { cwd: staging, timeoutMs: FETCH_TIMEOUT_MS, stderr: onStderr }),
    );
    for (const message of messages) {
      for (const resource of message.resources ?? []) {
        if (resource.error || !resource.local_path) continue;
        const relative = path.relative(staging, path.resolve(staging, resource.local_path));
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const target = path.join(downloadTo, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(staging, relative), target);
        resource.local_path = target;
      }
    }
    return messages;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function messagesOf(data: unknown): LarkMessage[] {
  const messages = (data as { messages?: unknown } | undefined)?.messages;
  return Array.isArray(messages) ? (messages as LarkMessage[]) : [];
}

/** This bot's own open_id: a group message is meant for the bot when it @-mentions this ID. */
export async function botOpenId(cli: LarkCli): Promise<string> {
  // The endpoint answers `{ bot: { open_id } }` with no `data`, which lark-cli's JSON envelope
  // drops; ndjson is the response as Feishu sent it.
  const response = await run(cli, ["api", "GET", "/open-apis/bot/v3/info", "--format", "ndjson"], { raw: true });
  const id = (response as { bot?: { open_id?: unknown } } | undefined)?.bot?.open_id;
  if (typeof id !== "string" || id === "") throw new Error("Feishu returned no open_id for this bot");
  return id;
}

const MAX_MEMBER_PAGES = 10;

/** Everyone in a chat the bot is in, with the names the chat shows. */
export async function chatMembers(cli: LarkCli, chatId: string): Promise<Array<{ openId: string; name: string }>> {
  const found: Array<{ openId: string; name: string }> = [];
  let pageToken = "";
  for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
    const params = { member_id_type: "open_id", page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) };
    const data = (await run(cli, ["api", "GET", `/open-apis/im/v1/chats/${chatId}/members`, "--params", JSON.stringify(params)])) as
      | { items?: Array<{ member_id?: unknown; name?: unknown }>; has_more?: unknown; page_token?: unknown }
      | undefined;
    for (const item of data?.items ?? []) {
      if (typeof item.member_id === "string" && typeof item.name === "string") {
        found.push({ openId: item.member_id, name: item.name });
      }
    }
    if (data?.has_more !== true || typeof data.page_token !== "string" || data.page_token === "") break;
    pageToken = data.page_token;
  }
  return found;
}
