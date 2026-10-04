import { describe, expect, it } from "vitest";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { buildSheetModel, type SheetLine, type SheetModel, type SheetRawDocument } from "@/lib/tax2025-sheet";
import { fullFacts1b } from "@/lib/__tests__/tax2025-fixtures";

// The sheet already renders a `document` ref as a verified / unverified chip with a review link. An
// answer accepted from a document carries such a ref (lib/tax2025/answers.ts), so the sheet shows the
// link with no sheet change; this pins that, and that the label is generic (no EIN / name).

const NOW = new Date("2026-10-04T16:30:00Z");
const DOCS: SheetRawDocument[] = [{ id: "w2-eric-a", docType: "w2", taxYear: 2025, verified: true, legacyFormat: false, subjectType: "person" }];

function lines(m: SheetModel): SheetLine[] {
  return [...m.federal, ...m.connecticut].flatMap((g) => g.lines);
}

describe("sheet shows the document an accepted answer was filled from", () => {
  it("a line fed by an accepted deferral answer gets a verified document chip linking to the document", () => {
    const f = fullFacts1b();
    const p = f.returnAnswers.people[0]!;
    p.deferralsCents = {
      value: 500_000,
      basis: "answer_owner",
      refs: [
        { kind: "questionnaire", id: "return-completeness.def_eric", label: "Eric: elective deferrals" },
        { kind: "document", id: "w2-eric-a", label: "W-2" },
      ],
      note: "answered 2026-10-04; filled from a W-2 (box 12 deferral codes), verified when accepted",
    };
    const m = buildSheetModel({ ret: computeTy2025Return(f), documents: DOCS, now: NOW });
    const withChip = lines(m).filter((l) => l.chips.some((c) => c.href === "/documents/w2-eric-a/review" && c.label === "W-2" && c.kind === "document_verified"));
    // the document chip is present on at least one line that cites the deferral answer
    expect(withChip.length).toBeGreaterThan(0);
    // and the unaccepted baseline has no such chip on any of those lines
    const base = buildSheetModel({ ret: computeTy2025Return(fullFacts1b()), documents: DOCS, now: NOW });
    const ids = new Set(withChip.map((l) => l.key));
    const baseline = lines(base).filter((l) => ids.has(l.key) && l.chips.some((c) => c.href === "/documents/w2-eric-a/review" && c.label === "W-2"));
    expect(baseline.length).toBeLessThan(withChip.length);
  });
});
