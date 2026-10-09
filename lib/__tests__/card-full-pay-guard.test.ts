import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-reading guard for the owner's rule: EVERY credit card is paid in full each month, so the minimum payment
// never applies. No computation, projection, notification, ledger line, advisor tool or Accounts page may read it.
// The database column and the Plaid sync that stores it are kept on purpose (additive-only schema); they are the
// allow-list at the bottom.

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const MINIMUM_PAYMENT_RE = /minimumPayment|ccMinimumPayment|minimum_payment/;

const MUST_NOT_READ_MINIMUM_PAYMENT = [
  "lib/forecast.ts",
  "lib/cc-funding.ts",
  "lib/card-due.ts",
  "lib/card-next-statement.ts",
  "lib/card-next-statement-build.ts",
  "lib/account-scheduled-flows.ts",
  "lib/upcoming-ledger.ts",
  "lib/upcoming-ledger-input.ts",
  "lib/upcoming-ledger-build.ts",
  "lib/upcoming-ledger-view.ts",
  "components/upcoming/upcoming-parts.tsx",
  "lib/notifications.ts",
  "app/forecast/page.tsx",
  "app/accounts/page.tsx",
  "components/accounts/accounts-page-client.tsx",
  "lib/advisor/tools/list-accounts.ts",
  "lib/advisor/queries/accounts.ts",
];

describe("the minimum payment never applies (every card is paid in full)", () => {
  it.each(MUST_NOT_READ_MINIMUM_PAYMENT)("%s does not read or pass a minimum payment", (file) => {
    expect(read(file)).not.toMatch(MINIMUM_PAYMENT_RE);
  });

  it("the advisor list_accounts description does not offer a minimum payment", () => {
    const src = read("lib/advisor/tools/list-accounts.ts");
    expect(src.toLowerCase()).not.toContain("minimum payment");
  });

  it("the funding message and the card notifications never say 'minimum payment'", () => {
    for (const file of ["lib/cc-funding.ts", "lib/notifications.ts", "lib/card-next-statement.ts"]) {
      expect(read(file).toLowerCase()).not.toContain("minimum payment");
    }
  });

  it("allow-list: the only places that still name the stored column are the schema, the Plaid sync and the PDF-statement extraction", () => {
    // These are kept deliberately: the column is part of the additive-only schema, the sync stores what Plaid sends,
    // and the PDF extraction labels a field of the statement document. None of them feeds a computation.
    expect(read("prisma/schema.prisma")).toContain("ccMinimumPayment");
    expect(read("lib/plaid-sync.ts")).toContain("minimumPayment");
    expect(read("lib/doc-extract.ts")).toContain("minimumPaymentCents");
  });
});

describe("no card is assigned to an account by its nickname", () => {
  it("the forecast page, notifications and the card modules never look an account up by the nickname 'Credit Cards' to fund a card", () => {
    const page = read("app/forecast/page.tsx");
    // the page may still use the nickname to choose which account the 14-day SCHEDULE is shown for, but never to fund a card
    expect(page).not.toContain("ccFundingAccount");
    expect(page).not.toContain("generateCardStatementPayment");
    expect(page).toContain("p.funding?.accountId");
    expect(read("lib/notifications.ts")).not.toMatch(/nickname:\s*"Credit Cards"/);
    for (const file of ["lib/card-next-statement.ts", "lib/card-next-statement-build.ts", "lib/cc-funding.ts"]) {
      expect(read(file)).not.toMatch(/["']Credit Cards["']/);
    }
  });

  it("the pure card module imports no database, auth or server-only code", () => {
    const src = read("lib/card-next-statement.ts");
    expect(src).not.toMatch(/from "@\/lib\/db"|from "@prisma\/client"|next\/cache|"use server"|requireAuth/);
  });

  it("the loaders are read-only", () => {
    for (const file of ["lib/card-next-statement-build.ts", "lib/account-scheduled-flows.ts"]) {
      const src = read(file);
      expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
      expect(src).not.toMatch(/\$executeRaw|\$queryRaw/);
    }
  });
});
