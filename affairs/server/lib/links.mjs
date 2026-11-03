// Outside references in what a person reads (an 易协作 ticket number, a Feishu task) become addresses they can open.
// One pure function does it for every place: text and the policy's templates in, segments out. Where the segments go
// (the card, a line, a question, a push) is the caller's business; this file touches nothing.
//
// Policy: `links` is { "<kind>": "https://…/{ref}" }; `linkHash` is the kind a bare "#12345" means. A kind with no
// template is left as it is. A reference is recognised only in these forms, so a date, a plate or a revision is never taken for one:
//   - "#" and five or more digits                      -> the kind of `linkHash`
//   - "#" and the number of the affair's own link      -> that link's kind (any length, it is registered)
//   - the number or id of the affair's own link, bare  -> that link's kind (five or more characters, on its own)
//   - "<kind>:<ref>" for a kind that has a template    -> that kind

/** @typedef {{ text: string, href?: string }} Segment */
/** @typedef {{ templates: Record<string, string>, hashKind: string, registered: Array<{ kind: string, ref: string }> }} LinkContext */

const OPENABLE = /^https?:\/\/[^\s{}]+\{ref\}[^\s{}]*$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "gcp:555001", "gcp:#700/字段", "feishu-task:5e7b…" -> { kind, ref }, or null. */
export function parseLink(link) {
  const m = /^([\w-]+):(.+)$/.exec(String(link ?? "").trim());
  if (!m) return null;
  const ref = m[2].trim().replace(/^#/, "").split(/[\/\s]/)[0];
  return ref ? { kind: m[1], ref } : null;
}

/** Templates that can be used: an http(s) address with {ref} in it. Anything else is dropped, never half-used. */
export function usableTemplates(links) {
  return Object.fromEntries(Object.entries(links ?? {}).filter(([kind, template]) => /^[\w-]+$/.test(kind) && typeof template === "string" && OPENABLE.test(template)));
}

/** What `policy.links` says is wrong with it, as sentences (for doctor and the plugin's start). */
export function linkProblems(policy) {
  const out = [];
  for (const [kind, template] of Object.entries(policy.links ?? {})) {
    if (!/^[\w-]+$/.test(kind) || typeof template !== "string" || !OPENABLE.test(template)) out.push({ key: `links.${kind}`, text: `links.${kind} 要写成带 {ref} 的 http(s) 地址（比如 https://…/{ref}），现在这条不会用` });
  }
  if (policy.linkHash && !usableTemplates(policy.links)[policy.linkHash]) out.push({ key: "linkHash", text: `linkHash 写的是「${policy.linkHash}」，但 links 里没有它的地址，#单号 不会变成链接` });
  return out;
}

/** The address of one reference, or null when its kind has no template. */
export function hrefOf(templates, kind, ref) {
  const template = templates[kind];
  return template ? template.replace("{ref}", encodeURIComponent(ref)) : null;
}

/** @returns {LinkContext} */
export function linkContext(policy, link) {
  const own = parseLink(link);
  return { templates: usableTemplates(policy.links), hashKind: String(policy.linkHash ?? ""), registered: own ? [own] : [] };
}

/**
 * The text as segments; those with an href are the references. Without any template the whole text is one segment.
 * @returns {Segment[]}
 */
export function linkify(text, ctx) {
  const source = String(text ?? "");
  const found = [];
  const take = (re, kindOf) => {
    for (const m of source.matchAll(re)) {
      const kind = kindOf(m);
      const href = kind ? hrefOf(ctx.templates, kind, m.groups?.ref ?? m[1]) : null;
      if (href) found.push({ start: m.index, end: m.index + m[0].length, href });
    }
  };
  if (ctx.hashKind) take(/(?<![\w#&/])#(?<ref>\d{5,12})(?![\w])/g, () => ctx.hashKind);
  for (const { kind, ref } of ctx.registered) {
    if (!ctx.templates[kind]) continue;
    take(new RegExp(`(?<![\\w#&/])#(?<ref>${esc(ref)})(?![\\w])`, "g"), () => kind);
    if (ref.length >= 5) take(new RegExp(`(?<![\\w.#&/:-])(?<ref>${esc(ref)})(?![\\w]|[.-]\\w)`, "g"), () => kind);
  }
  for (const kind of Object.keys(ctx.templates)) take(new RegExp(`(?<![\\w#&/:.-])${esc(kind)}:#?(?<ref>[A-Za-z0-9][\\w-]{2,})(?![\\w])`, "g"), () => kind);
  // Left to right; of two that overlap the earlier, then the longer, stays.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const segments = [];
  let at = 0;
  for (const f of found) {
    if (f.start < at) continue;
    if (f.start > at) segments.push({ text: source.slice(at, f.start) });
    segments.push({ text: source.slice(f.start, f.end), href: f.href });
    at = f.end;
  }
  if (at < source.length || segments.length === 0) segments.push({ text: source.slice(at) });
  return segments;
}

export const hasLinks = (segments) => segments.some((s) => s.href);

/** Segments, or nothing when there is no reference in the text (what a card or a line carries along). */
export const partsOf = (text, ctx) => {
  const segments = linkify(text, ctx);
  return hasLinks(segments) ? segments : undefined;
};

/**
 * For a place that can only show text (a push, a question): each reference is followed by its address, spaced apart so a
 * chat app takes the address for a link and not the punctuation after it.
 */
export function withUrls(text, ctx) {
  const segments = linkify(text, ctx);
  if (!hasLinks(segments)) return String(text ?? "");
  return segments
    .map((s, i) => {
      if (!s.href) return s.text;
      const after = segments[i + 1]?.text ?? "";
      return `${s.text} ${s.href}${after && !/^\s/.test(after) ? " " : ""}`;
    })
    .join("");
}
