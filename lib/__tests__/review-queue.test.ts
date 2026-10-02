import { describe, it, expect } from "vitest";
import {
  ASSIGNABLE_ENTITY_SLUGS,
  assigneeFirstName,
  assignmentChipKind,
  assignmentChipLabel,
  checkAssignable,
  isActiveAssignment,
  isAssignableEntitySlug,
  notAssignableMessage,
  resolveAssignee,
  rulePatternMatchesPayee,
  visibleChipKind,
  type AssignableCandidate,
  type NotAssignableReason,
} from "@/lib/review-queue";

const PERSONAL = "entity-personal";
const SUDDEN = "entity-sudden-valley";
const EKC = "entity-ek-consulting";
const MEZZO = "entity-mezzo";

const ALLOWED = new Set([PERSONAL, SUDDEN]);

function tx(overrides: Partial<AssignableCandidate> = {}): AssignableCandidate {
  return {
    entityId: PERSONAL,
    archivedAt: null,
    transferPairId: null,
    pending: false,
    hasActiveAssignment: false,
    ...overrides,
  };
}

describe("ASSIGNABLE_ENTITY_SLUGS / isAssignableEntitySlug", () => {
  it("contains exactly personal and sudden-valley", () => {
    expect([...ASSIGNABLE_ENTITY_SLUGS].sort()).toEqual(["personal", "sudden-valley"]);
  });

  it("accepts Personal and Sudden Valley slugs", () => {
    expect(isAssignableEntitySlug("personal")).toBe(true);
    expect(isAssignableEntitySlug("sudden-valley")).toBe(true);
  });

  it("rejects EK Consulting, Mezzo, taxes, null, undefined, empty", () => {
    expect(isAssignableEntitySlug("ek-consulting")).toBe(false);
    expect(isAssignableEntitySlug("mezzo")).toBe(false);
    expect(isAssignableEntitySlug("taxes")).toBe(false);
    expect(isAssignableEntitySlug(null)).toBe(false);
    expect(isAssignableEntitySlug(undefined)).toBe(false);
    expect(isAssignableEntitySlug("")).toBe(false);
  });

  it("is case-sensitive (slugs are lowercase) and not fooled by prefixes", () => {
    expect(isAssignableEntitySlug("Personal")).toBe(false);
    expect(isAssignableEntitySlug("personal-extra")).toBe(false);
  });
});

describe("checkAssignable", () => {
  it("allows a normal Personal transaction", () => {
    expect(checkAssignable(tx(), ALLOWED)).toEqual({ ok: true });
  });

  it("allows a normal Sudden Valley transaction", () => {
    expect(checkAssignable(tx({ entityId: SUDDEN }), ALLOWED)).toEqual({ ok: true });
  });

  it("rejects EK Consulting even though everything else is valid", () => {
    expect(checkAssignable(tx({ entityId: EKC }), ALLOWED)).toEqual({
      ok: false,
      reason: "wrong_entity",
    });
  });

  it("rejects Mezzo even though everything else is valid", () => {
    expect(checkAssignable(tx({ entityId: MEZZO }), ALLOWED)).toEqual({
      ok: false,
      reason: "wrong_entity",
    });
  });

  it("rejects a null / undefined / empty entity id", () => {
    expect(checkAssignable(tx({ entityId: null }), ALLOWED)).toEqual({ ok: false, reason: "wrong_entity" });
    expect(checkAssignable(tx({ entityId: undefined }), ALLOWED)).toEqual({ ok: false, reason: "wrong_entity" });
    expect(checkAssignable(tx({ entityId: "" }), ALLOWED)).toEqual({ ok: false, reason: "wrong_entity" });
  });

  it("fails closed when the allowed set is empty (e.g. slugs failed to resolve)", () => {
    expect(checkAssignable(tx(), new Set())).toEqual({ ok: false, reason: "wrong_entity" });
  });

  it("rejects an archived transaction", () => {
    expect(checkAssignable(tx({ archivedAt: new Date("2026-09-01T00:00:00Z") }), ALLOWED)).toEqual({
      ok: false,
      reason: "archived",
    });
  });

  it("rejects a transfer leg", () => {
    expect(checkAssignable(tx({ transferPairId: "pair-1" }), ALLOWED)).toEqual({
      ok: false,
      reason: "transfer_leg",
    });
  });

  it("rejects a bank-pending transaction", () => {
    expect(checkAssignable(tx({ pending: true }), ALLOWED)).toEqual({ ok: false, reason: "pending" });
  });

  it("rejects a transaction that already has an active assignment", () => {
    expect(checkAssignable(tx({ hasActiveAssignment: true }), ALLOWED)).toEqual({
      ok: false,
      reason: "already_assigned",
    });
  });

  it("reports the entity reason first when several rules fail (security-relevant rule wins)", () => {
    const result = checkAssignable(
      tx({
        entityId: MEZZO,
        archivedAt: new Date(),
        transferPairId: "pair-1",
        pending: true,
        hasActiveAssignment: true,
      }),
      ALLOWED
    );
    expect(result).toEqual({ ok: false, reason: "wrong_entity" });
  });

  it("reports reasons in the documented order for an allowed entity", () => {
    const all = { archivedAt: new Date(), transferPairId: "p", pending: true, hasActiveAssignment: true };
    expect(checkAssignable(tx(all), ALLOWED)).toEqual({ ok: false, reason: "archived" });
    expect(checkAssignable(tx({ ...all, archivedAt: null }), ALLOWED)).toEqual({ ok: false, reason: "transfer_leg" });
    expect(checkAssignable(tx({ ...all, archivedAt: null, transferPairId: null }), ALLOWED)).toEqual({
      ok: false,
      reason: "pending",
    });
    expect(
      checkAssignable(tx({ ...all, archivedAt: null, transferPairId: null, pending: false }), ALLOWED)
    ).toEqual({ ok: false, reason: "already_assigned" });
  });
});

describe("notAssignableMessage", () => {
  it("returns a non-empty message for every reason", () => {
    const reasons: NotAssignableReason[] = [
      "wrong_entity",
      "archived",
      "transfer_leg",
      "pending",
      "already_assigned",
    ];
    for (const r of reasons) {
      expect(notAssignableMessage(r).length).toBeGreaterThan(0);
    }
  });
});

describe("resolveAssignee", () => {
  const eric = { id: "u-eric", name: "Eric Kinniburgh" };
  const eva = { id: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" };

  it("returns the single other user", () => {
    expect(resolveAssignee([eric, eva], eric.id)).toEqual({ ok: true, assignee: eva });
  });

  it("works from the other side too", () => {
    expect(resolveAssignee([eric, eva], eva.id)).toEqual({ ok: true, assignee: eric });
  });

  it("returns none when the caller is the only user", () => {
    expect(resolveAssignee([eric], eric.id)).toEqual({ ok: false, reason: "none" });
  });

  it("returns none for an empty list", () => {
    expect(resolveAssignee([], eric.id)).toEqual({ ok: false, reason: "none" });
  });

  it("refuses to guess when more than one other user exists", () => {
    const third = { id: "u-3", name: "Someone Else" };
    expect(resolveAssignee([eric, eva, third], eric.id)).toEqual({ ok: false, reason: "ambiguous" });
  });
});

describe("assigneeFirstName", () => {
  it("takes the first name, splitting on hyphens and spaces", () => {
    expect(assigneeFirstName("Eva-Laura Ramirez-Wisiackas")).toBe("Eva");
    expect(assigneeFirstName("Eric Kinniburgh")).toBe("Eric");
  });

  it("handles single names and surrounding whitespace", () => {
    expect(assigneeFirstName("  Eva ")).toBe("Eva");
    expect(assigneeFirstName("Eva")).toBe("Eva");
  });

  it("falls back for empty input", () => {
    expect(assigneeFirstName("")).toBe("assignee");
    expect(assigneeFirstName("   ")).toBe("assignee");
  });
});

describe("assignmentChipKind / assignmentChipLabel", () => {
  it("pending in a draft batch -> draft chip", () => {
    expect(assignmentChipKind("draft", "pending")).toBe("draft");
  });

  it("pending in a submitted batch -> with_assignee chip", () => {
    expect(assignmentChipKind("submitted", "pending")).toBe("with_assignee");
  });

  it("pending in completed/cancelled batches -> no chip", () => {
    expect(assignmentChipKind("completed", "pending")).toBeNull();
    expect(assignmentChipKind("cancelled", "pending")).toBeNull();
  });

  it("returned shows a chip except in a cancelled batch", () => {
    expect(assignmentChipKind("submitted", "returned")).toBe("returned");
    expect(assignmentChipKind("completed", "returned")).toBe("returned");
    expect(assignmentChipKind("cancelled", "returned")).toBeNull();
  });

  it("resolved / removed never show a chip", () => {
    expect(assignmentChipKind("draft", "resolved")).toBeNull();
    expect(assignmentChipKind("submitted", "removed")).toBeNull();
  });

  it("unknown statuses show no chip", () => {
    expect(assignmentChipKind("weird", "pending")).toBeNull();
    expect(assignmentChipKind("draft", "weird")).toBeNull();
  });

  it("labels use the assignee's first name", () => {
    const name = "Eva-Laura Ramirez-Wisiackas";
    expect(assignmentChipLabel("draft", name)).toBe("Draft for Eva");
    expect(assignmentChipLabel("with_assignee", name)).toBe("With Eva");
    expect(assignmentChipLabel("returned", name)).toBe("Returned by Eva");
  });
});

describe("isActiveAssignment", () => {
  it("is true only for pending assignments on draft/submitted batches", () => {
    expect(isActiveAssignment("draft", "pending")).toBe(true);
    expect(isActiveAssignment("submitted", "pending")).toBe(true);
  });

  it("is false for completed/cancelled batches", () => {
    expect(isActiveAssignment("completed", "pending")).toBe(false);
    expect(isActiveAssignment("cancelled", "pending")).toBe(false);
  });

  it("is false for non-pending assignments", () => {
    expect(isActiveAssignment("draft", "removed")).toBe(false);
    expect(isActiveAssignment("submitted", "returned")).toBe(false);
    expect(isActiveAssignment("submitted", "resolved")).toBe(false);
  });
});

describe("rulePatternMatchesPayee", () => {
  it("true when the alnum-stripped pattern is contained in the alnum-stripped payee (case/punctuation-insensitive)", () => {
    expect(rulePatternMatchesPayee("shell oil", ["Shell Oil 123"])).toBe(true);
    expect(rulePatternMatchesPayee("Shell-Oil", ["SHELL OIL #123"])).toBe(true);
    expect(rulePatternMatchesPayee("lowes", ["LOWE'S #1234 BELLINGHAM"])).toBe(true);
    expect(rulePatternMatchesPayee("shell oil 123", ["shell oil 123"])).toBe(true);
  });
  it("false when the pattern is not in the payee, even if it shares a word", () => {
    expect(rulePatternMatchesPayee("acme", ["Shell Oil 123"])).toBe(false);
    expect(rulePatternMatchesPayee("shell oil 123 extra", ["Shell Oil 123"])).toBe(false);
  });
  it("matches if ANY candidate payee string contains it; ignores null/empty ones", () => {
    expect(rulePatternMatchesPayee("shell", [null, undefined, "", "Shell Oil"])).toBe(true);
    expect(rulePatternMatchesPayee("shell", [null, undefined, ""])).toBe(false);
  });
  it("a blank / punctuation-only pattern never matches (it would otherwise match everything)", () => {
    expect(rulePatternMatchesPayee("", ["Shell Oil"])).toBe(false);
    expect(rulePatternMatchesPayee("---", ["Shell Oil"])).toBe(false);
  });
});

describe("visibleChipKind", () => {
  it("hides a stale 'With <assignee>' chip once the row has tags", () => {
    expect(visibleChipKind("with_assignee", 1)).toBeNull();
    expect(visibleChipKind("with_assignee", 3)).toBeNull();
  });
  it("shows it while the row is untagged, and leaves other chips alone", () => {
    expect(visibleChipKind("with_assignee", 0)).toBe("with_assignee");
    expect(visibleChipKind("draft", 2)).toBe("draft");
    expect(visibleChipKind("returned", 2)).toBe("returned");
    expect(visibleChipKind(null, 2)).toBeNull();
  });
});
