import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Decimal } from "@prisma/client/runtime/library";
import {
  classifyProject,
  describeProjectForecast,
  projectEventsForAccount,
  type ProjectForecastInput,
} from "@/lib/project-forecast";
import { buildUpcomingLedger, type UpcomingLedgerInput } from "@/lib/upcoming-ledger";

const D = (v: string | number) => new Decimal(v);
const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);
const TODAY = utc("2026-10-15");

function project(over: Partial<ProjectForecastInput> = {}): ProjectForecastInput {
  return {
    id: "p1",
    name: "Bathroom",
    entityId: "e1",
    accountId: "acc1",
    accountEntityId: "e1",
    status: "active",
    budget: D(10000),
    spent: D(4000),
    targetDate: utc("2026-11-20"),
    ...over,
  };
}

describe("classifyProject", () => {
  it("counts a dated project with an account as what is left of the budget", () => {
    const c = classifyProject(project(), TODAY);
    expect(c).toMatchObject({ state: "counted", accountId: "acc1" });
    if (c.state === "counted") {
      expect(c.amount.toString()).toBe("6000");
      expect(c.date.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    }
  });

  it("no target date = an ongoing project, never a one-time expense", () => {
    expect(classifyProject(project({ targetDate: null }), TODAY).state).toBe("ongoing");
  });

  it("no account means it is left out and flagged, even with a date", () => {
    expect(classifyProject(project({ accountId: null }), TODAY).state).toBe("no_account");
    expect(classifyProject(project({ accountId: null, targetDate: null }), TODAY).state).toBe("no_account");
  });

  it("a passed date is left out (never moved to today); today itself still counts", () => {
    expect(classifyProject(project({ targetDate: utc("2026-10-14") }), TODAY).state).toBe("target_passed");
    expect(classifyProject(project({ targetDate: utc("2026-10-15") }), TODAY).state).toBe("counted");
  });

  it("nothing left once the budget is spent (or over-spent)", () => {
    expect(classifyProject(project({ spent: D(10000) }), TODAY).state).toBe("nothing_left");
    expect(classifyProject(project({ spent: D(12000) }), TODAY).state).toBe("nothing_left");
  });

  it("paused and completed projects are not forecast", () => {
    expect(classifyProject(project({ status: "paused" }), TODAY).state).toBe("not_active");
    expect(classifyProject(project({ status: "completed" }), TODAY).state).toBe("not_active");
  });
});

describe("projectEventsForAccount", () => {
  const from = TODAY;
  const to = utc("2027-01-13"); // 90 days

  it("is a negative event on the target date for the project's own account only", () => {
    const events = projectEventsForAccount([project()], "acc1", from, to, TODAY);
    expect(events).toHaveLength(1);
    expect(events[0]!.amount.toString()).toBe("-6000");
    expect(events[0]!.date.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(events[0]!.description).toContain("Bathroom");
    expect(projectEventsForAccount([project()], "other", from, to, TODAY)).toEqual([]);
  });

  it("leaves out ongoing projects, projects with no account and dates outside the window", () => {
    const list = [
      project({ id: "a", targetDate: null }),
      project({ id: "b", accountId: null }),
      project({ id: "c", targetDate: utc("2027-03-01") }),
      project({ id: "d", targetDate: utc("2027-01-13") }), // [from, to) is half-open like the other generators
    ];
    expect(projectEventsForAccount(list, "acc1", from, to, TODAY)).toEqual([]);
  });
});

describe("describeProjectForecast", () => {
  it("says plainly what the forecast does with the project", () => {
    expect(describeProjectForecast(classifyProject(project(), TODAY), "Primary Checking")).toEqual({
      counted: true,
      text: "In the forecast: $6,000 still to spend, leaving Primary Checking on Nov 20, 2026.",
    });
    expect(describeProjectForecast(classifyProject(project({ targetDate: null }), TODAY), null).text).toContain("Ongoing project");
    expect(describeProjectForecast(classifyProject(project({ accountId: null }), TODAY), null).text).toContain("choose the account");
  });
});

describe("the upcoming ledger counts a project as an estimated outflow", () => {
  const base: UpcomingLedgerInput = { from: TODAY, days: 60, entityId: "e1" } as unknown as UpcomingLedgerInput;

  it("lists it on the target date with its amount, in the totals as an estimate", () => {
    const ledger = buildUpcomingLedger({
      ...base,
      projects: [{ id: "p1", name: "Bathroom", entityId: "e1", accountId: "acc1", amount: "6000.00", date: utc("2026-11-20") }],
    });
    const item = ledger.items.find((i) => i.source === "project");
    expect(item).toBeDefined();
    expect(item!.amount?.toString()).toBe("-6000");
    expect(item!.tier).toBe("estimated");
    expect(item!.accountId).toBe("acc1");
    expect(ledger.totals.outflow.toString()).toBe("6000");
    expect(ledger.totals.outflowEstimated.toString()).toBe("6000");
  });

  it("ignores a project dated outside the window and one in another entity's view", () => {
    const row = { id: "p1", name: "Bathroom", entityId: "e1", accountId: "acc1", amount: "6000.00", date: utc("2027-06-01") };
    expect(buildUpcomingLedger({ ...base, projects: [row] }).items.filter((i) => i.source === "project")).toEqual([]);
    const other = buildUpcomingLedger({ ...base, entityId: "e2", projects: [{ ...row, date: utc("2026-11-20") }] });
    expect(other.items.filter((i) => i.source === "project")).toEqual([]);
  });
});

describe("project forecast wiring (source guards)", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

  it("the pure module has no database, Next or clock", () => {
    const src = read("lib/project-forecast.ts");
    expect(src).not.toMatch(/from "@\/lib\/db"|from "next\/|server-only|"use server"|new Date\(\)|Date\.now\(/);
  });

  it("the loader never writes and selects explicit columns", () => {
    const src = read("lib/project-forecast-build.ts");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(src).toMatch(/select:\s*\{/);
    expect(src).not.toMatch(/include:/);
    expect(src).toMatch(/archivedAt: null/);
  });

  it("creating a project needs an account; editing can change it", () => {
    const src = read("actions/projects.ts");
    expect(src).toMatch(/accountId: z\.string\(\)\.uuid\(/);
    expect(src).toMatch(/accountId: string;\n  \}>/);
    expect(src).toMatch(/assertAccountUsable\(/);
  });
});
