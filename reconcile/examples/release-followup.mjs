// Example rule: follow an issue from "done" through its release and rollout, reading what
// machines already record and asking a person only when they do not say, or disagree.
//
// Done is not released, and released is not fully rolled out, and the tracker records neither.
// But other systems do: the release branch has the commit or it does not, and the published
// switch file for the outward environment has the issue's key at some percentage or it does
// not. So for an issue that is closed (or in one of `readyStatuses`) and names a release day:
//
//   key       which switch key it is about: one found both in its text and in its commits wins;
//             else one its own commits bring in through an alias; several, or none when the text
//             hints there should be one, is one question offering what siblings settled.
//   released  per region it ships to: when its last commit got onto that region's release branch
//             (with a copy, for a branch made by copying), and whether that region's outward
//             version file went out built from a revision that has it (confirmed) or only built
//             after it got there (weak); on the branch and the day come is inferred. Also out when
//             the key is in an outward switch file or a person said so. Checked in the background:
//             some workdays after the release day, a region without the commit, or with it but no
//             newer outward version, is said as a statement (`notice`), on the page and once on a
//             card whose only answer is "知道了" (plus a line of one's own, kept as a note); the same
//             situation is not said again, a changed one is. `releaseCheck: "ask"` asks instead.
//   freeze    a release branch made by copying (from stable, say) is frozen by the copy: as soon
//             as the copy is seen, commits of an issue due in the release right after it that the
//             copy did not bring are said, once, on the same kind of card; the issue then waits
//             to be merged into that branch separately (`awaiting-merge`), and moves on when one
//             of its commits gets there.
//   rollout   read from the outward files of the regions it ships to: 100 everywhere is full;
//             back to 0 (or disabled) after being on is rolled back; the key gone after being
//             there cannot be told apart -- cleaned up after full, or pulled -- so it is a
//             question. Anything in between is followed without asking: a change in the file
//             wakes the case.
//   follow    a rollout belongs to the key, not to each issue: the lead is the issue whose own
//             commits add the key (of several, the one released last); one that came to the key
//             otherwise follows the lead while the lead is followed, and ends when it ends.
//   provides  an issue whose commits add a name a key's entry lists under `capabilityProperties`
//             (a version check, say) provides what the key needs: a dependency edge, recorded on
//             both ends. It has no key and no rollout; it is done once out, and wakes the issues
//             that hold the key.
//
// Copy it into <config>/rules/ and set `params` for your tracker. A rule gets everything through
// `ctx` and `kase` (kase.flags: the keys found, with what every flag file says); it may not
// import anything, read the clock, or touch the network.

export default {
  name: "release-followup",
  description: "外放和灰度：先读发布分支和外网开关文件，读不到或对不上才问人",
  applies: { source: "gcp-demo" },
  params: {
    owner: "owner",
    domain: "work",
    /** Fields that may hold the planned release day (the value starts with YYYY-MM-DD); the first set wins. */
    releaseFields: ["Release"],
    /** Statuses that count as done, besides closed. */
    readyStatuses: [],
    /** Branch names (as the source's version control config names them) that mean the change is in the release. */
    releaseBranches: ["release"],
    /** Region -> its release branches, when they differ by region; a region not listed uses releaseBranches. */
    regionBranches: {},
    /**
     * Region -> the item key of its outward version file (a "flags"-kind source with another item
     * kind), and which of its fields say what: the version, a revision it was built from (or null)
     * and the repository that revision is in, and when it was built as YYYYMMDDHHmmss local (or
     * null: when the file last changed).
     */
    versionFiles: {},
    versionFields: { version: "version", revision: null, revisionRepo: null, builtAt: null },
    /**
     * Not out by the release day: "notice" says what looks wrong (no commit on the release branch, or
     * the outward version not moving) and asks nothing; "ask" asks whether it went out.
     */
    releaseCheck: "notice",
    /** In the release branch and the day come, but no newer outward version for this many days: say so. */
    staleVersionDays: 3,
    /** Regions it ships to: `all` when any `allWhen` field has that value, else `default`. */
    regions: { default: ["main"], all: ["main"], allWhen: [] },
    regionNames: { main: "外网" },
    /** Region -> the item key of its outward switch file. */
    flagFiles: { main: "flags-demo:outer" },
    /** Region -> an inner (test) switch file, shown for context only. */
    innerFlagFiles: {},
    /** No key found but the text contains this: ask for the key. Empty: never ask. */
    keyHint: "",
    /**
     * Entry properties that name a capability the switch needs (a version check, say). An issue whose
     * own commits add such a name provides that capability: it has no key of its own, it is done
     * once out, and the issues that follow the key are told.
     */
    capabilityProperties: [],
    capabilityNoun: "能力",
    /**
     * Entry properties whose value names the key itself (another name for it). Only these count as
     * an alias of the key: a value like a branch name says nothing about which issue it is.
     */
    aliasProperties: [],
    graceWorkdays: 1,
    askAt: "18:00",
    nagAt: "10:00",
    nagEveryWorkdays: 1,
    nagMax: 3,
    keyBackstopWorkdays: 5,
    releaseBackstopWorkdays: 5,
    /** A copy freezes the release whose day is at most this many days after it. */
    freezeWindowDays: 6,
    /** A freeze is judged only once no newer copy has come for this long: another copy may still bring what one missed. */
    freezeQuietMinutes: 120,
    /**
     * When the freeze is expected, as "<weekday> HH:mm" (weekday as sun..sat). The copy is what
     * counts, but only one on that weekday before the release day (at any time: it may come earlier
     * or later than expected) or after it; earlier copies are syncs, which a commit may still make.
     * Null: every copy is a freeze. The time is for working back reminders before it, later.
     */
    freezeExpected: null,
    notYetMax: 5,
    rolloutEveryWorkdays: 3,
  },
  stages: ["open", "no-release-date", "awaiting-merge", "awaiting-release", "rolling-out", "finished", "dropped"],

  assess(kase, ctx) {
    const p = ctx.params;
    const item = kase.primary;
    const id = kase.id;
    const short = `#${id.split(":").pop()}`;
    const facts = [];
    const fact = (field, value, evidence) => facts.push({ field, value: String(value), evidence });
    // Set once the key is known, when it was inferred rather than read, so every headline says so.
    let headTail = "";
    // Set once something looks wrong; said with every outcome, and told once on a card that asks nothing.
    let notice = null;
    const noticeCards = [];
    const out = (stage, health, headline, next, commitments = []) => ({
      stage,
      health,
      headline: `${headline}${headTail}`.slice(0, 200),
      next,
      facts,
      // The notices' cards go with whatever else is asked; not once the case is dropped.
      commitments: stage !== "dropped" ? [...commitments, ...noticeCards] : commitments,
      ...(notice ? { notice: notice.slice(0, 300) } : {}),
    });
    const nobody = { actor: "nobody", what: "" };

    // ---- when -----------------------------------------------------------------------
    const releaseOf = (it) => {
      for (const f of p.releaseFields) {
        const d = /^(\d{4}-\d{2}-\d{2})/.exec(it.fields[f] ?? "")?.[1];
        if (d) return { field: f, date: d };
      }
      return { field: null, date: null };
    };
    const { field: releaseField, date: fieldDate } = releaseOf(item);
    if (fieldDate) fact("plannedRelease", fieldDate, `字段「${releaseField}」：${item.fields[releaseField]}`);
    const mine = ctx.commitments(id);
    const answered = (prefix) =>
      mine.filter((c) => c.key.startsWith(prefix) && c.status === "done" && c.answer).sort((a, b) => a.answer.at.localeCompare(b.answer.at));
    const byKey = (key) => mine.find((c) => c.key === key);
    const link = item.url ? `[${short}](${item.url})` : short;
    const hm = (iso) => iso.slice(5, 16).replace("T", " ");
    const local = (instant) => ctx.local(instant);
    const ack = (c) => (c?.status === "done" ? `（你 ${hm(local(c.answer.at))} ${c.answer.text ? `回了：${c.answer.text}` : "知道了"}）` : "");
    const ackOption = { id: "ack", label: "知道了", description: "同样的情况不再提醒；情况变了会再说" };
    const ackLine = "只是告诉你一声，不用做什么；想说一句（比如「这个版本不赶了」）就写在「其他」里，会记在这张单上。";
    // What a person wrote on any of these cards is kept on the issue.
    const replies = mine.filter((c) => (c.key.startsWith(`notice:${id}:`) || c.key.startsWith(`freeze:${id}:`)) && c.status === "done" && c.answer?.text).sort((a, b) => a.answer.at.localeCompare(b.answer.at));
    const reply = replies[replies.length - 1] ?? null;
    if (reply) fact("noticeReply", reply.answer.text, `你 ${hm(local(reply.answer.at))} 在提醒卡上说的`);

    // ---- where it ships ---------------------------------------------------------------
    const all = p.regions.allWhen.some((w) => (item.fields[w.field] ?? "") === w.equals);
    const regions = all ? p.regions.all : p.regions.default;
    const name = (r) => p.regionNames[r] ?? r;
    const branchesOf = (r) => p.regionBranches[r] ?? p.releaseBranches;

    // ---- the freeze --------------------------------------------------------------------
    // The latest copy into a region's release branch from the branch a commit is on freezes the
    // release right after it. Commits it did not bring have to be merged in separately; one of the
    // issue's commits getting there after it is that merge.
    const freezes = [];
    // A commit that could not be read: nothing is said about what may be missing.
    const partial = (item.incomplete ?? []).length > 0;
    const expected = /^(sun|mon|tue|wed|thu|fri|sat) /.exec(p.freezeExpected ?? "")?.[1];
    // The day of the release's freeze: the last such weekday on or before the release day.
    const freezeDay = (day) => {
      const ms = Date.parse(`${day}T00:00:00Z`);
      const back = (new Date(ms).getUTCDay() - ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(expected) + 7) % 7;
      return new Date(ms - back * 86_400_000).toISOString().slice(0, 10);
    };
    for (const r of fieldDate && !partial ? regions : []) {
      for (const b of branchesOf(r)) {
        const revs = (item.revisions ?? []).filter((rev) => rev.copied?.[b]);
        if (revs.length === 0) continue;
        const copy = revs.map((rev) => rev.copied[b]).reduce((x, y) => (Date.parse(y.at) > Date.parse(x.at) ? y : x));
        const lead = Date.parse(ctx.at(fieldDate, "23:59")) - Date.parse(copy.at);
        if (lead < 0 || lead > p.freezeWindowDays * 86_400_000) continue;
        if (expected && local(copy.at).slice(0, 10) < freezeDay(fieldDate)) continue;
        const number = (rev) => Number(/(\d+)$/.exec(rev.id)?.[1] ?? 0);
        // Only commits looked at since this copy, and seen without a newer one for freezeQuietMinutes,
        // can be said to have missed it; a copy within that starts it again.
        const quiet = (rev) => Date.parse(rev.copied[b].seen ?? copy.at) - Date.parse(copy.at) >= p.freezeQuietMinutes * 60_000;
        const open = revs.filter((rev) => !rev.in?.[b] && rev.copied[b].rev === copy.rev && number(rev) > copy.from);
        if (open.some((rev) => !quiet(rev))) continue;
        const missed = open;
        const merged = (item.revisions ?? []).filter((rev) => rev.in?.[b] && Date.parse(rev.in[b].at) > Date.parse(copy.at));
        const ids = (list) => list.map((rev) => rev.id).join("、");
        const when = `${hm(local(copy.at))} 封版（${b} 从 ${revs[0].branch}@${copy.from} 复制，rev ${copy.rev}）`;
        if (missed.length === 0) fact(`freeze.${r}`, "in", `${when}里有 ${ids(revs.filter((rev) => rev.in?.[b]))}`);
        else if (merged.length > 0) fact(`freeze.${r}`, "merged", `${when}没带进 ${ids(missed)}，之后 ${ids(merged)} 单独进了 ${b}`);
        else fact(`freeze.${r}`, "missed", `${when}没带进 ${ids(missed)}`);
        if (missed.length > 0 && merged.length === 0) {
          const where = regions.length > 1 ? `${name(r)}：` : "";
          freezes.push({
            region: r,
            branch: b,
            copy,
            ids: ids(missed),
            text: `${where}没赶上 ${hm(local(copy.at))} 的封版：它在 ${revs[0].branch} 上的 ${ids(missed)} 不在这次复制里，后续要单独 merge ${b}，否则赶不上 ${fieldDate.slice(5)} 外放`,
            short: `${where}${ids(missed)} 没进 ${hm(local(copy.at))} 的封版，要单独 merge ${b}`,
          });
          break;
        }
      }
    }
    if (freezes.length > 0) {
      const said = `${short} ${freezes.map((f) => f.text).join("；")}`;
      const k = `freeze:${id}:${freezes.map((f) => `${f.region}-${f.copy.rev}`).join("+")}`;
      notice = `${said}${ack(byKey(k))}`;
      noticeCards.push({
        key: k,
        title: `${short} 封版提醒`,
        domain: p.domain,
        owner: p.owner,
        trigger: { at: local(freezes[0].copy.at) },
        ask: { header: `${short} 封版`, question: `${short} 赶不上 ${fieldDate.slice(5)} 外放：${freezes.map((f) => f.short).join("；")}`, options: [ackOption], allowOther: true },
        brief: [`${freezes.map((f) => f.text).join("；")}。`, "", `- ${link} ${item.title}`, `- 状态：${item.status}；${releaseField}：${item.fields[releaseField]}`, "", ackLine].join("\n"),
        nag: { everyWorkdays: p.nagEveryWorkdays, at: p.nagAt, max: 1 },
        backstop: { at: ctx.addWorkdays(ctx.at(fieldDate, p.askAt), p.graceWorkdays, p.askAt) },
        level: "push",
        // Read from version control alone: an outward version file that cannot be read does not hold it.
        uses: [],
      });
    }
    const unmerged = `没赶上 ${freezes.map((f) => `${hm(local(f.copy.at))} 的封版`)[0] ?? ""}，等单独 merge ${freezes.map((f) => f.branch).join("、")}`;

    const ready = item.closed || p.readyStatuses.includes(item.status);
    if (!ready) return out("open", "on-track", `${item.status}${fieldDate ? `，计划 ${fieldDate.slice(5)} 外放` : ""}${freezes.length ? `；${unmerged}` : ""}`, { actor: "them", what: "等单子做完" });
    if (!fieldDate) return out("no-release-date", "done", `${item.status}，单子上没有外放日期，不跟了`, nobody);

    // Read before items kept their text and commits: nothing to search yet, so no questions either.
    if (item.text === undefined) return out("awaiting-release", "waiting", `${item.status}，${fieldDate.slice(5)} 外放；等重新读一遍单子和提交记录`, { actor: "system", what: "读单子" });

    const dateIn = (text) => {
      const full = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text ?? "");
      if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
      const md = /(\d{1,2})[-/.月](\d{1,2})/.exec(text ?? "");
      return md ? `${ctx.now.slice(0, 4)}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}` : null;
    };
    const nag = { everyWorkdays: p.nagEveryWorkdays, at: p.nagAt, max: p.nagMax };
    const known = [`- ${link} ${item.title}`, `- 状态：${item.status}；${releaseField}：${item.fields[releaseField]}`];

    // A person's answers about the release: a new date, not yet, out, or stop.
    const releases = answered(`release:${id}:`);
    const lastRelease = releases[releases.length - 1] ?? null;
    let date = fieldDate;
    let notYet = 0;
    for (const c of releases) {
      const moved = c.answer.option === null ? dateIn(c.answer.text) : null;
      if (moved) {
        date = moved > date ? moved : date;
        notYet = 0;
      } else if (c.answer.option === "not-yet" || c.answer.option === null) notYet++;
    }
    if (date !== fieldDate) fact("plannedRelease.answered", date, "问题卡上改的日期");
    if (lastRelease?.answer.option === "drop") return out("dropped", "done", "你说不用跟了", nobody);
    const dayCame = Date.parse(ctx.now) >= Date.parse(ctx.at(date, "00:00"));

    // ---- which key --------------------------------------------------------------------
    const notes = ctx.notes(id);
    const keyAnswer = answered(`flagkey:${id}`).pop() ?? null;
    let key = null;
    let keyWhy = "";
    let keyAsk = null;
    const aliasWhy = (f) =>
      f.aliases.map((a) => `别名匹配：${a.revision}${a.branch ? ` 在 ${a.branch} 上` : ""}新加了 ${a.name}，它是 ${a.entry} 的 ${a.property}`).join("；");
    // A capability alias says the issue provides what a key needs, not that the key is its own.
    const isCap = (a) => p.capabilityProperties.includes(a.property);
    const forKey = (flags) => flags.map((f) => ({ ...f, aliases: f.aliases.filter((a) => !isCap(a) && p.aliasProperties.includes(a.property)) })).filter((f) => f.inText || f.inDiff || f.aliases.length > 0);
    const capsOf = (flags) => flags.filter((f) => !f.inText && !f.inDiff).flatMap((f) => f.aliases.filter(isCap).map((a) => ({ key: f.key, alias: a })));
    const provided = capsOf(kase.flags);
    // In order: a key the issue names itself (text and commits), then one its own commits bring in
    // through an alias. Anything not unique, or the two disagreeing, settles nothing.
    const pick = (raw) => {
      const flags = forKey(raw);
      const direct = flags.filter((f) => f.inText || f.inDiff);
      const both = direct.filter((f) => f.inText && f.inDiff);
      const pool = both.length > 0 ? both : direct;
      const byAlias = flags.filter((f) => f.aliases.length > 0);
      if (pool.length === 1 && byAlias.every((f) => f.key === pool[0].key)) return { key: pool[0].key, why: pool[0].evidence.join("；"), via: "direct", pool, byAlias };
      if (pool.length === 0 && byAlias.length === 1 && byAlias[0].aliases.every((a) => a.sharedWith.length === 0))
        return { key: byAlias[0].key, why: aliasWhy(byAlias[0]), via: "alias", pool, byAlias };
      return { key: null, why: "", via: null, pool, byAlias };
    };
    const own = pick(kase.flags);
    const byAliasBefore = (notes.flagKey?.evidence ?? "").startsWith("别名匹配");
    if (keyAnswer) {
      key = keyAnswer.answer.option === "none" ? null : (keyAnswer.answer.option ? keyAnswer.answer.label : keyAnswer.answer.text.trim());
      const from = keyAnswer.answer.option?.[0];
      keyWhy = from === "s" ? "你在问题卡上确认的（候选从兄弟单推出来）" : from === "a" ? "你在问题卡上确认的（候选按别名推出来）" : "你在问题卡上选的";
    } else if (own.key) {
      key = own.key;
      keyWhy = own.why;
      if (own.via === "alias") headTail = `；key 由提交里的 ${kase.flags.find((f) => f.key === key).aliases[0].name} 推出`;
    } else if (own.pool.length === 0 && own.byAlias.length === 0 && notes.flagKey && !(byAliasBefore && (provided.length > 0 || ctx.flag(notes.flagKey.value).files.some((f) => f.present)))) {
      // Found before; a key taken out of every file is still this issue's key. One an alias found
      // that is still in a file but found no more no longer counts (the alias does not).
      key = notes.flagKey.value;
      keyWhy = notes.flagKey.evidence ?? "之前找到的";
      if (keyWhy.startsWith("别名匹配")) headTail = "；key 是按别名推出来的";
    } else if (own.pool.length > 1 || own.byAlias.length > 0 || (provided.length === 0 && p.keyHint && (item.text ?? item.title).includes(p.keyHint))) {
      const expired = mine.find((c) => c.key === `flagkey:${id}` && c.status === "expired");
      if (!expired) {
        // Not settled from the issue itself: keys its siblings (same parent) settled are likely
        // ones too. Still a question, but one click; each candidate says where it came from.
        const offered = new Set(own.pool.map((f) => f.key));
        const viaAlias = own.byAlias.filter((f) => !offered.has(f.key)).slice(0, 5);
        for (const f of viaAlias) offered.add(f.key);
        const kin = [];
        for (const sibling of ctx.siblings(item.key)) {
          // Its recorded key, or the one it settles by the same pick, so it does not matter which
          // of the two is judged first.
          const recorded = ctx.notes(sibling.key).flagKey;
          const theirs = recorded ? null : pick(ctx.flagsOf(sibling.key));
          const settled = recorded ? { key: recorded.value, evidence: recorded.evidence ?? "" } : theirs.key ? { key: theirs.key, evidence: theirs.why } : null;
          if (!settled || offered.has(settled.key)) continue;
          const at = kin.find((k) => k.key === settled.key);
          const from = `#${sibling.key.split(":").pop()}`;
          if (at) at.from.push(from);
          else kin.push({ key: settled.key, from: [from], evidence: settled.evidence });
        }
        const options = [
          ...own.pool.slice(0, 5).map((f, i) => ({ id: `k${i + 1}`, label: f.key, description: f.evidence[0] ?? "" })),
          ...viaAlias.map((f, i) => ({ id: `a${i + 1}`, label: f.key, description: `提交里新加了 ${f.aliases[0].name}（${f.aliases[0].entry} 的 ${f.aliases[0].property}）` })),
          ...kin.slice(0, 5).map((k, i) => ({ id: `s${i + 1}`, label: k.key, description: `同一父单下的 ${k.from.join("、")} 用的 key` })),
        ];
        const only = options.length === 1 ? options[0].label : null;
        options.push({ id: "none", label: "没有灰度 key", description: "不跟灰度，只看外放" });
        const trigger = byKey(`flagkey:${id}`)?.trigger.at ?? ctx.now;
        keyAsk = {
          key: `flagkey:${id}`,
          title: only ? `${short} 的灰度 key 是不是 ${only}` : `${short} 是哪个灰度 key`,
          domain: p.domain,
          owner: p.owner,
          trigger: { at: trigger },
          ask: {
            header: `${short} key`,
            question: only ? `${short} 的灰度 key 是不是 \`${only}\`？` : `${short} 对应哪个灰度 key？`,
            options,
            allowOther: true,
          },
          brief: [
            own.pool.length > 0
              ? `单子文本和提交里找到了 ${own.pool.length} 个可能的 key，判不准是哪个：`
              : own.byAlias.length > 0
                ? "单子文本和提交里没有直接写 key，提交里加的名字按别名对上了，但不唯一："
                : "单子提到了灰度，但在单子文本和提交里都没找到开关文件里有的 key。",
            "",
            ...own.pool.slice(0, 5).map((f) => `- \`${f.key}\`：${f.evidence.join("；")}`),
            ...(viaAlias.length > 0 ? [...(own.pool.length > 0 ? ["", "提交里加的名字按别名对上的（推出来的，和上面的不一致）："] : []), ...viaAlias.map((f) => `- \`${f.key}\`：${aliasWhy(f)}${f.aliases.some((a) => a.sharedWith.length > 0) ? `（这个名字也是 ${[...new Set(f.aliases.flatMap((a) => a.sharedWith))].join("、")} 的）` : ""}`)] : []),
            ...(kin.length > 0
              ? ["", "这张单本身没读准，下面是从同一父单下的兄弟单推出来的候选：", "", ...kin.slice(0, 5).map((k) => `- \`${k.key}\`：${k.from.join("、")} 对上的（那边的证据：${k.evidence}）`)]
              : []),
            "",
            ...known,
            "",
            "选一个，或者在「其他」里写 key 的名字；回答会记下来，以后不再问。",
          ].join("\n"),
          nag,
          backstop: { at: ctx.addWorkdays(trigger, p.keyBackstopWorkdays, p.askAt) },
          level: "push",
        };
      }
    }
    // ---- dependency edges: who provides a capability a key needs --------------------------
    // Issues whose own commits add a key itself, the one released last first.
    const holders = (k) =>
      ctx
        .naming(k)
        .filter((x) => x.link.inDiff)
        .sort((a, b) => (releaseOf(b.item).date ?? "").localeCompare(releaseOf(a.item).date ?? "") || a.item.key.localeCompare(b.item.key));
    const shortOf = (k) => `#${k.split(":").pop()}`;
    const atLeast = (a) => {
      const min = Array.isArray(a.value) ? a.value.find((v) => typeof v === "number") : undefined;
      return min === undefined ? "" : ` ≥ ${min}`;
    };
    const capWhy = (a) => `${a.revision}${a.branch ? ` 在 ${a.branch} 上` : ""}新加了 ${a.name}：+ ${a.line}；它是 ${a.entry} 的 ${a.property}`;
    const edge = (k, providerKey, a) => {
      const users = holders(k).map((x) => shortOf(x.item.key));
      return `${users.length ? `${users.join("、")} 的 ` : ""}\`${k}\` 要求 ${shortOf(providerKey)} 的${p.capabilityNoun} ${a.name}${atLeast(a)}`;
    };
    const providedFor = [];
    for (const c of provided) {
      fact(`provides.${c.key}`, edge(c.key, item.key, c.alias), capWhy(c.alias));
      providedFor.push(...holders(c.key).map((x) => x.item.key).filter((k) => k !== item.key && !providedFor.includes(k)));
    }
    if (provided.length > 0) {
      const users = providedFor.map(shortOf);
      headTail += `；给 ${users.length ? users.join("、") : provided.map((c) => `\`${c.key}\``).join("、")} 提供${p.capabilityNoun} ${provided.map((c) => c.alias.name).join("、")}`;
    }
    if (key) {
      // This issue's key needs capabilities others provide: say how far each provider is.
      for (const x of ctx.naming(key)) {
        if (x.item.key === item.key) continue;
        for (const c of capsOf([x.link]).filter((c) => c.key === key)) {
          const theirs = ctx.notes(x.item.key);
          const how = theirs.releasedHow?.value;
          const state = theirs.released?.value === "yes" ? (how === "confirmed" ? "已外放" : how === "weak" ? "已外放（弱证据）" : "推断已外放") : "还没外放";
          fact(`requires.${x.item.key.split(":").pop()}`, edge(key, x.item.key, c.alias), capWhy(c.alias));
          headTail += `；前置 ${shortOf(x.item.key)} ${state}`;
        }
      }
    }

    const flag = key ? (kase.flags.find((f) => f.key === key) ?? ctx.flag(key)) : null;
    if (key) fact("flagKey", key, keyWhy || "开关文件里有这个 key");

    // ---- what the switch files say -----------------------------------------------------
    const pct = (v) => {
      if (!v || !v.present) return null;
      const value = v.value;
      if (typeof value === "number") return value;
      if (value && typeof value === "object") return value.enabled === false ? 0 : typeof value.grey === "number" ? value.grey : 100;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const valueIn = (fileKey) => (flag && fileKey ? pct(flag.files.find((f) => f.file === fileKey)) : null);
    const outer = regions.map((r) => ({ region: r, now: valueIn(p.flagFiles[r]) }));
    const inner = key ? regions.filter((r) => p.innerFlagFiles[r]).map((r) => ({ region: r, now: valueIn(p.innerFlagFiles[r]) })) : [];
    const show = (list) => list.map((x) => `${name(x.region)} ${x.now === null ? "无" : `${x.now}%`}`).join("，");

    // ---- released? --------------------------------------------------------------------
    // Per region: when the issue's last commit got onto that region's release branch, and whether
    // the outward version file says a version built from it, or after it, went out.
    const entryOf = (r) => {
      let best = null;
      for (const rev of item.revisions ?? []) {
        for (const b of branchesOf(r)) {
          const e = rev.in?.[b] ?? (rev.branch === b ? { rev: Number(/(\d+)$/.exec(rev.id)?.[1] ?? 0), at: rev.at } : null);
          if (e && (!best || Date.parse(e.at) > Date.parse(best.at))) best = { ...e, id: rev.id, repo: rev.repo, branch: b };
        }
      }
      return best;
    };
    const versionOf = (r) => {
      const file = p.versionFiles[r] ? ctx.item(p.versionFiles[r]) : null;
      if (!file) return null;
      const f = p.versionFields;
      const stamp = f.builtAt ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(file.fields[f.builtAt] ?? "") : null;
      const builtAt = stamp ? ctx.at(`${stamp[1]}-${stamp[2]}-${stamp[3]}`, `${stamp[4]}:${stamp[5]}`) : file.sourceUpdatedAt ? ctx.local(file.sourceUpdatedAt) : null;
      const moved = ctx
        .observations(file.key)
        .flatMap((o) => o.changes.filter((c) => c.field === `fields.${f.version}`))
        .pop();
      const brief = (v) => (v && v.split(".").length > 4 ? v.split(".").slice(-2).join(".") : v);
      return { version: file.fields[f.version] ?? "", shown: `${moved ? `${brief(moved.from)}→` : ""}${brief(file.fields[f.version] ?? "")}`, rev: f.revision ? Number(file.fields[f.revision]) : Number.NaN, builtAt };
    };
    const byRegion = regions.map((r) => {
      const e = entryOf(r);
      const v = versionOf(r);
      const where = `${name(r)} ${branchesOf(r)[0]}`;
      const missed = freezes.find((f) => f.region === r);
      if (missed) return { region: r, how: "none", text: `${name(r)} ${missed.branch} 封版没带进 ${missed.ids}` };
      if (!e) return { region: r, how: "none", text: `${where} 里还没有这张单的提交` };
      const got = `${e.id} ${hm(local(e.at))} 进 ${e.branch}`;
      const sameRepo = !p.versionFields.revisionRepo || p.versionFields.revisionRepo === e.repo;
      if (v && sameRepo && Number.isFinite(v.rev) && v.rev >= e.rev) return { region: r, how: "confirmed", entry: e, text: `${name(r)}外网版本 ${v.shown}，包含 rev ${e.rev}（${got}）` };
      if (v && v.builtAt && Date.parse(v.builtAt) > Date.parse(e.at)) return { region: r, how: "weak", entry: e, version: v, text: `${name(r)}外网版本 ${v.shown}（${hm(v.builtAt)} 出包，在 ${got} 之后；对不上 revision，弱证据）` };
      return { region: r, how: dayCame ? "inferred" : "pending", entry: e, version: v, text: `${got}${dayCame ? "，外放日到了" : ""}` };
    });
    for (const x of byRegion) fact(`released.${x.region}`, x.how, x.text);
    const flagOut = outer.some((x) => x.now !== null);
    const saidOut = lastRelease && (lastRelease.answer.option === "out-on" || lastRelease.answer.option === "out-off");
    const signals = [];
    if (byRegion.every((x) => x.how !== "none" && x.how !== "pending")) signals.push(...byRegion.map((x) => x.text));
    if (flagOut) signals.push(`外网开关文件里有 \`${key}\`（${show(outer)}）`);
    if (saidOut) signals.push(`你说${lastRelease.answer.label}`);
    if (signals.length === 0 && notes.released?.value === "yes") signals.push(`之前确认过：${notes.released.evidence}`);
    const released = signals.length > 0;
    const commitments = keyAsk ? [keyAsk] : [];

    // What looks wrong some workdays after the release day, region by region.
    const late = dayCame ? ctx.workdaysBetween(ctx.at(date, "00:00"), ctx.now) : 0;
    // Told once on a card whose only answer is "知道了": the same situation is not told again after
    // that (its key is what is wrong, not the text, which counts the days); a changed one is.
    if (late >= p.graceWorkdays && !partial) {
      const wrong = [];
      const situation = [];
      let since = ctx.addWorkdays(ctx.at(date, p.nagAt), p.graceWorkdays, p.nagAt);
      for (const x of byRegion) {
        if (x.how === "none") {
          wrong.push(`${x.text}，可能没赶上这班版本`);
          situation.push(`none-${x.region}`);
        } else if (x.how === "inferred" && p.versionFiles[x.region] && Date.parse(ctx.now) - Date.parse(x.entry.at) >= p.staleVersionDays * 86_400_000) {
          const built = x.version?.builtAt ? `外网版本 ${hm(x.version.builtAt)} 之后没动过` : "外网版本一直没变";
          wrong.push(`${name(x.region)} ${x.entry.branch} 里 ${hm(local(x.entry.at))} 就有提交了，但${built}`);
          situation.push(`stale-${x.region}-${x.entry.rev}-${x.version?.version ?? ""}`);
          if (Date.parse(x.entry.at) > Date.parse(since)) since = local(x.entry.at);
        }
      }
      // Nothing is said once it is too late to matter: the same bound as the card's.
      const until = ctx.addWorkdays(since, p.releaseBackstopWorkdays, p.askAt);
      if (wrong.length > 0 && Date.parse(ctx.now) < Date.parse(until)) {
        const said = `${short} 外放日 ${date.slice(5)} 已过 ${late} 个工作日：${wrong.join("；")}`;
        const k = `notice:${id}:${situation.join("+")}`;
        notice = [notice, `${said}${ack(byKey(k))}`].filter(Boolean).join("；");
        // Asking whether it went out already covers it when the rule asks.
        if (p.releaseCheck !== "ask") {
          noticeCards.push({
            key: k,
            title: `${short} 外放提醒`,
            domain: p.domain,
            owner: p.owner,
            trigger: { at: since },
            ask: {
              header: `${short} 提醒`,
              question: `${short} 外放日 ${date.slice(5)} 之后：${wrong.join("；")}`,
              options: [ackOption],
              allowOther: true,
            },
            brief: [`外放日 **${date}** 已过 ${late} 个工作日。各地区现在的情况：`, "", ...known, ...byRegion.map((x) => `- ${x.text}`), "", ackLine].join("\n"),
            nag: { everyWorkdays: p.nagEveryWorkdays, at: p.nagAt, max: 1 },
            backstop: { at: until },
            level: "push",
          });
        }
      }
    }

    if (!released) {
      // Missed the freeze: waits for the separate merge, until it is too late to matter.
      if (freezes.length > 0 && late <= p.graceWorkdays + p.releaseBackstopWorkdays) {
        return out("awaiting-merge", "waiting", `${item.status}，${unmerged}；${date.slice(5)} 外放`, { actor: "them", what: `单独 merge ${freezes.map((f) => f.branch).join("、")}` }, commitments);
      }
      const branches = p.releaseBranches.length > 2 ? `${p.releaseBranches.slice(0, 2).join("/")} 等发布分支` : `${p.releaseBranches.join("/")} 分支`;
      if (p.releaseCheck !== "ask") {
        // Checked in the background; only what looks wrong is said, and nothing is asked.
        if (late > p.graceWorkdays + p.releaseBackstopWorkdays && byRegion.every((x) => x.how === "none")) {
          return out("dropped", "done", `外放日 ${date.slice(5)} 早就过了，发布分支里一直没有它的提交，不跟了`, nobody);
        }
        const head = byRegion.map((x) => x.text).join("；");
        return out(
          "awaiting-release",
          "waiting",
          `${item.status}，${date.slice(5)} 外放；${head}${inner.length ? `；内网 ${show(inner)}` : ""}`,
          { actor: "system", what: "后台核对发布分支和外网版本" },
          commitments,
        );
      }
      const round = notYet;
      const k = `release:${id}:${date}${round > 0 ? `:${round}` : ""}`;
      const trigger = round === 0 ? ctx.addWorkdays(ctx.at(date, p.askAt), p.graceWorkdays, p.askAt) : ctx.addWorkdays(lastRelease.answer.at, 1, p.nagAt);
      const backstopAt = ctx.addWorkdays(trigger, p.releaseBackstopWorkdays, p.askAt);
      const tooLate = `外放日 ${date.slice(5)} 早就过了，机器上没看到外放的记录，也没问过，不跟了`;
      const expired = mine.find((c) => c.key.startsWith(`release:${id}:`) && c.status === "expired");
      if (expired) return out("dropped", "done", expired.rounds === 0 ? tooLate : `问到兜底时间都没人答，停止跟进（${date.slice(5)} 外放）`, nobody);
      if (notYet >= p.notYetMax) return out("dropped", "done", `问了 ${notYet} 次都说还没外放，停止跟进`, nobody);
      if (round === 0 && !byKey(k) && Date.parse(backstopAt) <= Date.parse(ctx.now)) return out("dropped", "done", tooLate, nobody);
      const missing = [key ? `外网开关文件里还没有 \`${key}\`` : null, ...byRegion.filter((x) => x.how === "none" || x.how === "pending").map((x) => x.text)].filter(Boolean);
      commitments.push({
        key: k,
        title: `${short} 外放确认`,
        domain: p.domain,
        owner: p.owner,
        trigger: { at: trigger },
        ask: {
          header: short,
          question: `${short} 外放了吗？`,
          options: [
            { id: "out-on", label: "已外放，灰度开了", description: "之后从开关文件读灰度" },
            { id: "out-off", label: "已外放，灰度还没开", description: "之后从开关文件读灰度" },
            { id: "not-yet", label: "还没外放", description: "下一个工作日再看；改了日期就在「其他」里写新日期" },
            { id: "drop", label: "不用跟了", description: "这件事不再问" },
          ],
          allowOther: true,
        },
        brief: [`计划 **${date}** 外放，过了 ${p.graceWorkdays} 个工作日机器上还是看不出来：${missing.join("；")}。`, "", ...known, ...(inner.length ? [`- 内网开关：${show(inner)}`] : []), ...(releases.length ? ["", "之前的回答：", ...releases.map((c) => `- ${c.answer.at.slice(5, 16).replace("T", " ")} ${c.answer.text ?? c.answer.label}`)] : [])].join("\n"),
        nag,
        backstop: { at: backstopAt },
        level: "push",
      });
      const waitingOn = dayCame ? `外放日过了，还没看到外放的记录，${trigger.slice(5, 16).replace("T", " ")} 问你` : `${date.slice(5)} 外放，到时候看${branches}${key ? `和外网开关里的 \`${key}\`` : ""}`;
      const asked = byKey(k)?.status === "waiting";
      return out(
        "awaiting-release",
        "waiting",
        asked ? `问你 ${date.slice(5)} 外放了没，还没回答` : `${item.status}，${waitingOn}${inner.length ? `；内网 ${show(inner)}` : ""}`,
        { actor: asked ? "me" : "system", what: asked ? "回答外放了没" : "等外放的记录" },
        commitments,
      );
    }

    fact("released", "yes", signals.join("；"));
    // Confirmed: the outward file or a person says so. Inferred: a commit on a release branch and
    // the day come, which is how it usually goes but not proof.
    // Confirmed: the outward version is built from the commit, or the outward switch file or a person
    // says so. Weak: built after the commit got there, not traced to a revision. Inferred: on the
    // release branch and the day come. Never weaker than what was recorded before.
    const rank = { inferred: 0, weak: 1, confirmed: 2 };
    const computed = flagOut || saidOut || byRegion.every((x) => x.how === "confirmed") ? "confirmed" : byRegion.every((x) => x.how === "confirmed" || x.how === "weak") ? "weak" : "inferred";
    const before = notes.releasedHow?.value;
    const how = before in rank && rank[before] > rank[computed] ? before : computed;
    const outWord = how === "inferred" ? "推断已外放" : "已外放";
    const outWhy = signals.slice(0, 2).join("；");
    fact("releasedHow", how, outWhy);
    if (!key) {
      if (provided.length > 0) {
        // A provider is done once out; whoever needs it is woken to look again.
        const done = out("finished", "done", `${outWord}（${outWhy}）`, nobody);
        done.wake = providedFor.map((caseId) => ({ caseId, reason: `前置 ${short} ${outWord}` }));
        return done;
      }
      if (keyAsk) return out("rolling-out", "waiting", `${outWord}（${outWhy}）；问你灰度 key 是哪个`, { actor: "me", what: "选灰度 key" }, commitments);
      return out("finished", "done", `${outWord}（${outWhy}），没有灰度 key，不跟灰度`, nobody);
    }

    // ---- one item follows a key's rollout; the others follow that item ----------------
    // The lead is an item whose own commits add the key itself; of several, the one released
    // last. An item that came to the key otherwise (an alias, a sibling, an answer) follows it while
    // the lead is followed this round, and ends when the lead ends. Without a lead it goes on alone.
    const lead = holders(key)[0] ?? null;
    if (lead && lead.item.key !== item.key) {
      const leadShort = `#${lead.item.key.split(":").pop()}`;
      const result = ctx.notes(lead.item.key)["rollout.result"];
      if (result) {
        fact("rollout.result", result.value, `跟着 ${leadShort} 结束（${result.evidence}）`);
        return out("finished", "done", `跟着 ${leadShort} 结束：${result.value === "full" ? "已全量" : "已回退"}`, nobody);
      }
      if (lead.hot && lead.stage !== "dropped") {
        return out("rolling-out", "waiting", `${outWord}（${outWhy}），灰度跟着 ${leadShort}`, { actor: "system", what: `等 ${leadShort} 的灰度` }, commitments);
      }
    }

    // ---- rollout ----------------------------------------------------------------------
    for (const x of outer) {
      const peak = Math.max(Number(notes[`rollout.peak.${x.region}`]?.value ?? 0) || 0, x.now ?? 0);
      x.peak = peak;
      fact(`rollout.${x.region}`, x.now === null ? "absent" : x.now, `外网开关文件 ${p.flagFiles[x.region]}`);
      fact(`rollout.peak.${x.region}`, peak, "读到过的最高比例");
    }
    const rollouts = answered(`rollout:${id}:`);
    const lastRollout = rollouts[rollouts.length - 1] ?? null;
    // How it ended, for the items that follow this one's key.
    const ended = (result, headline, why) => (fact("rollout.result", result, why), out("finished", "done", headline, nobody));
    if (lastRollout?.answer.option === "full") return ended("full", `已全量（你说的；开关：${show(outer)}）`, "你在问题卡上说已全量");
    if (lastRollout?.answer.option === "rolled-back") return ended("rolled-back", `已回退（你说的；开关：${show(outer)}）`, "你在问题卡上说已回退");
    if (lastRollout?.answer.option === "drop") return out("dropped", "done", "你说不用跟了", nobody);
    if (outer.every((x) => x.now === 100)) return ended("full", `已全量：${show(outer)}`, `外网开关文件：${show(outer)}`);
    if (outer.some((x) => x.now === 0 && x.peak > 0)) {
      const peak = Math.max(...outer.map((x) => x.peak));
      return ended("rolled-back", `已回退：${show(outer)}（之前到过 ${peak}%）`, `外网开关文件：${show(outer)}，之前到过 ${peak}%`);
    }

    const removed = outer.filter((x) => x.now === null && x.peak > 0);
    const neverOut = outer.every((x) => x.now === null && x.peak === 0);
    if (removed.length === 0 && !neverOut) {
      // In between: followed by reading; a change in the file wakes the case.
      return out("rolling-out", "waiting", `灰度中：${show(outer)}`, { actor: "system", what: "开关文件一变就再看" }, commitments);
    }
    const n = rollouts.length + 1;
    const from = lastRollout ? lastRollout.answer.at : ctx.addWorkdays(ctx.at(date, p.askAt), p.graceWorkdays, p.askAt);
    const trigger = lastRollout ? ctx.addWorkdays(from, p.rolloutEveryWorkdays, p.nagAt) : from;
    const expired = mine.find((c) => c.key.startsWith(`rollout:${id}:`) && c.status === "expired");
    if (expired) return out("dropped", "done", `灰度判不准、问到兜底都没人答，停止跟进（开关：${show(outer)}）`, nobody);
    if (rollouts.filter((c) => c.answer.option !== "going").length === 0 && rollouts.length >= p.notYetMax) return out("dropped", "done", `问了 ${rollouts.length} 次都说还没开，停止跟进`, nobody);
    const backstopAt = ctx.addWorkdays(trigger, p.releaseBackstopWorkdays, p.askAt);
    const question = removed.length > 0 ? `${short} 的 \`${key}\` 从外网开关文件里删掉了，是全量后清理，还是撤掉了？` : `${short} 外放了，但外网开关文件里一直没有 \`${key}\`：灰度开了吗？`;
    const k = `rollout:${id}:${n}`;
    if (!byKey(k) && Date.parse(backstopAt) <= Date.parse(ctx.now)) {
      return out("dropped", "done", removed.length > 0 ? `\`${key}\` 早就从外网开关里删了，太久了，不问了` : `${outWord}，外网开关里一直没有 \`${key}\`，太久了，不问了`, nobody);
    }
    commitments.push({
      key: k,
      title: `${short} 灰度确认`,
      domain: p.domain,
      owner: p.owner,
      trigger: { at: trigger },
      ask: {
        header: short,
        question,
        options: [
          { id: "full", label: "全量了", description: "跟完了" },
          { id: "rolled-back", label: "撤掉 / 回退了", description: "跟完了" },
          { id: "going", label: "还没开 / 还在灰度", description: `过 ${p.rolloutEveryWorkdays} 个工作日再看开关文件` },
          { id: "drop", label: "不用跟了", description: "这件事不再问" },
        ],
        allowOther: true,
      },
      brief: [
        removed.length > 0 ? `外网开关文件里之前有 \`${key}\`（最高 ${Math.max(...removed.map((x) => x.peak))}%），现在没了。删掉可能是全量后清理，也可能是撤掉了，文件本身分不出来。` : `${outWord}（${signals.join("；")}），但外网开关文件里没有 \`${key}\`。`,
        "",
        ...known,
        `- 外网开关：${show(outer)}${inner.length ? `；内网：${show(inner)}` : ""}`,
        `- key 的依据：${keyWhy}`,
      ].join("\n"),
      nag,
      backstop: { at: backstopAt },
      level: "push",
    });
    const asked = byKey(k)?.status === "waiting";
    return out(
      "rolling-out",
      "waiting",
      asked ? `灰度判不准，问你了，还没回答（开关：${show(outer)}）` : removed.length > 0 ? `\`${key}\` 从外网开关里删了，${trigger.slice(5, 16).replace("T", " ")} 问你` : `${outWord}，外网开关里还没有 \`${key}\`，${trigger.slice(5, 16).replace("T", " ")} 还没有就问你`,
      { actor: asked ? "me" : "system", what: asked ? "回答灰度情况" : "等开关文件" },
      commitments,
    );
  },
};
