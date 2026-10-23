import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config";
import { createEngine, type CardAnswer, type CardContent, type Carrier, type Engine } from "../server/engine";
import type { RunView } from "../shared/graph";
import type { Card, Item } from "../shared/model";
import type { PollInput, Source } from "../server/sources/source";
import type { Conversation, Receipt } from "../server/requests";
import { openStore, type Store } from "../server/store";

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

export function writeConfig(dir: string, overrides: { persons?: unknown; policy?: unknown; rules?: Record<string, string>; watch?: number[]; extraSources?: unknown[] } = {}) {
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
  /** files: switch files (by name) that fail to read while the others do. */
  fail: { source: Error | null; carrier: Error | null; files: Set<string>; deliver: Error | null };
  /** What server.deliver was handed, failed tries included. */
  deliveries: Array<{ channel: string; to: string; idempotencyKey: string; title: string; text: string; status: string; ok: boolean }>;
  polls: number;
  /** While set, the tracker source's poll waits for it: a reconcile that runs long. */
  hold: Promise<void> | null;
  store: Store;
  engine: Engine;
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
  close(): void;
}

export async function makeWorld(options: { start: string; mode?: "live" | "dry-run"; config?: Parameters<typeof writeConfig>[1]; deliver?: boolean; runs?: (caseId: string) => RunView[] }): Promise<World> {
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

  const world = { dir, configDir, dataDir, items, flags, innerFlags, versions, lastPoll: null, clock, cards, archived, fail, deliveries, polls: 0, hold: null, logs, statuses, conversations, ensured: 0 } as World;

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
    world.store = openStore({ dir: dataDir, now: () => clock.now });
    world.engine = createEngine({
      store: world.store,
      config: loadConfig(configDir),
      sources: [source, flagSource],
      carrier,
      mode,
      instanceId: "test",
      home: dir,
      tickSeconds: 60,
      requestsDir,
      conversation: async (agentId) => conversations.get(agentId) ?? null,
      rulesKeep: { dir: path.join(dataDir, "rules-last-good"), write: true, now: () => clock.now },
      runs: options.runs ?? null,
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
  world.run = async (untilLocal, stepMinutes = 15) => {
    const end = at(untilLocal);
    while (clock.now <= end) {
      await world.engine.tick();
      clock.now += stepMinutes * 60_000;
    }
    clock.now = end;
  };
  world.restart = async (mode = "live") => {
    world.store.close();
    await boot(mode);
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
