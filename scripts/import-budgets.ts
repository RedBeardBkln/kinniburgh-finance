/**
 * Import budgets from data/budgets 2026 v2 (with accounts).csv verbatim.
 * Creates one budget record per CSV line for each month of 2026 (2026-01 through 2026-12).
 * Expected: 53 lines × 12 months = 636 records; $16,489/mo per month.
 *
 * Account mapping (owner-confirmed):
 *   mask → account lookup; blank on "Business Ventures" row → x2566 per owner decision.
 *
 * Run with: pnpm import:budgets
 */

import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { join } from "path";
import { PrismaClient, Prisma } from "@prisma/client";

const db = new PrismaClient();

interface CsvRow {
  NAME: string;
  Budgeted: string;
  Account: string; // last-4 mask or blank
}

// Arbor Retreat lines belong to Sudden Valley PM LLC entity (owner decision, June 2026).
// All other lines belong to Personal entity.
function resolveEntityByTagName(tagName: string, entities: { id: string; name: string }[]) {
  if (tagName.startsWith("Arbor Retreat")) {
    return entities.find((e) => e.name === "Sudden Valley Property Management, LLC")!;
  }
  return entities.find((e) => e.name === "Personal")!;
}

async function main() {
  const csvPath = join(process.cwd(), "data", "budgets 2026 v2 (with accounts).csv");
  const raw = readFileSync(csvPath, "utf-8");

  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];

  console.log(`Parsed ${rows.length} rows from CSV (expected 53).`);
  if (rows.length !== 53) {
    throw new Error(`CSV row count mismatch: expected 53, got ${rows.length}`);
  }

  const entities = await db.entity.findMany();
  const accounts = await db.account.findMany({ where: { archivedAt: null } });

  function findAccountByMask(mask: string) {
    return accounts.find((a) => a.mask === mask) ?? null;
  }

  // Verify sum = $16,489.00
  const monthlyTotal = rows.reduce((sum, r) => sum + parseFloat(r.Budgeted), 0);
  if (Math.round(monthlyTotal * 100) !== 1648900) {
    throw new Error(
      `Budget monthly total mismatch: expected $16,489.00, got $${monthlyTotal.toFixed(2)}`
    );
  }
  console.log(`Monthly total verified: $${monthlyTotal.toFixed(2)} ✓`);

  const months = Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, "0");
    return `2026-${m}`;
  });

  let created = 0;
  let skipped = 0;

  for (const period of months) {
    for (const row of rows) {
      const tagName = row.NAME;
      const budgeted = new Prisma.Decimal(row.Budgeted);

      // Resolve account: blank "Business Ventures" → x2566 (owner decision)
      const mask = row.Account || "2566";
      const account = findAccountByMask(mask);
      if (!account) {
        throw new Error(`Account not found for mask ${mask} (tag: ${tagName})`);
      }

      const tag = await db.tag.findUnique({ where: { name: tagName } });
      if (!tag) {
        throw new Error(
          `Tag not found: "${tagName}" — run pnpm import:tags first`
        );
      }

      const entity = resolveEntityByTagName(tagName, entities);

      const existing = await db.budget.findUnique({
        where: { tagId_entityId_period: { tagId: tag.id, entityId: entity.id, period } },
      });

      if (existing) {
        skipped++;
        continue;
      }

      await db.budget.create({
        data: {
          tagId: tag.id,
          entityId: entity.id,
          accountId: account.id,
          period,
          budgeted,
        },
      });
      created++;
    }
  }

  const total = await db.budget.count();
  console.log(
    `Done. ${created} created, ${skipped} skipped (already existed). ${total} total budget records.`
  );
  console.log(`Expected 636 (53 lines × 12 months). Got ${total}.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
