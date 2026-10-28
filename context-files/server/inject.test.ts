import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsDefinition, type Settings } from "../shared/settings";
import { cutUtf8, inject, wantsFiles, type InjectInput, type Reader } from "./inject";

const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...settingsDefinition.schema.parse({}),
  files: ["/kb/INDEX.md"],
  ...patch,
});
const input = (patch: Partial<InjectInput> = {}): InjectInput => ({
  provider: "codex",
  cwd: "/work/project",
  existing: undefined,
  env: undefined,
  ...patch,
});
const files =
  (table: Record<string, string>): Reader =>
  async (path) => {
    if (!(path in table)) throw new Error(`ENOENT: ${path}`);
    return Buffer.from(table[path], "utf8");
  };

test("defaults inject for codex and pi, not for claude", () => {
  const s = settings();
  assert.equal(wantsFiles(s, input({ provider: "codex" })), true);
  assert.equal(wantsFiles(s, input({ provider: "pi" })), true);
  assert.equal(wantsFiles(s, input({ provider: "claude" })), false);
  assert.equal(wantsFiles(s, input({ provider: "opencode" })), false);
});

test("a provider id with a model suffix is the same provider", () => {
  assert.equal(wantsFiles(settings(), input({ provider: "codex/gpt-5.4" })), true);
});

test("claude gets the files only when CLAUDE.md loading is off for the session", () => {
  assert.equal(wantsFiles(settings(), input({ provider: "claude", env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } })), true);
  assert.equal(wantsFiles(settings(), input({ provider: "claude", env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0" } })), false);
  assert.equal(wantsFiles(settings(), input({ provider: "claude", env: { OTHER: "1" } })), false);
  assert.equal(
    wantsFiles(settings({ claudeWhenClaudeMdDisabled: false }), input({ provider: "claude", env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } })),
    false,
  );
});

test("providers without a model are never injected, even when listed", () => {
  const s = settings({ providers: ["codex", "orch-gate", "reconcile"] });
  assert.equal(wantsFiles(s, input({ provider: "orch-gate" })), false);
  assert.equal(wantsFiles(s, input({ provider: "reconcile" })), false);
});

test("cwdPrefixes limit injection to agents inside those directories", () => {
  const s = settings({ cwdPrefixes: ["/work/project"] });
  assert.equal(wantsFiles(s, input({ cwd: "/work/project" })), true);
  assert.equal(wantsFiles(s, input({ cwd: "/work/project/sub" })), true);
  assert.equal(wantsFiles(s, input({ cwd: "/work/project-other" })), false);
  assert.equal(wantsFiles(s, input({ cwd: "/elsewhere" })), false);
  assert.equal(wantsFiles(settings({ cwdPrefixes: ["C:\\Work\\Project\\"] }), input({ cwd: "c:/work/project/x" })), true);
});

test("appends after the existing system prompt and keeps it intact", async () => {
  const existing = "You are the chat assistant.\nStay short.";
  const result = await inject(settings(), input({ existing }), files({ "/kb/INDEX.md": "# Index\n- one" }));
  assert.ok(result.systemPrompt);
  assert.ok(result.systemPrompt.startsWith(existing));
  assert.match(result.systemPrompt, /<!-- context-files: \/kb\/INDEX\.md -->\n# Index\n- one\n<!-- \/context-files: \/kb\/INDEX\.md -->$/);
  assert.deepEqual(result.added, ["/kb/INDEX.md"]);
});

test("without an existing prompt the files are the whole prompt", async () => {
  const result = await inject(settings(), input(), files({ "/kb/INDEX.md": "hello" }));
  assert.equal(result.systemPrompt, "<!-- context-files: /kb/INDEX.md -->\nhello\n<!-- /context-files: /kb/INDEX.md -->");
});

test("several files keep their order", async () => {
  const s = settings({ files: ["/a.md", "/b.md"] });
  const result = await inject(s, input(), files({ "/a.md": "AAA", "/b.md": "BBB" }));
  assert.ok(result.systemPrompt);
  assert.ok(result.systemPrompt.indexOf("AAA") < result.systemPrompt.indexOf("BBB"));
});

test("a missing file is skipped and the others still go in", async () => {
  const s = settings({ files: ["/gone.md", "/b.md"] });
  const result = await inject(s, input({ existing: "base" }), files({ "/b.md": "BBB" }));
  assert.match(result.systemPrompt ?? "", /BBB/);
  assert.deepEqual(result.added, ["/b.md"]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].path, "/gone.md");
  assert.match(result.skipped[0].why, /cannot read/);
});

test("when nothing can be read the prompt is left alone", async () => {
  const result = await inject(settings(), input({ existing: "base" }), files({}));
  assert.equal(result.systemPrompt, undefined);
  assert.equal(result.added.length, 0);
});

test("a relative path and an empty file are skipped", async () => {
  const s = settings({ files: ["rel/INDEX.md", "/empty.md"] });
  const result = await inject(s, input(), files({ "rel/INDEX.md": "x", "/empty.md": "  \n" }));
  assert.equal(result.systemPrompt, undefined);
  assert.deepEqual(result.skipped.map((s) => s.why), ["not an absolute path", "empty"]);
});

test("a file over the limit is cut and says so", async () => {
  const s = settings({ maxFileBytes: 1024 });
  const result = await inject(s, input(), files({ "/kb/INDEX.md": "a".repeat(5000) }));
  assert.ok(result.systemPrompt);
  assert.match(result.systemPrompt, /\[context-files: cut after 1024 of 5000 bytes\]/);
  assert.ok(result.systemPrompt.length < 1500);
});

test("the cut never splits a multi-byte character", () => {
  const bytes = Buffer.from("你好世界", "utf8"); // 12 bytes, 3 per character
  for (let max = 0; max <= 12; max += 1) {
    const text = cutUtf8(bytes, max).toString("utf8");
    assert.equal(text.includes("\uFFFD"), false, `max=${max}`);
    assert.ok("你好世界".startsWith(text));
  }
  assert.equal(cutUtf8(bytes, 7).toString("utf8"), "你好");
});

test("a file already in the prompt is not added twice", async () => {
  const first = await inject(settings(), input(), files({ "/kb/INDEX.md": "hello" }));
  const second = await inject(settings(), input({ existing: first.systemPrompt }), files({ "/kb/INDEX.md": "hello" }));
  assert.equal(second.systemPrompt, undefined);
  assert.equal(second.skipped[0].why, "already in the system prompt");
});

test("the file is read each time, so an edit shows up in the next agent", async () => {
  const table = { "/kb/INDEX.md": "version one" };
  const read = files(table);
  const one = await inject(settings(), input(), read);
  table["/kb/INDEX.md"] = "version two";
  const two = await inject(settings(), input(), read);
  assert.match(one.systemPrompt ?? "", /version one/);
  assert.match(two.systemPrompt ?? "", /version two/);
});
