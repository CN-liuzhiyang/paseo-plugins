// Text that comes from a file somebody else writes (the orchestration runtime's event files, which anyone who can
// write the log directory can write too) is not trusted: before it is shown on a page it is cut to a length and
// stripped of what cannot be drawn or can mislead a reader. The list of characters is
// orchestration/fixtures/affair-cases.json, the same one runtime/affair.mjs and orchestration-ui test against.

export const TEXT_LIMIT = 120;

// Built from code points rather than written out, because most of these are invisible and a literal one in a
// source file is lost the first time an editor strips it.
//   controls, line and paragraph separators (\p{Cc} \p{Zl} \p{Zp});
//   direction: 061C, 200E, 200F, 202A-202E, 2066-2069;
//   nothing drawn: 200B, 2060, FEFF, 00AD, 034F, 180E, 2800, the Hangul fillers 115F 1160 3164 FFA0;
//   the tag block E0000-E007F.
// The joiners 200C, 200D and the emoji selector FE0F are ordinary text and stay.
const HIDDEN_RANGES: Array<[number, number]> = [
  [0x061c, 0x061c], [0x200b, 0x200b], [0x200e, 0x200f], [0x2060, 0x2060], [0x202a, 0x202e], [0x2066, 0x2069],
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x180e, 0x180e], [0x2800, 0x2800], [0x115f, 0x115f], [0x1160, 0x1160],
  [0x3164, 0x3164], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xe0000, 0xe007f],
];
const BACKSLASH = String.fromCharCode(92);
const codePoint = (n: number) => `${BACKSLASH}u{${n.toString(16)}}`;
const HIDDEN = HIDDEN_RANGES.map(([a, b]) => (a === b ? codePoint(a) : `${codePoint(a)}-${codePoint(b)}`)).join("");
const CLASS = `[${BACKSLASH}p{Cc}${BACKSLASH}p{Zl}${BACKSLASH}p{Zp}${HIDDEN}]`;
const UNSAFE_ALL = new RegExp(CLASS, "gu");
const UNSAFE_ANY = new RegExp(CLASS, "u");

/** Whether a text holds a character that is not drawn or can mislead. */
export const hasUnsafe = (text: string): boolean => UNSAFE_ANY.test(text);

/** A text as one clean line of at most `limit` characters; null when nothing is left. Not a string: null. */
export function cleanText(raw: unknown, limit: number = TEXT_LIMIT): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(UNSAFE_ALL, " ").replace(/ {2,}/g, " ").trim();
  if (text === "") return null;
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
}

/** What an agent id looks like (the ones Paseo gives are UUIDs); anything else is not opened as an agent. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const agentIdOf = (raw: unknown): string | null => (typeof raw === "string" && AGENT_ID.test(raw) ? raw : null);
