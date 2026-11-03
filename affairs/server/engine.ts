import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { dayStart, mayLook } from "./lib/limits.mjs";
import { secretIn } from "./lib/check.mjs";
import { ID, append, isOpen, listIds, load, read } from "./lib/log.mjs";
import { policyProblems } from "./lib/policy.mjs";
import * as ops from "./lib/ops.mjs";
import * as readers from "./lib/readers.mjs";
import { localParts } from "./lib/time.mjs";
import { cardOf, linkOf, rowsOf, say } from "./lib/view.mjs";
import * as schedule from "./lib/schedule.mjs";
import { ensureProject, titleOf } from "./lib/workspace.mjs";
import type { Sent, View } from "./conversation";
import { MODEL_ID, PROVIDER_ID } from "./conversation";

// The plugin's one loop: when an affair's log changes (or every minute, or at start) look at that affair and make the
// world agree with it -- its conversation exists, the sidebar title is right, the conversation shows what the log
// says, anything that must reach the person is pushed within the day's budget, and an affair that ended three days
// ago is archived. Nothing here decides anything about an affair; the log and the check do.

type Ctx = ReturnType<typeof ops.makeCtx>;
const DAY = 86_400_000;
const TICK_MS = 60_000;

export interface PaseoLike {
  agents: { ref(id: string): { refresh(): Promise<{ agent: { status: string } } | null>; archive(): Promise<unknown> } };
  workspaces: { ref(id: string): { setTitle(title: string | null): Promise<unknown>; archive(): Promise<unknown>; agents: { create(options: Record<string, unknown>): Promise<{ id: string }> } } };
}
export type Deliver = (channelId: string, message: { to: string; idempotencyKey: string; title: string; text: string; status: "succeeded" | "failed" }) => Promise<void>;

export interface EngineDeps {
  ctx: Ctx;
  paseo: PaseoLike | null;
  deliver: Deliver | null;
  refresh(affairId: string, force?: boolean): void;
  log(message: string): void;
  /** Something to do once in each pass of the reading loop (the runtime's sweep for runs that were lost); none for now. */
  wakeLost?(): Promise<void>;
  /** At start, say on a card what is missing from policy.json (the plugin does; the tests that have no policy do not). */
  checkSetup?: boolean;
}

/** Windows can cut the front off a recursive watcher's names ("s\D1\log.jsonl"): the id is the folder beside the log. */
export function idOfWatch(name: string | Buffer | null): string | null {
  const id = /([^\\/]+)[\\/]log\.jsonl$/.exec(String(name ?? ""))?.[1] ?? "";
  return ID.test(id) ? id : null;
}

const conversationOptions = (s: { title: string }, id: string) => ({ title: s.title, config: { provider: `${PROVIDER_ID}/${MODEL_ID}` }, env: { AFFAIR_ID: id }, prompt: `事项 ${id}`, labels: { "affairs.affair": id } });

type Candidate = { key: string; text: string; live: boolean };

export function createEngine(deps: EngineDeps) {
  const { ctx, log } = deps;
  const queues = new Map<string, Promise<void>>();
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const debounce = new Map<string, ReturnType<typeof setTimeout>>();
  /** Conversations looked at since this start: after a restart the app shows a closed one as broken until someone opens it. */
  const revived = new Set<string>();
  /** When each watched value was last read, and when each affair was last asked to look because of one. Not in the log: after a restart everything is read once. */
  const readAt = new Map<string, number>();
  const triedAt = new Map<string, number>();
  let reading = false;
  const redraws = new Set<ReturnType<typeof setTimeout>>();

  const state = (id: string) => ({ ...load(ctx.root, id), lines: read(ctx.root, id) });
  const write = (id: string, entries: Array<Record<string, unknown>>) => append(ctx.root, id, entries, { now: ctx.now(), tz: ctx.policy.tz });

  function view(id: string): View | null {
    const s = state(id);
    if (!s.id) return null;
    const now = ctx.now();
    const gate = isOpen(s) ? mayLook(ctx.root, id, now, ctx.policy) : { ok: true };
    const trouble = isOpen(s) && s.lastEnd?.state === "failed" && !s.running ? `这次没看成：${String(s.lastEnd.error ?? "没有说明").slice(0, 60)}` : "";
    return {
      card: cardOf(s, now, ctx.policy, { budget: gate.ok ? "" : (gate as { text: string }).text, trouble }),
      rows: rowsOf(s, now, ctx.policy),
      asks: s.asks.filter((a: { state: string }) => a.state === "open").map((a: { id: string; title: string; line: string; options: string[] }) => ({ id: a.id, title: a.title, line: a.line, options: a.options })),
    };
  }

  /** What should reach the person on another channel, from the log alone. */
  function candidates(s: ReturnType<typeof state>): Candidate[] {
    const link = linkOf(ops.paseoUrl(ctx, s), ctx.policy);
    const out: Candidate[] = [];
    for (const a of s.asks) {
      const choices = a.options.map((o: string, i: number) => `${i + 1} ${o}`).join("  ");
      out.push({ key: `asked:${a.seq}`, live: a.state === "open", text: `${a.title}${a.line ? `\n${a.line}` : ""}${choices ? `\n${choices}` : ""}\n（${s.id}）${link}` });
    }
    for (const l of s.lines) {
      if (l.kind === "flag" && l.what === "chain") out.push({ key: `chain:${l.seq}`, live: true, text: `${s.title}：${l.detail}\n（${s.id}）${link}` });
      if (l.kind === "status" && l.status === "done" && l.by === "look") out.push({ key: `done:${l.seq}`, live: s.status === "done", text: say.done(s.title, l.evidence) });
      if (l.kind === "next" && l.verdict === "appeal") {
        const dl = s.deadlines.find((d: { at: string }) => Date.parse(d.at) > Date.parse(l.at));
        const was = dl ? `${localParts(Date.parse(dl.at), ctx.policy.tz).date.slice(5)}` : "";
        out.push({ key: `appeal:${l.seq}`, live: true, text: `${s.id}：我把下次定在 ${localParts(Date.parse(l.next), ctx.policy.tz).date.slice(5)}${was ? `，比单子上写的 ${was} 晚` : ""}，理由在 Paseo 里。${was ? `不对就回「改回 ${was}」。` : ""}\n（${s.id}）${link}` });
      }
    }
    return out;
  }

  /** Inside the hours this kind of affair may be pushed in (work has none). */
  function quietNow(domain: string): boolean {
    const [from, to] = ctx.policy.push.quiet?.[domain] ?? [];
    if (!from || !to) return false;
    const p = localParts(ctx.now(), ctx.policy.tz);
    const at = p.h * 60 + p.mi;
    const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    return at < min(from) || at >= min(to);
  }

  function pushedToday(): number {
    const since = dayStart(ctx.now(), ctx.policy.tz, ctx.policy.limits.dayStartHour);
    let n = 0;
    for (const id of listIds(ctx.root)) for (const l of read(ctx.root, id)) if (l.kind === "push" && l.ok && Date.parse(l.at) >= since) n += 1;
    return n;
  }

  async function pushes(id: string) {
    const s = state(id);
    const sent = new Set(s.lines.filter((l: { kind: string }) => l.kind === "push").map((l: { for: string }) => l.for));
    for (const c of candidates(s)) {
      if (sent.has(c.key) || !c.live) continue;
      if (!deps.deliver || !ctx.policy.push.to) return;
      if (quietNow(s.domain) || pushedToday() >= ctx.policy.push.perDay) return;
      try {
        await deps.deliver("popo", { to: ctx.policy.push.to, idempotencyKey: `${id}:${c.key}`, title: s.title, text: c.text, status: "succeeded" });
        write(id, [{ kind: "push", for: c.key, ok: true }]);
      } catch (error) {
        // Once, not on every scan: a channel that is down must not turn into a stream of retries.
        write(id, [{ kind: "push", for: c.key, ok: false, error: (error as Error).message.slice(0, 120) }]);
        log(`push ${id} ${c.key} failed: ${(error as Error).message}`);
      }
    }
  }

  async function scanNow(id: string) {
    let s = state(id);
    if (!s.id) return;
    // Lines that do not follow from the one before were put in around the commands: said once, in red, and told to the person.
    if (s.chainBroken && !s.flags.some((f: { what: string }) => f.what === "chain")) {
      write(id, [{ kind: "flag", what: "chain", detail: `这件事的记录有被手动改过的痕迹（第 ${s.chainBroken} 条起对不上），看不出是谁改的，请核对一下。` }]);
      log(`${id}: the log does not follow from line ${s.chainBroken}`);
      s = state(id);
    }
    let made = false;
    const ws = s.workspaceId && deps.paseo ? deps.paseo.workspaces.ref(s.workspaceId) : null;
    if (ws && !s.conversationId) {
      const agent = await ws.agents.create(conversationOptions(s, id));
      write(id, [{ kind: "conversation", agentId: agent.id }]);
      s = state(id);
      made = true;
    }
    if (ws) {
      const want = titleOf(s, ctx.now(), ctx.policy);
      // While a look is on, the plan in the log is only the fallback that guards against a look that never reports: the title waits for what the look decides.
      if (want !== s.titleShown && !(isOpen(s) && s.running && ctx.now() - Date.parse(s.runningSince) < 45 * 60_000)) {
        await ws.setTitle(want);
        write(id, [{ kind: "workspace", title: want }]);
      }
      if (!isOpen(s) && s.statusAt && ctx.now() - Date.parse(s.statusAt) > ctx.policy.archiveAfterDays * DAY) {
        await ws.archive();
        write(id, [{ kind: "workspace", archived: true }]);
        // Archiving ends the plan that runs in the workspace; what is left of it is only clutter.
        if (s.scheduleId) await schedule.remove(ctx.run, s.scheduleId).catch((error: unknown) => log(`${id}: removing the plan failed: ${(error as Error).message}`));
      }
    }
    if (s.conversationId && deps.paseo && ws && !revived.has(id)) {
      revived.add(id);
      const old = deps.paseo.agents.ref(s.conversationId);
      const status = (await old.refresh())?.agent.status;
      if (status === "closed" || status === "error") {
        // Waking the old one would show a line the person never wrote ("事项 D3") under the host's "connection closed" error; a new conversation starts clean and the old one is put away.
        const fresh = await ws.agents.create(conversationOptions(s, id));
        write(id, [{ kind: "conversation", agentId: fresh.id }]);
        made = true;
        await old.archive().catch((error: unknown) => log(`${id}: putting the old conversation away failed: ${(error as Error).message}`));
        s = state(id);
      }
    }
    deps.refresh(id, made);
    // What a conversation is shown while it is being made may not reach the app: once more a moment later.
    if (made) {
      const timer = setTimeout(() => {
        redraws.delete(timer);
        if (!stopped) deps.refresh(id, true);
      }, 3000);
      timer.unref?.();
      redraws.add(timer);
    }
    await pushes(id);
  }

  /** One watched value: read it; a different value is written down (and looks at the affair); a read that fails is written down a few times, and asks the person once. */
  async function readWatch(id: string, w: { id: string; tool: string; args: Record<string, unknown>; hash: string | null; failures?: number; downAsked?: boolean; lastError?: string; label?: string }) {
    let got: Awaited<ReturnType<typeof readers.readOnce>> = await readers.readOnce(ctx.policy, w.tool, w.args);
    // Nothing that looks like a secret is written into an affair's folder, whatever a tool printed.
    if (got.ok && secretIn(`${JSON.stringify(got.value)} ${got.summary}`)) got = { ok: false, reason: "读到的东西像密码或令牌，没有记" };
    const limit = ctx.policy.readers.failuresBeforeAsk;
    if (!got.ok) {
      const failures = (w.failures ?? 0) + 1;
      if (failures > limit) return;
      write(id, [{ kind: "watch.read", id: w.id, ok: false, reason: got.reason }]);
      if (failures >= limit && !w.downAsked) {
        const s = state(id);
        write(id, [{ kind: "asked", id: `${id}-${s.asks.length + 1}`, for: `down:${w.id}`, title: `${s.title}：${w.label || w.tool}读不到`, line: `${got.reason}。处理好了点一下，我马上看。`, options: ["好了", "不用盯了"] }]);
      }
      return;
    }
    const hash = readers.hashOf(got.value);
    const entry = { kind: "watch.read", id: w.id, ok: true, value: got.value, summary: got.summary, hash };
    if (w.hash == null) write(id, [{ ...entry, changed: false, baseline: true }]);
    else if (hash !== w.hash) write(id, [{ ...entry, changed: true }]);
    else if (w.failures || w.downAsked || w.lastError) write(id, [{ ...entry, changed: false }]);
  }

  /** What came of a change, if a look could not be made at once: tried again, but not more than once in a while. */
  async function lookAtChanges(id: string) {
    const s = state(id);
    if (!isOpen(s) || s.running || !s.pending.some((p: string) => p.startsWith("watch"))) return;
    const gap = ctx.policy.readers.minLookGapMinutes * 60_000;
    const now = ctx.now();
    const last = s.wakes[s.wakes.length - 1];
    if ((last && now - Date.parse(last.at) < gap) || now - (triedAt.get(id) ?? 0) < gap) return;
    triedAt.set(id, now);
    await ops.requestLook(ctx, id, "watch");
  }

  /** One pass over everything watched: the ones whose time has come are read, a few at a time. */
  async function readPass() {
    if (reading || stopped) return;
    reading = true;
    try {
      let left = ctx.policy.readers.perPass;
      for (const id of listIds(ctx.root)) {
        if (!isOpen(state(id))) continue;
        for (const w of Object.values(state(id).watches) as Array<any>) {
          const now = ctx.now();
          if (w.until && now >= Date.parse(w.until)) {
            write(id, [{ kind: "watch.read", id: w.id, expired: true }]);
            continue;
          }
          const key = `${id}/${w.id}`;
          if (left <= 0 || now - (readAt.get(key) ?? 0) < (w.every ?? ctx.policy.readers.everyMinutes) * 60_000) continue;
          left -= 1;
          readAt.set(key, now);
          await readWatch(id, w).catch((error: unknown) => log(`${key}: ${(error as Error).message}`));
        }
        await lookAtChanges(id).catch((error: unknown) => log(`${id}: ${(error as Error).message}`));
      }
      await deps.wakeLost?.().catch((error: unknown) => log(`sweeping lost runs failed: ${(error as Error).message}`));
    } finally {
      reading = false;
    }
  }

  function scan(id: string): Promise<void> {
    const run = (queues.get(id) ?? Promise.resolve()).then(() => (stopped ? undefined : scanNow(id))).catch((error: unknown) => log(`${id}: ${(error as Error).message}`));
    queues.set(id, run);
    return run;
  }

  const scanAll = () => Promise.all(listIds(ctx.root).map(scan)).then(() => undefined);

  /** A run finished (the plan delivers to this plugin): note how it ended, and look again if things came in meanwhile. */
  async function runEnded(delivery: { to: string; status: string; text: string; agentId: string | null }) {
    const id = delivery.to;
    if (!ID.test(id) || !existsSync(path.join(ctx.root, id))) return;
    const ok = delivery.status === "succeeded";
    write(id, [{ kind: "wake.end", state: ok ? "ok" : "failed", usd: null, agentId: delivery.agentId, ...(ok ? {} : { error: delivery.text.slice(0, 200) }) }]);
    let s = state(id);
    const tail = s.wakes.slice(-3);
    if (isOpen(s) && tail.length === 3 && tail.every((w: { reported: boolean }) => !w.reported) && !s.asks.some((a: { state: string; title: string }) => a.state === "open" && a.title.endsWith("没看成"))) {
      write(id, [{ kind: "asked", id: `${id}-${s.asks.length + 1}`, title: `${s.title}没看成`, line: "连着 3 次没看成。处理好了点一下，我马上看。", options: ["好了", "不用盯了"] }]);
    }
    await ops.syncPlan(ctx, id);
    s = state(id);
    if (isOpen(s) && s.pending.length > 0) await ops.requestLook(ctx, id, "pending");
    await scan(id);
  }

  /** At start: the plan is made to agree with every log, and a look that came due while nothing was running is made once. */
  async function catchUp() {
    const now = ctx.now();
    for (const id of listIds(ctx.root)) {
      const s = state(id);
      if (!isOpen(s) || s.system) continue;
      // Made halfway (the process stopped in the middle of `new`): nobody is waiting for it any more.
      if (!s.scheduleId && now - Date.parse(s.createdAt) > 10 * 60_000) {
        write(id, [{ kind: "status", status: "stopped", evidence: "没建成", by: "system" }]);
        continue;
      }
      await ops.syncPlan(ctx, id);
      const due = s.next ? Date.parse(s.next.at) : NaN;
      const lastWake = s.wakes.length ? Date.parse(s.wakes[s.wakes.length - 1].at) : 0;
      const looking = s.running && now - Date.parse(s.runningSince) < 45 * 60_000;
      if (Number.isFinite(due) && due < now - 10_000 && lastWake < due && !looking) await ops.requestLook(ctx, id, "catchup");
    }
  }

  async function start() {
    try {
      if (deps.paseo) await ensureProject(ctx.run, ctx.root);
    } catch (error) {
      log(`the 事项 project could not be made: ${(error as Error).message}`);
    }
    if (deps.checkSetup) {
      const problems = policyProblems(ctx.policy);
      for (const p of problems) log(`policy.json: ${p.key}: ${p.text}`);
      // On a card, not only in the log: whoever opens the 事项 project sees what is missing.
      await ops.setupCard(ctx, problems).catch((error: unknown) => log(`could not say what is missing from policy.json: ${(error as Error).message}`));
    }
    await catchUp().catch((error: unknown) => log(`catch-up failed: ${(error as Error).message}`));
    await scanAll();
    try {
      watcher = watch(ctx.root, { recursive: true }, (_event, name) => {
        const id = idOfWatch(name);
        if (!id || debounce.has(id)) return;
        debounce.set(id, setTimeout(() => {
          debounce.delete(id);
          void scan(id);
        }, 150));
      });
      watcher.on("error", (error) => log(`watching ${ctx.root} failed: ${error.message}`));
    } catch (error) {
      log(`cannot watch ${ctx.root}, falling back to the minute: ${(error as Error).message}`);
    }
    void readPass();
    timer = setInterval(() => {
      void scanAll();
      void readPass();
    }, TICK_MS);
    timer.unref?.();
  }

  async function stop() {
    stopped = true;
    watcher?.close();
    if (timer) clearInterval(timer);
    for (const t of debounce.values()) clearTimeout(t);
    for (const t of redraws) clearTimeout(t);
    await Promise.all(queues.values());
  }

  return {
    start, stop, scan, scanAll, view, runEnded, readPass,
    said: async (id: string, text: string, sent: Sent[] = []) => {
      const r = await ops.note(ctx, id, { said: text, via: "workspace", attachments: sent });
      // Refused (a secret, an over-size file, an affair that is over): the person is told why, in place of "收到".
      return r.ok ? { recorded: true, notice: r.refused as string | undefined } : { recorded: false, notice: r.text };
    },
    answered: async (id: string, qid: string, text: string) => void (await ops.answer(ctx, id, qid, text, "workspace")),
  };
}
