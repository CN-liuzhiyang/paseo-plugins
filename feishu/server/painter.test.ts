import assert from "node:assert/strict";
import { test } from "node:test";
import { createPainter } from "./painter";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function rig(options: { intervalMs?: number; fail?: (card: object, attempt: number) => Error | null } = {}) {
  const sent: string[] = [];
  const logs: string[] = [];
  let clock = 0;
  let attempts = 0;
  let release: (() => void) | null = null;
  let hold = false;
  const painter = createPainter({
    cardId: "om_card",
    intervalMs: options.intervalMs ?? 0,
    now: () => clock,
    log: (line) => logs.push(line),
    patch: async (_cardId, card) => {
      attempts += 1;
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      const error = options.fail?.(card, attempts);
      if (error) throw error;
      sent.push((card as { state: string }).state);
    },
  });
  return {
    painter,
    sent,
    logs,
    advance: (ms: number) => (clock += ms),
    holdPatches: () => (hold = true),
    releasePatch: () => {
      hold = false;
      release?.();
    },
  };
}

test("draws that arrive while a patch is out collapse into the latest one", async () => {
  const r = rig();
  r.holdPatches();
  r.painter.draw(() => ({ state: "a" }));
  r.painter.draw(() => ({ state: "b" }));
  r.painter.draw(() => ({ state: "c" }));
  r.releasePatch();
  await tick();
  await tick();
  assert.deepEqual(r.sent, ["a", "c"]);
});

test("the card is rendered when its patch goes out, not when it was asked for", async () => {
  const r = rig({ intervalMs: 1_000 });
  let value = "early";
  r.painter.draw(() => ({ state: value }));
  await tick();
  r.painter.draw(() => ({ state: value }));
  value = "late";
  r.advance(1_000);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.deepEqual(r.sent, ["early", "late"]);
});

test("the last state wins over any draw still waiting, and nothing is drawn after it", async () => {
  const r = rig({ intervalMs: 60_000 });
  r.painter.draw(() => ({ state: "running" }));
  await tick();
  r.painter.draw(() => ({ state: "running again" }));
  r.painter.finish({ state: "done" });
  r.painter.draw(() => ({ state: "too late" }));
  await tick();
  assert.deepEqual(r.sent, ["running", "done"]);
});

test("a rate-limited final state is retried; a rate-limited frame is dropped", async () => {
  const limited = new Error("lark-cli api PATCH exited 1: 230020 message is updating too frequently");
  const r = rig({ fail: (card, attempt) => ((card as { state: string }).state === "done" && attempt < 3 ? limited : null) });
  r.painter.finish({ state: "done" });
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  assert.deepEqual(r.sent, ["done"]);

  const frames = rig({ fail: () => limited });
  frames.painter.draw(() => ({ state: "running" }));
  await tick();
  assert.deepEqual(frames.sent, []);
  assert.match(frames.logs.join("\n"), /230020/);
});

test("a last state Feishu refuses is replaced by the fallback, so the card does not stay running", async () => {
  const r = rig({ fail: (card) => ((card as { state: string }).state === "done" ? new Error("230099 card too large") : null) });
  r.painter.finish({ state: "done" }, { state: "fallback" });
  await tick();
  await tick();
  assert.deepEqual(r.sent, ["fallback"]);
});

test("a card whose last patch failed says it is behind until a newer one lands", async () => {
  let failing = true;
  const r = rig({ fail: () => (failing ? new Error("timed out") : null) });
  r.painter.draw(() => ({ state: "waiting" }));
  await tick();
  assert.equal(r.painter.behind(), true);
  failing = false;
  r.painter.draw(() => ({ state: "waiting" }));
  await tick();
  assert.equal(r.painter.behind(), false);
  assert.deepEqual(r.sent, ["waiting"]);
});
