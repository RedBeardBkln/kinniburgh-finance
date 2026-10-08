"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { convertStoredFact, isMissingTable, resolvePersonalEntityId } from "@/lib/tax-facts-store";
import {
  CARRY_POLICIES,
  FACT_CATEGORIES,
  FACT_LIMITS,
  VALUE_KINDS,
  type TaxFactRow,
} from "@/lib/tax-facts/types";
import {
  MAX_FACT_TAX_YEAR,
  MIN_FACT_TAX_YEAR,
  containsPrivateIdentifier,
  privacyError,
  validateFactDraft,
  validateReason,
} from "@/lib/tax-facts/validate";
import { planNextVersion, type VersionRequest } from "@/lib/tax-facts/versioning";
import { MIGRATION_MISSING_MESSAGE } from "@/lib/tax-facts/format";
import { checkCarryTarget } from "@/lib/tax-facts/carry-target";
import { TAX_FACTS_SEED_CONFIRMED_AT, TAX_FACTS_SEED_TY2025, TAX_FACTS_SEED_VERSION } from "@/lib/tax-facts/seed-ty2025";

// Tax facts carry-forward store: the owner records, changes, re-confirms and retires the facts he told the app, and
// loads the TY2025 seed. Append-only: every change inserts version + 1 and sets archivedAt on the previous latest
// version ("superseded"); there is NO update-in-place and NO delete (tax records are never hard-deleted). The label,
// value, reason and seed text are stored and shown but NEVER written to AuditLog: audit rows hold ids, the key, the
// version, the category, the policy, the kind of change, the tax year and the value type only.
// The store is not read by the TY2025 engine, the return fingerprint or the AI reviewer.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

export type TaxFactActionResult =
  | { ok: true; id: string; version: number }
  | { ok: false; error: string; code?: "conflict" | "migration_missing" };

export type TaxFactSeedResult =
  | { ok: true; inserted: number; alreadyPresent: number; total: number }
  | { ok: false; error: string; code?: "migration_missing" };

const yearSchema = z.number().int().min(MIN_FACT_TAX_YEAR).max(MAX_FACT_TAX_YEAR);
const keySchema = z.string().min(1).max(FACT_LIMITS.keyMax);
const reasonField = z.string().max(FACT_LIMITS.reasonMax).nullable().optional();
const centsField = z.number().int().nullable().optional();
const textField = z.string().max(FACT_LIMITS.textMax).nullable().optional();

const setSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    factKey: keySchema,
    category: z.enum(FACT_CATEGORIES),
    label: z.string().max(FACT_LIMITS.labelMax),
    valueKind: z.enum(VALUE_KINDS),
    valueCents: centsField,
    valueText: textField,
    carryPolicy: z.enum(CARRY_POLICIES),
    taxYear: yearSchema,
    sourceRef: z.string().max(FACT_LIMITS.sourceRefMax).nullable().optional(),
    reason: reasonField,
  }),
  z.object({
    mode: z.literal("change"),
    factKey: keySchema,
    taxYear: yearSchema,
    valueCents: centsField,
    valueText: textField,
    newLabel: z.string().max(FACT_LIMITS.labelMax).optional(),
    reason: reasonField,
  }),
]);

const reconfirmSchema = z.object({ factKey: keySchema, taxYear: yearSchema, reason: reasonField });
const policySchema = z.object({ factKey: keySchema, carryPolicy: z.enum(CARRY_POLICIES), reason: reasonField });
const retireSchema = z.object({ factKey: keySchema, taxYear: yearSchema, reason: z.string().max(FACT_LIMITS.reasonMax) });

function json(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/** Ids, key, version, category, policy, kind of change, year and value type only: never a label, a value or a reason. */
function auditShape(r: {
  id: string;
  version: number;
  factKey: string;
  category: string;
  carryPolicy: string;
  changeKind: string;
  taxYear: number;
  valueKind: string;
}) {
  return {
    id: r.id,
    version: r.version,
    factKey: r.factKey,
    category: r.category,
    carryPolicy: r.carryPolicy,
    changeKind: r.changeKind,
    taxYear: r.taxYear,
    valueKind: r.valueKind,
  } satisfies Prisma.InputJsonValue;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** Every free-text field is checked BEFORE any database call; the rejected text is never echoed. */
function privacyProblem(fields: ReadonlyArray<readonly [string, string | null | undefined]>): string | null {
  for (const [name, text] of fields) {
    if (typeof text === "string" && text.length > 0 && containsPrivateIdentifier(text)) return privacyError(name);
  }
  return null;
}

function failure(e: unknown): TaxFactActionResult | TaxFactSeedResult {
  if (isUniqueViolation(e)) {
    return { ok: false, code: "conflict", error: "Someone changed this fact just now. Reload the page and try again." };
  }
  if (isMissingTable(e)) return { ok: false, code: "migration_missing", error: MIGRATION_MISSING_MESSAGE };
  throw e;
}

type Writer = { id: string; name: string };

/** One transaction: read every version of the key, plan the next one, archive the prior latest, insert, audit. */
async function writeVersion(
  entityId: string,
  author: Writer,
  req: VersionRequest,
  auditType: string
): Promise<TaxFactActionResult> {
  try {
    return await db.$transaction(async (tx): Promise<TaxFactActionResult> => {
      const stored = await tx.taxFact.findMany({
        where: { entityId, factKey: req.factKey },
        orderBy: { version: "desc" },
      });
      const existing: TaxFactRow[] = [];
      for (const s of stored) {
        const row = convertStoredFact(s);
        if (row === null) return { ok: false, error: "A stored version of this fact has an unrecognised value; nothing was changed." };
        existing.push(row);
      }
      const plan = planNextVersion(existing, req);
      if (!plan.ok) return { ok: false, error: plan.error };

      const now = new Date();
      if (plan.toArchiveIds.length > 0) {
        await tx.taxFact.updateMany({
          where: { id: { in: plan.toArchiveIds }, archivedAt: null },
          data: { archivedAt: now, archivedById: author.id },
        });
      }
      const row = await tx.taxFact.create({
        data: { ...plan.newRow, entityId, setById: author.id, setByName: author.name },
      });
      const previous = stored[0];
      await tx.auditLog.create({
        data: {
          changedBy: author.id,
          changeType: auditType,
          before: previous ? auditShape(previous) : Prisma.JsonNull,
          after: auditShape(row),
        },
      });
      return { ok: true, id: row.id, version: row.version };
    });
  } catch (e) {
    return failure(e) as TaxFactActionResult;
  }
}

async function loadWriter(userId: string): Promise<{ ok: true; writer: Writer; entityId: string } | { ok: false; error: string }> {
  const author = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!author) return { ok: false, error: "Your user record was not found." };
  const entityId = await resolvePersonalEntityId();
  if (!entityId) return { ok: false, error: "The Personal entity was not found." };
  return { ok: true, writer: { id: userId, name: author.name }, entityId };
}

/** Create a new fact (first version) or change an existing fact's value (new version; a reason is required). */
export async function setTaxFact(input: z.input<typeof setSchema>): Promise<TaxFactActionResult> {
  const user = await requireAuth();
  const parsed = setSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const bad = privacyProblem([
    ["label", v.mode === "create" ? v.label : v.newLabel],
    ["value", v.valueText],
    ["source reference", v.mode === "create" ? v.sourceRef : null],
    ["reason", v.reason],
  ]);
  if (bad) return { ok: false, error: bad };
  // Reject an invalid new fact before touching the database.
  if (v.mode === "create") {
    const draft = validateFactDraft({ ...v, sourceKind: "owner_statement" });
    if (!draft.ok) return { ok: false, error: draft.error };
    const r = validateReason(v.reason, false);
    if (!r.ok) return { ok: false, error: r.error };
  }

  try {
    const who = await loadWriter(user.id);
    if (!who.ok) return { ok: false, error: who.error };
    const confirmedAt = new Date();
    const req: VersionRequest =
      v.mode === "create"
        ? {
            factKey: v.factKey,
            changeKind: "established",
            taxYear: v.taxYear,
            confirmedAt,
            reason: v.reason,
            category: v.category,
            label: v.label,
            valueKind: v.valueKind,
            valueCents: v.valueCents,
            valueText: v.valueText,
            carryPolicy: v.carryPolicy,
            sourceKind: "owner_statement",
            sourceRef: v.sourceRef ?? null,
          }
        : {
            factKey: v.factKey,
            changeKind: "changed",
            taxYear: v.taxYear,
            confirmedAt,
            reason: v.reason,
            valueCents: v.valueCents,
            valueText: v.valueText,
            newLabel: v.newLabel,
          };
    const res = await writeVersion(who.entityId, who.writer, req, "tax_fact_set");
    if (res.ok) revalidatePath("/tax/facts");
    return res;
  } catch (e) {
    return failure(e) as TaxFactActionResult;
  }
}

/** Confirm the same value again for a later tax year: a new version with the new year, never an overwrite. */
export async function reconfirmTaxFact(input: z.input<typeof reconfirmSchema>): Promise<TaxFactActionResult> {
  const user = await requireAuth();
  const parsed = reconfirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const bad = privacyProblem([["reason", v.reason]]);
  if (bad) return { ok: false, error: bad };
  // The carry screen is the only caller: TY2025 and earlier are never re-confirmed (checked before any database call).
  const target = checkCarryTarget(v.taxYear, { latestClosedYear: null, now: new Date() });
  if (!target.ok) return { ok: false, error: target.message };
  try {
    const who = await loadWriter(user.id);
    if (!who.ok) return { ok: false, error: who.error };
    const res = await writeVersion(
      who.entityId,
      who.writer,
      { factKey: v.factKey, changeKind: "reconfirmed", taxYear: v.taxYear, confirmedAt: new Date(), reason: v.reason },
      "tax_fact_reconfirm"
    );
    if (res.ok) {
      revalidatePath("/tax/facts");
      revalidatePath(`/tax/facts/carry/${v.taxYear}`);
    }
    return res;
  } catch (e) {
    return failure(e) as TaxFactActionResult;
  }
}

/** Change what happens to a fact when a new year starts. The value and the year it was confirmed for stay as they were. */
export async function setTaxFactPolicy(input: z.input<typeof policySchema>): Promise<TaxFactActionResult> {
  const user = await requireAuth();
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const bad = privacyProblem([["reason", v.reason]]);
  if (bad) return { ok: false, error: bad };
  try {
    const who = await loadWriter(user.id);
    if (!who.ok) return { ok: false, error: who.error };
    const res = await writeVersion(
      who.entityId,
      who.writer,
      {
        factKey: v.factKey,
        changeKind: "policy_changed",
        taxYear: 0, // ignored: a policy change keeps the year the value was confirmed for
        confirmedAt: new Date(),
        reason: v.reason,
        newCarryPolicy: v.carryPolicy,
      },
      "tax_fact_policy"
    );
    if (res.ok) revalidatePath("/tax/facts");
    return res;
  } catch (e) {
    return failure(e) as TaxFactActionResult;
  }
}

/**
 * Retire a fact ("no longer applies from this year") or resolve an open item. Both are new versions that keep the
 * value for history; nothing is deleted. The reason is required.
 */
export async function retireTaxFact(input: z.input<typeof retireSchema>): Promise<TaxFactActionResult> {
  const user = await requireAuth();
  const parsed = retireSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const bad = privacyProblem([["reason", v.reason]]);
  if (bad) return { ok: false, error: bad };
  try {
    const who = await loadWriter(user.id);
    if (!who.ok) return { ok: false, error: who.error };
    const latest = await db.taxFact.findFirst({
      where: { entityId: who.entityId, factKey: v.factKey },
      orderBy: { version: "desc" },
      select: { valueKind: true },
    });
    if (!latest) return { ok: false, error: "That fact was not found." };
    const res = await writeVersion(
      who.entityId,
      who.writer,
      {
        factKey: v.factKey,
        changeKind: latest.valueKind === "open_item" ? "resolved" : "retired",
        taxYear: v.taxYear,
        confirmedAt: new Date(),
        reason: v.reason,
      },
      "tax_fact_retire"
    );
    if (res.ok) revalidatePath("/tax/facts");
    return res;
  } catch (e) {
    return failure(e) as TaxFactActionResult;
  }
}

/**
 * Load the TY2025 facts transcribed from specs/12 (lib/tax-facts/seed-ty2025.ts). Idempotent: it inserts version 1 only
 * for keys that have no row at all (never an update, never an upsert), so a fact the owner has since edited is never
 * overwritten and a second run inserts nothing. Writes only to TaxFact plus one AuditLog row (counts and the seed
 * version only).
 */
export async function seedTaxFactsTy2025(): Promise<TaxFactSeedResult> {
  const user = await requireAuth();

  // The seed is validated like any other input before anything is written.
  for (const s of TAX_FACTS_SEED_TY2025) {
    const draft = validateFactDraft({ ...s });
    if (!draft.ok) return { ok: false, error: `The built-in seed list is invalid (${s.factKey}).` };
  }

  try {
    const who = await loadWriter(user.id);
    if (!who.ok) return { ok: false, error: who.error };
    const present = await db.taxFact.findMany({
      where: { entityId: who.entityId, factKey: { in: TAX_FACTS_SEED_TY2025.map((s) => s.factKey) } },
      select: { factKey: true },
    });
    const have = new Set(present.map((p) => p.factKey));
    const fresh = TAX_FACTS_SEED_TY2025.filter((s) => !have.has(s.factKey));
    const total = TAX_FACTS_SEED_TY2025.length;
    if (fresh.length === 0) return { ok: true, inserted: 0, alreadyPresent: total, total };

    const inserted = await db.$transaction(async (tx) => {
      const res = await tx.taxFact.createMany({
        data: fresh.map((s) => ({
          entityId: who.entityId,
          factKey: s.factKey,
          version: 1,
          category: s.category,
          label: s.label,
          taxYear: s.taxYear,
          valueKind: s.valueKind,
          valueCents: s.valueCents ?? null,
          valueText: s.valueText ?? null,
          carryPolicy: s.carryPolicy,
          changeKind: "established",
          sourceKind: s.sourceKind,
          sourceRef: s.sourceRef,
          reason: s.reason ?? null,
          confirmedAt: TAX_FACTS_SEED_CONFIRMED_AT,
          setById: who.writer.id,
          setByName: who.writer.name,
        })),
        skipDuplicates: true,
      });
      await tx.auditLog.create({
        data: {
          changedBy: who.writer.id,
          changeType: "tax_fact_seed",
          before: Prisma.JsonNull,
          after: json({ seedVersion: TAX_FACTS_SEED_VERSION, inserted: res.count, total }),
        },
      });
      return res.count;
    });
    revalidatePath("/tax/facts");
    return { ok: true, inserted, alreadyPresent: total - fresh.length, total };
  } catch (e) {
    return failure(e) as TaxFactSeedResult;
  }
}
