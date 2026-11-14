import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fetchMessages } from "./lark";

// A stand-in for lark-cli: writes an image under its working directory, as the real one does,
// and reports where, relative to that directory.
const FAKE_CLI = `#!/bin/sh
mkdir -p lark-im-resources && printf 'png' > lark-im-resources/img_v3_key.png
pwd > "$CWD_LOG"
echo '{"ok":true,"data":{"messages":[{"message_id":"om_1","msg_type":"image","content":"[Image: img_v3_key]","resources":[{"key":"img_v3_key","type":"image","local_path":"lark-im-resources/img_v3_key.png"}]}]}}'
`;

// Like FAKE_CLI, but reports an absolute path built from the real working directory (`pwd -P`).
const FAKE_CLI_ABSOLUTE = `#!/bin/sh
mkdir -p lark-im-resources && printf 'png' > lark-im-resources/img_v3_key.png
echo '{"ok":true,"data":{"messages":[{"message_id":"om_1","msg_type":"image","content":"[Image: img_v3_key]","resources":[{"key":"img_v3_key","type":"image","local_path":"'"$(pwd -P)"'/lark-im-resources/img_v3_key.png"}]}]}}'
`;

// os.tmpdir() can be spelled differently from where lark-cli reports files: a symlinked /tmp, macOS
// /var -> /private/var, or a Windows 8.3 short path (C:\Users\LIUZHI~1\...). The file is still inside
// the staging directory and must be moved over, not dropped. POSIX only, like the fake CLI above.
test("an absolute path from lark-cli is moved over when the temp dir is reached through a link", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-lark-"));
  const cli = path.join(root, "lark-cli");
  await writeFile(cli, FAKE_CLI_ABSOLUTE);
  await chmod(cli, 0o755);
  await mkdir(path.join(root, "real"));
  await symlink(path.join(root, "real"), path.join(root, "alias"));
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = path.join(root, "alias");
  const target = path.join(root, "media", "om_1");
  try {
    const [message] = await fetchMessages({ path: cli, profile: "p" }, ["om_1"], target);

    const file = path.join(target, "lark-im-resources", "img_v3_key.png");
    assert.equal(message.resources?.[0].local_path, file);
    assert.equal(await readFile(file, "utf8"), "png");
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  }
});

test("attachments are downloaded outside the target directory, then moved into it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-lark-"));
  const cli = path.join(root, "lark-cli");
  await writeFile(cli, FAKE_CLI);
  await chmod(cli, 0o755);
  process.env.CWD_LOG = path.join(root, "cwd");
  const target = path.join(root, "media", "om_1");

  const [message] = await fetchMessages({ path: cli, profile: "p" }, ["om_1"], target);

  const file = path.join(target, "lark-im-resources", "img_v3_key.png");
  assert.equal(message.resources?.[0].local_path, file);
  assert.equal(await readFile(file, "utf8"), "png");
  const ranIn = (await readFile(process.env.CWD_LOG, "utf8")).trim();
  assert.ok(!ranIn.startsWith(target), `lark-cli ran in ${ranIn}, inside the target`);
  assert.deepEqual(await readdir(path.dirname(ranIn)).then((names) => names.includes(path.basename(ranIn))), false);
});
