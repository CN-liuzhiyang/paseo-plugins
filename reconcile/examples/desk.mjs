// Example rule: follow a matter a person told in a conversation ("盯一下洗牙，月底前要约上"), one that has no ticket in
// any system. The controller keeps what was said as the item `desk:D<n>` (source "desk"); this rule decides, with no model and
// nothing read from outside, WHEN to look at it, and a flow ("item-glance", one agent, read only) does the looking.
//
//   wake      a look is asked for when: it is the first one; a question put to the person was answered (or a line was added to the
//             matter) since the last look; or the time the last look chose has come (at most `dailyTimeLooks` such looks a day).
//             "过 3 天再看" and "不用盯了" are answers the rule takes itself: they cost no look.
//   keys      a look is the run `look-<N>`, N counted in the fact `desk.looks`. A key is run once; a look that came to nothing is
//             followed by the next key when the rule wakes again (it says "tomorrow" itself: the flow is `selfRetry`).
//   clamp     what the look proposes is a proposal: the time of the next look is kept between `minLookMinutes` and `maxLookDays`
//             and, for work, inside `workHours` on a workday; a question put to the person in the last `dedupeDays` days is not
//             put again; "it is done" is a question to the person, never an ending by itself.
//   states    every state says in words what it is and what happens next; times are shown with the day of the week, worked out here.
//
// All the state is in facts (desk.*). Copy it into <config>/rules/ and set `params` (the directories a look runs in, and what to tell
// it about where to read, per domain).

const DAY = 86_400_000;
const WEEKDAYS = "日一二三四五六";
const FACTS = ["looks", "woke", "seen", "next", "status", "log", "ask", "asked", "answered", "fails", "fail", "finish"];

export const flows = {
  look: { flow: "item-glance", timeout: "20m", maxUsd: 0.5, notify: false, selfRetry: true },
};

const json = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const ms = (text) => (text ? Date.parse(text) : 0) || 0;
const flat = (text, max) => {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
/** For text that a card shows as Markdown: the characters that would make a link, emphasis or a heading are escaped. */
const md = (text, max) => flat(text, max).replace(/[\\`*_[\]()<>#|~!]/g, "\\$&");
const same = (a, b) => {
  const [x, y] = [String(a).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ""), String(b).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "")];
  return x !== "" && x === y;
};

// ---- times: shown with the weekday, worked out here and never by the model ---------------------

const localOf = (ctx, instant) => ctx.local(instant);
const dateOf = (ctx, instant) => localOf(ctx, instant).slice(0, 10);
const clockOf = (ctx, instant) => localOf(ctx, instant).slice(11, 16);
const weekdayOf = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
/** "11-03 周二 10:00" */
const stamp = (ctx, instant) => `${localOf(ctx, instant).slice(5, 10)} 周${weekdayOf(dateOf(ctx, instant))} ${clockOf(ctx, instant)}`;
/** "2026-11-03 周二 10:00" */
const fullStamp = (ctx, instant) => `${dateOf(ctx, instant)} 周${weekdayOf(dateOf(ctx, instant))} ${clockOf(ctx, instant)}`;
const shiftDate = (date, days) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const isWorkday = (ctx, date) => ctx.addWorkdays(ctx.at(shiftDate(date, -1), "12:00"), 1, "10:00").slice(0, 10) === date;
/** The first workday after the instant's own date, at a time. */
const nextWorkday = (ctx, instant, time) => ctx.addWorkdays(instant, 1, time);
/** The next day, at a time, workday or not (for the domains that have no working hours). */
const tomorrow = (ctx, instant, time) => ctx.at(shiftDate(dateOf(ctx, instant), 1), time);

/**
 * The time of the next look, from what the look proposed ("YYYY-MM-DD HH:mm", the instance's zone): never nearer than
 * `minLookMinutes` nor further than `maxLookDays`, and for work inside working hours on a workday. `clamp` says what was changed.
 */
function clampNext(ctx, p, domain, proposed) {
  const now = Date.parse(ctx.now);
  const fallback = (why) => ({ at: ctx.addWorkdays(ctx.now, 3, p.retryAt), clamp: why });
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/.exec(String(proposed ?? "").trim());
  if (!m) return fallback("它没给读得懂的下次时间，按 3 个工作日算");
  let at;
  try {
    at = ctx.at(m[1], `${m[2]}:${m[3]}`);
  } catch {
    return fallback("它没给读得懂的下次时间，按 3 个工作日算");
  }
  let t = Date.parse(at);
  if (Number.isNaN(t)) return fallback("它没给读得懂的下次时间，按 3 个工作日算");
  let clamp = null;
  const lo = now + p.minLookMinutes * 60_000;
  const hi = now + p.maxLookDays * DAY;
  if (t < lo) {
    t = lo;
    clamp = `太近了，推到 ${p.minLookMinutes} 分钟后`;
  } else if (t > hi) {
    t = hi;
    clamp = `太远了，拉到 ${p.maxLookDays} 天内`;
  }
  at = ctx.local(new Date(t).toISOString());
  if (domain === "work") {
    const [from, to] = p.workHours.split("-");
    const date = dateOf(ctx, at);
    const clock = clockOf(ctx, at);
    if (!isWorkday(ctx, date) || clock > to) {
      at = nextWorkday(ctx, at, p.retryAt);
      clamp = `${clamp ? `${clamp}；` : ""}不在工作时间，挪到下一个工作日 ${p.retryAt}`;
    } else if (clock < from) {
      at = ctx.at(date, p.retryAt);
      clamp = `${clamp ? `${clamp}；` : ""}不在工作时间，挪到当天 ${p.retryAt}`;
    }
  }
  return { at, clamp };
}

/** Whether a commitment of this rule is still to be answered. */
const isOpen = (c) => c.status === "scheduled" || c.status === "waiting";

export default {
  name: "desk",
  description: "你在对话里交代的、没有单子的事：到点自己去看一眼，只在要你定的时候找你，办完了说一声",
  applies: { source: "desk" },
  params: {
    // The next look is never nearer than this many minutes, nor further than this many days.
    minLookMinutes: 60,
    maxLookDays: 14,
    // For work: the hours a next look may fall in, and the time of day a moved look, a retry and a question's reminder are put at.
    workHours: "09:30-20:00",
    retryAt: "10:00",
    // Looks the clock asks for in a day at most (a look asked for by an answer or a line added is not counted).
    dailyTimeLooks: 2,
    // A question is reminded `askNagMax` times at most, once a workday, and lapses after `backstopWorkdays` workdays.
    askNagMax: 2,
    backstopWorkdays: 5,
    // "过 3 天再看": this many workdays.
    laterWorkdays: 3,
    // The same question is not put again within this many days.
    dedupeDays: 3,
    // Where a look runs, and what it is told about where to read, by domain; empty: the run's own directory, nothing told.
    cwd: { work: "", personal: "", family: "" },
    hints: { work: "", personal: "", family: "" },
  },
  stages: [
    // A detour declared before the route: it returns to "watching".
    { id: "asking", label: "等你定", side: true, when: "要你定的时候" },
    { id: "watching", label: "盯着" },
    { id: "closing", label: "等你确认结束", done: "你确认办完了" },
    { id: "done", label: "办完了", end: true },
    { id: "dropped", label: "不盯了", end: true, endKind: "dropped" },
  ],

  assess(kase, ctx) {
    const p = ctx.params;
    const item = kase.primary;
    const did = kase.id.replace(/^desk:/, "");
    const title = item.title;
    const domain = item.fields.domain || "work";
    const owner = item.people.owner?.[0] ?? "";
    const facts = ctx.notes(kase.id);
    const fact = (field) => facts[`desk.${field}`]?.value ?? "";
    const now = ctx.now;
    const nowMs = Date.parse(now);

    const out = (stage, health, headline, actor, what, extra = {}) => ({
      stage,
      health,
      headline: flat(headline, 190) || "盯着",
      next: { actor, what },
      facts: extra.facts ?? [],
      commitments: extra.commitments ?? [],
      ...(extra.run ? { run: extra.run } : {}),
    });

    // ---- what is over --------------------------------------------------------------------------

    const mine = ctx.commitments(kase.id).filter((c) => c.key.startsWith(`desk:${did}:`));
    const answers = mine
      .filter((c) => c.answer)
      .map((c) => ({ c, a: c.answer }))
      .sort((x, y) => ms(x.a.at) - ms(y.a.at));
    const dropped = answers.find((x) => x.a.option === "drop");
    if (dropped) return out("dropped", "done", `不盯了（${stamp(ctx, dropped.a.at)} 你说不用盯了）`, "nobody", "不再盯");
    const finishedBy = answers.find((x) => x.c.key.includes(":done:") && x.a.option === "yes");
    if (finishedBy) return out("done", "done", `办完了（${stamp(ctx, finishedBy.a.at)} 你确认）`, "nobody", "办完了");

    // ---- the state, from the facts ---------------------------------------------------------------

    let looks = Number(fact("looks")) || 0;
    let seen = Number(fact("seen")) || 0;
    let woke = json(fact("woke"), null);
    let next = fact("next");
    let status = fact("status");
    let fails = Number(fact("fails")) || 0;
    let fail = json(fact("fail"), null);
    let answered = fact("answered");
    let log = json(fact("log"), []);
    let ask = json(fact("ask"), null);
    let asked = json(fact("asked"), []);
    let finish = json(fact("finish"), null);

    // Lines the person added to the matter, oldest first.
    const lines = Object.keys(item.fields)
      .filter((k) => /^note\.\d+$/.test(k))
      .map((k) => ({ text: item.fields[k], at: item.fields[`${k}.at`] ?? "" }))
      .sort((a, b) => ms(a.at) - ms(b.at));

    const commitmentOf = (key) => mine.find((c) => c.key === key);
    /** A question or a "done?" card counts as open from the judgment that puts it up, before the controller has made it. */
    const openAsk = (spec) => {
      if (!spec) return false;
      const c = commitmentOf(spec.key);
      return !c || isOpen(c);
    };
    const askKey = (a) => `desk:${did}:ask:${a.n}`;
    const doneKey = (f) => `desk:${did}:done:${f.n}`;

    let tookNow = false;

    // ---- a look is on its way: take what it brought, or wait for it ----------------------------------

    let inFlight = null;
    if (looks > seen) {
      const r = ctx.run("look", `look-${looks}`);
      const v = r?.value;
      const readable = v && typeof v === "object" && typeof v.status === "string" && typeof v.looked === "string" && typeof v.nextLook === "string" && typeof v.question === "string" && Array.isArray(v.options) && typeof v.finished === "string";
      if (r && (r.state === "done" || r.state === "stopped") && readable && !(typeof v.why === "string" && v.why)) {
        tookNow = true;
        seen = looks;
        fails = 0;
        fail = null;
        // The look is asked for about 60 characters; what it overshoots by is kept (a sentence cut in the middle reads worse than a long one).
        status = flat(v.status, 100) || status || "看过了";
        const nextAt = clampNext(ctx, p, domain, v.nextLook);
        next = nextAt.at;
        const entry = { n: looks, at: now, why: woke?.why ?? "", looked: flat(v.looked, 120), status, next, nextWhy: flat(v.nextWhy ?? "", 30), clamp: nextAt.clamp };
        // The question: not put again within the days after the same one was.
        const question = flat(v.question, 200);
        const options = v.options.map((o) => flat(o, 12)).filter((o) => o && o !== "过 3 天再看" && o !== "不用盯了").slice(0, 2);
        const declined = mine.some((c) => c.key.includes(":done:") && c.answer?.option === "no" && nowMs - ms(c.answer.at) < p.dedupeDays * DAY);
        finish = null;
        if (v.finished === "yes" && !declined) finish = { n: looks, at: now, why: flat(v.finishedWhy ?? "", 120) };
        if (finish) {
          // It says it is done: that is put to the person; a question beside it would only ask the other thing again.
          entry.question = null;
        } else if (question) {
          const again = asked.some((a) => same(a.question, question) && nowMs - ms(a.at) < p.dedupeDays * DAY);
          if (again) entry.question = `（${p.dedupeDays} 天内问过同一个，没再问）`;
          else {
            ask = { n: looks, at: now, question, options, status, looked: entry.looked };
            asked = [...asked, { at: now, question }].slice(-5);
            entry.question = question;
          }
        }
        log = [...log, entry].slice(-10);
      } else if (r && ["failed", "timeout", "lost", "not-started", "refused", "stopped", "done", "dismissed"].includes(r.state)) {
        // Came to nothing: told as that, and tried again the next workday (the next key), not left for a person to press.
        tookNow = true;
        seen = looks;
        fails += 1;
        const why = flat(r.why || v?.why || (r.state === "done" || r.state === "stopped" ? "它交回来的东西读不懂" : r.state), 120);
        next = domain === "work" ? nextWorkday(ctx, now, p.retryAt) : tomorrow(ctx, now, p.retryAt);
        fail = { at: now, why };
        log = [...log, { n: looks, at: now, why: woke?.why ?? "", looked: `没看成：${why}`, status, next, nextWhy: "", clamp: null }].slice(-10);
      } else {
        inFlight = r;
      }
    }

    // ---- no look on its way: is it time for one? -----------------------------------------------------

    let wake = null;
    let wokeNow = woke;
    if (looks === seen && !tookNow) {
      const lastWoke = ms(woke?.at);
      const fresh = answers.filter((x) => ms(x.a.at) > Math.max(lastWoke, ms(answered)));
      const latest = fresh[fresh.length - 1];
      const noteAt = lines.length > 0 ? ms(lines[lines.length - 1].at) : 0;
      const asking = ask && openAsk({ key: askKey(ask) });
      const closing = finish && openAsk({ key: doneKey(finish) });
      if (looks === 0) wake = "first";
      else if (latest && latest.a.option === "later3") {
        // The person asked to wait: the next look is that many workdays on, and the answer cost nothing.
        answered = latest.a.at;
        next = ctx.addWorkdays(latest.a.at, p.laterWorkdays, p.retryAt);
        fail = null;
      } else if (latest) wake = "answer";
      else if (noteAt > lastWoke) wake = "note";
      else if (next && nowMs >= ms(next) && !asking && !closing) {
        const today = dateOf(ctx, now);
        const tries = log.filter((e) => e.why === "time" && dateOf(ctx, e.at) === today).length;
        if (tries >= p.dailyTimeLooks) next = tomorrow(ctx, now, p.retryAt);
        else wake = "time";
      }
      if (wake) {
        looks += 1;
        wokeNow = { n: looks, at: now, why: wake };
        woke = wokeNow;
      }
    }

    // ---- the run for the look on its way ----------------------------------------------------------------

    let run;
    if (looks > seen) {
      const w = wokeNow ?? { n: looks, at: now, why: "first" };
      const upTo = ms(w.at);
      const history = mine
        .filter((c) => c.key.includes(":ask:") && c.answer && ms(c.answer.at) <= upTo)
        .sort((x, y) => ms(x.answer.at) - ms(y.answer.at))
        .slice(-3)
        .map((c) => ({ question: flat(c.ask.question, 200), answer: flat(c.answer.text ?? c.answer.label, 200), at: fullStamp(ctx, c.answer.at) }));
      run = [
        {
          flow: "look",
          key: `look-${w.n}`,
          label: `第 ${w.n} 次看一眼`,
          ...(owner ? { owner } : {}),
          input: {
            id: did,
            title,
            said: flat(item.fields.said ?? "", 500),
            domain,
            n: w.n,
            why: w.why,
            now: fullStamp(ctx, w.at),
            tz: ctx.tz,
            status,
            log: log.slice(-5).map((e) => ({ at: fullStamp(ctx, e.at), looked: e.looked, status: e.status })),
            askQuestion: ask ? ask.question : "",
            askOptions: ask ? ask.options : [],
            askAt: ask ? fullStamp(ctx, ask.at) : "",
            answers: history,
            notes: lines.filter((l) => ms(l.at) <= upTo).slice(-10).map((l) => ({ at: fullStamp(ctx, l.at), text: flat(l.text, 300) })),
            hint: p.hints?.[domain] ?? "",
            workdir: p.cwd?.[domain] ?? "",
          },
        },
      ];
    }

    // ---- the facts, and what the person sees --------------------------------------------------------------

    const put = (field, value) => ({ field: `desk.${field}`, value: String(value), evidence: `第 ${looks} 次看一眼` });
    const factList = [
      put("looks", looks),
      put("woke", woke ? JSON.stringify(woke) : ""),
      put("seen", seen),
      put("next", next),
      put("status", status),
      put("log", JSON.stringify(log)),
      put("ask", ask ? JSON.stringify(ask) : ""),
      put("asked", JSON.stringify(asked)),
      put("answered", answered),
      put("fails", fails),
      put("fail", fail ? JSON.stringify(fail) : ""),
      put("finish", finish ? JSON.stringify(finish) : ""),
    ];

    // What is put to the person. A card stays for as long as the look that put it up is the last to have asked.
    const commitments = [];
    const owned = owner || undefined;
    if (ask && owned) {
      const key = askKey(ask);
      commitments.push({
        key,
        title: flat(`${title}：${ask.question}`, 100),
        domain,
        owner: owned,
        trigger: { at: ask.at },
        ask: {
          header: flat(`${title}（${did}）`, 40),
          question: flat(ask.question, 300),
          options: [
            ...ask.options.map((label, i) => ({ id: `p${i + 1}`, label, description: "" })),
            { id: "later3", label: `过 ${p.laterWorkdays} 天再看`, description: "" },
            { id: "drop", label: "不用盯了", description: "" },
          ],
          allowOther: true,
        },
        brief: [`**${md(title, 40)}**：${md(ask.status, 80)}`, "", `这次看了：${md(ask.looked, 160)}`, "", "（「看一眼」只读，不会替你联系任何人。）"].join("\n"),
        nag: { everyWorkdays: 1, at: p.retryAt, max: p.askNagMax },
        backstop: { at: ctx.addWorkdays(ask.at, p.backstopWorkdays, p.retryAt) },
        level: "push",
        uses: [],
      });
    }
    if (finish && owned) {
      commitments.push({
        key: doneKey(finish),
        title: flat(`${title}：看起来办完了`, 100),
        domain,
        owner: owned,
        trigger: { at: finish.at },
        ask: {
          header: flat(`${title}（${did}）`, 40),
          question: "看起来办完了，结束吗？",
          options: [
            { id: "yes", label: "对，结束", description: "" },
            { id: "no", label: "还没完", description: "" },
          ],
          allowOther: true,
        },
        brief: [`**${md(title, 40)}**：${md(status, 80)}`, "", `依据：${md(finish.why, 160)}`].join("\n"),
        nag: { everyWorkdays: 1, at: p.retryAt, max: p.askNagMax },
        backstop: { at: ctx.addWorkdays(finish.at, p.backstopWorkdays, p.retryAt) },
        level: "push",
        uses: [],
      });
    }
    const base = { facts: factList, commitments, ...(run ? { run } : {}) };

    // Which state it is in, in words, and what happens next.
    if (finish && openAsk({ key: doneKey(finish) })) {
      return out("closing", "waiting", `${status}（看起来办完了，等你确认：${flat(finish.why, 80)}）`, "me", "等你确认结束", base);
    }
    if (ask && openAsk({ key: askKey(ask) })) {
      return out("asking", "waiting", `${status}（等你定：${flat(ask.question, 80)}）`, "me", `等你定：${flat(ask.question, 40)}`, base);
    }
    if (looks > seen) {
      if (inFlight?.state === "deferred") {
        return out("watching", "waiting", `这次「看一眼」先没起：${flat(inFlight.why ?? "额度不够", 120)}`, "system", "等有空位自己再看", base);
      }
      if (inFlight?.state === "slow") return out("watching", "waiting", "这次看一眼很久没动静了，等它到时限收场，再按明天重来", "system", "等这次看完", base);
      const first = looks === 1 && !status;
      return out("watching", "waiting", first ? "正在看第一眼" : `${status || "盯着"}（正在看第 ${looks} 次）`, "system", "正在看", base);
    }
    if (fail && fails > 0) {
      // The runtime's own words for what went wrong can be long and technical: the list line keeps the start of them, the log keeps all.
      return out("watching", "waiting", `这次没看成：${flat(fail.why, 50)}；${next ? stamp(ctx, next) : "明天"} 再看`, "system", next ? `下次看 ${stamp(ctx, next)}` : "明天再看", base);
    }
    return out("watching", "waiting", status || "盯着", "system", next ? `下次看 ${stamp(ctx, next)}` : "等下一次看", base);
  },
};
