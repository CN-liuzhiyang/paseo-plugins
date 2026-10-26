import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyConfig, preview, previewText } from "../server/preview";
import { makeWorld, type World } from "./helpers";
import { asks, POLICY, req, RULE } from "./flows-kit";
import { set } from "./item-flow";

// The preview of a rule that asks for runs: which would be started and when, counted in the breaker like the rest, and nothing
// started, written or recorded in the controller's own data by looking.

/** The kit's rule that asks for nothing: what is in use before the change. */
const QUIET = RULE.replace("if (f.Runs) out.run = JSON.parse(f.Runs);", "");

async function withPreview(body: (w: World, candidate: string) => Promise<void>, options: { inUse?: string; policy?: unknown; flows?: boolean } = {}) {
  const w = await makeWorld({ start: "2026-10-13 09:50", flows: options.flows ?? false, config: { rules: { "flow.mjs": options.inUse ?? QUIET }, ...(options.policy ? { policy: options.policy } : {}) } });
  const candidate = mkdtempSync(path.join(os.tmpdir(), "reconcile-candidate-"));
  try {
    for (let n = 1; n <= 4; n++) asks(w, n, [req("k1")], { Watch: "triage:k1" });
    await w.run("2026-10-13 10:00", 5);
    rmSync(candidate, { recursive: true });
    copyConfig(w.configDir, candidate);
    await body(w, candidate);
  } finally {
    w.close();
    rmSync(candidate, { recursive: true, force: true });
  }
}

const look = (w: World, candidate: string) => preview({ configDir: w.configDir, candidateDir: candidate, dataDir: w.dataDir, nowMs: w.clock.now });
/** Every file under the data directory, with its size. */
const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${path.relative(dir, path.join(e.parentPath, e.name))} ${readFileSync(path.join(e.parentPath, e.name)).length}`).sort();

test("a rule that would start runs lists them apart, counts them in the breaker, and starts, writes and records nothing", () =>
  withPreview(
    async (w, candidate) => {
      writeFileSync(path.join(candidate, "rules", "flow.mjs"), RULE);
      const before = tree(w.dataDir).filter((f) => !f.startsWith("LOCK") && !f.startsWith("snapshot"));
      const p = await look(w, candidate);
      assert.equal(p.empty, false);
      assert.deepEqual(p.flows.map((f) => [f.caseId, f.request, f.flow, f.maxUsd, f.from, f.inUse, f.candidate]), [1, 2, 3, 4].map((n) => [`gcp-demo:${n}`, "初查", "triage-flow", 1, "现在", false, true]));
      assert.deepEqual(p.breaker, { changes: { newCommitments: 0, dropped: 0, changed: 0, reopened: 0, flows: 4 }, limit: 3 }, "four at once is over the limit of three");
      const text = previewText(p);
      assert.match(text, /⚠ 这个改动一下子会起 4 个流程（要花钱），超过了上限 3/);
      assert.match(text, /## 会起的流程（起了要花钱，也计进熔断）\n- #1 示例单 1「初查」（triage-flow，按 \$1 算）：候选会起，现在/);
      assert.match(text, /推演里流程只记下「要起」，不真起/);
      assert.match(text, /没有起流程的命令（flows.json）/, "this instance has none, so the copy would not start them");
      // nothing was started or written
      assert.equal(w.flows.launcher.started.length, 0);
      assert.deepEqual(tree(w.dataDir).filter((f) => !f.startsWith("LOCK") && !f.startsWith("snapshot")), before);
      assert.equal(existsSync(path.join(w.dir, "flows")), false);
      assert.deepEqual(Object.keys(w.store.state.flows ?? {}), []);
    },
    { policy: POLICY({}) },
  ));

test("the day's limits hold a preview back like the real thing: only the runs that would start are listed", () =>
  withPreview(async (w, candidate) => {
    writeFileSync(path.join(candidate, "rules", "flow.mjs"), RULE);
    const p = await look(w, candidate);
    assert.equal(p.flows.length, 2, "two at once is the default");
    assert.deepEqual(p.breaker, null, "two is under the breaker's three");
  }));

test("a run both sides would start is no difference, and one already started is not asked again", async () => {
  await withPreview(async (w, candidate) => {
    const p = await look(w, candidate);
    assert.deepEqual(p.flows, []);
    assert.equal(p.empty, true);
    assert.equal(previewText(p).includes("会起的流程"), false);
  }, { inUse: RULE });
  // the in-use rules have started some: the candidate asking for the same keys changes nothing
  await withPreview(
    async (w, candidate) => {
      assert.equal(w.flows.launcher.started.length, 4);
      writeFileSync(path.join(candidate, "rules", "flow.mjs"), `// a note\n${RULE}`);
      const p = await look(w, candidate);
      assert.deepEqual(p.flows, []);
      assert.equal(p.empty, true);
    },
    { inUse: RULE, flows: true, policy: POLICY({}) },
  );
});

test("a candidate that stops asking, and one that moves a key, show on the list from both sides", () =>
  withPreview(
    async (w, candidate) => {
      writeFileSync(path.join(candidate, "rules", "flow.mjs"), QUIET);
      const gone = await look(w, candidate);
      assert.deepEqual(gone.flows.map((f) => [f.caseId, f.inUse, f.candidate]), [1, 2, 3, 4].map((n) => [`gcp-demo:${n}`, true, false]));
      assert.match(previewText(gone), /在用会起、候选不起/);
      assert.equal(gone.breaker, null, "a run not started is not a change to the breaker's count");
      writeFileSync(path.join(candidate, "rules", "flow.mjs"), RULE.replace("if (f.Runs) out.run = JSON.parse(f.Runs);", 'if (f.Runs) out.run = JSON.parse(f.Runs).map((r) => ({ ...r, key: r.key + "x" }));'));
      const moved = await look(w, candidate);
      assert.equal(moved.flows.length, 8, "each item: the key in use, and the key of the candidate");
      assert.equal(moved.flows.filter((f) => f.inUse).length, 4);
      assert.equal(moved.flows.filter((f) => f.candidate).length, 4);
    },
    { inUse: RULE, policy: POLICY({}) },
  ));

test("the id of a preview follows the runs it lists", () =>
  withPreview(
    async (w, candidate) => {
      writeFileSync(path.join(candidate, "rules", "flow.mjs"), RULE);
      const a = await look(w, candidate);
      assert.equal((await look(w, candidate)).id, a.id, "the same preview run again");
      set(w, 2, { Runs: JSON.stringify([req("k9")]) });
      await w.run("2026-10-13 10:40", 5);
      const b = await look(w, candidate);
      assert.notEqual(b.id, a.id);
      assert.ok(b.flows.some((f) => f.caseId === "gcp-demo:2" && f.candidate));
    },
    { policy: POLICY({}) },
  ));
