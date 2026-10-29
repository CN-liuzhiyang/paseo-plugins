// The arguments of bin/reconcile-say.mjs, read one way for both sides: the command reads them to
// know what to send, and the plugin reads a command line from a conversation to know what that
// command sent. A line the command would refuse or only print its usage for sent nothing. No
// dependencies: the command runs on bare Node.

const KNOWN = {
  say: ["item", "kind", "said", "until", "person", "what", "expected", "data", "wait"],
  undo: ["id", "last", "said", "data", "wait"],
  track: ["said", "title", "domain", "data", "wait"],
  note: ["item", "said", "data", "wait"],
  answer: ["ask", "said", "data", "wait"],
};

/** The longest short name a matter may be given (requests.ts DESK_TITLE_MAX). */
const TITLE_MAX = 20;

/**
 * The arguments after the program. Returns the request they send (without its id, time and
 * conversation), the command's own --data and --wait; or `help` when it only prints its usage; or
 * the error it stops with (`usage`: printed with the usage).
 */
export function parseSayArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return { help: true };
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) return { error: `看不懂的参数：${arg}`, usage: true };
    const name = arg.slice(2);
    if (name === "last" || name === "help") {
      flags[name] = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined) return { error: `--${name} 后面要有值` };
    flags[name] = value;
  }
  if (flags.help) return { help: true };
  if (!Object.hasOwn(KNOWN, cmd)) return { error: `没有 ${cmd} 这个子命令`, usage: true };
  if (!flags.said) return { error: "要用 --said 给出人的原话" };
  for (const name of Object.keys(flags)) if (!KNOWN[cmd].includes(name)) return { error: `${cmd} 不认识 --${name}` };
  const wait = flags.wait === undefined ? 90 : Number(flags.wait);
  if (!Number.isFinite(wait) || wait < 0) return { error: "--wait 要是秒数" };
  const data = flags.data ?? null;
  if (cmd === "say") {
    if (!flags.item) return { error: "要用 --item 给出单号" };
    if (!["drop", "hold", "wrong"].includes(flags.kind)) return { error: "--kind 只能是 drop、hold、wrong" };
    if (flags.kind === "hold" && !/^\d{4}-\d{2}-\d{2}$/.test(flags.until ?? "")) return { error: "hold 要用 --until YYYY-MM-DD 说到哪天" };
    const request = { cmd, kind: flags.kind, item: flags.item, said: flags.said };
    for (const name of ["until", "person", "what", "expected"]) if (flags[name] !== undefined) request[name] = flags[name];
    return { request, data, wait };
  }
  if (cmd === "track") {
    const title = (flags.title ?? "").trim();
    if (!title) return { error: "要用 --title 给这件事起一个不超过 20 字的短名字" };
    if ([...title].length > TITLE_MAX) return { error: `--title 最多 ${TITLE_MAX} 个字，现在是 ${[...title].length} 个，改短再跑` };
    if (flags.domain !== undefined && !["work", "personal", "family"].includes(flags.domain)) return { error: "--domain 只能是 work、personal、family" };
    const request = { cmd, title: flags.title, said: flags.said };
    if (flags.domain !== undefined) request.domain = flags.domain;
    return { request, data, wait };
  }
  if (cmd === "answer") {
    if (!flags.ask) return { error: "要用 --ask 给出回答的是哪个问题（推送最后一行的编号，比如 D1-1）" };
    if (flags.said !== "-") return { error: "answer 的 --said 只能是 -：回答是人在这个对话里写的那条消息，由插件自己去取，不用你转抄" };
    return { request: { cmd, ask: flags.ask, said: "-" }, data, wait };
  }
  if (cmd === "note") {
    if (!flags.item) return { error: "要用 --item 给出交代过的事的编号，比如 D12" };
    return { request: { cmd, item: flags.item, said: flags.said }, data, wait };
  }
  if (!flags.id === !flags.last) return { error: "undo 要 --id <a_…> 或者 --last，二选一" };
  if (flags.id && !/^a_[0-9a-f]{12}$/.test(flags.id)) return { error: `${flags.id} 不是一条的编号（像 a_0123456789ab）` };
  return { request: { cmd, target: flags.id ?? "last", said: flags.said }, data, wait };
}
