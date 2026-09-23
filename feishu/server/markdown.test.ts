import assert from "node:assert/strict";
import { test } from "node:test";
import { cardMarkdown, codeSpans } from "./markdown";

const Z = "​";

test("formatting survives: emphasis, lists, quotes, inline code", () => {
  const text = "**结论**：通过\n\n- 第一项 `npm test`\n- 第二项\n\n> 引用";
  assert.equal(cardMarkdown(text), text);
});

test("no tag gets through outside code: no mention, no restyling", () => {
  const out = cardMarkdown("大家看 <at id=all></at> 和 <font color='red'>红字</font>");
  assert.ok(!out.includes("<at"));
  assert.ok(!out.includes("<font"));
  assert.match(out, /&#60;at id=all>/);
});

test("an entity cannot be decoded back into a tag, but a URL keeps its &", () => {
  assert.equal(cardMarkdown("&#60;at id=all&#62;"), "&#38;#60;at id=all&#38;#62;");
  assert.equal(
    cardMarkdown("[https://a.example/?x=1&y=2](https://a.example/?x=1&y=2)"),
    "[https://a.example/?x=1&y=2](https://a.example/?x=1&y=2)",
  );
});

test("an entity without a semicolon is escaped too", () => {
  assert.ok(cardMarkdown("&#60at id=all&#62").startsWith("&#38;#60at"));
  assert.ok(cardMarkdown("&ltat id=all&gt").startsWith("&#38;ltat"));
});

test("a link shows where it goes", () => {
  assert.equal(
    cardMarkdown("[官方文档](https://evil.example/login)"),
    "官方文档（[https://evil.example/login](https://evil.example/login)）",
  );
  assert.equal(cardMarkdown("[本地](file:///etc/passwd)"), "本地（file:///etc/passwd）");
});

test("images become links, since a card only shows images this app uploaded", () => {
  assert.equal(
    cardMarkdown("![架构图](https://example.com/a.png)"),
    "图片 架构图（[https://example.com/a.png](https://example.com/a.png)）",
  );
  assert.equal(cardMarkdown("![x](img_v3_abc)"), "[图片 x]");
});

test("code is shown as written, but nothing in it can become a tag or a link", () => {
  const fenced = ["```html", "<at id=all></at>", "[a](https://b.example)", "let x = 1 < 2;", "```"].join("\n");
  assert.equal(
    cardMarkdown(fenced),
    ["```html", `<${Z}at id=all><${Z}/at>`, `[a]${Z}(https://b.example)`, "let x = 1 < 2;", "```"].join("\n"),
  );
  assert.equal(cardMarkdown("写 `<div>` 就行"), `写 \`<${Z}div>\` 就行`);
});

test("no way around it through code spans, fences or line breaks", () => {
  const tick = "`";
  const fence = tick.repeat(3);
  const cases = [
    `看 ${tick}${tick}<at id=all></at>${tick}`,
    `\\${tick}<at id=all></at>${tick}`,
    [fence, "x", `${fence}js`, fence, "<at id=all></at>", fence].join("\n"),
    [`${fence}x${tick}`, "<at id=all></at>", `${fence}x${tick}`].join("\n"),
    ["~~~", "<at id=all></at>", "~~~"].join("\n"),
    `[${tick}https://good.example${tick}](https://evil.example)`,
    "[点这里\n看文档](https://evil.example)",
    `![${tick}x${tick}](https://evil.example/a.png)`,
  ];
  for (const input of cases) {
    const out = cardMarkdown(input);
    assert.ok(!/<at\b/.test(out), `mention survived: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    const links = [...out.matchAll(/\[([^\]]*)\]\((https:\/\/evil[^)]*)\)/g)];
    assert.ok(
      links.every(([, label, href]) => label === href),
      `disguised link survived: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`,
    );
  }
});

test("code spans pair runs of the same length, and a backslash escapes a backtick", () => {
  const tick = "`";
  assert.deepEqual(codeSpans(`a ${tick}${tick}b${tick} c${tick}${tick} d`), [
    { code: false, text: "a " },
    { code: true, text: `${tick}${tick}b${tick} c${tick}${tick}` },
    { code: false, text: " d" },
  ]);
  assert.deepEqual(codeSpans(`\\${tick}x${tick}`), [{ code: false, text: `\\${tick}x${tick}` }]);
  // Not across paragraphs.
  assert.deepEqual(codeSpans(`${tick}a\n\nb${tick}`), [{ code: false, text: `${tick}a\n\nb${tick}` }]);
});

test("an unclosed fence is closed so it cannot swallow the rest of the card", () => {
  assert.equal(cardMarkdown("```\nlet a = 1"), "```\nlet a = 1\n```");
});

test("big headings shrink one size", () => {
  assert.equal(cardMarkdown("# 标题\n## 小节\n#### 已经很小"), "#### 标题\n#### 小节\n#### 已经很小");
});

test("tables past the third turn into code, whatever separator they use", () => {
  for (const separator of ["| --- | --- |", "|-|-|", "--- | ---"]) {
    const table = `| a | b |\n${separator}\n| 1 | 2 |`;
    const out = cardMarkdown([table, table, table, table].join("\n\n"));
    assert.equal(out.split("```").length - 1, 2, separator);
  }
});
