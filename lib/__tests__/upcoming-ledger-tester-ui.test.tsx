// TESTER-authored adversarial UI / view / wiring tests for the upcoming ledger (task: upcoming-ledger).
import React from "react";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildUpcomingLedger, type UpcomingLedgerInput } from "@/lib/upcoming-ledger";
import { groupByWeek, parseHorizon, toUiLedger, type UiContext } from "@/lib/upcoming-ledger-view";
import { UpcomingWidget } from "@/components/upcoming/upcoming-widget";
import { UpcomingAgenda } from "@/components/upcoming/upcoming-agenda";

(globalThis as unknown as { React: typeof React }).React = React;

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const P = "ent-p";
const SV = "ent-sv";
const EK = "ent-ek";
const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const ctx = (over: Partial<UiContext> = {}): UiContext => ({
  days: 30,
  bucketSlug: "taxes",
  isAggregate: false,
  entityNameById: { [P]: "Personal", [SV]: "Sudden Valley", [EK]: "EK Consulting" },
  entitySlugById: { [P]: "personal", [SV]: "sudden-valley", [EK]: "ek-consulting" },
  accountNameById: { "acct-a": "Primary Checking" },
  includeTransfers: false,
  ...over,
});
const bill = (o: Record<string, unknown>) => ({
  accountId: "acct-a", entityId: P, amountType: "static", expectedAmount: 100, autopayDay: 12, annualBudget: null,
  active: true, budgetTagId: null, budgetEntityId: null, ...o,
});
const ui = (input: Partial<UpcomingLedgerInput>, c: Partial<UiContext> = {}, days = 30) =>
  toUiLedger(buildUpcomingLedger({ from: d("2026-10-08"), days, ...input }), ctx({ days, ...c }));
const widget = (l: ReturnType<typeof ui> | null, slug = "taxes") => renderToStaticMarkup(<UpcomingWidget ledger={l} bucketSlug={slug} />);
const agenda = (l: ReturnType<typeof ui> | null, h: 30 | 60 | 90 = 30, t = false, slug = "taxes") =>
  renderToStaticMarkup(<UpcomingAgenda ledger={l} bucketSlug={slug} horizon={h} showTransfers={t} />);

const aggregateInput = (): Partial<UpcomingLedgerInput> => ({
  entityId: null,
  bills: [
    bill({ id: "pb", payee: "Personal power", expectedAmount: 1234.56, autopayDay: 12 }),
    bill({ id: "sb", payee: "Valley taxes", entityId: SV, expectedAmount: 2000, autopayDay: 13 }),
  ] as UpcomingLedgerInput["bills"],
  incomeSources: [{ id: "i", accountId: "a", entityId: EK, description: "Consulting pay", cadence: "monthly", dayRules: { dayOfMonth: 15 }, amount: 5000, active: true }],
});

describe("aggregate (Taxes / Projects) views never show a blended total", () => {
  for (const [name, render] of [
    ["widget", (l: ReturnType<typeof ui>) => widget(l)],
    ["agenda", (l: ReturnType<typeof ui>) => agenda(l)],
  ] as const) {
    it(`${name}: per-entity lines, no 3,234.56 (the blend) and no netted figure`, () => {
      const html = render(ui(aggregateInput(), { isAggregate: true }));
      expect(html).toContain("Personal");
      expect(html).toContain("Sudden Valley");
      expect(html).toContain("EK Consulting");
      expect(html).toContain("~$1,234.56");
      expect(html).toContain("~$2,000.00");
      expect(html).toContain("~$5,000.00");
      expect(html).not.toContain("3,234.56"); // 1,234.56 + 2,000.00
      expect(html).not.toContain("1,765.44"); // 5,000 - 3,234.56 (netted)
      expect(html).not.toContain("8,234.56");
      expect(html).not.toMatch(/Biggest:/); // a single "biggest" across entities would blend them
    });
  }
  it("each row carries an entity chip and links through its OWN entity slug, not the 'taxes' bucket", () => {
    const html = widget(ui(aggregateInput(), { isAggregate: true }));
    expect(html).toContain("/forecast?bucket=personal");
    expect(html).toContain("/forecast?bucket=sudden-valley");
    expect(html).toMatch(/href="[^"]*bucket=personal[^"]*"[^>]*>Personal power</);
  });
  it("single-entity view keeps one total strip with biggest", () => {
    const html = widget(ui({ entityId: P, bills: aggregateInput().bills }, { bucketSlug: "personal" }), "personal");
    expect(html).toContain("~$1,234.56");
    expect(html).toContain("Biggest:");
    expect(html).not.toContain("Valley taxes");
  });
});

describe("unknown amounts in the UI", () => {
  it("shows 'amount not set' for the row, never a dollar figure for it, and a count", () => {
    const l = ui({ bills: [bill({ id: "u", payee: "Mystery", expectedAmount: null })] as UpcomingLedgerInput["bills"] });
    const html = widget(l);
    expect(html).toContain("amount not set");
    expect(html).toContain("1 item has no amount set");
    expect(html).not.toMatch(/Mystery<\/a>[^]*?~\$/);
    const ag = agenda(l);
    expect(ag).toContain("amount not set");
  });
  it("a day-not-set bill is listed in the disclosure with its amount, not placed on a date", () => {
    const l = ui({ bills: [bill({ id: "lx", payee: "Lexus Financial", expectedAmount: 250, autopayDay: null })] as UpcomingLedgerInput["bills"] });
    expect(l.items).toEqual([]);
    const html = widget(l);
    expect(html).toContain("Day not set (1)");
    expect(html).toContain("Lexus Financial");
    expect(html).toContain("~$250.00");
    expect(html).toContain("Nothing due in the next 30 days.");
  });
});

describe("transfers in the UI", () => {
  const tr = { id: "t", fromAccountId: "a1", toAccountId: "a2", fromEntityId: P, amount: 256, cadence: "weekly", dayRules: { dayOfWeek: 1 }, purpose: "Fund groceries", active: true };
  it("hidden by default (summary line only); listed when asked; never in the week subtotals or totals", () => {
    const input = { bills: [bill({ id: "b", payee: "Zed bill", expectedAmount: 50, autopayDay: 12 })] as UpcomingLedgerInput["bills"], transfers: [tr] };
    const hidden = ui(input);
    expect(hidden.items.some((i) => i.kind === "transfer")).toBe(false);
    expect(widget(hidden)).toContain("not counted");
    expect(widget(hidden)).not.toContain("Fund groceries");
    const shown = ui(input, { includeTransfers: true });
    expect(shown.items.filter((i) => i.kind === "transfer").length).toBe(4);
    expect(agenda(shown, 30, true)).toContain("Fund groceries");
    expect(shown.totals.outflow).toBe("50.00");
    const weeks = groupByWeek(shown.items);
    expect(weeks.reduce((n, w) => n + Number(w.outflow), 0)).toBe(50);
  });
});

describe("week subtotals reconcile to ledger totals (fuzz)", () => {
  it("sum of weekly outflow/inflow == totals for a single-entity ledger", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 60; n++) {
      const bills = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, k) =>
        bill({ id: `b${k}`, payee: `Bill${k}x${n}y`, expectedAmount: Math.round(rnd() * 100000) / 100 + 0.01, autopayDay: 1 + Math.floor(rnd() * 28),
          frequency: rnd() < 0.3 ? "weekly" : "monthly", payDayOfWeek: Math.floor(rnd() * 7) })
      ) as UpcomingLedgerInput["bills"];
      const l = ui({ bills, entityId: P }, { bucketSlug: "personal" }, 90);
      const weeks = groupByWeek(l.items);
      const sumOut = weeks.reduce((a, w) => a + Math.round(Number(w.outflow) * 100), 0);
      expect(sumOut).toBe(Math.round(Number(l.totals.outflow) * 100));
    }
  });
});

describe("date display does not shift a day (stored UTC midnight / ET-midnight dates)", () => {
  it("card due Oct 12 UTC-midnight renders Oct 12 (not Oct 11); deadlines stored 04:00Z/05:00Z render their ET calendar day", () => {
    const l = ui({
      cards: [{ id: "c", nickname: "jetBlue", entityId: P, ccDueDate: d("2026-10-12"), ccStatementBalance: 51.26 }],
      taxDeadlines: [
        { id: "t1", entityId: P, label: "Oct filing", dueDate: new Date("2026-10-15T04:00:00Z"), status: "upcoming" },
        { id: "t2", entityId: P, label: "Nov filing", dueDate: new Date("2026-11-02T05:00:00Z"), status: "upcoming" },
      ],
    });
    const byLabel = Object.fromEntries(l.items.map((i) => [i.label, i.dateLabel]));
    expect(byLabel["jetBlue statement due"]).toBe("Mon, Oct 12");
    expect(byLabel["Oct filing"]).toBe("Thu, Oct 15");
    expect(byLabel["Nov filing"]).toBe("Mon, Nov 2");
    const html = widget(l);
    expect(html).toContain("Oct 12");
    expect(html).not.toContain("Oct 11");
  });
  it("window end label: 'through Nov 6' for 30 days from Oct 8", () => {
    const l = ui({});
    expect(l.lastDayIso).toBe("2026-11-06");
    expect(widget(l)).toContain("through Nov 6");
  });
});

describe("agenda tabs", () => {
  it("every tab keeps the bucket and the transfers flag; the active one is marked; default is 90", () => {
    const html = agenda(ui({}, { bucketSlug: "sudden-valley" }), 60, true, "sudden-valley");
    expect(html).toContain("bucket=sudden-valley&amp;horizon=30&amp;transfers=1#upcoming");
    expect(html).toContain("bucket=sudden-valley&amp;horizon=90&amp;transfers=1#upcoming");
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
    expect(parseHorizon(undefined)).toBe(90);
    for (const bad of ["", "abc", "45", "-30", "30.5", "0", "9999"]) expect(parseHorizon(bad)).toBe(90);
    expect(parseHorizon("30")).toBe(30);
    expect(parseHorizon("60")).toBe(60);
  });
});

describe("wording", () => {
  it("no advice / certainty wording in the rendered widget and agenda for a rich ledger", () => {
    const l = ui(
      {
        entityId: null,
        ...aggregateInput(),
        bills: [
          ...(aggregateInput().bills as NonNullable<UpcomingLedgerInput["bills"]>),
          bill({ id: "f", payee: "Firewood", amountType: "accrued", expectedAmount: 83.33, annualBudget: 1000, autopayDay: null }),
          bill({ id: "fl", payee: "Fluct", amountType: "fluctuating", expectedAmount: 80, autopayDay: 14 }),
        ] as UpcomingLedgerInput["bills"],
        cards: [{ id: "c", nickname: "Barclay", entityId: P, ccDueDate: d("2026-10-05"), ccStatementBalance: 623.19 }],
      },
      { isAggregate: true }
    );
    const text = (widget(l) + agenda(l)).replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\b(will be charged|guarantee|guaranteed|you should|we recommend|invest|advice:)/i);
    expect(text).toContain("Not financial advice.");
    expect(text).toMatch(/\bdue\b/);
  });
});

describe("wiring / safety (static)", () => {
  it("both pages call auth() and redirect BEFORE the loader; widget only on the current period", () => {
    const home = read("app/page.tsx");
    expect(home.indexOf("auth()")).toBeGreaterThan(-1);
    expect(home.indexOf("auth()")).toBeLessThan(home.indexOf("loadUpcomingLedger("));
    expect(home).toMatch(/if \(isCurrentPeriod\) \{\s*try \{/);
    expect(home).toMatch(/\{isCurrentPeriod && <UpcomingWidget/);
    const fc = read("app/forecast/page.tsx");
    expect(fc.indexOf("auth()")).toBeGreaterThan(-1);
    expect(fc.indexOf("auth()")).toBeLessThan(fc.indexOf("loadUpcomingLedger("));
  });
  it("the loader is the only DB-aware new file, has no write path and no raw SQL, and is imported only by the two pages", () => {
    const src = read("lib/upcoming-ledger-build.ts");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/);
    expect(src).not.toMatch(/\$(executeRaw|queryRaw|executeRawUnsafe|queryRawUnsafe|transaction)/);
    expect(src).not.toMatch(/["']use server["']/);
    expect(src).not.toMatch(/revalidatePath|revalidateTag|cookies\(|headers\(/);
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        if (["node_modules", ".next", ".git", ".claude"].includes(e)) continue;
        const p = path.join(dir, e);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e) && !p.includes("__tests__") && /from "@\/lib\/upcoming-ledger-build"/.test(readFileSync(p, "utf8"))) importers.push(path.relative(root, p).replace(/\\/g, "/"));
      }
    };
    for (const dir of ["app", "actions", "components", "lib"]) walk(path.join(root, dir));
    expect(importers.sort()).toEqual(["app/forecast/page.tsx", "app/page.tsx"]);
  });
  it("new components and pure modules do not import the db or server-only modules", () => {
    for (const f of ["lib/upcoming-ledger.ts", "lib/upcoming-ledger-view.ts", "components/upcoming/upcoming-widget.tsx", "components/upcoming/upcoming-agenda.tsx", "components/upcoming/upcoming-parts.tsx"]) {
      const s = read(f)
        .split("\n")
        .filter((ln) => !/^\s*\/\//.test(ln))
        .join("\n");
      expect(s, f).not.toMatch(/@\/lib\/db|@prisma\/client["']|next\/cache|next\/headers|["']use server["']|["']use client["']/);
    }
  });
  it("components receive no Decimal or Date (plain-value convention)", () => {
    for (const f of ["components/upcoming/upcoming-widget.tsx", "components/upcoming/upcoming-agenda.tsx", "components/upcoming/upcoming-parts.tsx"]) {
      expect(read(f), f).not.toMatch(/Decimal|new Date\(|: Date\b/);
    }
  });
});
