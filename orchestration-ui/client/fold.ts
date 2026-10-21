// How much of a long output the drawer shows before "展开". Measured on real runs: a drafted
// patch field of 80 to 265 lines and a list of some 20 check reports, each 14 to 39 lines long,
// pushed everything else in the drawer out of sight. With these, the longest nodes fit in about
// two dozen lines and "who did it" is back on the first screen.

/** A text longer than this many lines, or characters, starts folded. */
export const TEXT_FOLD_LINES = 8;
export const TEXT_FOLD_CHARS = 600;
/** What a folded text shows: this many lines, and no more than this many characters. */
export const TEXT_PREVIEW_LINES = 6;
export const TEXT_PREVIEW_CHARS = 400;
/** A list longer than this starts folded, showing the first few items. */
export const LIST_FOLD_ITEMS = 5;
export const LIST_PREVIEW_ITEMS = 3;

export interface TextFold {
  folded: boolean;
  preview: string;
  lines: number;
  chars: number;
}

export function foldText(text: string): TextFold {
  const all = text.split("\n");
  const lines = all.length;
  const chars = text.length;
  if (lines <= TEXT_FOLD_LINES && chars <= TEXT_FOLD_CHARS) return { folded: false, preview: text, lines, chars };
  let preview = all.slice(0, TEXT_PREVIEW_LINES).join("\n");
  if (preview.length > TEXT_PREVIEW_CHARS) preview = `${preview.slice(0, TEXT_PREVIEW_CHARS)}…`;
  return { folded: true, preview, lines, chars };
}

/** How many items a list shows folded; all of them when it is short. */
export function foldList(length: number): { folded: boolean; shown: number } {
  return length > LIST_FOLD_ITEMS ? { folded: true, shown: LIST_PREVIEW_ITEMS } : { folded: false, shown: length };
}
