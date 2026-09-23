import { spawn } from "node:child_process";

export interface LarkCli {
  readonly path: string;
  readonly profile: string;
}

const CALL_TIMEOUT_MS = 30_000;

// lark-cli prints `{ ok: true, data }` on stdout, or `{ ok: false, error }` on
// stderr with a non-zero exit. The body goes over stdin, so a card never meets
// the command line's length limit or its quoting rules.
function call(cli: LarkCli, method: "POST" | "PATCH", path: string, body: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      cli.path,
      ["--profile", cli.profile, "api", method, path, "--as", "bot", "--data", "-"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), CALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve((JSON.parse(stdout) as { data?: unknown }).data);
        } catch {
          reject(new Error(`lark-cli ${method} ${path}: unreadable output: ${stdout.slice(0, 300)}`));
        }
        return;
      }
      reject(new Error(`lark-cli ${method} ${path} exited ${code}: ${describeFailure(stderr)}`));
    });
    child.stdin.end(JSON.stringify(body));
  });
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
