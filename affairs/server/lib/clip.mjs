// How much of a text read from outside the panel keeps. A reading can be a long ticket title or a long list; the panel shows the
// first CLIP_CHARS characters with … after them, and the whole (up to FULL_CHARS) to open.
export const CLIP_CHARS = 120;
export const FULL_CHARS = 600;

/** `text` cut to `max` characters (whole characters, not halves of a pair), with … where it was cut. */
export function clip(text, max) {
  const chars = Array.from(String(text ?? ""));
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}
