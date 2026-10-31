// Again smoke: one cheap agent is asked for a colour, then asked again in the same conversation to name another and to say
// which one it named the first time. A few cents; it is how a person checks, against a real Paseo, that `$.again` goes to the
// agent that answered -- and that the agent remembers -- instead of starting a new one.
//
//   node runtime/orch.mjs run flows/again-smoke.mjs
//
// In the run's events the second call has `continues` pointing at the first and the same agent; the agent's own conversation
// holds both messages.

import { flow, define, text } from "../runtime/flow.mjs";

const name = define({
  name: "name-a-colour",
  title: "说一个颜色",
  headline: "color",
  effects: "none",
  timeout: "5m",
  returns: {
    color: text("one colour word"),
    recalled: text("the colour you named the first time in this conversation, or an empty string if this is the first time"),
  },
  prompt: () => "Name a colour. If you have already named one in this conversation, say which in `recalled`; otherwise leave `recalled` empty.",
});

export default flow({
  name: "again-smoke",
  description: "再问冒烟：问一个颜色，再接着同一个 agent 问一次，看它记不记得上一轮；几分钱",
  phases: [],
  inputs: {},
  grants: [],
  async run(_, $) {
    const first = await $.ask(name, {}, { role: "fast" });
    const second = await $.again(first, "Name a different colour this time, and say in `recalled` which one you named before.");
    return { first: first.color, second: second.color, recalled: second.recalled, remembered: second.recalled.trim().toLowerCase() === first.color.trim().toLowerCase() };
  },
  summarize: (value) => `${value.remembered ? "记得" : "不记得"}上一轮：${value.first} → ${value.second}（它说上一轮是「${value.recalled}」）`,
});
