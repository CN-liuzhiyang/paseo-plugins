import type { PanelData, PanelEvent } from "./panel";

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

/**
 * How each kind of thing that happened is drawn: its dot (filled = done on our side, hollow = him or nothing much), the
 * color of the dot and of the small title. The same table for every row, so one thing looks the same wherever it is.
 * "看了一眼" and "回你" are both ours but are told apart at a glance: the look is an accent dot with a plain title, the
 * reply is a foreground dot with an accent title and a bar beside its sentence.
 */
export type EventStyle = { dot: "solid" | "ring"; color: (c: Colors) => string; title: (c: Colors) => string; bar?: boolean };
export const KINDS: Record<PanelEvent["kind"], EventStyle> = {
  look: { dot: "solid", color: (c) => c.accent, title: (c) => c.foreground },
  reply: { dot: "solid", color: (c) => c.foreground, title: (c) => c.accent, bar: true },
  said: { dot: "ring", color: (c) => c.foreground, title: (c) => c.foreground },
  answered: { dot: "ring", color: (c) => c.foreground, title: (c) => c.foreground },
  asked: { dot: "solid", color: (c) => c.statusWarning, title: (c) => c.statusWarning },
  note: { dot: "ring", color: (c) => c.foregroundMuted, title: (c) => c.foregroundMuted },
  next: { dot: "ring", color: (c) => c.foregroundMuted, title: (c) => c.foreground },
  read: { dot: "ring", color: (c) => c.foregroundMuted, title: (c) => c.foregroundMuted },
  done: { dot: "solid", color: (c) => c.statusSuccess, title: (c) => c.statusSuccess },
  stopped: { dot: "solid", color: (c) => c.foregroundMuted, title: (c) => c.foregroundMuted },
  resumed: { dot: "solid", color: (c) => c.accent, title: (c) => c.foreground },
  flow: { dot: "solid", color: (c) => c.accent, title: (c) => c.foreground },
  error: { dot: "solid", color: (c) => c.statusDanger, title: (c) => c.statusDanger },
};

/** The three ways to narrow the rows once all of them are open: what he said, what changed. */
export const FILTERS = [
  { id: "all", label: "全部", keep: (_e: PanelEvent) => true },
  { id: "yours", label: "你说的", keep: (e: PanelEvent) => e.yours },
  { id: "changed", label: "有变化的", keep: (e: PanelEvent) => e.changed },
] as const;
export type FilterId = (typeof FILTERS)[number]["id"];

/** How many rows each filter keeps; a filter that keeps none is not offered. */
export const filterCounts = (items: readonly PanelEvent[]) => FILTERS.map((f) => ({ id: f.id, label: f.label, n: items.filter(f.keep).length }));
