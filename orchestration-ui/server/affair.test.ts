import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { affairOf, affairTarget, LABEL_LIMIT, pluginScreenRoute } from "../shared/affair";
import { foldEvents } from "../shared/run";
import { createRunIndex } from "./runs";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const scratch = mkdtemp(path.join(os.tmpdir(), "orchestration-ui-affair-"));
after(async () => rm(await scratch, { recursive: true, force: true }));

const LINKED = {
  label: "事项 #123 · 等单独 merge",
  url: "https://tracker.example.com/items/123",
  link: { plugin: "tracker", screen: "item", params: { id: "123", note: "a b&c" } },
};
const WEB = { hostId: "srv-1", routes: true };

// What the view shows is `affairOf` (what is read) and `affairTarget` (what pressing it does):
// client/affair.tsx draws those two and nothing else.

test("a link: the words, and the route of the other plugin's screen", () => {
  const affair = affairOf(LINKED)!;
  assert.equal(affair.label, "事项 #123 · 等单独 merge");
  assert.deepEqual(affairTarget(affair, WEB), {
    kind: "route",
    route: "/h/srv-1/plugin/tracker/surface/item?param.id=123&param.note=a%20b%26c",
  });
  // The shape of the Paseo app's own route builder (packages/app/src/plugins/routes.ts).
  assert.equal(pluginScreenRoute("a b", { plugin: "p", screen: "s", params: {} }), "/h/a%20b/plugin/p/surface/s");
});

test("a link wins over a url; without routes or a host the url takes its place", () => {
  const affair = affairOf(LINKED)!;
  assert.equal(affairTarget(affair, WEB).kind, "route");
  assert.deepEqual(affairTarget(affair, { hostId: "srv-1", routes: false }), { kind: "url", url: LINKED.url });
  assert.deepEqual(affairTarget(affair, { hostId: null, routes: true }), { kind: "url", url: LINKED.url });
  const linkOnly = affairOf({ label: "x", link: LINKED.link })!;
  assert.deepEqual(affairTarget(linkOnly, { hostId: null, routes: true }), { kind: "none" });
});

test("only a url: an outside link", () => {
  const affair = affairOf({ label: "Release 2.4", url: "https://example.com/r/24" })!;
  assert.equal(affair.link, null);
  assert.deepEqual(affairTarget(affair, WEB), { kind: "url", url: "https://example.com/r/24" });
});

test("neither: only the words", () => {
  const affair = affairOf({ label: "just words" })!;
  assert.deepEqual(affair, { label: "just words", url: null, link: null });
  assert.deepEqual(affairTarget(affair, WEB), { kind: "none" });
});

test("no affair, or one without a usable label, is no affair", () => {
  for (const raw of [undefined, null, "text", 7, [], {}, { label: "" }, { label: "   " }, { label: 5 }, { label: "\u0007‮" }]) {
    assert.equal(affairOf(raw), null, JSON.stringify(raw));
  }
});

test("a file is not trusted: the label is cleaned and cut, what is not a plain link is dropped", () => {
  const label = affairOf({ label: "fdp.‮txt\nsecond\u0000 line" })!.label;
  assert.equal(label, "fdp. txt second line");
  const long = affairOf({ label: "あ".repeat(LABEL_LIMIT + 50) })!.label;
  assert.equal([...long].length, LABEL_LIMIT);
  assert.ok(long.endsWith("…"));

  for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "/relative", "https://u:p@example.com/", "https://example.com/a b", `https://example.com/${"a".repeat(2100)}`, 5, null]) {
    assert.equal(affairOf({ label: "x", url })!.url, null, String(url));
  }
  for (const link of [
    { plugin: "a/b", screen: "s" },
    { plugin: "p", screen: "s?x=1" },
    { plugin: "../p", screen: "s" },
    { plugin: "p" },
    "p/s",
    [],
  ]) {
    assert.equal(affairOf({ label: "x", link })!.link, null, JSON.stringify(link));
  }
  // Bad params are dropped one by one; the link stays.
  const link = affairOf({
    label: "x",
    link: { plugin: "p", screen: "s", params: { ok: "1", "a=b": "2", num: 3, long: "v".repeat(300), "": "z" } },
  })!.link!;
  assert.deepEqual(link.params, { ok: "1" });
  // So nothing in a route can add a segment or a query of its own.
  assert.equal(affairTarget(affairOf({ label: "x", link: { plugin: "p", screen: "s", params: { k: "v&param.x=1#/../" } } })!, WEB).kind, "route");
  const route = (affairTarget(affairOf({ label: "x", link: { plugin: "p", screen: "s", params: { k: "v&param.x=1#/../" } } })!, WEB) as { route: string }).route;
  assert.equal(route, "/h/srv-1/plugin/p/surface/s?param.k=v%26param.x%3D1%23%2F..%2F");
});

test("folding run.start: files without an affair read as none, with one as given", () => {
  const events = readFileSync(path.join(FIXTURES, "committee-done.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(foldEvents(events).start?.affair, null, "a file written before affair existed");
  const withAffair = [{ ...events[0], affair: LINKED }, ...events.slice(1)];
  assert.deepEqual(foldEvents(withAffair).start?.affair, { label: LINKED.label, url: LINKED.url, link: { plugin: "tracker", screen: "item", params: LINKED.link.params } });
  const hostile = [{ ...events[0], affair: { label: "x", url: "javascript:1", link: { plugin: "a/b", screen: "s" } } }, ...events.slice(1)];
  assert.deepEqual(foldEvents(hostile).start?.affair, { label: "x", url: null, link: null });
  assert.equal(foldEvents(hostile).problems.length, foldEvents(events).problems.length, "a bad affair is not a problem with the run");
});

test("the list carries the label, and only the label", async () => {
  const dir = await scratch;
  const text = readFileSync(path.join(FIXTURES, "committee-done.jsonl"), "utf8");
  const lines = text.split("\n").filter(Boolean);
  const start = JSON.parse(lines[0]!);
  await writeFile(path.join(dir, "with.jsonl"), [JSON.stringify({ ...start, runId: "with", affair: LINKED }), ...lines.slice(1).map((l) => JSON.stringify({ ...JSON.parse(l), runId: "with" }))].join("\n") + "\n");
  await writeFile(path.join(dir, "without.jsonl"), [JSON.stringify({ ...start, runId: "without" }), ...lines.slice(1).map((l) => JSON.stringify({ ...JSON.parse(l), runId: "without" }))].join("\n") + "\n");
  await writeFile(path.join(dir, "junk.jsonl"), "not json\n");
  // The runtime's claim files sit next to the event files and are not runs.
  await writeFile(path.join(dir, "with.claim"), JSON.stringify({ pid: 1, hostname: "h", startedAt: "2026-10-23T00:00:00Z" }));
  assert.ok((await readdir(dir)).includes("with.claim"));

  const listed = await createRunIndex().list(dir, 100, 15 * 60_000);
  assert.equal(listed.state, "ok");
  assert.equal(listed.total, 3, "the claim file is not a run");
  const byId = Object.fromEntries(listed.runs.map((run) => [run.runId, run]));
  assert.equal(byId.with!.affairLabel, LINKED.label);
  assert.equal(byId.without!.affairLabel, null);
  assert.equal(byId.junk!.affairLabel, null);
  assert.ok(!JSON.stringify(byId.with).includes(LINKED.url), "the address stays in the file; the list needs the words");
});
