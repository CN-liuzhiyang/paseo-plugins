import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { affairOf, affairTarget, openPluginScreenOf, urlHost } from "../shared/affair";

// What the view does with an affair: which words, and what pressing them does. client/affair.tsx
// draws these results and nothing else; there is no way to render a React Native component under
// node:test here, so the component is covered by the type check and by this.

const LINKED = {
  label: "事项 #123 · 等单独 merge",
  url: "https://tracker.example.com/items/123",
  link: { plugin: "tracker", screen: "item", params: { id: "123" } },
};

const CASES = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "..", "orchestration", "fixtures", "affair-cases.json"), "utf8"),
) as { unsafe: Array<{ code: number; as_text: string }>; ok: Array<{ code: number; as_text: string }> };

test("hidden characters: the runtime refuses what this removes, and the joiners stay", () => {
  for (const { code, as_text: ch } of CASES.unsafe) {
    const label = affairOf({ label: `a${ch}b` })?.label;
    assert.ok(label !== undefined && !label.includes(ch), `U+${code.toString(16)} is gone from a label`);
    assert.equal(affairOf({ label: ch }), null, `U+${code.toString(16)} alone is no label`);
    const param = affairOf({ label: "x", link: { plugin: "p", screen: "s", params: { k: `v${ch}` } } })!.link!.params.k!;
    assert.ok(!param.includes(ch), `U+${code.toString(16)} is gone from a param`);
    assert.equal(affairOf({ label: "x", url: `https://example.com/${ch}` })!.url, null, `U+${code.toString(16)} in a url`);
  }
  for (const { code, as_text: ch } of CASES.ok) {
    assert.ok(affairOf({ label: `a${ch}b` })!.label.includes(ch), `U+${code.toString(16)} is kept`);
  }
});

test("the source holds the character classes as code points, not as invisible characters", () => {
  const source = readFileSync(path.join(import.meta.dirname, "..", "shared", "affair.ts"), "utf8");
  const literal = source
    .split(String.fromCharCode(10))
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !line.trimStart().startsWith("//") && /[^\x20-\x7e]/.test(line))
    .map(({ index }) => index + 1);
  // One line holds the ellipsis that ends a cut label; nothing else may.
  assert.equal(literal.length, 1, literal.join(","));
  assert.match(source.split(String.fromCharCode(10))[literal[0]! - 1]!, /LABEL_LIMIT - 1/);
});

test("a link is opened by the host when it can, by route when it cannot, and shown as words on a phone", () => {
  const affair = affairOf(LINKED)!;
  assert.deepEqual(affairTarget(affair, { hostId: "srv-1", routes: true, hostOpensScreens: true }), { kind: "screen", link: affair.link });
  // The host's way works where there are no URLs, too.
  assert.equal(affairTarget(affair, { hostId: null, routes: false, hostOpensScreens: true }).kind, "screen");
  // Without it: a route (the page loads again) on the web and desktop app...
  assert.equal(affairTarget(affair, { hostId: "srv-1", routes: true }).kind, "route");
  // ...and on a phone the url if there is one, else nothing to press.
  assert.equal(affairTarget(affair, { hostId: "srv-1", routes: false }).kind, "url");
  assert.equal(affairTarget(affairOf({ label: "x", link: LINKED.link })!, { hostId: "srv-1", routes: false }).kind, "none");
});

test("the host's navigation: used when it has openPluginScreen, called on itself, absent otherwise", () => {
  assert.equal(openPluginScreenOf(undefined), null);
  assert.equal(openPluginScreenOf({ openAgent() {} }), null);
  assert.equal(openPluginScreenOf({ openPluginScreen: "not a function" }), null);
  const calls: unknown[] = [];
  const navigation = {
    marker: 7,
    openPluginScreen(this: { marker: number }, ...args: unknown[]) {
      calls.push([this.marker, ...args]);
    },
  };
  openPluginScreenOf(navigation)!({ pluginId: "tracker", screenId: "item", params: { id: "1" } });
  // The host takes (pluginId, screenId, params?) and throws on anything else.
  assert.deepEqual(calls, [[7, "tracker", "item", { id: "1" }]]);
});

test("a url is shown with its host, so a label cannot say where it goes", () => {
  assert.equal(urlHost("https://tracker.example.com:8443/items/1?x=2"), "tracker.example.com:8443");
  assert.equal(urlHost("not a url"), null);
});
