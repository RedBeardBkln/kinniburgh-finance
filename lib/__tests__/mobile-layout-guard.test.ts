// mobile-layout-cleanup guard: cheap source scans so a new page cannot quietly push a phone screen sideways again.
// Wide tables must scroll inside their own box, no page-level fixed width may be wider than a phone, hand-rolled
// dialogs use the shared bottom-sheet frame, and the shell / print rules this task relies on stay in place.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".tsx")) out.push(relative(ROOT, full).replace(/\\/g, "/"));
  }
  return out;
}
const FILES = [...walk(resolve(ROOT, "app")), ...walk(resolve(ROOT, "components"))];

// Files allowed to hold a table that is not inside a scroll wrapper, with the reason.
const TABLE_ALLOW: Record<string, string> = {
  "components/transactions/transactions-table.tsx": "stacked rows on phones; md:overflow-x-auto wrapper on desktop",
};

// Fixed widths wider than a phone that are allowed, each inside a horizontal scroll box.
const WIDTH_ALLOW: Record<string, string> = {
  "components/accounts/accounts-page-client.tsx": "min-w-[980px] table inside overflow-x-auto",
  "components/settings/duplicate-log-client.tsx": "min-w-[760px] table inside overflow-x-auto",
  "components/settings/import-sign-repair-client.tsx": "min-w-[560px] table inside overflow-x-auto",
  "components/tax/forms/return-sheet.tsx": "rem table minimums inside overflow-x-auto; print-pinned",
};

// Overlays that already fit a phone and keep their own frame.
const DIALOG_ALLOW: Record<string, string> = {
  "components/app-sidebar.tsx": "the nav drawer",
  "components/dashboard/drilldown-dialog.tsx": "already a bottom sheet",
  "components/tax/forms/modal-shell.tsx": "full screen below sm",
  "components/review-queue/tag-picker-sheet.tsx": "bottom sheet on the public queue page",
  "components/ui/dialog.tsx": "mx-4 max-w-sm alert with short text",
  "components/advisor/advisor-slideover.tsx": "inset-y-0 slide-over, w-full on phones",
};

/**
 * True when the table at `pos` has a still-open scroll wrapper among its ancestors: a `<TableScroll>` or an element whose
 * opening tag carries overflow-x-auto / overflow-auto, opened before the table and not closed again before it (checked per
 * table, not per file: an unrelated scroll row elsewhere in the file must not count).
 */
function insideScrollWrapper(src: string, pos: number): boolean {
  const before = src.slice(0, pos);
  for (const w of before.matchAll(/<TableScroll\b|overflow-x-auto|overflow-auto/g)) {
    const at = w.index ?? 0;
    const open = before.lastIndexOf("<", at);
    const tag = /^<([A-Za-z][\w.]*)/.exec(before.slice(open))?.[1];
    if (!tag) continue;
    // Walk the same tag's opens/closes after the wrapper's own opening tag, with nesting depth: depth 0 = it was closed.
    const between = before.slice(open + 1);
    let depth = 1;
    for (const t of between.matchAll(new RegExp(`<${tag}[\\s>]|</${tag}>`, "g"))) {
      depth += t[0].startsWith("</") ? -1 : 1;
      if (depth === 0) break;
    }
    if (depth > 0) return true;
  }
  return false;
}

describe("mobile layout guard", () => {
  it("every table sits inside a horizontal scroll box (or is allow-listed with a reason)", () => {
    let tables = 0;
    const bad: string[] = [];
    for (const f of FILES) {
      const src = read(f);
      const t = (src.match(/<table[\s>]/g) ?? []).length;
      if (t === 0) continue;
      tables += t;
      if (TABLE_ALLOW[f]) continue;
      for (const m of src.matchAll(/<table[\s>]/g)) {
        if (!insideScrollWrapper(src, m.index ?? 0)) bad.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(tables).toBeGreaterThan(30); // the scan really found the tables (a broken walk must not pass)
    expect(bad).toEqual([]);
  });

  it("no unprefixed fixed width or min-width wider than a phone (352px / 22rem) outside the allow-list", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of FILES) {
      const src = read(f);
      for (const m of src.matchAll(/(?<![\w:\-[])(?:min-)?w-\[(\d+(?:\.\d+)?)(px|rem)\]/g)) {
        seen++;
        const px = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
        if (px > 352 && !WIDTH_ALLOW[f]) bad.push(`${f}: ${m[0]}`);
      }
      for (const m of src.matchAll(/(?<![\w:\-])(?:min-)?w-(?:96|screen)\b/g)) bad.push(`${f}: ${m[0]}`);
    }
    expect(seen).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });

  it("hand-rolled `fixed inset-0` dialogs use the shared modal frame", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      const src = read(f);
      if (!src.includes("fixed inset-0") || DIALOG_ALLOW[f]) continue;
      bad.push(f);
    }
    expect(bad).toEqual([]);
    const users = FILES.filter((f) => read(f).includes('from "@/components/ui/modal-frame"'));
    expect(users.length).toBeGreaterThanOrEqual(12);
    for (const f of users) {
      const src = read(f);
      expect(src, f).toContain("MODAL_OVERLAY");
      expect(src, f).toContain("modalPanelClass(");
    }
  });

  it("the shell keeps h-screen (print CSS targets it) and the phone rules are screen-only", () => {
    expect(read("components/app-shell.tsx")).toMatch(/\bh-screen\b/);
    const css = read("app/globals.css");
    const at = css.indexOf("@media screen and (max-width: 767.98px)");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = css.slice(at);
    expect(block).toContain("font-size: 16px !important;");
    expect(css).toContain("body:has(#cpa-summary)");
    expect(css).toContain("body:has(#return-sheet)");
  });

  it("the phone notification panel is absolutely positioned against the sticky header, never fixed", () => {
    // A fixed panel would rely on the header's backdrop-filter becoming a containing block, which iOS Safari may not do
    // (it would then open below the screen). The bell wrapper is static on phones so the header is the anchor.
    const src = read("components/notifications/notification-bell.tsx");
    expect(src).toMatch(/<div className="relative max-md:static" ref=\{ref\}>/);
    const panel = /\{open && \([\s\S]*?<div className="([^"]*)">/.exec(src)?.[1] ?? "";
    expect(panel.split(" ")).toEqual(expect.arrayContaining(["absolute", "top-full", "max-md:absolute", "max-md:inset-x-2", "max-md:w-auto", "max-md:overflow-y-auto"]));
    expect(src).not.toContain("max-md:fixed");
    expect(read("components/app-header.tsx")).toMatch(/<header className="sticky top-0/);
  });

  it("Card padding stays unprefixed (twMerge keeps a caller's p-0 only within the same variant)", () => {
    // Callers pass p-0 to table cards; a responsive padding in the primitive would survive that override on one side
    // of the breakpoint and inset the tables. Mobile changes go to callers, not to Card.
    const card = read("components/ui/card.tsx");
    expect(card).not.toMatch(/\b(?:max-)?sm:p[xytblr]?-/);
  });
});
