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

  let imported = 0;
  let skipped = 0;

  for (const row of toInsert) {
    const amount = new Prisma.Decimal(row.amount);
    const payeeNormalized = normalizePayee(row.payee);
    let postedAt: Date;
    try {
      postedAt = new Date(normalizeDate(row.date));
      if (isNaN(postedAt.getTime())) throw new Error("Invalid date");
    } catch {
      skipped++;
      continue;
    }

    // Dedup check (in case duplicates slipped through the preview)
    const existing = await db.transaction.findFirst({
      where: {
        accountId: parsed.accountId,
        archivedAt: null,
        postedAt,
        amount,
        payeeNormalized,
      },
    });
    if (existing) {
      skipped++;
      continue;
    }

    const tx = await db.transaction.create({
      data: {
        accountId: parsed.accountId,
        entityId: parsed.entityId,
        postedAt,
        amount,
        payeeRaw: row.payee,
        payeeNormalized,
        description: row.description,
        source: "import",
      },
    });

    // Auto-assign tag from rules
    const matchedTagId = matchTagRule(ruleInput, {
      normalizedPayee: payeeNormalized,
      amount: amount.abs().toNumber(),
      accountId: parsed.accountId,
    });
    if (matchedTagId) {
      await db.transactionTag.create({
        data: { transactionId: tx.id, tagId: matchedTagId },
      }).catch(() => {}); // ignore if tag no longer exists
    }

    imported++;
  }

  revalidatePath("/transactions");
  revalidatePath("/");
  return { success: true, imported, skipped };
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
