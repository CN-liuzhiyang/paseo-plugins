import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { MAX_BYTES, cleanName } from "../server/lib/attach.mjs";
import { append, load, read } from "../server/lib/log.mjs";
import * as ops from "../server/lib/ops.mjs";
import { attachSummary, cardOf, rowsOf, say, sentOf } from "../server/lib/view.mjs";
import { scratch, world } from "./kit";

const MECHANISM = /叫醒|校验|记录|计划|读数|会话|agent/i;
// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const png = (name?: string) => ({ type: "image", data: PNG.toString("base64"), mimeType: "image/png", ...(name ? { name } : {}) });

async function started(w: ReturnType<typeof world>) {
  const made = await ops.create(w.ctx, { id: "dental", title: "洗牙", goal: "约上洗牙", said: "帮我盯一下洗牙，今天最好要搞定", noWait: true });
  assert.equal(made.ok, true, made.text);
  return made.id as string;
}
const filesOf = (w: ReturnType<typeof world>, id: string) => readdirSync(path.join(w.root, id, "files"));
const runs = (w: ReturnType<typeof world>) => w.calls().filter((c) => c[1] === "run-once").length;
const lastSaid = (w: ReturnType<typeof world>, id: string) => [...read(w.root, id)].reverse().find((l) => l.kind === "said");

// ---- keeping it ----

test("a picture is kept in this affair's files/ under the time and its name; the line says where, and a look is called", async () => {
  const w = await world_();
  const before = runs(w.w);
  const r = await ops.note(w.w.ctx, w.id, { said: "", via: "workspace", attachments: [png("shot.png")] });
  assert.equal(r.ok, true, r.text);
  const [name] = filesOf(w.w, w.id);
  assert.match(name!, /^20261102-100000-shot\.png$/);
  const file = path.join(w.w.root, w.id, "files", name!);
  assert.deepEqual(readFileSync(file), PNG);
  const line = lastSaid(w.w, w.id);
  assert.equal(line.text, "发了一张图：shot.png");
  assert.equal(line.via, "workspace");
  assert.equal(line.by, "user");
  assert.deepEqual(line.attachments, [{ name: "shot.png", path: file.replaceAll("\\", "/"), mime: "image/png", size: PNG.length }]);
  assert.equal(runs(w.w), before + 1, "typing and sending are the same: a look is asked for");
  const s = load(w.w.root, w.id);
  assert.ok(s.pending.includes(`said:${line.seq}`));
  assert.equal(s.said.at(-1)!.attachments[0].name, "shot.png");
});

async function world_() {
  const w = world();
  return { w, id: await started(w) };
}

test("words with a file: the words stay the words; the file is copied from where the app put it, the original untouched", async () => {
  const { w, id } = await world_();
  const from = path.join(scratch("affairs-up-"), "u-8f3a");
  writeFileSync(from, "预约：11-11 14:00");
  const r = await ops.note(w.ctx, id, { said: "这是预约单", via: "workspace", attachments: [{ type: "file", from, name: "预约单.txt", mimeType: "text/plain" }] });
  assert.equal(r.ok, true, r.text);
  const line = lastSaid(w, id);
  assert.equal(line.text, "这是预约单");
  assert.equal(line.attachments[0].name, "预约单.txt");
  assert.equal(readFileSync(line.attachments[0].path, "utf8"), "预约：11-11 14:00");
  assert.equal(existsSync(from), true);
  assert.equal(path.dirname(line.attachments[0].path), path.join(w.root, id, "files").replaceAll("\\", "/"));
});

test("two the same second with the same name do not overwrite each other", async () => {
  const { w, id } = await world_();
  await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [png("a.png"), png("a.png")] });
  assert.equal(filesOf(w, id).length, 2);
  assert.equal(lastSaid(w, id).text, "发了 2 张图：a.png、a.png");
});

test("over the limit is refused in plain words; nothing is written, nothing recorded, no look", async () => {
  const { w, id } = await world_();
  const before = { files: filesOf(w, id), lines: read(w.root, id).length, runs: runs(w) };
  const big = Buffer.alloc(MAX_BYTES + 1024, 1).toString("base64");
  const r1 = await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [{ type: "image", data: big, mimeType: "image/png", name: "huge.png" }] });
  assert.equal(r1.ok, false);
  assert.match(r1.text, /「huge\.png」超过 20 MB，没收下/);
  const from = path.join(scratch("affairs-up-"), "u-big");
  writeFileSync(from, "x");
  truncateSync(from, MAX_BYTES + 1);
  const r2 = await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [{ type: "file", from, name: "录屏.mov", mimeType: "video/quicktime" }] });
  assert.equal(r2.ok, false);
  assert.match(r2.text, /「录屏\.mov」有 21 MB，超过 20 MB，没收下/);
  assert.deepEqual({ files: filesOf(w, id), lines: read(w.root, id).length, runs: runs(w) }, before);
  for (const t of [r1.text, r2.text]) assert.doesNotMatch(t, MECHANISM);
});

test("under the limit but one of two too large: the good one is kept and recorded, the other is told", async () => {
  const { w, id } = await world_();
  const big = Buffer.alloc(MAX_BYTES + 1024, 1).toString("base64");
  const r = await ops.note(w.ctx, id, { said: "两张", via: "workspace", attachments: [png("ok.png"), { type: "image", data: big, mimeType: "image/png", name: "huge.png" }] });
  assert.equal(r.ok, true);
  assert.match(r.refused, /huge\.png/);
  assert.equal(filesOf(w, id).length, 1);
  assert.equal(lastSaid(w, id).attachments.length, 1);
});

test("an empty or unreadable one is refused; a folder is not a file", async () => {
  const { w, id } = await world_();
  const dir = scratch("affairs-up-");
  const empty = path.join(dir, "empty");
  writeFileSync(empty, "");
  for (const item of [
    { type: "file", from: empty, name: "空.txt", mimeType: "text/plain" },
    { type: "file", from: path.join(dir, "nope"), name: "没有.txt", mimeType: "text/plain" },
    { type: "file", from: dir, name: "夹.txt", mimeType: "text/plain" },
    { type: "image", data: "", mimeType: "image/png", name: "x.png" },
  ]) {
    const r = await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [item] });
    assert.equal(r.ok, false, JSON.stringify(item));
    assert.match(r.text, /没收|没存|不是一个文件/);
  }
  assert.deepEqual(filesOf(w, id), []);
});

test("bad names stay inside files/: folders, drive letters, reserved names, dots, control characters, runnable types", async () => {
  const names: Array<[string, RegExp]> = [
    ["../../evil.png", /^20261102-100000-evil\.png$/],
    ["..\\..\\evil2.png", /^20261102-100000-evil2\.png$/],
    ["C:\\Windows\\win.ini", /^20261102-100000-win\.ini$/],
    ["/etc/passwd", /^20261102-100000-passwd\.png$/],
    ["a:b*c?.png", /^20261102-100000-a_b_c_\.png$/],
    ["..", /^20261102-100000-.+/],
    [".hidden", /^20261102-100000-hidden\.png$/],
    ["CON.png", /^20261102-100000-_CON\.png$/],
    ["x\u0000y\u202ecod.png", /^20261102-100000-x_y_cod\.png$/],
    ["run.exe", /^20261102-100000-run\.exe\.txt$/],
    ["setup.PS1", /^20261102-100000-setup\.PS1\.txt$/],
    ["", /^20261102-100000-图片\.png$/],
  ];
  const { w, id } = await world_();
  const outside = readdirSync(w.root).sort();
  for (const [name] of names) await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [png(name)] });
  const files = filesOf(w, id).sort();
  assert.equal(files.length, names.length);
  for (const [name, expected] of names) assert.ok(files.some((f) => expected.test(f)), `${JSON.stringify(name)} -> ${files.join(" | ")}`);
  for (const f of files) {
    assert.equal(path.basename(f), f);
    assert.ok(f.length <= 100, f);
  }
  assert.deepEqual(readdirSync(w.root).sort(), outside, "nothing outside this affair's folder");
  assert.ok(!existsSync(path.join(w.root, "evil.png")) && !existsSync(path.join(w.root, "..", "evil.png")));
  assert.equal(cleanName("a".repeat(300) + ".png", "x").length <= 80, true);
  assert.equal(cleanName("a".repeat(300) + ".png", "x").endsWith(".png"), true);
});

test("an image with no name is named for its type; a name without an extension gets the one its type says", async () => {
  const { w, id } = await world_();
  await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/jpeg" }, png("截图")] });
  const files = filesOf(w, id);
  assert.ok(files.some((f) => /-图片\.jpg$/.test(f)), files.join());
  assert.ok(files.some((f) => /-截图\.png$/.test(f)), files.join());
});

test("only into the affair that was meant: another affair's folder is not touched, and a look cannot send things", async () => {
  const { w, id } = await world_();
  await ops.create(w.ctx, { id: "other-2", title: "牙冠", noWait: true });
  await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [png("one.png")] });
  assert.deepEqual(filesOf(w, "other-2"), []);
  const looks = { ...w.ctx, by: "look" };
  const files = filesOf(w, id);
  const r = await ops.note(looks, id, { said: "我看到了", attachments: [png("two.png")] });
  assert.equal(r.ok, false);
  assert.match(r.text, /看一眼的会话/);
  assert.deepEqual(filesOf(w, id), files);
});

test("an affair that is over takes nothing in: no file is left behind", async () => {
  const { w, id } = await world_();
  await ops.stop(w.ctx, id);
  const r = await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [png("late.png")] });
  assert.equal(r.ok, false);
  assert.deepEqual(filesOf(w, id), []);
});

// ---- the credential guard: words only ----

test("a secret in the words is refused as before, and nothing that came with it is kept; a picture whose bytes or name look like a secret is not refused", async () => {
  const { w, id } = await world_();
  const secret = await ops.note(w.ctx, id, { said: "密码是 password=hunter2hunter2", via: "workspace", attachments: [png("a.png")] });
  assert.equal(secret.ok, false);
  assert.deepEqual(filesOf(w, id), [], "nothing is kept when the line is refused");
  const text = Buffer.from("password=hunter2hunter2\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789").toString("base64");
  const r = await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [{ type: "image", data: text, mimeType: "image/png", name: "password-token-reset.png" }] });
  assert.equal(r.ok, true, r.text);
  assert.equal(filesOf(w, id).length, 1);
  assert.equal(lastSaid(w, id).text, "发了一张图：password-token-reset.png");
});

// ---- the record, the brief, the files the look reads ----

test("the state, progress.md and the brief show what he sent, with absolute paths; the new ones are marked", async () => {
  const { w, id } = await world_();
  await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [png("old.png")] });
  w.advance(60_000);
  const before = (await ops.brief(w.ctx, id)).text;
  assert.match(before, /## 他发来的东西/);
  assert.match(before, /\[新\] old\.png/);
  append(w.root, id, [{ kind: "wake.end", state: "ok", usd: 0.01 }], { now: w.now() });
  w.advance(10 * 60_000);
  await ops.note(w.ctx, id, { said: "这是新的", via: "workspace", attachments: [png("new.png"), { type: "file", from: (() => { const f = path.join(scratch("affairs-up-"), "u"); writeFileSync(f, "hello"); return f; })(), name: "单.txt", mimeType: "text/plain" }] });
  const s = load(w.root, id);
  const sent = sentOf({ ...s });
  assert.deepEqual(sent.map((a: { name: string }) => a.name), ["old.png", "new.png", "单.txt"]);
  const progress = readFileSync(path.join(w.root, id, "progress.md"), "utf8");
  for (const a of sent) assert.ok(progress.includes(a.path), `progress.md has ${a.path}`);
  assert.match(progress, /他发来的（在 files\/ 里）/);
  w.advance(10 * 60_000);
  const brief = (await ops.brief(w.ctx, id)).text;
  const section = brief.slice(brief.indexOf("## 他发来的东西"));
  assert.match(section, /\[新\] new\.png/);
  assert.match(section, /\[新\] 单\.txt/);
  assert.doesNotMatch(section.split("\n").find((l) => l.includes("old.png"))!, /\[新\]/);
  for (const a of sent) {
    assert.ok(path.isAbsolute(a.path), a.path);
    assert.ok(brief.includes(a.path), a.path);
  }
  assert.match(brief, /他说了：「这是新的」.*带了：.*new\.png/);
  assert.match(section, /图片用 Read 工具看，文件按需读；别把内容原样抄进/);
  assert.match(section, /密码、令牌、证件号看到了也不要写/);
});

test("the brief lists only what is really in this affair's files/, whatever a line of the log says", async () => {
  const { w, id } = await world_();
  const stray = path.join(scratch("affairs-stray-"), "secret.txt");
  writeFileSync(stray, "x");
  const gone = path.join(w.root, id, "files", "gone.png").replaceAll("\\", "/");
  mkdirSync(path.join(w.root, id, "files"), { recursive: true });
  append(w.root, id, [
    { kind: "said", text: "forged", via: "workspace", by: "user", attachments: [{ name: "secret.txt", path: stray.replaceAll("\\", "/"), mime: "text/plain", size: 1 }, { name: "gone.png", path: gone, mime: "image/png", size: 1 }, { name: 5, path: 7 }] },
  ], { now: w.now() });
  const brief = (await ops.brief(w.ctx, id)).text;
  assert.ok(!brief.includes(stray.replaceAll("\\", "/")) && !brief.includes("gone.png"), "a path outside files/, or a file that is not there, is not handed to a look");
});

test("a new affair's folder note and the handbook tell the look how to treat what he sent", async () => {
  const { w, id } = await world_();
  assert.equal(existsSync(path.join(w.root, id, "CLAUDE.md")), false);
  const handbook = readFileSync(path.join(import.meta.dirname, "..", "handbook.md"), "utf8");
  assert.match(handbook, /图片用 Read 工具/);
  assert.match(handbook, /看到了也不要写/);
});

test("in the conversation it is his line: 你：发了一张图：x.png; the words he typed are not drawn twice; taking it back removes it", async () => {
  const { w, id } = await world_();
  await ops.note(w.ctx, id, { said: "只是文字", via: "workspace" });
  await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [png("x.png")] });
  await ops.note(w.ctx, id, { said: "这是预约短信", via: "workspace", attachments: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/jpeg", name: "短信.jpg" }] });
  const view = () => {
    const s = { ...load(w.root, id), lines: read(w.root, id) };
    return rowsOf(s, w.now(), w.ctx.policy) as Array<{ key: string; text: string; own: boolean }>;
  };
  const rows = view().filter((r) => r.own);
  // (the first line is what he said when he asked for it)
  assert.deepEqual(rows.slice(1).map((r) => r.text.replace(/^\S+\s+/, "")), ["你：发了一张图：x.png", "你：发了一张图：短信.jpg"]);
  assert.ok(rows.every((r) => r.key.startsWith("s")), "drawn as his own");
  ops.undo(w.ctx, id);
  assert.equal(view().filter((r) => r.own).length, 2);
  assert.equal(sentOf({ ...load(w.root, id) }).length, 1);
  void cardOf;
});

test("typed from elsewhere (not the conversation) a line with a file shows the words and the file", async () => {
  const { w, id } = await world_();
  await ops.note(w.ctx, id, { said: "看这个", via: "chat", attachments: [png("y.png")] });
  const s = { ...load(w.root, id), lines: read(w.root, id) };
  const own = (rowsOf(s, w.now(), w.ctx.policy) as Array<{ own: boolean; text: string }>).filter((r) => r.own);
  assert.match(own.at(-1)!.text, /你：看这个（发了一张图：y\.png）/);
});

test("nothing he reads about this names the machinery", async () => {
  const { w, id } = await world_();
  const spoken: string[] = [];
  const big = Buffer.alloc(MAX_BYTES + 1024, 1).toString("base64");
  const r = await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [png("z.png"), { type: "image", data: big, mimeType: "image/png", name: "huge.png" }] });
  spoken.push(r.text, r.refused ?? "");
  spoken.push((await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [{ type: "image", data: "", mimeType: "image/png", name: "e.png" }] })).text);
  spoken.push(attachSummary([{ name: "a.png", mime: "image/png" }, { name: "b.pdf", mime: "application/pdf" }]), attachSummary([{ name: "b.pdf", mime: "application/pdf" }]));
  const s = { ...load(w.root, id), lines: read(w.root, id) };
  spoken.push(...(rowsOf(s, w.now(), w.ctx.policy) as Array<{ text: string }>).map((x) => x.text), say.noted("洗牙", "发了一张图：z.png", ""));
  for (const text of spoken) assert.doesNotMatch(text, MECHANISM, text);
});

test("a chain of the log still holds with attachments in it", async () => {
  const { w, id } = await world_();
  await ops.note(w.ctx, id, { said: "", via: "workspace", attachments: [png("c.png")] });
  assert.equal(load(w.root, id).chainBroken, 0);
});
