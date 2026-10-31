import { durationText, SITUATION, type Ball, type Group, type ListRow } from "../shared/graph";

// What the list says, apart from how it is drawn: the second line of a row, how long, and which groups
// there are with how many rows each shows. No renderer here, so that a test can read the structure.

// "你 · 回答：…" -> "回答：…"
const whatOf = (label: string) => (label.includes(" · ") ? label.slice(label.indexOf(" · ") + 3) : "");

const ACTOR: Record<Ball, string> = { me: "你", them: "别人", system: "系统", nobody: "" };

export const GROUP_ORDER: Group[] = ["me", "errors", "them", "system", "mine", "done"];

/** How many of the ended ones are shown before "更早的": the list is for what is going on. */
export const ENDED_SHOWN = 3;

/**
 * How long, in words. A clock that starts when tracking began is "at least": it says so, and an item that was already over
 * when tracking began does not get a length made up for it.
 */
export function waitText(row: ListRow): string {
  if (row.group === "mine") return ""; // your own work is not something to nag about: no clock on it
  const w = row.waiting;
  if (w.ended) return w.ms !== null ? `${w.atLeast ? "至少用了" : "用了"} ${durationText(w.ms)}` : w.atLeast ? "追踪前就结束了" : "";
  return w.ms !== null ? `${w.atLeast ? "至少已等" : "已等"} ${durationText(w.ms)}` : "";
}

/** The second line of a row: where it is, whose ball it is (what you are to answer, when there is a question; what went wrong, when a flow did), how long. */
export function statusLine(row: ListRow): string {
  const who = row.group === "done" ? "" : row.group !== "me" ? ACTOR[row.who.actor] : row.asking > 0 ? whatOf(row.who.label) || ACTOR.me : SITUATION[row.situation].name;
  return [row.stageLabel, who, waitText(row)].filter(Boolean).join(" · ");
}

/**
 * The groups to draw, in order: one with nothing in it is not drawn (that nothing wants you is said once, above the list), and the
 * ended ones show the first few and count the rest. `older`: the rest has been asked for.
 */
export function arrange(rows: ListRow[], older = false, extra: Partial<Record<Group, unknown>> = {}): Array<{ group: Group; total: number; shown: ListRow[]; hidden: number }> {
  return GROUP_ORDER.flatMap((group) => {
    const here = rows.filter((r) => r.group === group);
    if (here.length === 0 && !extra[group]) return [];
    const capped = group === "done" && !older && here.length > ENDED_SHOWN;
    return [{ group, total: here.length, shown: capped ? here.slice(0, ENDED_SHOWN) : here, hidden: capped ? here.length - ENDED_SHOWN : 0 }];
  });
}
