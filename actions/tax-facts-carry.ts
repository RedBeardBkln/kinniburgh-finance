"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { setTaxFact, type TaxFactActionResult } from "@/actions/tax-facts";
import { checkCarryTarget } from "@/lib/tax-facts/carry-target";
import { FACT_LIMITS } from "@/lib/tax-facts/types";
import { MAX_FACT_TAX_YEAR, MIN_FACT_TAX_YEAR } from "@/lib/tax-facts/validate";

// The carry screen's "It changed" writer: a new version of ONE fact for the carry target year. It refuses the TY2025 and
// earlier years (and, once a year can be marked filed, a filed year) before any database call, then delegates to
// `setTaxFact` in "change" mode so versioning, the privacy checks, archive-on-supersede and the audit shape stay the
// existing, tested path. One fact key per call: there is no array parameter and no bulk variant. The value and the
// reason are never written to AuditLog (setTaxFact's audit shape holds ids, the key, the version and the year only).
// The store is not read by the TY2025 engine, the return fingerprint or the AI reviewer.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

const changeSchema = z.object({
  factKey: z.string().min(1).max(FACT_LIMITS.keyMax),
  taxYear: z.number().int().min(MIN_FACT_TAX_YEAR).max(MAX_FACT_TAX_YEAR),
  valueCents: z.number().int().nullable().optional(),
  valueText: z.string().max(FACT_LIMITS.textMax).nullable().optional(),
  reason: z.string().max(FACT_LIMITS.reasonMax),
});

export async function changeTaxFactForCarry(input: z.input<typeof changeSchema>): Promise<TaxFactActionResult> {
  await requireAuth();
  const parsed = changeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const target = checkCarryTarget(v.taxYear, { latestClosedYear: null, now: new Date() });
  if (!target.ok) return { ok: false, error: target.message };
  const res = await setTaxFact({
    mode: "change",
    factKey: v.factKey,
    taxYear: v.taxYear,
    valueCents: v.valueCents,
    valueText: v.valueText,
    reason: v.reason,
  });
  if (res.ok) revalidatePath(`/tax/facts/carry/${v.taxYear}`);
  return res;
}
