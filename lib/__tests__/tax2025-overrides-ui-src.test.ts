import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// There is no jsdom / component-test infrastructure in this repo, so the override UI is pinned by
// SOURCE CHECKS (what must and must not be in the new components) plus the pure helpers' unit
// tests (tax2025-override-input.test.ts). The interactive behaviour is checked by hand in Chrome
// (checklist in .claude/pipeline/ty2025-overrides-wiring/02-implementation.md).

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const CLIENT = [
  "components/tax/forms/modal-shell.tsx",
  "components/tax/forms/override-parts.tsx",
  "components/tax/forms/override-dialog.tsx",
  "components/tax/forms/override-line-button.tsx",
  "components/tax/forms/override-decision-button.tsx",
];
const ALL = [...CLIENT, "components/tax/forms/overrides-panel.tsx"];

describe("override UI source checks", () => {
  it("client components start with 'use client'; the panel is a server component", () => {
    for (const f of CLIENT) expect(read(f).startsWith('"use client";'), f).toBe(true);
    expect(read("components/tax/forms/overrides-panel.tsx")).not.toMatch(/"use client"/);
  });

  it("no window.confirm / confirm() anywhere (the clear is a two-step inline form)", () => {
    const code = (f: string): string => read(f).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
    for (const f of ALL) expect(code(f), f).not.toMatch(/window\.confirm|\bconfirm\s*\(/);
    const parts = read("components/tax/forms/override-parts.tsx");
    expect(parts).toContain("Yes, clear it");
    expect(parts).toContain("Keep it");
    expect(parts).toContain("Reason for clearing (required)");
  });

  it("the dialog is accessible: role=dialog, aria-modal, Escape closes, focus returns, live result region", () => {
    const shell = read("components/tax/forms/modal-shell.tsx");
    expect(shell).toContain('role="dialog"');
    expect(shell).toContain('aria-modal="true"');
    expect(shell).toContain('e.key === "Escape"');
    expect(shell).toMatch(/opener\.focus\(\)/);
    expect(shell).toMatch(/onClick=\{onClose\}/); // backdrop click
    expect(shell).toContain("min-h-[44px]"); // mobile tap target
    expect(read("components/tax/forms/override-dialog.tsx")).toContain('aria-live="polite"');
    expect(read("components/tax/forms/override-parts.tsx")).toContain('aria-live="polite"'); // history
  });

  it("the chips are hidden when the sheet is printed and have a 44 px mobile tap target", () => {
    for (const f of ["components/tax/forms/override-line-button.tsx", "components/tax/forms/override-decision-button.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("print:hidden");
      expect(src, f).toContain("min-h-[44px]");
    }
  });

  it("the line dialog says what the app computed, warns a blocked line does not recompute totals, and lists dependents", () => {
    const src = read("components/tax/forms/override-dialog.tsx");
    expect(src).toContain("What the app computed");
    expect(src).toContain("No value yet:");
    expect(src).toContain("It does NOT recompute the");
    expect(src).toContain("These lines depend on this one and will NOT be recalculated");
    expect(src).toContain("Amount (whole dollars)");
    expect(src).toContain("amountEntryHint(line.key)"); // the loss-line hint (enter a loss as a negative number)
    expect(src).toContain('inputMode="numeric"');
    expect(src).toContain("Reason (required)");
    expect(src).toMatch(/disabled=\{!form\.canSave\}/); // Save stays disabled until amount and reason are valid
  });

  it("authority uses the plain labels CPA and Owner (Eric/Eva); the reason says not to type SSNs or account numbers", () => {
    const parts = read("components/tax/forms/override-parts.tsx");
    expect(parts).toContain("Owner (Eric/Eva)");
    expect(parts).toMatch(/\bCPA\n/);
    expect(parts).toContain("Do not type Social Security or account numbers");
  });

  it("history is loaded lazily, on open", () => {
    const parts = read("components/tax/forms/override-parts.tsx");
    expect(parts).toContain("onToggle");
    expect(parts).toContain("listTaxReturnOverrideHistory");
    expect(parts).toMatch(/state\.kind === "idle"/);
  });

  it("success refreshes the page inside startTransition; failures show a plain message", () => {
    for (const f of ["components/tax/forms/override-dialog.tsx", "components/tax/forms/override-decision-button.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("startTransition(() => router.refresh())");
      expect(src, f).toContain("describeActionFailure");
    }
  });

  it("client components never import the engine at runtime (types only): no LINE_FLOW, no overrides.ts values", () => {
    for (const f of CLIENT) {
      const src = read(f);
      expect(src, f).not.toMatch(/line-flow/);
      for (const m of src.matchAll(/^import\s+(?!type\b)[^;]*from\s+"(@\/lib\/tax2025\/overrides)"/gm)) {
        throw new Error(`${f} imports a value from ${m[1]}`);
      }
      expect(src, f).not.toMatch(/@\/lib\/db|@\/lib\/auth|@prisma/);
    }
  });

  it("the review sheet mounts the panel, the line chips and the decision button; the printed note keeps its test id", () => {
    const sheet = read("components/tax/forms/return-sheet.tsx");
    expect(sheet).toContain("<OverridesPanel summary={s.overrides} />");
    expect(sheet).toContain("<OverrideLineButton");
    expect(sheet).toContain("<OverrideDecisionButton");
    expect(sheet).toContain('data-testid="override-note"');
    expect(sheet).toContain('data-testid="depends-on-override"');
    expect(sheet).toContain("{line.canOverride ? (");
  });

  it("the actions the dialog calls start with requireAuth and are the only writers (the loader is read-only)", () => {
    expect(read("actions/tax-return-overrides.ts")).toMatch(/export async function setTaxReturnOverride[\s\S]{0,120}await requireAuth\(\);/);
    expect(read("lib/tax2025-overrides-build.ts")).not.toMatch(/\.(create|update|updateMany|delete|deleteMany|upsert)\(/);
  });
});
