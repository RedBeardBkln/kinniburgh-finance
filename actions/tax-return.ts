"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { buildTy2025ReturnWithOverrides } from "@/lib/tax2025-overrides-build";
import { sheetCsvFilename, sheetToCsv } from "@/lib/tax2025-sheet-csv";
import { loadSheet } from "@/lib/tax2025-sheet-load";

// CSV export of the TY2025 return review sheet (Phase 1c). READ-ONLY: it computes the
// return from existing data (lib/tax2025-build.ts is read-only) and returns the CSV text;
// nothing is written, stored or sent anywhere. The CSV is a computed DRAFT for your review
// (the preparer of record); lines without an amount are exported with an EMPTY amount, never 0.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

const yearSchema = z.number().int().min(2000).max(2100);

export type TaxReturnCsvResult = { ok: true; filename: string; csv: string } | { ok: false; error: string };

export async function exportTaxReturnCsv(year: number): Promise<TaxReturnCsvResult> {
  await requireAuth();
  const parsed = yearSchema.safeParse(year);
  if (!parsed.success) return { ok: false, error: "Invalid tax year" };

  const loaded = await loadSheet(parsed.data, { build: buildTy2025ReturnWithOverrides });
  if (loaded.kind === "unsupported_year") {
    return { ok: false, error: "The return engine is TY2025 only" };
  }
  if (loaded.kind === "error") return { ok: false, error: loaded.message };
  return { ok: true, filename: sheetCsvFilename(loaded.model), csv: sheetToCsv(loaded.model) };
}
