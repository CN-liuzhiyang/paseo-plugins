import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config";
import { createEngine, type CardAnswer, type CardContent, type Carrier, type Engine } from "../server/engine";
import type { RunView } from "../shared/graph";
import type { Card, FlowRec, Item } from "../shared/model";
import { recordingLauncher, type Launcher, type LaunchSpec } from "../server/flows";
import type { RunProbe } from "../server/runs";
import type { PollInput, Source } from "../server/sources/source";
import type { Conversation, Receipt } from "../server/requests";
import { openStore, type Store } from "../server/store";
import { exec } from "../server/exec";
import { createCommandSource } from "../server/sources/command";

// A world for the engine: a private config written to a temp dir, a source that serves
// whatever the test puts in `items`, a carrier that records cards instead of starting agents,
// and a clock the test moves. All names and ids are made up.

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_RULE = path.join(here, "..", "examples", "release-followup.mjs");

export const TZ = "Asia/Shanghai";

export function at(local: string): number {
  return Date.parse(`${local}:00+08:00`);
}

/** The example rule with some params replaced, as a rule file's text. */
export function exampleRule(params: Record<string, unknown> = {}, source = "gcp-demo"): string {
  const text = readFileSync(EXAMPLE_RULE, "utf8").replace('source: "gcp-demo"', `source: "${source}"`);
  return text
    .replace(/\n {2}params: \{\r?\n/, "\n  params: Object.assign({\n")
    .replace(/\n {2}\},\r?\n {2}stages:/, `\n  }, ${JSON.stringify(params)}),\n  stages:`);
}

/** The defaults the engine tests use: ask on the release day itself. */
// Most engine tests exercise asking (cards, nagging, quiet hours): they keep the question mode.
export const TEST_RULE_PARAMS = { graceWorkdays: 0, readyStatuses: ["merged"], releaseCheck: "ask", aliasProperties: ["checker"] };

export const TEST_POLICY = {
  tz: TZ,
  ruleBreakerChanges: 3,
  sourceDownHours: 6,
  hot: { recentDays: 14, dateWindowDays: 14, dateFields: ["Release"] },
  coldTitles: ["【总单】", "长期维护"],
};

export function writeConfig(dir: string, overrides: { persons?: unknown; policy?: unknown; rules?: Record<string, string>; watch?: number[]; extraSources?: unknown[]; sourceLabels?: Record<string, string> } = {}) {
  mkdirSync(path.join(dir, "rules"), { recursive: true });
  mkdirSync(path.join(dir, "calendar"), { recursive: true });
  writeFileSync(
    path.join(dir, "persons.json"),
    JSON.stringify(
      overrides.persons ?? {
        owner: { name: "测试用户", admin: true, tz: TZ, quiet: { work: "workdays 09:30-20:00" }, pushPerDay: 8 },
      },
    ),
  );
  writeFileSync(
    path.join(dir, "sources.json"),
    JSON.stringify([
      {
        id: "gcp-demo",
        ...(overrides.sourceLabels?.["gcp-demo"] ? { label: overrides.sourceLabels["gcp-demo"] } : {}),
        kind: "gcp",
        command: ["node", "cli.js"],
        gateway: { path: "/api/tracker/call", tool: "tool_call", target: "tracker" },
        gcpHost: "tracker.example",
        projectId: 1,
        lookbackDays: 14,
        watch: overrides.watch ?? [],
        activeHours: "workdays 09:00-21:00",
        everyMinutes: 20,
        offHoursEveryMinutes: 120,
        maxCallsPerHour: 60,
        timeoutSeconds: 60,
        domain: "work",
      },
      {
        id: "flags-demo",
        ...(overrides.sourceLabels?.["flags-demo"] ? { label: overrides.sourceLabels["flags-demo"] } : {}),
        kind: "flags",
        files: [{ id: "outer", url: "https://flags.example/outer.json", labels: { env: "outer" } }],
        sections: ["switches"],
        activeHours: "daily 00:00-23:59",
        everyMinutes: 15,
        offHoursEveryMinutes: 15,
        maxCallsPerHour: 60,
        timeoutSeconds: 10,
        domain: "work",
      },
      ...(overrides.extraSources ?? []),
    ]),
  );
  writeFileSync(path.join(dir, "policy.json"), JSON.stringify(overrides.policy ?? TEST_POLICY));
  writeFileSync(
    path.join(dir, "calendar", "2026.json"),
    JSON.stringify({ holidays: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"], workdays: ["2026-10-10"] }),
  );
  if (overrides.rules) {
    for (const [file, text] of Object.entries(overrides.rules)) writeFileSync(path.join(dir, "rules", file), text);
  } else {
    writeFileSync(path.join(dir, "rules", "release-followup.mjs"), exampleRule(TEST_RULE_PARAMS));
  }
}

export function issue(id: number, patch: Partial<Item> & { release?: string } = {}): Item {
  const { release, ...rest } = patch;
  return {
    key: `gcp-demo:${id}`,
    source: "gcp-demo",
    kind: "issue",
    title: `示例单 ${id}`,
    url: `https://tracker.example/issues/${id}`,
    status: "开发中",
    closed: false,
    fields: { Release: release ?? "" },
    people: {},
    parent: null,
    sourceUpdatedAt: "2026-10-12T10:00:00+08:00",
    observedAt: "2026-10-12T10:00:00+08:00",
    text: `示例单 ${id}`,
    revisions: [],
    ...rest,
  };
}

/** What a test world gives the engine to start flows with: a launcher that only records, and a probe the test sets by run id. */
export interface FlowsKit {
  launcher: ReturnType<typeof recordingLauncher>;
  dir: string;
  /** How the runtime's files stand for a run, by id (or by "<id>@<log directory>" for one read from that directory only); a run not set here is "absent" (nothing of it on disk). */
  probes: Map<string, Partial<RunProbe>>;
  /** Runs the probe was asked about, in order. */
  asked: string[];
  /** The log directory new runs go to (the engine's `flows.logDir`), and the ones the probe was asked to read from, in order. */
  logDir: string | null;
  askedDirs: Array<string | null>;
  /** The launcher fails this many starts, with this error. */
  failStarts: { count: number; error: Error };
  /** Called as the launcher is asked to start a run, before it answers (what the journal holds at that moment is the test's to look at). */
  onStart: ((spec: LaunchSpec) => void) | null;
}

export const probeOf = (patch: Partial<RunProbe> = {}): RunProbe => ({ state: "absent", safeToRestart: false, refused: null, view: null, end: null, costUsd: 0, costKnown: true, unread: 0, reachable: true, gate: false, slow: false, ...patch });

export interface World {
  dir: string;
  configDir: string;
  dataDir: string;
  items: Map<string, Item>;
  /** The outer flag file's switches: key -> value (a number or an object, as published). */
  flags: Map<string, unknown>;
  /** An inner (test) flag file's switches; the file is only published while it has any. */
  innerFlags: Map<string, unknown>;
  /** Outward version files by name, published as items "flags-demo:ver-<name>" of kind "version". */
  versions: Map<string, Record<string, string>>;
  lastPoll: PollInput | null;
  clock: { now: number };
  cards: Array<{ card: Card; content: CardContent; attempt: number; agentId: string }>;
  archived: string[];
  /** Times the engine made sure of the cards' workspace. */
  ensured: number;
  /** Runs inside the carrier, while a card is being raised (the engine is waiting for it): a person answering at that moment. */
  hooks: { raise: ((card: Card) => void | Promise<void>) | null };
  /** files: switch files (by name) that fail to read while the others do. */
  fail: { source: Error | null; carrier: Error | null; files: Set<string>; deliver: Error | null };
  /** What server.deliver was handed, failed tries included. */
  deliveries: Array<{ channel: string; to: string; idempotencyKey: string; title: string; text: string; status: string; ok: boolean }>;
  polls: number;
  /** While set, the tracker source's poll waits for it: a reconcile that runs long. */
  hold: Promise<void> | null;
  store: Store;
  engine: Engine;
  /** The flows kit (option `flows`): what the launcher was asked to start, and the runtime's files as the test says they stand. */
  flows: FlowsKit;
  logs: string[];
  statuses: unknown[];
  /** Conversations by agent id, as the host would show them to the engine. */
  conversations: Map<string, Conversation>;
  /** Leaves a request where bin/reconcile-say.mjs would, and returns its id. */
  say(request: Record<string, unknown>): string;
  /** The receipt of a request, once the engine has written it. */
  receipt(id: string): Receipt | null;
  /** Answers the newest card the way the app does. */
  answer(answers: Record<string, string>): string;
  respond(answer: CardAnswer): string;
  /** Moves the clock and reconciles at each step. */
  run(untilLocal: string, stepMinutes?: number): Promise<void>;
  restart(mode?: "live" | "dry-run"): Promise<void>;
  /** The process dies where it stands (no snapshot, the lock left behind) and a new one starts on what the journal holds. */
  crash(mode?: "live" | "dry-run"): Promise<void>;
  /** Every event in the journal on disk, in order. */
  journal(): Array<Record<string, unknown> & { type: string; seq: number }>;
  close(): void;
}

export async function makeWorld(options: {
  start: string;
  mode?: "live" | "dry-run";
  config?: Parameters<typeof writeConfig>[1];
  deliver?: boolean;
  runs?: (caseId: string) => RunView[];
  /** The runs `runs` returns are ones the controller itself started: it recorded their intent (and their end, for a run over). */
  adopt?: boolean;
  /** The journal's clock runs this far ahead of the engine's (as in life, where an event is written after the round began). */
  storeSkewMs?: number;
  /** The engine can start flows: true, a recording launcher and a probe the test sets (world.flows); or the launcher and probe to use, as they are. */
  flows?: boolean | { launcher: Launcher; dir: string; logDir?: string | null; probe(runId: string, spawnedAtMs: number | null, logDir: string | null): RunProbe };
}): Promise<World> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reconcile-test-"));
  const configDir = path.join(dir, "config");
  const dataDir = path.join(dir, "data");
  writeConfig(configDir, options.config);
  const items = new Map<string, Item>();
  const flags = new Map<string, unknown>();
  const innerFlags = new Map<string, unknown>();
  const versions = new Map<string, Record<string, string>>();
  const clock = { now: at(options.start) };
  const cards: World["cards"] = [];
  const archived: string[] = [];
  const fail: World["fail"] = { source: null, carrier: null, files: new Set(), deliver: null };
  const deliveries: World["deliveries"] = [];
  const logs: string[] = [];
  const statuses: unknown[] = [];
  let agents = 0;

  const conversations = new Map<string, Conversation>();
  const requestsDir = path.join(dataDir, "requests");
  let requests = 0;

  const kit: FlowsKit = { launcher: recordingLauncher(), dir: path.join(dir, "flows"), probes: new Map(), asked: [], logDir: path.join(dir, "logs-a"), askedDirs: [], failStarts: { count: 0, error: new Error("spawn failed") }, onStart: null };
  const world = { dir, configDir, dataDir, items, flags, innerFlags, versions, lastPoll: null, clock, cards, archived, fail, deliveries, polls: 0, hold: null, logs, statuses, conversations, ensured: 0, hooks: { raise: null }, flows: kit } as World;

  const source: Source = {
    id: "gcp-demo",
    domain: "work",
    async poll(input) {
      world.polls++;
      world.lastPoll = input;
      if (world.hold) await world.hold;
      if (fail.source) throw fail.source;
      return { snapshots: [...items.values()].map((i) => ({ ...i, observedAt: new Date(clock.now).toISOString() })), cursor: { n: world.polls }, calls: 1, errors: [], more: false };
    },
  };
  const flagSource: Source = {
    id: "flags-demo",
    domain: "work",
    async poll() {
      const file = (name: string, switches: Map<string, unknown>): Item => {
        const fields: Record<string, string> = {};
        for (const [key, value] of switches) fields[`switches.${key}`] = typeof value === "object" ? JSON.stringify(value) : String(value);
        return {
          key: `flags-demo:${name}`,
          source: "flags-demo",
          kind: "flags",
          title: name,
          url: `https://flags.example/${name}.json`,
          status: "ok",
          closed: false,
          fields,
          people: {},
          parent: null,
          sourceUpdatedAt: null,
          observedAt: new Date(clock.now).toISOString(),
          labels: { env: name },
        };
      };
      const all = [
        file("outer", flags),
        ...(innerFlags.size > 0 ? [file("inner", innerFlags)] : []),
        ...[...versions].map(([name, fields]) => ({ ...file(`ver-${name}`, new Map()), kind: "version", fields: { ...fields } })),
      ];
      const snapshots = all.filter((s) => !fail.files.has(s.title));
      const errors = all.filter((s) => fail.files.has(s.title)).map((s) => `${s.title}: HTTP 404`);
      return { snapshots, cursor: null, calls: all.length, errors, more: false };
    },
  };
  const carrier: Carrier = {
    async raise(card, content, attempt) {
      await world.hooks.raise?.(card);
      if (fail.carrier) throw fail.carrier;
      const agentId = `agent-${++agents}`;
      cards.push({ card: structuredClone(card), content, attempt, agentId });
      return agentId;
    },
    async archive(agentId) {
      archived.push(agentId);
    },
    async ensure() {
      world.ensured++;
    },
  };

  const boot = async (mode: "live" | "dry-run") => {
    mkdirSync(requestsDir, { recursive: true });
    world.store = openStore({ dir: dataDir, now: () => clock.now + (options.storeSkewMs ?? 0) });
    const config = loadConfig(configDir);
    world.engine = createEngine({
      store: world.store,
      config,
      // An observing source in the config runs its command for real (a test's own script).
      sources: [source, flagSource, ...config.sources.flatMap((s) => (s.kind === "command" ? [createCommandSource(s, { exec })] : []))],
      carrier,
      mode,
      instanceId: "test",
      home: dir,
      tickSeconds: 60,
      requestsDir,
      conversation: async (agentId) => conversations.get(agentId) ?? null,
      rulesKeep: { dir: path.join(dataDir, "rules-last-good"), write: true, now: () => clock.now },
      runs: options.runs ?? null,
      flows: typeof options.flows === "object"
        ? options.flows
        : options.flows
        ? {
            dir: kit.dir,
            launcher: {
              async start(spec) {
                kit.onStart?.(spec);
                if (kit.failStarts.count > 0) {
                  kit.failStarts.count--;
                  throw kit.failStarts.error;
                }
                return kit.launcher.start(spec);
              },
            },
            get logDir() {
              return kit.logDir;
            },
            probe(runId, _spawnedAtMs, logDir) {
              kit.asked.push(runId);
              kit.askedDirs.push(logDir);
              const p = probeOf(kit.probes.get(`${runId}@${logDir}`) ?? kit.probes.get(runId));
              // A run that ended "now": the end the test wrote down has no time of its own, the clock's is taken.
              return p.end && p.end.at === 0 ? { ...p, end: { ...p.end, at: clock.now } } : p;
            },
          }
        : null,
      now: () => clock.now,
      log: (m) => logs.push(m),
      writeStatus: (s) => statuses.push(s),
      deliver:
        options.deliver === false
          ? null
          : async (channel, message) => {
              deliveries.push({ channel, ...message, ok: !fail.deliver });
              if (fail.deliver) throw fail.deliver;
            },
    });
    await world.engine.recover();
  };
  await boot(options.mode ?? "live");

  world.respond = (answer) => {
    const newest = cards[cards.length - 1];
    if (!newest) throw new Error("no card raised");
    return world.engine.answer(newest.card.id, answer);
  };
  world.answer = (answers) => world.respond({ kind: "answers", answers, via: "form" });
  world.say = (request) => {
    const id = (request.id as string | undefined) ?? `r_${(++requests).toString(16).padStart(12, "0")}`;
    mkdirSync(requestsDir, { recursive: true });
    writeFileSync(path.join(requestsDir, `${id}.json`), JSON.stringify({ v: 1, id, at: new Date(clock.now).toISOString(), via: "agent-me", ...request }));
    return id;
  };
  world.receipt = (id) => {
    const file = path.join(requestsDir, "done", `${id}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Receipt) : null;
  };
  /** The runs `runs` returns, written into the journal as the controller's own (what a controller that started them would have recorded). */
  const adoptRuns = () => {
    if (!options.adopt || !options.runs) return;
    const events: Parameters<Store["append"]>[0] = [];
    for (const caseId of items.keys()) {
      for (const v of options.runs(caseId)) {
        if (world.store.state.flows?.[v.runId]) continue;
        const rec: FlowRec = { runId: v.runId, caseId, name: "adopted", flow: v.flow, key: v.stage ?? "", round: 0, stage: v.stage, label: v.flow, affairLabel: v.flow, owner: null, notify: false, maxUsd: 0, timeout: null, input: null, inputHash: "", rules: "", intentAt: v.startedAt, spawnedAt: v.startedAt };
        events.push({ type: "flow.intent", rec });
        const outcome = v.situation === "done" ? "done" : v.situation === "fail" ? "failed" : v.situation === "lost" ? "lost" : null;
        if (outcome) events.push({ type: "flow.ended", runId: v.runId, end: { outcome, summary: v.outcome, costUsd: v.costUsd, value: null, valueDropped: false, why: null } });
      }
    }
    if (events.length > 0) world.store.append(events);
  };
  world.run = async (untilLocal, stepMinutes = 15) => {
    const end = at(untilLocal);
    while (clock.now <= end) {
      adoptRuns();
      await world.engine.tick();
      // An observing command runs beside the rounds; here it is back before the clock moves on.
      await world.engine.settled();
      clock.now += stepMinutes * 60_000;
    }
    clock.now = end;
  };
  world.restart = async (mode = "live") => {
    world.store.close();
    await boot(mode);
  };
  world.crash = async (mode = "live") => {
    world.store.abandon();
    await boot(mode);
  };
  world.journal = () => {
    const journalDir = path.join(dataDir, "journal");
    return readdirSync(journalDir)
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .flatMap((f) =>
        readFileSync(path.join(journalDir, f), "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string; seq: number }),
      );
  };
  world.close = () => {
    try {
      world.store.close();
    } catch {
      // Already closed.
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return world;
}
