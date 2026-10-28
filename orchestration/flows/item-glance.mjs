// Item glance: one read-only look at a matter a person asked to have followed ("盯一下洗牙，月底前要约上").
//
// A matter like that has no ticket anywhere. The reconcile plugin keeps it and decides, without a model, when to look; this is the
// look: one agent reads where the matter stands (wherever the caller says to read, which is its business and not this flow's), says
// it in one line, proposes when to look again, and says what only the person can decide. What it returns is a proposal: the plugin's
// rule bounds the time, drops a question that was put lately, and never ends a matter on the agent's word.
//
// It changes nothing and contacts no one -- `effects: "none"` is a request in the prompt, not a sandbox (fences.mjs says so for each
// provider). Anything to do about the world is written into `question` for the person to do.
//
// Needs a role called `glance` (roles/glance.md in this checkout): the model of every look is that one file.
//
//   node runtime/orch.mjs run item-glance --input @input.json

import { flow, define, text, count, choice, list, group } from "../runtime/flow.mjs";

export const ROLE = "glance";

const WHY = {
  first: "第一次看：刚交代下来",
  answer: "他回答了你上次问的，或者回答了别的问题",
  note: "他补了一句话",
  time: "上次定的下次看的时间到了",
};
const DOMAIN = { work: "工作", personal: "个人", family: "家庭" };

const lines = (items, one) => (items.length === 0 ? ["- （没有）"] : items.map((x) => `- ${one(x)}`));

export const glance = define({
  name: "glance",
  title: "看一眼",
  headline: "status",
  effects: "none",
  timeout: "15m",
  returns: {
    status: text("现状，一句话，不超过 60 字，写事实（谁做了什么、什么时候），不写计划，不写“我会”。读不到就写读不到什么。"),
    looked: text("这次看了什么、发现了什么，一句话，不超过 120 字。"),
    nextLook: text("下次看的时间，本地时间，写成 YYYY-MM-DD HH:mm（时区在输入里）。挑可能有变化的时候，不是越早越好。不要写星期几。"),
    nextWhy: text("为什么是那个时候，不超过 30 字。"),
    question: text("只有他能定的事，一句话；没有就空字符串。同一件事上次问过、情况没变，就不要再问。"),
    options: list(text(), "对 question 的可能回答，0 到 2 个，每个不超过 12 个字；没有问题就空列表。不要写“过几天再看”“不用盯了”，系统会加。"),
    finished: choice(["no", "yes"], "这件事办完了吗。只有你看到了办完的证据才写 yes。"),
    finishedWhy: text("办完的证据，不超过 120 字；没办完就空字符串。"),
  },
  prompt: (i) =>
    [
      "你在替一个人盯着一件他交代给你的事。现在要看一眼：这件事到现在是什么情况，下一次该什么时候再看，有没有只有他能定的事要问他。",
      "",
      "## 这件事",
      `- 名字：${i.title}（${i.id}，${DOMAIN[i.domain] ?? i.domain}）`,
      `- 他的原话：${i.said}`,
      `- 现在：${i.now}（${i.tz}）。今天几号、星期几以这个为准，不要自己猜。`,
      `- 这次为什么看：${WHY[i.why] ?? i.why}（第 ${i.n} 次）`,
      "",
      "## 之前",
      `- 上一次的现状：${i.status === "" ? "（还没看过）" : i.status}`,
      "- 之前几次看了什么：",
      ...lines(i.log, (e) => `${e.at}：${e.looked}（那时的现状：${e.status}）`).map((l) => `  ${l}`),
      "- 他后来补的话：",
      ...lines(i.notes, (n) => `${n.at}：${n.text}`).map((l) => `  ${l}`),
      i.askQuestion === ""
        ? "- 你上次没有问他什么。"
        : `- 你上次问他的（${i.askAt}）：${i.askQuestion}${i.askOptions.length > 0 ? `（给的选项：${i.askOptions.join(" / ")}）` : ""}`,
      "- 他的回答：",
      ...lines(i.answers, (a) => `${a.at}：问“${a.question}” → 答“${a.answer}”`).map((l) => `  ${l}`),
      "",
      "## 去哪里读",
      i.hint === "" ? "没有指定：从他的原话和上面这些里判断；读不到就如实说读不到。" : i.hint,
      "",
      "## 要做的",
      "- **只读。** 不联系任何人，不改任何东西：不发消息，不改、不完成、不新建任务，不改日历和文档。要联系谁、要改什么，写进 question，让他自己去做。",
      "- 要读的东西自己去读；读不到就如实写读不到，不要编。",
      "- status 写事实，给人看的一句话。",
      "- nextLook 选“可能有变化的时候”：等别人回复就选对方多半会回的时候，等一个日期就选那个日期前后，不要为了稳妥选得很近。它会被限制在 1 小时到 14 天之间。",
      "- question 只放他能定的事。拿不准要不要问时，宁可问；但同一件事上次问过、情况没变，不要再问。",
      "- finished 写 yes 只在你看到了办完的证据的时候；拿不准就写 no。",
      "- 所有文字用中文，不要写星期几，时间只写 YYYY-MM-DD HH:mm。",
    ].join("\n"),
});

export default flow({
  name: "item-glance",
  description: "替人盯一件没有单子的事：读相关的地方，写一句现状、定下次什么时候再看、需要时问他一句。只读，不联系任何人，不改任何东西",
  phases: [],
  inputs: {
    id: text("这件事的编号，像 D12"),
    title: text("这件事的短名字"),
    said: text("他交代这件事时的原话"),
    domain: choice(["work", "personal", "family"], "工作 / 个人 / 家庭"),
    n: count("这是第几次看"),
    why: choice(["first", "answer", "note", "time"], "为什么看这一次"),
    now: text("现在，本地时间，带星期，如 2026-11-03 周二 10:02"),
    tz: text("时区"),
    status: text("上一次的现状；还没看过就是空字符串"),
    log: list(group({ at: text("那次看的时间，带星期"), looked: text("那次看了什么"), status: text("那次的现状") }), "最近几次看了什么，旧的在前"),
    askQuestion: text("上次问他的问题；没问过就是空字符串"),
    askOptions: list(text(), "上次问题给的选项"),
    askAt: text("上次问的时间，带星期；没问过就是空字符串"),
    answers: list(group({ question: text("问了什么"), answer: text("他怎么答"), at: text("什么时候答的，带星期") }), "他回答过的，旧的在前"),
    notes: list(group({ at: text("什么时候补的，带星期"), text: text("补的话") }), "他后来补的话，旧的在前"),
    hint: text("去哪里读（调用方写的）；没有就是空字符串"),
    workdir: text("这次看一眼在哪个目录里起；空字符串就是运行本身的目录"),
  },
  grants: [],

  async run(input, $) {
    // The model of every look is the role's: a missing role is found before anything is spent.
    $.ctx.role(ROLE);
    return $.ask(glance, input, { role: ROLE, ...(input.workdir === "" ? {} : { cwd: input.workdir }) });
  },

  summarize: (value) => (value?.looked ? `看了一眼：${value.looked}` : "没有结果"),
});
