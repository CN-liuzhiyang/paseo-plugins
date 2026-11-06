import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { flowProblems } from "./flows.mjs";
import { linkProblems } from "./links.mjs";

// The thresholds live in policy.json under the affairs root, so tuning them is a file edit, not a code change.

export const DEFAULT_POLICY = {
  tz: "Asia/Shanghai",
  check: {
    minGapMinutes: 30,
    softDays: 14,
    hardDays: 365,
    deadlineMarginRatio: 0.2,
    loopCount: 3,
    loopWindowMinutes: 120,
    overAllowanceMinutes: 1440,
    overAllowanceRatio: 0.5,
    appealDays: 7,
    maxAttempts: 3,
    filler: ["等变化", "等待变化", "再看看", "常规检查", "例行检查", "定期检查", "看看有没有变化", "继续观察", "继续关注"],
  },
  limits: {
    perAffairPerDay: 8,
    perAffairUsdPerDay: 0.5,
    totalPerDay: 40,
    totalUsdPerDay: 5,
    breakerPerHour: 20,
    burstPerAffairPerHour: 4,
    maxActive: 30,
    dayStartHour: 8,
  },
  // Where a push goes (a POPO address) is data and lives in policy.json; quiet is the window a kind of affair may be pushed in.
  push: { perDay: 5, to: "", quiet: { personal: ["08:00", "22:00"], family: ["08:00", "22:00"] } },
  fallbackMinutes: 120,
  archiveAfterDays: 3,
  // Off until a test push with the link has been opened by a person (the link kind is not known to work on every phone).
  popoLink: false,
  // Where an outside reference leads, by the kind of link: { "<kind>": "https://…/{ref}" }; the address is the private part, so it lives in policy.json.
  links: {},
  // The kind a bare "#12345" (five digits or more) means; empty: such a number is left as text.
  linkHash: "",
  projectsByKind: {},
  projects: { searchDirs: [] },
  workDir: "",
  areaByKind: {},
  chatHandbookByKind: {},
  handbooksDir: "",
  // The handbook to read after affair.md for an affair whose link is of that kind (otherwise asked.md): { "<kind>": "<file>.md" }.
  handbookByKind: {},
  // The role (a key of `roles`) an affair of that kind of link is looked at with, unless `affair new --role` says another: { "<kind>": "<role>" }.
  roleByKind: {},
  // Where this machine keeps the command and the public handbook, for a plugin that cannot tell where it was loaded from.
  binPath: "",
  handbookPath: "",
  // Reading tools: each is a file <name>.mjs in a directory; the private ones (dirs, searched first) hold what names an internal system.
  readers: {
    dirs: [],
    // The public directory, for a plugin that cannot tell where it was loaded from (otherwise it sits beside the command).
    publicDir: "",
    timeoutSeconds: 60,
    // How often a watched value is read, unless the look asked for another; never more often than minEveryMinutes.
    everyMinutes: 30,
    minEveryMinutes: 5,
    // A change looks at the affair at once, but not more than once in this many minutes.
    minLookGapMinutes: 15,
    // Failed reads in a row before the person is told, once.
    failuresBeforeAsk: 3,
    // At most this many reads in one pass of the loop; the rest wait for the next minute.
    perPass: 10,
  },
  // Flows the chat may start for an affair (`affair flow`): { perDay: 3, "<name>": { kinds, prepare, timeout, says } }; see lib/flows.mjs.
  flows: { perDay: 3 },
  role: "glance",
  // The chat session of an affair. It is kept as long as it is cheap to keep: warm (spoken to within the cache's lifetime) it is
  // never replaced; cold and long, or very long, or left over the night, it is replaced by a new one that reads the brief.
  chat: {
    // The name of a role in `roles` that every chat runs on (empty: the role of the affair's looks). A role may also have a
    // `chat` of its own: { provider, thinking, mode, env }.
    role: "",
    // Cache lifetime asked for the chat session (the env of its session): its turns come minutes to an hour apart.
    cacheTtl: "1h",
    // Match the default one-hour cache lifetime before treating an idle chat as cold.
    coldMinutes: 60,
    coldContext: 80_000,
    // Context this long: replaced when it has been idle for idleMinutes, warm or not.
    hardContext: 150_000,
    idleMinutes: 10,
    // Once a day at this hour: a chat idle for nightIdleHours with at least nightContext is replaced (the first words of the morning get the new price).
    nightHour: 4,
    nightIdleHours: 6,
    nightContext: 50_000,
    maxPerDay: 2,
    // He has typed in this many minutes: not replaced.
    typingMinutes: 2,
    // How many of the latest lines and which open questions are drawn again after a restart (what the plugin drew into a conversation is lost with the daemon).
    redraw: 3,
  },
  // estimateUsd is a guess per look (the real cost is not known yet); it is what the money limits count with.
  roles: { glance: { provider: "claude/claude-haiku-5-5", thinking: "high", mode: "bypassPermissions", estimateUsd: 0.02 } },
};

/**
 * What a policy.json must say before the plugin can do its whole job; each problem is a sentence a person can act on.
 * @returns {Array<{ key: string, text: string }>}
 */
export function policyProblems(policy) {
  const out = [];
  const need = (key, ok, text) => ok || out.push({ key, text });
  need("binPath", Boolean(policy.binPath) && existsSync(policy.binPath), "binPath 要写成 affair 命令（bin/affair.mjs）的完整路径，文件要在");
  need("handbookPath", Boolean(policy.handbookPath) && existsSync(policy.handbookPath), "handbookPath 要写成公开手册（handbook.md）的完整路径，文件要在");
  need("push.to", Boolean(policy.push?.to), "push.to 要写成收推送的人的地址，不写就一条推送也发不出去");
  need("readers.dirs", Array.isArray(policy.readers?.dirs) && policy.readers.dirs.length > 0 && policy.readers.dirs.every((d) => existsSync(d)), "readers.dirs 要列出放读取工具的目录，目录要在");
  need("readers.publicDir", Boolean(policy.readers?.publicDir) && existsSync(policy.readers.publicDir), "readers.publicDir 要写成公开读取工具目录（readers/）的完整路径，目录要在");
  need("handbooksDir", Boolean(policy.handbooksDir) && existsSync(policy.handbooksDir), "handbooksDir 要写成私有手册目录，目录要在");
  out.push(...linkProblems(policy));
  out.push(...flowProblems(policy));
  need("roles", Object.values(policy.roles ?? {}).every((r) => typeof r?.provider === "string" && r.provider), "roles 里每一档要写 provider");
  return out;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export const defaultRoot = () => process.env.AFFAIRS_HOME || path.join(os.homedir(), "affairs");

/** policy.json is optional; a file that cannot be read is an error, not a silent default. A file named on purpose (--policy) has to be there. */
export function loadPolicy(root, named = "") {
  let file = named || path.join(root, "policy.json");
  if (named && !existsSync(file)) throw new Error(`policy 文件不存在：${file}`);
  if (!existsSync(file)) return DEFAULT_POLICY;
  try {
    let data = JSON.parse(readFileSync(file, "utf8"));
    if (data.use) {
      if (!path.isAbsolute(data.use)) throw new Error("use 要写绝对路径");
      file = data.use;
      data = JSON.parse(readFileSync(file, "utf8"));
      if (data.use) throw new Error("use 只能跟一次");
    }
    const policy = merge(DEFAULT_POLICY, data);
    delete policy.homes;
    Object.defineProperty(policy, "sourcePath", { value: file, enumerable: false });
    return policy;
  } catch (error) {
    throw new Error(`policy.json 读不了（${file}）：${error.message}`);
  }
}
