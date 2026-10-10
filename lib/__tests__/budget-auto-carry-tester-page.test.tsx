// TESTER: the real /budgets server page + real client component over fixtures of MY OWN (nesting, recurring override,
// annual line, variable line, ended line, two entities). Checks the effective view the owner sees, with an independent
// total, that nothing is written by viewing, and that the screens never expose a Budget id to an action.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Prisma } from "@prisma/client";

(globalThis as unknown as { React: typeof React }).React = React;

const H = vi.hoisted(() => {
  const s = {
    rows: [] as Array<Record<string, unknown>>,
    writes: [] as string[],
    entities: {} as Record<string, { id: string; name: string; slug: string; navLabel: string }>,
    pickerOptions: [] as Array<{ value: string; label: string }>,
    clientProps: null as null | Record<string, unknown>,
  };
  return { s };
});

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u1", name: "Eric" } }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error("REDIRECT:" + to);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: async (slug: string) => H.s.entities[slug] ?? null }));
vi.mock("@/components/app-shell", () => ({ AppShell: (p: { children: React.ReactNode }) => p.children }));
vi.mock("@/components/export-csv-button", () => ({ ExportCsvButton: () => null }));
vi.mock("@/components/period-picker", () => ({
  PeriodPicker: (p: { options: Array<{ value: string; label: string }> }) => {
    H.s.pickerOptions = p.options;
    return null;
  },
}));
vi.mock("@/actions/reports", () => ({ exportBudgetCsv: async () => "" }));
vi.mock("@/actions/budgets", () => ({
  updateBudgetLine: async () => ({ success: true }),
  updateBudget: async () => ({ success: true }),
  updateBudgetAdditionalAmount: async () => ({ success: true }),
  deleteBudget: async () => ({ success: true, removedMonths: 1 }),
  createBudget: async () => ({ success: true }),
}));
vi.mock("@/lib/month-spend-build", async (orig) => ({ ...(await orig<typeof import("@/lib/month-spend-build")>()), loadMonthTransactions: async () => [] }));
vi.mock("@/lib/own-account-masks-build", () => ({ loadOwnAccountByMask: async () => new Map() }));
vi.mock("@/components/budgets/budget-page-client", async (orig) => {
  const real = await orig<typeof import("@/components/budgets/budget-page-client")>();
  return {
    ...real,
    BudgetPageClient: (p: Parameters<typeof real.BudgetPageClient>[0]) => {
      H.s.clientProps = p as unknown as Record<string, unknown>;
      return real.BudgetPageClient(p);
    },
  };
});
vi.mock("@/lib/db", () => {
  const writeVerb = (name: string) => () => {
    H.s.writes.push(name);
    throw new Error("write attempted by a read-only page: " + name);
  };
  const tagRows = [
    { id: "t-home", name: "Home", shortName: "Home", parentId: null },
    { id: "t-rep", name: "Home / Repairs", shortName: "Repairs", parentId: "t-home" },
    { id: "t-el", name: "Utilities / Electric (Eversource)", shortName: "Electric", parentId: null },
    { id: "t-ins", name: "Insurance", shortName: "Insurance", parentId: null },
    { id: "t-tax", name: "Property tax", shortName: "Property tax", parentId: null },
    { id: "t-old", name: "Old bill", shortName: "Old bill", parentId: null },
    { id: "t-sv", name: "Arbor Retreat / Water", shortName: "Water", parentId: null },
  ];
  const budgetRow = (r: Record<string, unknown>) => {
    const tag = tagRows.find((t) => t.id === r.tagId)!;
    return {
      ...r,
      tag: { id: tag.id, name: tag.name, shortName: tag.shortName, parentId: tag.parentId },
      entity: { id: r.entityId, name: r.entityId === "e-p" ? "Personal" : "Sudden Valley", slug: r.entityId === "e-p" ? "personal" : "sudden-valley" },
      account: { nickname: r.accountId === "a-1" ? "Checking" : "SV Operating", entity: { name: "x" } },
    };
  };
  return {
    db: {
      budget: {
        findMany: async (args: { where?: { entityId?: string } }) => {
          const w = args.where?.entityId;
          return H.s.rows.filter((r) => !w || r.entityId === w).map(budgetRow);
        },
        create: writeVerb("budget.create"),
        createMany: writeVerb("budget.createMany"),
        update: writeVerb("budget.update"),
        updateMany: writeVerb("budget.updateMany"),
        delete: writeVerb("budget.delete"),
        deleteMany: writeVerb("budget.deleteMany"),
        upsert: writeVerb("budget.upsert"),
      },
      $transaction: writeVerb("$transaction"),
      appSetting: { findUnique: async () => null },
      account: {
        findMany: async (args: { where?: { id?: unknown } }) =>
          args.where && "id" in args.where
            ? [{ id: "a-1", currentBalance: new Prisma.Decimal(100000), currentBalanceAt: null }]
            : [
                { id: "a-1", nickname: "Checking", mask: "1111" },
                { id: "a-2", nickname: "SV Operating", mask: "2222" },
              ],
      },
      tag: { findMany: async () => tagRows },
      recurringExpense: {
        findMany: async () => [{ id: "re-1", name: "Car insurance", tagId: "t-ins", entityId: "e-p", amountCents: 12000, frequency: "monthly" }],
      },
    },
  };
});

import BudgetsPage from "@/app/budgets/page";

const D = (s: string) => new Prisma.Decimal(s);
function row(p: Record<string, unknown>) {
  return {
    id: "row-" + String(p.tagId) + "-" + String(p.period) + "-" + String(p.entityId),
    accountId: "a-1",
    budgeted: D("10"),
    additionalAmountCents: D("0"),
    payDay: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    rolloverEnabled: false,
    rolloverAmount: null,
    ...p,
  };
}

function arrange() {
  H.s.writes = [];
  H.s.entities = {
    personal: { id: "e-p", name: "Personal", slug: "personal", navLabel: "Personal" },
    "sudden-valley": { id: "e-s", name: "Sudden Valley", slug: "sudden-valley", navLabel: "Sudden Valley" },
    mezzo: { id: "e-m", name: "Mezzo", slug: "mezzo", navLabel: "Mezzo" },
  };
  H.s.rows = [
    row({ entityId: "e-p", tagId: "t-old", period: "2026-11", budgeted: D("33") }),
    row({ entityId: "e-p", tagId: "t-home", period: "2026-12", budgeted: null }),
    row({ entityId: "e-p", tagId: "t-rep", period: "2026-12", budgeted: D("200"), rolloverAmount: D("40") }),
    row({ entityId: "e-p", tagId: "t-el", period: "2026-12", budgeted: D("90") }),
    row({ entityId: "e-p", tagId: "t-ins", period: "2026-12", budgeted: D("100"), additionalAmountCents: D("500") }),
    row({ entityId: "e-p", tagId: "t-tax", period: "2026-12", budgeted: D("400"), frequency: "annual", payMonth: 4, payDay: 15, annualAmountDue: D("4800") }),
    row({ entityId: "e-s", tagId: "t-sv", period: "2026-12", budgeted: D("55"), accountId: "a-2" }),
  ];
}

const render = async (search: { bucket?: string; period?: string }) => renderToStaticMarkup((await BudgetsPage({ searchParams: Promise.resolve(search) })) as React.ReactElement);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
  arrange();
});
afterEach(() => vi.useRealTimers());

describe("TESTER: /budgets effective view with nesting, recurring override, annual and variable lines", () => {
  it("2027-01: five carried lines (not the ended one), 'Carried from December 2026', one notice, no copy control", async () => {
    const html = await render({ bucket: "personal", period: "2027-01" });
    expect((html.match(/Carried from December 2026/g) ?? []).length).toBe(5);
    expect((html.match(/data-testid="carried-notice"/g) ?? []).length).toBe(1);
    for (const t of ["Home", "Repairs", "Electric", "Insurance", "Property tax"]) expect(html, t).toContain(t);
    expect(html).not.toContain("Old bill");
    expect(html).not.toMatch(/<button[^>]*>[^<]*copy/i);
    expect(html).not.toMatch(/copy (last|previous|forward)/i);
    expect(H.s.writes).toEqual([]);
  });

  it("Total Budgeted: parent auto-sums its child (child not double counted), recurring override replaces the stored amount, and the one-off additional buffer is NOT carried", async () => {
    // roots: Home (auto-sum = Repairs 200) + Electric 90 + Insurance (recurring 120.00, additional 0 when carried) + Property tax 400
    const carried = await render({ bucket: "personal", period: "2027-01" });
    expect(carried).toContain("$810.00");
    // the month with its own rows has the 5.00 additional buffer on Insurance: 120 + 5
    const own = await render({ bucket: "personal", period: "2026-12" });
    expect(own).toContain("$815.00");
    expect(own).not.toContain("Carried from");
    expect(own).not.toContain("carried-notice");
  });

  it("rollover is not carried: the source row's $40.00 rollover never appears in a carried month", async () => {
    const carried = await render({ bucket: "personal", period: "2027-03" });
    expect(carried).not.toContain("$40.00");
    const own = await render({ bucket: "personal", period: "2026-12" });
    expect(own).toContain("$40.00");
  });

  it("entity separation: Sudden Valley carries only its own line; the add-line tag list still hides Personal's tags and SV's", async () => {
    const html = await render({ bucket: "sudden-valley", period: "2027-01" });
    expect(html).toContain("Water");
    expect(html).not.toContain("Repairs");
    expect((html.match(/Carried from December 2026/g) ?? []).length).toBe(1);
    const used = (H.s.clientProps!.budgetedTagIdsAllEntities as string[]).slice().sort();
    expect(used).toEqual(["t-el", "t-home", "t-ins", "t-rep", "t-sv", "t-tax"]);
  });

  it("Mezzo (no rows) keeps the empty state; a month before an entity's first row shows nothing; the ended line shows only in its own month", async () => {
    expect(await render({ bucket: "mezzo", period: "2027-01" })).toContain("No budget lines found for January 2027.");
    expect(await render({ bucket: "personal", period: "2026-10" })).toContain("No budget lines found for October 2026.");
    const nov = await render({ bucket: "personal", period: "2026-11" });
    expect(nov).toContain("Old bill");
    expect(nov).not.toContain("Home");
  });

  it("any month in the URL renders (even 2030-05) and is added to the picker; the picker is 12 back to 12 ahead", async () => {
    const far = await render({ bucket: "personal", period: "2030-05" });
    expect(far).toContain("Carried from December 2026");
    expect(H.s.pickerOptions.map((o) => o.value)).toContain("2030-05");
    await render({ bucket: "personal", period: "2026-10" });
    const v = H.s.pickerOptions.map((o) => o.value);
    expect(v[0]).toBe("2025-10");
    expect(v[v.length - 1]).toBe("2027-10");
    expect(v.length).toBe(25);
    expect(v.every((x, i) => i === 0 || (v[i - 1] as string) < x)).toBe(true);
    expect(H.s.pickerOptions.find((o) => o.value === "2027-01")!.label).toBe("January 2027");
  });

  it("garbage period in the URL falls back to the current New York month", async () => {
    const html = await render({ bucket: "personal", period: "2027-13" });
    expect(html).toContain("October 2026");
  });

  it("the client never receives a Budget id it could send to an action: synthetic ids only for carried lines, and the lines carry a locator's parts", async () => {
    await render({ bucket: "personal", period: "2027-01" });
    const lines = H.s.clientProps!.budgets as Array<{ id: string; entityId: string; tagId: string; source: string }>;
    expect(lines.length).toBe(5);
    for (const l of lines) {
      expect(l.source).toBe("carried");
      expect(l.id.startsWith("carried:")).toBe(true);
      expect(l.entityId).toBe("e-p");
      expect(l.tagId).toMatch(/^t-/);
    }
    expect(H.s.clientProps!.period).toBe("2027-01");
  });
});

describe("TESTER round 1: first-edit notice counts, End line button and confirm wording", () => {
  it("a month right after the latest one says it saves this month only; a far one says how many months and which", async () => {
    const one = await render({ bucket: "personal", period: "2027-01" });
    expect(one).toContain("The first time you change something here, the whole list is saved for this month.");
    const far = await render({ bucket: "sudden-valley", period: "2027-03" });
    expect(far).toContain("the list is saved for 3 months (January 2027 to March 2027): this month and every empty month before it.");
    expect(far).toContain("Those months then keep their own amounts and no longer follow later changes made to earlier months.");
    expect(far).not.toContain("the whole list is saved for this month.");
  });

  it("the All view with several carried entities gives one clause per entity", async () => {
    const all = await render({ bucket: "all", period: "2027-03" });
    expect(all).toMatch(/\(Personal: 3 months, Sudden Valley: 3 months\)|\(Sudden Valley: 3 months, Personal: 3 months\)/);
  });

  it("a month with its own rows has no notice and no 'saved for' text", async () => {
    const own = await render({ bucket: "personal", period: "2026-12" });
    expect(own).not.toContain("saved for");
    expect(own).not.toContain("carried-notice");
  });

  it("the line button reads 'End line' (not 'Delete') and each line carries its later-saved-month count", async () => {
    const html = await render({ bucket: "personal", period: "2026-12" });
    expect(html).toContain("End line");
    expect(html).not.toMatch(/>\s*Delete\s*</);
    const lines = H.s.clientProps!.budgets as Array<{ laterSavedMonths: number | null }>;
    expect(lines.length).toBe(5);
    expect(lines.every((l) => l.laterSavedMonths === 0)).toBe(true); // nothing saved after December in this fixture
    const carried = await render({ bucket: "personal", period: "2027-01" });
    expect(carried).toContain("End line");
  });
});

import { carriedEditNote, endLineConfirmText, firstEditSaveSentence, monthName } from "@/lib/budget-first-edit-note";

describe("TESTER round 1: wording helpers (pure)", () => {
  it("end-line confirm: 0, 1, N and unknown variants, singular/plural grammar, always the earlier-months and bill sentences", () => {
    const tail = " Earlier months are not changed. The linked scheduled bill will also be deactivated.";
    expect(endLineConfirmText("Water", "January 2027", 0)).toBe(`End "Water" from January 2027 onward? This removes the line from January 2027; no later month has it saved, and it stops appearing in the budget and the forecast from then on.${tail}`);
    expect(endLineConfirmText("Water", "January 2027", 1)).toContain("and the 1 later month that already has it,");
    expect(endLineConfirmText("Water", "January 2027", 5)).toContain("and the 5 later months that already have it,");
    expect(endLineConfirmText("Water", "January 2027", null)).toContain("and every later month that already has it,");
    for (const n of [0, 1, 5, null]) expect(endLineConfirmText("Water", "January 2027", n)).toContain(tail.trim());
    expect(endLineConfirmText("Water", "January 2027", 2)).not.toMatch(/undefined|NaN|null/);
  });

  it("first-edit sentence: unknown count drops the number but still warns; dashboard note has the same three shapes", () => {
    expect(firstEditSaveSentence(null)).toContain("If earlier months after the last saved one are also empty, they are saved too.");
    expect(firstEditSaveSentence(["2027-01"])).toBe("The first time you change something here, the whole list is saved for this month.");
    expect(firstEditSaveSentence(["2026-10", "2026-11", "2026-12", "2027-01"])).toContain("saved for 4 months (October 2026 to January 2027)");
    expect(carriedEditNote("2026-12", ["2027-01"])).toBe("Carried from December 2026: this month has no saved budget of its own yet. Changing the amount saves the carried budget for this month.");
    expect(carriedEditNote("2026-09", ["2026-10", "2026-11", "2026-12", "2027-01"])).toContain("for 4 months (October 2026 to January 2027)");
    expect(carriedEditNote("2026-09", null)).toContain("and for any empty month before it");
    expect(monthName("2027-13")).toBe("2027-13");
  });
});

describe("TESTER round 1: authoritative months are per entity", () => {
  it("another entity having rows in a month does not stop this entity's empty month from carrying (loader path, several entities in one read)", async () => {
    H.s.rows.push(row({ entityId: "e-s", tagId: "t-sv", period: "2027-01", budgeted: D("60"), accountId: "a-2" }));
    const personal = await render({ bucket: "personal", period: "2027-01" });
    expect((personal.match(/Carried from December 2026/g) ?? []).length).toBe(5);
    expect(personal).toContain("$810.00");
    // and the entity that DOES have rows that month shows them as its own, not carried
    const sv = await render({ bucket: "sudden-valley", period: "2027-01" });
    expect(sv).not.toContain("Carried from");
    expect(sv).toContain("$60.00");
  });

  it("a month in which an entity has a row is authoritative: a line absent from it is not shown, even though it is in the latest month", async () => {
    // Personal: add a second month 2027-03 with all five lines; in 2027-02 (between) put ONE row only
    for (const t of ["t-home", "t-rep", "t-el", "t-ins", "t-tax"]) H.s.rows.push(row({ entityId: "e-p", tagId: t, period: "2027-03", budgeted: D("10") }));
    H.s.rows.push(row({ entityId: "e-p", tagId: "t-el", period: "2027-02", budgeted: D("90") }));
    const feb = await render({ bucket: "personal", period: "2027-02" });
    expect(feb).toContain("Electric");
    for (const gone of ["Insurance", "Property tax", "Repairs"]) expect(feb, gone).not.toContain(gone);
    expect(feb).not.toContain("carried-notice");
    // January (no rows at all) still carries all five from December
    const jan = await render({ bucket: "personal", period: "2027-01" });
    expect((jan.match(/Carried from December 2026/g) ?? []).length).toBe(5);
    // April (after the latest) carries from the latest own rows, which for lines with a March row is March
    const apr = await render({ bucket: "personal", period: "2027-04" });
    expect((apr.match(/Carried from March 2027/g) ?? []).length).toBe(5);
  });
});
