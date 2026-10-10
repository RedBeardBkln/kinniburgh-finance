import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { resolveEffectiveBudgets, type EffectiveBudgetInput, type RecurringForBudget } from "@/lib/budget-effective";
import { resolveBudgetedAmounts, getRootBudgetLineIds } from "@/lib/budget-nesting";
import { monthlyEquivalentCents } from "@/lib/recurring-expenses";

const D = (v: string | number) => new Decimal(v);

// tag tree: utilities > electric, utilities > water; food > groceries
const PARENT: Record<string, string | null> = {
  utilities: null,
  electric: "utilities",
  water: "utilities",
  food: null,
  groceries: "food",
  solo: null,
};
const parentOf = (id: string) => PARENT[id] ?? null;

const line = (id: string, tagId: string, accountId: string, budgeted: string | null, additional = "0"): EffectiveBudgetInput => ({
  id,
  tagId,
  accountId,
  budgeted: budgeted === null ? null : D(budgeted),
  additionalAmountCents: D(additional),
});

describe("resolveEffectiveBudgets", () => {
  it("uses the stored amount, adds up a blank parent from its children, and totals roots only", () => {
    const e = resolveEffectiveBudgets(
      [line("u", "utilities", "A", null), line("el", "electric", "A", "150"), line("wa", "water", "A", "60"), line("so", "solo", "A", "40")],
      [],
      parentOf
    );
    expect(e.resolvedById.get("u")!.toFixed(2)).toBe("210.00");
    expect(e.resolvedById.get("el")!.toFixed(2)).toBe("150.00");
    expect([...e.rootIds].sort()).toEqual(["so", "u"]);
    expect(e.totalBudgeted.toFixed(2)).toBe("250.00"); // 210 + 40, children not added again
    expect([...e.parentIds]).toEqual(["u"]);
    expect(e.explicitById.get("u")).toBeNull();
  });

  it("a recurring-linked line takes the recurring amount instead of the stored one (the missing +28 on the old dashboard)", () => {
    const lines = [line("el", "electric", "A", "150")];
    const without = resolveEffectiveBudgets(lines, [], parentOf);
    const recurring: RecurringForBudget[] = [{ tagId: "electric", amountCents: 17800, frequency: "monthly" }];
    const withRec = resolveEffectiveBudgets(lines, recurring, parentOf);
    expect(withRec.resolvedById.get("el")!.toFixed(2)).toBe("178.00");
    expect(withRec.totalBudgeted.minus(without.totalBudgeted).toFixed(2)).toBe("28.00");
    expect([...withRec.recurringLinkedIds]).toEqual(["el"]);
  });

  it("adds the stored additional buffer and converts other frequencies to a monthly amount", () => {
    const e = resolveEffectiveBudgets(
      [line("el", "electric", "A", "1", "2500")],
      [
        { tagId: "electric", amountCents: 12000, frequency: "quarterly" }, // 40.00 a month
        { tagId: "electric", amountCents: 1000, frequency: "weekly" }, // 43.33 a month
        { tagId: null, amountCents: 99999, frequency: "monthly" }, // no tag: ignored
      ],
      parentOf
    );
    const expected = (monthlyEquivalentCents(12000, "quarterly") + monthlyEquivalentCents(1000, "weekly") + 2500) / 100;
    expect(e.resolvedById.get("el")!.toFixed(2)).toBe(expected.toFixed(2));
  });

  it("a recurring child flows up into a blank parent", () => {
    const e = resolveEffectiveBudgets(
      [line("u", "utilities", "A", null), line("el", "electric", "A", "150")],
      [{ tagId: "electric", amountCents: 20000, frequency: "monthly" }],
      parentOf
    );
    expect(e.resolvedById.get("u")!.toFixed(2)).toBe("200.00");
    expect(e.totalBudgeted.toFixed(2)).toBe("200.00");
  });

  it("nesting is per account: a child on another account is its own root and is not added into the parent", () => {
    const e = resolveEffectiveBudgets([line("u", "utilities", "A", null), line("el", "electric", "B", "150")], [], parentOf);
    expect(e.resolvedById.get("u")!.toFixed(2)).toBe("0.00");
    expect([...e.rootIds].sort()).toEqual(["el", "u"]);
    expect(e.totalBudgeted.toFixed(2)).toBe("150.00");
    expect(e.parentIds.size).toBe(0);
  });

  it("a blank leaf is 0", () => {
    const e = resolveEffectiveBudgets([line("so", "solo", "A", null)], [], parentOf);
    expect(e.resolvedById.get("so")!.toFixed(2)).toBe("0.00");
  });

  it("matches the algorithm /budgets used before it shared this module, over random inputs", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const tags = Object.keys(PARENT);
    for (let round = 0; round < 100; round++) {
      const lines: EffectiveBudgetInput[] = [];
      const used = new Set<string>();
      for (const t of tags) {
        if (rnd() < 0.7 && !used.has(t)) {
          used.add(t);
          lines.push(line(`L${lines.length}`, t, rnd() < 0.5 ? "A" : "B", rnd() < 0.4 ? null : String(Math.floor(rnd() * 500)), String(Math.floor(rnd() * 3000))));
        }
      }
      const recurring: RecurringForBudget[] = tags.filter(() => rnd() < 0.3).map((t) => ({ tagId: t, amountCents: Math.floor(rnd() * 50000), frequency: rnd() < 0.5 ? "monthly" : "biweekly" }));

      // the previous inline implementation, kept here as the reference
      const monthlyByTag = new Map<string, number>();
      for (const r of recurring) monthlyByTag.set(r.tagId!, (monthlyByTag.get(r.tagId!) ?? 0) + monthlyEquivalentCents(r.amountCents, r.frequency));
      const explicit = new Map<string, Decimal | null>();
      for (const l of lines) {
        const m = monthlyByTag.get(l.tagId);
        if (m !== undefined) explicit.set(l.id, D((m + Number(l.additionalAmountCents!.toString())) / 100));
        else explicit.set(l.id, l.budgeted);
      }
      const byAccount = new Map<string, EffectiveBudgetInput[]>();
      for (const l of lines) byAccount.set(l.accountId, [...(byAccount.get(l.accountId) ?? []), l]);
      const refResolved = new Map<string, Decimal>();
      const refRoots = new Set<string>();
      for (const g of byAccount.values()) {
        for (const [id, a] of resolveBudgetedAmounts(g.map((l) => ({ id: l.id, tagId: l.tagId, budgeted: explicit.get(l.id) ?? null })), parentOf, D(0))) refResolved.set(id, a);
        for (const id of getRootBudgetLineIds(g, parentOf)) refRoots.add(id);
      }
      let refTotal = D(0);
      for (const l of lines) if (refRoots.has(l.id)) refTotal = refTotal.plus(refResolved.get(l.id) ?? 0);

      const e = resolveEffectiveBudgets(lines, recurring, parentOf);
      for (const l of lines) expect(e.resolvedById.get(l.id)!.toFixed(2), `round ${round} ${l.id}`).toBe(refResolved.get(l.id)!.toFixed(2));
      expect([...e.rootIds].sort()).toEqual([...refRoots].sort());
      expect(e.totalBudgeted.toFixed(2)).toBe(refTotal.toFixed(2));
    }
  });
});
