import { primaryLink } from "./links.mjs";

export const defaultMode = (s, policy) => (policy.watchKinds ?? []).includes(primaryLink(s)?.split(":")[0]) ? "watch" : "drive";
export const modeOf = (s, policy) => s.modeExplicit ? s.mode : defaultMode(s, policy);
export const modeText = (s, policy) => modeOf(s, policy) === "drive" ? "我来推" : "我盯着";
