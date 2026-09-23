// An agent's answer shown in a card's markdown element. It keeps the formatting people want to
// read (emphasis, lists, code, tables, links) and loses what the agent must not do on a card:
//
// - tags: `<at id=all></at>` would @ everyone in a group on every patch, `<font>` or `<link>`
//   would restyle the card. Outside code every `<` is escaped, and every entity that could
//   decode into one.
// - disguised links: `[the docs](https://evil.example)` shows its target next to the text.
// - things Feishu rejects outright, which would leave the card stuck on its previous state:
//   images (a card only shows images uploaded by this app, anything else is 200570; they
//   become links) and more than a few tables (230099).
//
// Code is shown as written, except that a zero-width space goes after `<` before a letter,
// between `](`, and after an entity's `&`. So nothing inside code can become a tag or a link
// either, and if this parser and Feishu's ever disagree about where code starts and ends,
// the text on the wrong side is still inert.

// Feishu refuses a card with a fourth table (230099/11310, per the official OpenClaw plugin).
const MAX_TABLES = 3;
const ZWSP = "​";
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;

export function cardMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const tables = { count: 0 };
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (prose.length > 0) out.push(renderProse(prose, tables));
    prose = [];
  };
  for (const line of lines) {
    if (fence !== null) {
      const closing = CLOSING_FENCE.exec(line)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) {
        out.push(line);
        fence = null;
      } else {
        out.push(inert(line));
      }
      continue;
    }
    const opening = OPENING_FENCE.exec(line);
    // A backtick fence's info string cannot hold a backtick (CommonMark 4.5).
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      flush();
      fence = opening[1];
      out.push(inert(line));
      continue;
    }
    prose.push(line);
  }
  flush();
  // An unclosed fence would swallow the card's footer.
  if (fence !== null) out.push(fence);
  return out.join("\n");
}

/** Code as written, but with nothing in it that can become a tag, a link or an entity. */
function inert(code: string): string {
  return code
    .replace(/<(?=[A-Za-z/!?])/g, `<${ZWSP}`)
    .replace(/\]\(/g, `]${ZWSP}(`)
    .replace(/&(?=#|[A-Za-z]+;?)/g, `&${ZWSP}`);
}

/** Lines outside fences: tables counted, then the text as one piece so links can span lines. */
function renderProse(lines: string[], tables: { count: number }): string {
  const blocks: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) blocks.push(renderText(run.join("\n")));
    run = [];
  };
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      let end = index + 2;
      while (end < lines.length && lines[end].includes("|") && lines[end].trim() !== "") end++;
      const rows = lines.slice(index, end);
      tables.count += 1;
      if (tables.count > MAX_TABLES) {
        flush();
        blocks.push(["```", ...rows.map(inert), "```"].join("\n"));
      } else {
        run.push(...rows);
      }
      index = end - 1;
      continue;
    }
    run.push(demoteHeading(lines[index]));
  }
  flush();
  return blocks.join("\n");
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("|") || !line.includes("-")) return false;
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

// Card headings run large on a phone; keep them, one size down.
function demoteHeading(line: string): string {
  return line.replace(/^ {0,3}#{1,3}(?=\s)/, "####");
}

/** Prose with its code spans set aside, made inert, and put back as inert code. */
function renderText(text: string): string {
  const codes: string[] = [];
  const hidden = codeSpans(text)
    .map((part) => {
      if (!part.code) return part.text;
      codes.push(inert(part.text));
      return `\u0000${codes.length - 1}\u0000`;
    })
    .join("");
  const safe = hidden
    // An entity would be decoded back into the tag it spells; a bare `&` in a URL is fine.
    // HTML decodes the old named ones even without the semicolon: `&ltat` is `<at`.
    .replace(/&(?=#|lt|gt|amp|quot|apos|nbsp|[A-Za-z][A-Za-z0-9]*;)/gi, "&#38;")
    .replace(/</g, "&#60;")
    // Images first: `![alt](src)` would otherwise read as `!` and a link.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_match, alt: string, src: string) =>
      /^https?:\/\//i.test(src) ? `图片 ${alt}（[${src}](${src})）` : `[图片 ${alt || src}]`,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (match, label: string, href: string) => {
      if (!/^https?:\/\//i.test(href)) return `${label}（${href}）`;
      return label.trim() === href ? match : `${label}（[${href}](${href})）`;
    });
  return safe.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)]);
}

/**
 * Splits text into code spans and the rest, as CommonMark does: a span opens on a run of
 * backticks not escaped by a backslash and closes on the next run of the same length, within
 * the same paragraph; a run with no partner is literal text.
 */
export function codeSpans(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  let last = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] !== "`") {
      index++;
      continue;
    }
    let end = index;
    while (text[end] === "`") end++;
    const length = end - index;
    const paragraph = /\n[ \t]*\n/g;
    paragraph.lastIndex = end;
    const limit = paragraph.exec(text)?.index ?? text.length;
    let close = -1;
    for (let cursor = end; cursor < limit; ) {
      if (text[cursor] !== "`") {
        cursor++;
        continue;
      }
      let runEnd = cursor;
      while (text[runEnd] === "`") runEnd++;
      if (runEnd - cursor === length) {
        close = cursor;
        break;
      }
      cursor = runEnd;
    }
    if (close === -1 || close + length > limit) {
      index = end;
      continue;
    }
    if (index > last) parts.push({ code: false, text: text.slice(last, index) });
    parts.push({ code: true, text: text.slice(index, close + length) });
    index = last = close + length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}
