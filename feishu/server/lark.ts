import { spawn } from "node:child_process";

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
  options: { body?: unknown; cwd?: string; timeoutMs?: number; raw?: boolean } = {},
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
 * Fetches messages with their sender names. With `downloadTo`, their images and files are
 * downloaded into `<downloadTo>/lark-im-resources/`: lark-cli only writes under its working
 * directory, so that is where it runs.
 */
export async function fetchMessages(
  cli: LarkCli,
  messageIds: string[],
  downloadTo: string | null,
): Promise<LarkMessage[]> {
  const args = ["im", "+messages-mget", "--message-ids", messageIds.join(","), "--no-reactions", "--format", "json"];
  const data = await run(
    cli,
    downloadTo === null ? args : [...args, "--download-resources"],
    downloadTo === null ? {} : { cwd: downloadTo, timeoutMs: FETCH_TIMEOUT_MS },
  );
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
