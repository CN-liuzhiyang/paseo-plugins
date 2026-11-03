import type { PanelData } from "./panel";

// The pure part of how the panel looks (no React): the word and theme color of each state, and the faint wash of a color.

export type Colors = {
  readonly surface0: string;
  readonly surface1: string;
  readonly surface2: string;
  readonly border: string;
  readonly foreground: string;
  readonly foregroundMuted: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly statusSuccess: string;
  readonly statusWarning: string;
  readonly statusDanger: string;
};

/** A faint wash of a theme color; falls back to a surface when the color is not a plain #rrggbb. */
export const tint = (color: string, alpha: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : fallback);

export const MOODS: Record<PanelData["mood"], { label: string; color: (c: Colors) => string }> = {
  watching: { label: "在盯", color: (c) => c.accent },
  ask: { label: "等你", color: (c) => c.statusWarning },
  done: { label: "办完", color: (c) => c.statusSuccess },
  error: { label: "出错", color: (c) => c.statusDanger },
  paused: { label: "暂停", color: (c) => c.foregroundMuted },
  stopped: { label: "不盯了", color: (c) => c.foregroundMuted },
};
