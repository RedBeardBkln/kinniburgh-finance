// The business-use percentage (X6) in the PDF packet's cover: the "Shared-use accounts" section, only when a shared account is booked.

import { describe, expect, it } from "vitest";
import { buildCoverModel, type CoverBlock, type CoverForm } from "@/lib/tax2025/pdf/cover";
import { toPdfReturnView, type AdapterOverrides } from "@/lib/tax2025/pdf/adapter";
import { applyOverrides, decisionsFromOverrides, formatOverrideNote, type OverrideRow } from "@/lib/tax2025/overrides";
import { TY2025_ENGINE_VERSION, computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { fullFacts1b, gl } from "./tax2025-fixtures";

const OPTS = { generatedAt: "2026-10-06T16:00:00.000Z", generatedBy: "Test User" } as const;
const REASON = "Bill split by the number of people working from home; usage log kept.";
const SECTION = "Shared-use accounts (the business share is the owner's decision, not verified by documents)";
const forms: CoverForm[] = [{ formId: "f1040", title: "Form 1040", included: true, reason: "always", blankByDesign: {} }];

function facts(withAccount = true): Ty2025Facts {
  const f = fullFacts1b();
  if (withAccount) f.income.scheduleC.glLines = [...f.income.scheduleC.glLines, gl("6100", "Utilities:Internet & Phone", "expense", 261_017)];
  return f;
}
function row(valueText: string): OverrideRow {
  return {
    id: "row-1",
    taxYear: 2025,
    targetKind: "decision",
    targetKey: "businessUse.internet_phone",
    version: 1,
    valueKind: "choice",
    valueCents: null,
    valueText,
    computedSnapshot: { status: "default_undecided", cents: null, engineVersion: TY2025_ENGINE_VERSION },
    authority: "owner",
    reason: REASON,
    setByName: "Eric",
    setAt: new Date("2026-10-06T16:00:00.000Z"),
    archivedAt: null,
  };
}
function view(rows: OverrideRow[], f: Ty2025Facts = facts()) {
  const ret = computeTy2025Return(f, decisionsFromOverrides(rows));
  const overrides: AdapterOverrides = { effective: applyOverrides(ret, rows), formatNote: formatOverrideNote };
  return toPdfReturnView(ret, f, { ...OPTS, overrides });
}
function lines(blocks: CoverBlock[]): string[] {
  return blocks.map((b) => (b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text));
}
function cover(v: ReturnType<typeof view>): string[] {
  return lines(buildCoverModel({ view: v, forms, fillItems: [], continuations: [], stamp: true }).blocks);
}

describe("cover: Shared-use accounts", () => {
  it("decided 70%: one bullet with the booked amount, the share, the line, the personal portion, the decision note with who / when / reason", () => {
    const text = cover(view([row("70")]));
    const at = text.indexOf(SECTION);
    expect(at).toBeGreaterThan(-1);
    const bullet = text[at + 1] ?? "";
    expect(bullet).toContain("Utilities:Internet & Phone: $2,610.17 booked; 70% business = $1,827.12;");
    expect(bullet).toContain("Schedule C line 25 prints $1,827 (the line total, rounded once)");
    expect(bullet).toContain("decision X6: Owner decision:");
    expect(bullet).toContain("set to 70%");
    expect(bullet).toContain("by Eric (owner) on 2026-10-06");
    expect(bullet).toContain(`reason: ${REASON}`);
    expect(bullet).toContain("personal portion $783.05 not deducted (informational only; nothing is booked)");
  });
  it("undecided: 100% in force, default, undecided; and the defaults list names the decision", () => {
    const text = cover(view([]));
    const at = text.indexOf(SECTION);
    expect(at).toBeGreaterThan(-1);
    expect(text[at + 1]).toContain("100% business use in force (default, undecided; decision X6); Schedule C line 25 prints $2,610; personal portion $0 until a percentage is recorded");
    expect(text.some((l) => l.includes("Business-use share of the shared internet and phone service") && l.includes("100% (default, undecided)"))).toBe(true);
  });
  it("the Schedule C line 25 field is tagged 'default, undecided' only while no percentage is recorded; its printed amount follows the decision", () => {
    expect(view([]).lines["schc.25"]?.defaultUndecided).toContain("Business-use share of the shared internet and phone service");
    expect(view([]).lines["schc.25"]?.amount).toBe(2610);
    expect(view([row("70")]).lines["schc.25"]?.defaultUndecided).toBeUndefined();
    expect(view([row("70")]).lines["schc.25"]?.amount).toBe(1827);
  });
  it("0% and a decimal read the same way", () => {
    expect(cover(view([row("0")])).join("\n")).toContain("0% business = $0; Schedule C line 25 prints $0");
    expect(cover(view([row("70.5")])).join("\n")).toContain("70.5% business = $1,840.");
  });
  it("no shared account booked: no section and the cover is the same text as without the feature", () => {
    const v = view([], facts(false));
    expect(v.businessUse).toBeUndefined();
    expect(cover(v).some((l) => l.startsWith("Shared-use accounts"))).toBe(false);
  });
  it("the fingerprint changes when the recorded percentage changes (and when it is recorded at all)", () => {
    const f = (rows: OverrideRow[]) => buildCoverModel({ view: view(rows), forms, fillItems: [], continuations: [], stamp: true }).fingerprint12;
    const a = f([]);
    const b = f([row("70")]);
    const c = f([row("60")]);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(f([row("70")])).toBe(b);
  });
  it("every cover string went through the SSN guard: an SSN-like reason would not reach the cover", () => {
    // the reason is refused at the action; the cover also scrubs: a bullet built from a hostile note is replaced, never printed raw
    const hostile = row("70");
    hostile.reason = "per statement SSN 123-45-6789 on file";
    const model = buildCoverModel({ view: view([hostile]), forms, fillItems: [], continuations: [], stamp: true });
    expect(lines(model.blocks).join("\n")).not.toContain("123-45-6789");
  });
});
