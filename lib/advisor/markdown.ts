// A small, safe markdown parser for assistant replies (plan section 12, decision D9: no new dependency). PURE.
//
// It produces an AST of a few node kinds; the React renderer maps nodes to elements and NEVER uses dangerouslySetInnerHTML. Raw HTML in
// the source is just text (React escapes it), images are reduced to their alt text, and a link is clickable only when its target is one of
// the app's own pages (isKnownAppPath) or an https irs.gov / ct.gov URL. Everything else (javascript:, data:, other hosts, unknown paths)
// becomes plain text, so the answer stays readable but inert.

import { isAllowedExternalUrl, isKnownAppPath } from "@/lib/advisor/links";

export type Inline =
  | { k: "text"; v: string }
  | { k: "bold"; c: Inline[] }
  | { k: "italic"; c: Inline[] }
  | { k: "code"; v: string }
  | { k: "link"; href: string; external: boolean; c: Inline[] };

export type Block =
  | { k: "p"; c: Inline[] }
  | { k: "h"; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { k: "ul"; items: Inline[][] }
  | { k: "ol"; items: Inline[][] }
  | { k: "quote"; c: Inline[] }
  | { k: "table"; head: Inline[][]; rows: Inline[][][] }
  | { k: "code"; v: string }
  | { k: "hr" };

const MAX_INLINE_DEPTH = 4;
const MAX_TABLE_COLS = 12;

function pushText(out: Inline[], v: string): void {
  if (v === "") return;
  const last = out[out.length - 1];
  if (last !== undefined && last.k === "text") last.v += v;
  else out.push({ k: "text", v });
}

function resolveHref(raw: string): { href: string; external: boolean } | null {
  const href = raw.trim();
  if (isKnownAppPath(href)) return { href, external: false };
  if (isAllowedExternalUrl(href)) return { href, external: true };
  return null;
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = (): void => {
    pushText(out, buf);
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ k: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_INLINE_DEPTH && ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ k: "bold", c: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (depth < MAX_INLINE_DEPTH && (ch === "*" || ch === "_") && src[i + 1] !== " " && src[i + 1] !== ch) {
      const prev = i > 0 ? src[i - 1]! : " ";
      if (ch === "*" || !/[A-Za-z0-9]/.test(prev)) {
        const end = src.indexOf(ch, i + 1);
        if (end > i + 1 && src[end - 1] !== " ") {
          flush();
          out.push({ k: "italic", c: parseInline(src.slice(i + 1, end), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === "!" && src[i + 1] === "[") {
      const m = /^!\[([^\]]*)\]\(([^)\s]*)[^)]*\)/.exec(src.slice(i));
      if (m !== null) {
        buf += m[1] ?? ""; // images are never rendered: keep the alt text only
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]*)\]\(([^)]*)\)/.exec(src.slice(i));
      if (m !== null) {
        const target = resolveHref(m[2] ?? "");
        flush();
        const label = depth < MAX_INLINE_DEPTH ? parseInline(m[1] ?? "", depth + 1) : [{ k: "text", v: m[1] ?? "" } as Inline];
        if (target === null) {
          for (const n of label) out.push(n); // inert: the label alone
        } else {
          out.push({ k: "link", href: target.href, external: target.external, c: label });
        }
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

const isTableSeparator = (line: string, columns: number): boolean => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && splitRow(line).length === columns;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (/^```/.test(line.trim())) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!.trim())) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ k: "code", v: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h !== null) {
      // Headings render at most as h4 so an answer never out-shouts the page title.
      const level = Math.min(4, h[1]!.length) as 1 | 2 | 3 | 4;
      blocks.push({ k: "h", level, c: parseInline(h[2]!.trim()) });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ k: "hr" });
      i += 1;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!, splitRow(line).length)) {
      const head = splitRow(line).slice(0, MAX_TABLE_COLS);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitRow(lines[i]!).slice(0, MAX_TABLE_COLS));
        i += 1;
      }
      blocks.push({ k: "table", head: head.map((c) => parseInline(c)), rows: rows.map((r) => r.map((c) => parseInline(c))) });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ k: "quote", c: parseInline(body.join(" ")) });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (ul !== null || ol !== null) {
      const ordered = ul === null;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = ordered ? /^\s*\d{1,3}[.)]\s+(.*)$/.exec(lines[i]!) : /^\s*[-*+]\s+(.*)$/.exec(lines[i]!);
        if (m === null) break;
        items.push(parseInline(m[1]!.trim()));
        i += 1;
      }
      blocks.push(ordered ? { k: "ol", items } : { k: "ul", items });
      continue;
    }
    // Paragraph: consecutive plain lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^```/.test(lines[i]!.trim()) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*>/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d{1,3}[.)]\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!.trim());
      i += 1;
    }
    if (para.length === 0) {
      // Defensive: always make progress, whatever the line looked like.
      para.push(line.trim());
      i += 1;
    }
    blocks.push({ k: "p", c: parseInline(para.join(" ")) });
  }
  return blocks;
}

/** Plain text of an inline run (used by tests and for aria labels). */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes.map((n) => (n.k === "text" || n.k === "code" ? n.v : inlineText(n.c))).join("");
}
