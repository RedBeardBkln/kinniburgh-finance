/**
 * Validate imported data and surface spec-07 items for owner review.
 * Run with: pnpm validate
 * Exit 0 = all checks pass; exit 1 = failures that must be addressed.
 */

import { PrismaClient, Prisma } from "@prisma/client";

const db = new PrismaClient();

let hasFailure = false;

function pass(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string) { console.error(`  ✗ ${msg}`); hasFailure = true; }
function warn(msg: string) { console.warn(`  ⚠ ${msg}`); }
function section(title: string) { console.log(`\n── ${title} ──`); }

async function main() {
  console.log("Validating imports…\n");

  // ── 1. Tag count ─────────────────────────────────────────────────────────────

  section("Tags");
  const tagCount = await db.tag.count();
  if (tagCount === 135) {
    pass(`Tag count: ${tagCount} ✓`);
  } else {
    fail(`Tag count: expected 135, got ${tagCount}`);
  }

  // ── 2. Tag quirks (import verbatim; surface for one-click cleanup) ────────────

  section("Tag quirks (spec 07 — imported verbatim; offer one-click cleanup)");

  const lowercaseMemberships = await db.tag.findUnique({ where: { name: "memberships / Apple" } });
  if (lowercaseMemberships) {
    warn(
      `"memberships / Apple" has lowercase parent reference (parent should be "Memberships"). ` +
      `Rename to "Memberships / Apple"? [awaiting owner approval]`
    );
  } else {
    fail(`Expected to find tag "memberships / Apple" (quirk from source CSV) — not found`);
  }

  const strayUtility = await db.tag.findUnique({ where: { name: "Utility/Internet" } });
  if (strayUtility) {
    warn(
      `Stray root tag "Utility/Internet" exists alongside "Utilities / Internet". ` +
      `Delete or merge? [awaiting owner approval]`
    );
  } else {
    fail(`Expected stray root tag "Utility/Internet" — not found`);
  }

  const misspelled = await db.tag.findUnique({ where: { name: "Misc. / ATM Withdrawl" } });
  if (misspelled) {
    warn(
      `"Misc. / ATM Withdrawl" has a misspelling ("Withdrawl" should be "Withdrawal"). ` +
      `Rename? [awaiting owner approval]`
    );
  } else {
    fail(`Expected tag "Misc. / ATM Withdrawl" (misspelling from source CSV) — not found`);
  }

  // ── 3. Budget line count ──────────────────────────────────────────────────────

  section("Budgets (2026-01 sample month)");

  const period = "2026-01";
  const budgetLines = await db.budget.count({ where: { period } });
  if (budgetLines === 53) {
    pass(`Budget line count for ${period}: ${budgetLines} ✓`);
  } else {
    fail(`Budget line count for ${period}: expected 53, got ${budgetLines}`);
  }

  // ── 4. Budget monthly total ───────────────────────────────────────────────────

  const sumResult = await db.budget.aggregate({
    where: { period },
    _sum: { budgeted: true },
  });
  const monthlyTotal = new Prisma.Decimal(sumResult._sum.budgeted ?? 0);
  const expected = new Prisma.Decimal("16489.00");

  if (monthlyTotal.equals(expected)) {
    pass(`Monthly total for ${period}: $${monthlyTotal.toFixed(2)} ✓`);
  } else {
    fail(`Monthly total for ${period}: expected $16,489.00, got $${monthlyTotal.toFixed(2)}`);
  }

  // ── 5. Per-account budget totals (spot check) ─────────────────────────────────

  section("Budget totals by account mask (2026-01)");

  const expected_by_mask: Record<string, string> = {
    "2566": "5744.00", // $5,694 explicit x2566 lines + $50 Business Ventures
    "2558": "7080.00",
    "2540": "1066.00",
    "3612": "1200.00",
    "0626": "1399.00",
  };

  const accounts = await db.account.findMany({ where: { mask: { in: Object.keys(expected_by_mask) } } });

  for (const [mask, expectedTotal] of Object.entries(expected_by_mask)) {
    const acct = accounts.find((a) => a.mask === mask);
    if (!acct) { fail(`Account x${mask} not found`); continue; }

    const sumR = await db.budget.aggregate({
      where: { period, accountId: acct.id },
      _sum: { budgeted: true },
    });
    const actual = new Prisma.Decimal(sumR._sum.budgeted ?? 0);
    const exp = new Prisma.Decimal(expectedTotal);

    if (actual.equals(exp)) {
      pass(`x${mask}: $${actual.toFixed(2)} ✓`);
    } else {
      fail(`x${mask}: expected $${exp.toFixed(2)}, got $${actual.toFixed(2)}`);
    }
  }

  // ── 6. Total budget record count ──────────────────────────────────────────────

  section("Total budget records (53 lines × 12 months = 636)");
  const totalBudgets = await db.budget.count();
  if (totalBudgets === 636) {
    pass(`Total budget records: ${totalBudgets} ✓`);
  } else {
    warn(`Total budget records: expected 636, got ${totalBudgets} (may be expected if import ran partially)`);
  }

  // ── 7. Spec-07 open items — MUST confirm before first use ─────────────────────

  section("Spec-07 open items (collect from owner before or at setup)");

  warn(
    "OPEN: Auto Insurance budget line is $120/mo (stale). " +
    "Actuals are Amica $206/mo + Progressive ~$10.58/mo ≈ $217/mo combined. " +
    "Update budget to ~$217? Should Progressive get its own line?"
  );

  warn(
    "OPEN: No funding transfer for Slush Funds (x3612). " +
    "The app will propose ~$277/wk from x2566 at setup — do not auto-create."
  );

  warn(
    "OPEN: Property values for 27 Old Barry Rd and 56 Arbor Rd not yet supplied. " +
    "Required for net worth calculation. Owner agreed to provide; pending."
  );

  warn(
    "OPEN: PennyMac and solar loan balances — pull via Plaid Liabilities at link time; " +
    "if Plaid doesn't support them, prompt owner for manual entry at setup."
  );

  warn(
    "OPEN: CPA confirmation of October 15, 2026 extended deadline for Eric Kinniburgh " +
    "Consulting LLC 2025 Schedule C filing. Do not rely on this date until CPA confirms."
  );

  warn(
    "OPEN: Savings (x3950) 'pay ourselves first' amount — recommend after 2–3 months " +
    "of linked transaction data. Do not create transfer yet."
  );

  warn(
    "OPEN: Property tax bill dates for 56 Arbor Rd — seeded as July/January (typical CT " +
    "semi-annual cycle). Confirm actual due dates with owner."
  );

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log("\n" + "─".repeat(50));
  if (hasFailure) {
    console.error("VALIDATION FAILED — fix errors above before proceeding.");
    process.exit(1);
  } else {
    console.log("All checks passed. 7 open items above require owner input (see warnings).");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
