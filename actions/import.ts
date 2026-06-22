"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { normalizePayee, matchTagRule } from "@/lib/tags";
import { revalidatePath } from "next/cache";
import { z } from "zod";

// ── CSV column mapping ────────────────────────────────────────────────────────

export interface ColumnMapping {
  date: string;       // column name for the date field
  payee: string;      // column name for the payee/description
  amount: string;     // column name for the amount
  credit?: string;    // optional separate credit column (for split credit/debit CSVs)
  debit?: string;     // optional separate debit column
  description?: string;
}

export interface ParsedRow {
  date: string;
  payee: string;
  amount: string; // signed decimal string; negative = outflow
  description?: string;
  isDuplicate?: boolean;
}

// ── Parse CSV string into rows using column mapping ───────────────────────────

export async function parseImportPreview(opts: {
  csvContent: string;
  mapping: ColumnMapping;
  accountId: string;
}): Promise<{ rows: ParsedRow[]; headers: string[] }> {
  const { csvContent, mapping, accountId } = opts;

  const lines = csvContent
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return { rows: [], headers: [] };

  // Parse headers
  const headers = parseCsvLine(lines[0] ?? "");

  const colIndex = (name: string) => {
    const idx = headers.findIndex(
      (h) => h.toLowerCase().trim() === name.toLowerCase().trim()
    );
    return idx;
  };

  const dateIdx = colIndex(mapping.date);
  const payeeIdx = colIndex(mapping.payee);
  const amountIdx = mapping.amount ? colIndex(mapping.amount) : -1;
  const creditIdx = mapping.credit ? colIndex(mapping.credit) : -1;
  const debitIdx = mapping.debit ? colIndex(mapping.debit) : -1;
  const descIdx = mapping.description ? colIndex(mapping.description) : -1;

  const rows: ParsedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i] ?? "");
    const dateStr = cells[dateIdx]?.trim() ?? "";
    const payeeStr = cells[payeeIdx]?.trim() ?? "";

    if (!dateStr || !payeeStr) continue;

    let amountStr: string;
    if (amountIdx >= 0 && cells[amountIdx]) {
      // Single amount column — strip currency symbols, keep sign
      amountStr = (cells[amountIdx] ?? "").replace(/[$,\s]/g, "");
    } else if (debitIdx >= 0 || creditIdx >= 0) {
      // Split debit/credit columns: debit = outflow (negative), credit = inflow (positive)
      const debit = parseFloat((cells[debitIdx] ?? "").replace(/[$,\s]/g, "")) || 0;
      const credit = parseFloat((cells[creditIdx] ?? "").replace(/[$,\s]/g, "")) || 0;
      const net = credit - debit;
      amountStr = net.toFixed(2);
    } else {
      continue; // can't determine amount
    }

    // Validate parseable amount
    if (isNaN(parseFloat(amountStr))) continue;

    rows.push({
      date: dateStr,
      payee: payeeStr,
      amount: amountStr,
      description: descIdx >= 0 ? cells[descIdx]?.trim() : undefined,
    });
  }

  // Dedup check against existing transactions
  if (accountId && rows.length > 0) {
    const existingTxns = await db.transaction.findMany({
      where: {
        accountId,
        archivedAt: null,
        postedAt: {
          gte: new Date(rows.at(-1)?.date ?? "2000-01-01"),
          lte: new Date(rows[0]?.date ?? "2100-01-01"),
        },
      },
      select: { postedAt: true, amount: true, payeeNormalized: true },
    });

    const existingSet = new Set(
      existingTxns.map(
        (t) =>
          `${t.postedAt.toISOString().slice(0, 10)}|${Number(t.amount).toFixed(2)}|${t.payeeNormalized}`
      )
    );

    for (const row of rows) {
      const normalized = normalizePayee(row.payee);
      const key = `${normalizeDate(row.date)}|${parseFloat(row.amount).toFixed(2)}|${normalized}`;
      row.isDuplicate = existingSet.has(key);
    }
  }

  return { rows, headers };
}

// ── Confirm import ────────────────────────────────────────────────────────────

const importSchema = z.object({
  accountId: z.string().uuid(),
  entityId: z.string().uuid(),
  rows: z.array(
    z.object({
      date: z.string(),
      payee: z.string().min(1),
      amount: z.string(),
      description: z.string().optional(),
      skipDuplicate: z.boolean().optional(),
    })
  ),
});

export async function confirmImport(input: z.infer<typeof importSchema>) {
  await auth().then((s) => {
    if (!s?.user) throw new Error("Unauthorized");
  });

  const parsed = importSchema.parse(input);

  const tagRules = await db.tagRule.findMany();
  const ruleInput = tagRules.map((r) => ({
    tagId: r.tagId,
    payeePattern: r.payeePattern,
    amountMin: r.amountMin ? Number(r.amountMin) : null,
    amountMax: r.amountMax ? Number(r.amountMax) : null,
    accountId: r.accountId,
  }));

  const toInsert = parsed.rows.filter((r) => !r.skipDuplicate);

  // Pre-process: parse dates and normalize payees up front
  interface ProcessedRow {
    date: Date;
    payee: string;
    payeeNormalized: string;
    amount: Prisma.Decimal;
    description: string | undefined;
  }
  const processed: ProcessedRow[] = [];
  let skipped = 0;

  for (const row of toInsert) {
    try {
      const date = new Date(normalizeDate(row.date));
      if (isNaN(date.getTime())) throw new Error("Invalid date");
      processed.push({
        date,
        payee: row.payee,
        payeeNormalized: normalizePayee(row.payee),
        amount: new Prisma.Decimal(row.amount),
        description: row.description,
      });
    } catch {
      skipped++;
    }
  }

  if (processed.length === 0) {
    return { success: true, imported: 0, skipped };
  }

  // Batch dedup check: fetch existing transactions on any of these dates for this account
  const uniqueDates = [...new Set(processed.map((r) => r.date.toISOString()))].map(
    (d) => new Date(d)
  );
  const existingTxns = await db.transaction.findMany({
    where: {
      accountId: parsed.accountId,
      archivedAt: null,
      postedAt: { in: uniqueDates },
    },
    select: { postedAt: true, amount: true, payeeNormalized: true },
  });
  const existingSet = new Set(
    existingTxns.map(
      (t) => `${t.postedAt.getTime()}|${t.amount.toString()}|${t.payeeNormalized}`
    )
  );

  const unique = processed.filter(
    (r) =>
      !existingSet.has(
        `${r.date.getTime()}|${r.amount.toString()}|${r.payeeNormalized}`
      )
  );
  skipped += processed.length - unique.length;

  if (unique.length === 0) {
    revalidatePath("/transactions");
    revalidatePath("/");
    return { success: true, imported: 0, skipped };
  }

  // Batch insert all new transactions at once
  const created = await db.transaction.createManyAndReturn({
    data: unique.map((r) => ({
      accountId: parsed.accountId,
      entityId: parsed.entityId,
      postedAt: r.date,
      amount: r.amount,
      payeeRaw: r.payee,
      payeeNormalized: r.payeeNormalized,
      description: r.description,
      source: "import" as const,
    })),
    skipDuplicates: true,
  });

  // Batch tag assignment
  const tagData = created
    .map((tx) => {
      const tagId = matchTagRule(ruleInput, {
        normalizedPayee: tx.payeeNormalized ?? "",
        amount: new Prisma.Decimal(tx.amount).abs().toNumber(),
        accountId: parsed.accountId,
      });
      return tagId ? { transactionId: tx.id, tagId } : null;
    })
    .filter((t): t is { transactionId: string; tagId: string } => t !== null);

  if (tagData.length > 0) {
    await db.transactionTag.createMany({ data: tagData, skipDuplicates: true });
  }

  revalidatePath("/transactions");
  revalidatePath("/");
  return { success: true, imported: created.length, skipped };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/** Normalize various date formats to YYYY-MM-DD for dedup key. */
function normalizeDate(raw: string): string {
  // Try ISO first
  const iso = new Date(raw);
  if (!isNaN(iso.getTime())) return iso.toISOString().slice(0, 10);
  // Try MM/DD/YYYY
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1]!.padStart(2, "0")}-${mdy[2]!.padStart(2, "0")}`;
  return raw;
}
