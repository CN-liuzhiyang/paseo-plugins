import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cardText, overheardBlock, readIncoming, sniffImage } from "./inbound";
import type { LarkMessage } from "./lark";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function fixture(bytes = PNG) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-inbound-"));
  const file = path.join(dir, "img_v3_key.png");
  await writeFile(file, bytes);
  return { dir, file };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: "om_1",
    chat_id: "oc_1",
    chat_type: "p2p",
    message_type: "text",
    content: "你好",
    ...overrides,
  };
}

function deps(messages: LarkMessage[], dir: string) {
  const asked: string[][] = [];
  return {
    asked,
    deps: {
      fetch: async (ids: string[]) => {
        asked.push(ids);
        return messages;
      },
      mediaDir: () => dir,
    },
  };
}

test("a few typed words in a single chat go as they are, without asking Feishu", async () => {
  const { dir } = await fixture();
  const { asked, deps: d } = deps([], dir);
  const incoming = await readIncoming(event(), d);
  assert.deepEqual(incoming, { prompt: "你好", images: [], summary: "你好", problems: [] });
  assert.deepEqual(asked, []);
});

test("a screenshot reaches the agent as an image, not as a key", async () => {
  const { dir, file } = await fixture();
  const { deps: d } = deps(
    [
      {
        message_id: "om_1",
        msg_type: "image",
        content: "[Image: img_v3_key]",
        resources: [{ key: "img_v3_key", type: "image", local_path: file }],
      },
    ],
    dir,
  );
  const incoming = await readIncoming(event({ message_type: "image", content: "[Image: img_v3_key]" }), d);
  assert.equal(incoming.prompt, "[图片 1]");
  assert.equal(incoming.summary, "[图片]");
  assert.deepEqual(incoming.images, [{ data: PNG.toString("base64"), mimeType: "image/png" }]);
  assert.deepEqual(incoming.problems, []);
});

test("an image the model cannot take is left as a file, and the card says so", async () => {
  const { dir, file } = await fixture(Buffer.from("BM not a supported image"));
  const { deps: d } = deps(
    [
      {
        message_id: "om_1",
        msg_type: "image",
        content: "[Image: img_v3_key]",
        resources: [{ key: "img_v3_key", type: "image", local_path: file }],
      },
    ],
    dir,
  );
  const incoming = await readIncoming(event({ message_type: "image", content: "[Image: img_v3_key]" }), d);
  assert.deepEqual(incoming.images, []);
  assert.ok(incoming.prompt.includes(file));
  assert.match(incoming.problems[0], /格式不支持/);
});

test("a file arrives as a path the agent can open", async () => {
  const { dir } = await fixture();
  const local = path.join(dir, "report.pdf");
  const { deps: d } = deps(
    [
      {
        message_id: "om_1",
        msg_type: "file",
        content: '<file key="file_v3_key" name="report.pdf"/>',
        resources: [{ key: "file_v3_key", type: "file", local_path: local }],
      },
    ],
    dir,
  );
  const incoming = await readIncoming(event({ message_type: "file", content: '<file key="file_v3_key" name="report.pdf"/>' }), d);
  assert.equal(incoming.prompt, `[文件 report.pdf，在 ${local}]`);
  assert.equal(incoming.summary, "[report.pdf]");
});

test("a reply carries the message it replies to, with that message's images", async () => {
  const { dir, file } = await fixture();
  const { asked, deps: d } = deps(
    [
      { message_id: "om_1", msg_type: "text", content: "这是啥？", sender: { name: "甲" } },
      {
        message_id: "om_0",
        msg_type: "image",
        content: "[Image: img_v3_key]",
        sender: { name: "乙", sender_type: "user" },
        resources: [{ key: "img_v3_key", type: "image", local_path: file }],
      },
    ],
    dir,
  );
  const incoming = await readIncoming(event({ content: "这是啥？", reply_to: "om_0" }), d);
  assert.deepEqual(asked, [["om_1", "om_0"]]);
  assert.equal(incoming.prompt, "[回复 乙 的消息]\n> [图片 1]\n\n这是啥？");
  assert.equal(incoming.images.length, 1);
  assert.equal(incoming.summary, "这是啥？");
});

test("replying to one of this bot's cards quotes the card's words", async () => {
  const { dir } = await fixture();
  const card = JSON.stringify({
    header: { title: { tag: "plain_text", content: "完成 · 3 秒" } },
    body: { elements: [{ tag: "markdown", content: "构建全部通过。" }] },
  });
  const { deps: d } = deps(
    [
      { message_id: "om_1", msg_type: "text", content: "再详细点" },
      { message_id: "om_0", msg_type: "interactive", content: card, sender: { sender_type: "app" } },
    ],
    dir,
  );
  const incoming = await readIncoming(event({ content: "再详细点", reply_to: "om_0" }), d);
  assert.equal(incoming.prompt, "[回复 你之前的回复]\n> 完成 · 3 秒\n> 构建全部通过。\n\n再详细点");
});

test("in a group the agent is told who is speaking", async () => {
  const { dir } = await fixture();
  const { deps: d } = deps([{ message_id: "om_1", msg_type: "text", content: "帮我看看", sender: { name: "甲" } }], dir);
  const incoming = await readIncoming(event({ chat_type: "group", content: "帮我看看" }), d);
  assert.equal(incoming.prompt, "甲：帮我看看");
});

test("when Feishu cannot be asked, the message still goes, and the card says what is missing", async () => {
  const { dir } = await fixture();
  const incoming = await readIncoming(event({ message_type: "image", content: "[Image: img_v3_key]" }), {
    fetch: async () => {
      throw new Error("missing scope im:message:readonly");
    },
    mediaDir: () => dir,
  });
  assert.equal(incoming.prompt, "[图片（没能下载）]");
  assert.match(incoming.problems.join("\n"), /missing scope/);
});

test("image types come from the bytes", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(Buffer.from("GIF89a......")), "image/gif");
  assert.equal(sniffImage(Buffer.from("RIFF....WEBPVP8 ")), "image/webp");
  assert.equal(sniffImage(Buffer.from("<svg")), null);
  assert.equal(cardText("not json"), "not json");
});

test("an attachment path lark-cli gives relative to its working directory is made absolute", async () => {
  const { dir } = await fixture();
  const { deps: d } = deps(
    [
      {
        message_id: "om_1",
        msg_type: "file",
        content: '<file key="file_v3_key" name="a.txt"/>',
        resources: [{ key: "file_v3_key", type: "file", local_path: "lark-im-resources/a.txt" }],
      },
    ],
    dir,
  );
  const incoming = await readIncoming(
    event({ message_type: "file", content: '<file key="file_v3_key" name="a.txt"/>' }),
    d,
  );
  assert.equal(incoming.prompt, `[文件 a.txt，在 ${path.join(dir, "lark-im-resources", "a.txt")}]`);
});

test("images stop being attached once the message's total would be too large for one request", async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(3_600_000)]);
  const { dir, file } = await fixture(big);
  const keys = ["a", "b", "c", "d", "e"].map((name) => `img_v3_${name}`);
  const content = keys.map((key) => `[Image: ${key}]`).join(" ");
  const { deps: d } = deps(
    [
      {
        message_id: "om_1",
        msg_type: "post",
        content,
        resources: keys.map((key) => ({ key, type: "image" as const, local_path: file })),
      },
    ],
    dir,
  );
  const incoming = await readIncoming(event({ message_type: "post", content }), d);
  assert.equal(incoming.images.length, 4);
  assert.match(incoming.problems.join("\n"), /合起来太大/);
});

test("a command at the start of a message with attachments is not sent to the agent", async () => {
  const { dir, file } = await fixture();
  const content = "/new 看看 [Image: img_v3_key]";
  const { deps: d } = deps(
    [
      {
        message_id: "om_1",
        msg_type: "post",
        content,
        resources: [{ key: "img_v3_key", type: "image", local_path: file }],
      },
    ],
    dir,
  );
  const incoming = await readIncoming(event({ message_type: "post", content }), d, { command: /^\/new\b\s*/ });
  assert.equal(incoming.prompt, "看看 [图片 1]");
});

test("what the group said before the @ comes first, with names, tags and mentions as people see them", async () => {
  const { dir } = await fixture();
  const lookedUp: string[][] = [];
  const incoming = await readIncoming(
    event({ chat_type: "group", content: "@_user_1 你觉得呢", mentions: [{ id: "ou_bot", key: "@_user_1", name: "Bot" }] }),
    {
      fetch: async () => [{ message_id: "om_1", msg_type: "text", content: "@_user_1 你觉得呢", sender: { name: "甲" } }],
      lookup: async (ids) => {
        lookedUp.push(ids);
        return [{ message_id: "om_a", msg_type: "text", content: "", sender: { name: "乙" } }];
      },
      mediaDir: () => dir,
    },
    {
      overheard: [
        { messageId: "om_a", content: "看这个 [Image: img_v3_x]", mentions: [], at: 0 },
        { messageId: "om_b", content: "@_user_2 多行\n消息", mentions: [{ key: "@_user_2", name: "丙" }], at: 0 },
      ],
    },
  );
  assert.deepEqual(lookedUp, [["om_a", "om_b"]]);
  assert.equal(incoming.prompt, "[群里在这之前的消息，没有 @ 你]\n乙：看这个 [图片]\n某人：@丙 多行 消息\n\n甲：你觉得呢");
});

test("when the group has been talking a lot, the oldest of it is left out", async () => {
  const long = "字".repeat(400);
  const overheard = Array.from({ length: 20 }, (_, i) => ({ messageId: `om_${i}`, content: `${i}${long}`, mentions: [], at: 0 }));
  const block = await overheardBlock(overheard);
  assert.ok(block.length <= 3_100);
  assert.match(block, /某人：19/);
  assert.doesNotMatch(block, /某人：0字/);
});
