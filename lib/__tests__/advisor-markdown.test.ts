import { describe, expect, it } from "vitest";
import { inlineText, parseInline, parseMarkdown, type Block, type Inline } from "@/lib/advisor/markdown";

function links(nodes: readonly Inline[]): { href: string; external: boolean }[] {
  const out: { href: string; external: boolean }[] = [];
  for (const n of nodes) {
    if (n.k === "link") out.push({ href: n.href, external: n.external }, ...links(n.c));
    else if (n.k === "bold" || n.k === "italic") out.push(...links(n.c));
  }
  return out;
}

function allLinks(blocks: readonly Block[]): { href: string; external: boolean }[] {
  const out: { href: string; external: boolean }[] = [];
  for (const b of blocks) {
    if (b.k === "p" || b.k === "h" || b.k === "quote") out.push(...links(b.c));
    else if (b.k === "ul" || b.k === "ol") for (const it of b.items) out.push(...links(it));
    else if (b.k === "table") for (const row of [b.head, ...b.rows]) for (const cell of row) out.push(...links(cell));
  }
  return out;
}

describe("block structure", () => {
  it("parses paragraphs, headings (capped at h4), lists, quotes and rules", () => {
    const blocks = parseMarkdown("# Title\n\nSome **bold** and *it* and `code`.\n\n- a\n- b\n\n1. one\n2. two\n\n> quoted\n\n---\n\n###### deep");
    expect(blocks.map((b) => b.k)).toEqual(["h", "p", "ul", "ol", "quote", "hr", "h"]);
    const h = blocks[0] as Extract<Block, { k: "h" }>;
    expect(h.level).toBe(1);
    expect((blocks[6] as Extract<Block, { k: "h" }>).level).toBe(4);
    expect((blocks[2] as Extract<Block, { k: "ul" }>).items).toHaveLength(2);
    const p = blocks[1] as Extract<Block, { k: "p" }>;
    expect(p.c.map((n) => n.k)).toEqual(["text", "bold", "text", "italic", "text", "code", "text"]);
  });

  it("parses a pipe table with a header", () => {
    const blocks = parseMarkdown("| Item | Amount |\n| --- | ---: |\n| Rent | $1,200.00 |\n| Food | $400.00 |");
    expect(blocks).toHaveLength(1);
    const t = blocks[0] as Extract<Block, { k: "table" }>;
    expect(t.k).toBe("table");
    expect(t.head.map(inlineText)).toEqual(["Item", "Amount"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]!.map(inlineText)).toEqual(["Food", "$400.00"]);
  });

  it("accepts a one-dash delimiter row, and a pipe in prose is not a table", () => {
    expect(parseMarkdown("| A | B |\n| - | - |\n| 1 | 2 |")[0]!.k).toBe("table");
    expect(parseMarkdown("|A|B|\n|:-:|--:|\n|1|2|")[0]!.k).toBe("table");
    expect(parseMarkdown("x | y\n---")[0]!.k).not.toBe("table"); // column counts differ
    expect(parseMarkdown("Use a | b in prose\nnext line")[0]!.k).toBe("p");
  });

  it("keeps a fenced block verbatim and always makes progress on odd input", () => {
    const blocks = parseMarkdown("```\n<script>alert(1)</script>\n```\n\n#######\n|\n---|");
    expect(blocks[0]).toEqual({ k: "code", v: "<script>alert(1)</script>" });
    expect(blocks.length).toBeGreaterThan(1);
  });
});

describe("inline safety", () => {
  it("makes known internal paths and allow-listed irs.gov / ct.gov links clickable", () => {
    const blocks = parseMarkdown("See [Tax Forms](/tax/forms/2025), [Pub 463](https://www.irs.gov/pub/irs-pdf/p463.pdf) and [CT](https://portal.ct.gov/DRS).");
    expect(allLinks(blocks)).toEqual([
      { href: "/tax/forms/2025", external: false },
      { href: "https://www.irs.gov/pub/irs-pdf/p463.pdf", external: true },
      { href: "https://portal.ct.gov/DRS", external: true },
    ]);
  });

  it.each([
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](data:text/html;base64,AAAA)",
    "[x](http://www.irs.gov/x)",
    "[x](https://evil.example.com/irs.gov)",
    "[x](https://irs.gov.evil.example.com/)",
    "[x](https://user:pw@www.irs.gov/)",
    "[x](//evil.example.com/a)",
    "[x](/not/a/real/page)",
    "[x](/tax/forms/2025/../../vault)",
    "[x](/vault)",
    "[x](/api/advisor/chat)",
  ])("renders %s as inert text", (md) => {
    const blocks = parseMarkdown(md);
    expect(allLinks(blocks)).toEqual([]);
    expect(inlineText((blocks[0] as Extract<Block, { k: "p" }>).c)).toMatch(/^x\)?$/); // a URL with its own parentheses leaves a stray ")" behind; it is text, never a link
  });

  it("never produces an image: only its alt text remains", () => {
    const nodes = parseInline("![logo](https://www.irs.gov/a.png) tail");
    expect(nodes.every((n) => n.k === "text")).toBe(true);
    expect(inlineText(nodes)).toBe("logo tail");
  });

  it("treats raw HTML as plain text (React escapes it)", () => {
    const nodes = parseInline('<img src=x onerror=alert(1)> <script>alert(1)</script>');
    expect(nodes).toEqual([{ k: "text", v: '<img src=x onerror=alert(1)> <script>alert(1)</script>' }]);
  });

  it("bounds nesting depth", () => {
    const deep = "**".repeat(0) + "*a ".repeat(50) + "b" + "*".repeat(50);
    expect(() => parseInline(deep)).not.toThrow();
  });
});
