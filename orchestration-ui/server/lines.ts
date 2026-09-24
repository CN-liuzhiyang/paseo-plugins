import { open, type FileHandle } from "node:fs/promises";

// Byte-level reading of an append-only JSONL file. Offsets are bytes, never characters, so a
// reader can resume exactly where it stopped; a final line without "\n" may still be being
// written and is left for the next read.

const NEWLINE = 0x0a;

export interface Line {
  /** Byte offset of the line's first byte. */
  offset: number;
  text: string;
}

/** Complete lines in `buffer`, which starts at byte `base` of the file. Blank lines are skipped. */
export function splitComplete(buffer: Uint8Array, base = 0): { lines: Line[]; consumed: number } {
  const lines: Line[] = [];
  const decoder = new TextDecoder("utf-8");
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== NEWLINE) continue;
    let end = index;
    if (end > start && buffer[end - 1] === 0x0d) end -= 1;
    const text = decoder.decode(buffer.subarray(start, end));
    if (text.trim() !== "") lines.push({ offset: base + start, text });
    start = index + 1;
  }
  return { lines, consumed: start };
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

export interface Chunk {
  lines: Line[];
  nextOffset: number;
  size: number;
  /** `offset` was past the end: the file was replaced, and this chunk starts from 0. */
  reset: boolean;
  /** Complete lines remain after nextOffset. */
  more: boolean;
}

/**
 * Complete lines from `offset`, about `budget` bytes of them. A single line longer than the
 * budget is still returned whole, so a huge prompt cannot wedge the reader.
 */
export async function readFrom(file: string, offset: number, budget = 1 << 20): Promise<Chunk> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const reset = offset > size;
    const from = reset ? 0 : offset;
    let length = Math.min(budget, size - from);
    for (;;) {
      const buffer = await readAt(handle, from, length);
      const { lines, consumed } = splitComplete(buffer, from);
      const atEnd = from + buffer.length >= size;
      if (consumed > 0 || atEnd) {
        const nextOffset = from + consumed;
        // Anything left is either a half-written last line or more whole lines.
        const more = !atEnd && nextOffset < size;
        return { lines, nextOffset, size, reset, more };
      }
      length = Math.min(length * 4, size - from);
    }
  } finally {
    await handle.close();
  }
}

/** The first complete line, or null while it is still being written. */
export async function readHeadLine(file: string, first = 64 << 10, cap = 64 << 20): Promise<string | null> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    let length = Math.min(first, size);
    for (;;) {
      const buffer = await readAt(handle, 0, length);
      const newline = buffer.indexOf(NEWLINE);
      if (newline !== -1) return new TextDecoder("utf-8").decode(buffer.subarray(0, newline)).replace(/\r$/, "");
      if (length >= size || length >= cap) return null;
      length = Math.min(length * 4, size, cap);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Complete lines at the end of the file, oldest first. The window grows until it holds at least
 * one whole line, so a large run.end is still found.
 */
export async function readTailLines(file: string, first = 64 << 10, cap = 64 << 20): Promise<Line[]> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    let length = Math.min(first, size);
    for (;;) {
      const from = size - length;
      const buffer = await readAt(handle, from, length);
      // Unless the window starts at 0, its first line is a fragment of a longer one.
      const skip = from === 0 ? 0 : buffer.indexOf(NEWLINE) + 1;
      if (from === 0 || skip > 0) {
        const { lines } = splitComplete(buffer.subarray(skip), from + skip);
        if (lines.length > 0 || from === 0 || length >= cap) return lines;
      }
      if (length >= cap) return [];
      length = Math.min(length * 4, size, cap);
    }
  } finally {
    await handle.close();
  }
}
