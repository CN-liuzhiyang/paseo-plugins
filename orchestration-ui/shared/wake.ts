// Who was told that a run is over, in the words the run view and the flow bar use.

import type { Wake } from "./run";

const WHO = { steward: "负责会话", caller: "发起的对话", explicit: "指定的对话" } as const;

/** The line at the bottom of an opened run. */
export function wakeLine(wake: Wake): string {
  if (wake.to === null || wake.via === null) return "跑完告诉了：没人";
  return wake.ok === false ? `想告诉${WHO[wake.via]}，没送到` : `跑完告诉了：${WHO[wake.via]}`;
}

/** The flow bar's row for the session in charge of the flow; null when it was not the one told. */
export function stewardRow(wake: Wake | null): { agentId: string; text: string } | null {
  if (!wake || wake.via !== "steward" || wake.to === null) return null;
  return { agentId: wake.to, text: `负责会话：${wake.ok === false ? "没送到" : "已告知"}` };
}
