// DB-aware read side of the tax facts store (tax-facts-carry-forward-store).
//
// READ-ONLY: this file only reads (`findFirst`, `findMany`). Writes happen in `actions/tax-facts.ts`, behind
// `requireAuth()`. It has no auth of its own, so callers (the /tax/facts page) check the session first. The store is
// NOT read by the TY2025 engine, the return fingerprint or the AI reviewer, and this file imports none of them.
//
// Fails closed: a missing table (the migration is not applied yet) is its own state, never a crash and never an empty list
// that looks like "no facts".

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  CARRY_POLICIES,
  CHANGE_KINDS,
  FACT_CATEGORIES,
  SOURCE_KINDS,
  VALUE_KINDS,
  asMember,
  type TaxFactRow,
} from "@/lib/tax-facts/types";

type StoredFact = Prisma.TaxFactGetPayload<object>;

export type TaxFactsLoad =
  | { state: "ok"; entityId: string; rows: TaxFactRow[]; skipped: number }
  | { state: "no_entity" }
  | { state: "table_missing" }
  | { state: "error" };

/** The household return belongs to the Personal entity (same convention as donations and overrides). */
export async function resolvePersonalEntityId(): Promise<string | null> {
  const personal = await db.entity.findFirst({
    where: { type: "personal", archivedAt: null },
    select: { id: true },
  });
  return personal?.id ?? null;
}

/** Prisma P2021: the table does not exist (the migration has not been applied). */
export function isMissingTable(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2021";
}

/** A stored row as the typed row the pure code uses; null when a stored value is not in its closed vocabulary. */
export function convertStoredFact(r: StoredFact): TaxFactRow | null {
  const category = asMember(FACT_CATEGORIES, r.category);
  const valueKind = asMember(VALUE_KINDS, r.valueKind);
  const carryPolicy = asMember(CARRY_POLICIES, r.carryPolicy);
  const changeKind = asMember(CHANGE_KINDS, r.changeKind);
  const sourceKind = asMember(SOURCE_KINDS, r.sourceKind);
  if (!category || !valueKind || !carryPolicy || !changeKind || !sourceKind) return null;
  return {
    id: r.id,
    factKey: r.factKey,
    version: r.version,
    category,
    label: r.label,
    taxYear: r.taxYear,
    valueKind,
    valueCents: r.valueCents,
    valueText: r.valueText,
    carryPolicy,
    changeKind,
    sourceKind,
    sourceRef: r.sourceRef,
    reason: r.reason,
    confirmedAt: r.confirmedAt,
    setByName: r.setByName,
    setAt: r.setAt,
    archivedAt: r.archivedAt,
  };
}

/** Every version of every fact, oldest first within a key. Rows with an unrecognised stored value are counted, not shown. */
export async function loadTaxFacts(): Promise<TaxFactsLoad> {
  try {
    const entityId = await resolvePersonalEntityId();
    if (!entityId) return { state: "no_entity" };
    const stored = await db.taxFact.findMany({
      where: { entityId },
      orderBy: [{ factKey: "asc" }, { version: "asc" }],
    });
    const rows: TaxFactRow[] = [];
    let skipped = 0;
    for (const r of stored) {
      const row = convertStoredFact(r);
      if (row === null) skipped += 1;
      else rows.push(row);
    }
    return { state: "ok", entityId, rows, skipped };
  } catch (e) {
    if (isMissingTable(e)) return { state: "table_missing" };
    // Never echo the error text (it may carry row data); the name is enough to find it in the logs.
    console.error("tax facts could not be loaded:", e instanceof Error ? e.name : "unknown error");
    return { state: "error" };
  }
}
