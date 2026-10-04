"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  decisionKeyOf,
  decisionSnapshot,
  isAckableStatus,
  isSupportedOverrideTaxYear,
  isValidDecisionChoice,
  lineSnapshot,
  OVERRIDE_AUTHORITIES,
  OVERRIDE_MAX_ABS_CENTS,
  OVERRIDE_TARGET_KINDS,
  checkLineOverrideAgainstBase,
  DECISION_KEYS,
  DECISION_REGISTRY,
  reasonSchema,
  ruleSnapshot,
  type ComputedSnapshot,
  type OverrideActionResult,
  type OverrideHistoryRow,
  type OverrideHistoryResult,
  type OverrideTargetKind,
  type OverrideValueKind,
} from "@/lib/tax2025/overrides";
import { containsSsnLikeText } from "@/lib/tax-extraction-schema";
import { loadBaseAndActive, loadOverrideHistory, resolvePersonalEntityId } from "@/lib/tax2025-overrides-build";
import { LINE_KEYS } from "@/lib/tax2025/types";

// TY2025 return overrides: Eric records a CPA instruction (or his own decision) over
// the computed return. Append-only: setting creates version + 1 and archives the
// previous active version ("superseded"); clearing only sets archivedAt. There is
// NO update-in-place and NO delete (tax records are never hard-deleted). The
// reason / archiveReason text is stored and shown but NEVER written to AuditLog:
// audit rows hold ids, kinds, keys, versions and values only.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

type Result = OverrideActionResult;

const yearSchema = z
  .number()
  .int()
  .refine((y): y is 2025 => isSupportedOverrideTaxYear(y), "Overrides are supported for tax year 2025 only.");

const authoritySchema = z.enum(OVERRIDE_AUTHORITIES);

const commonFields = {
  taxYear: yearSchema,
  authority: authoritySchema.default("owner"),
  reason: reasonSchema,
};

const setSchema = z.discriminatedUnion("targetKind", [
  z.object({
    ...commonFields,
    targetKind: z.literal("line"),
    targetKey: z.string().min(1).max(40),
    /** Whole dollars expressed in cents (the server re-validates against the base return). */
    valueCents: z
      .number()
      .int("The override amount must be a whole number of dollars.")
      .refine((c) => c % 100 === 0, "Overrides are whole dollars (the amount cannot have cents).")
      .refine((c) => Math.abs(c) <= OVERRIDE_MAX_ABS_CENTS, "The override amount is too large."),
  }),
  z.object({
    ...commonFields,
    targetKind: z.literal("decision"),
    targetKey: z.enum(DECISION_KEYS as [string, ...string[]]),
    /** Choice id, validated against the typed registry below. */
    choice: z.string().min(1).max(40),
  }),
  z.object({
    ...commonFields,
    targetKind: z.literal("rule_ack"),
    targetKey: z.string().min(1).max(80),
  }),
]);

const clearSchema = z.object({
  id: z.string().uuid("Invalid id"),
  reason: reasonSchema,
});

const historySchema = z.object({
  taxYear: yearSchema,
  targetKind: z.enum(OVERRIDE_TARGET_KINDS),
  targetKey: z.string().min(1).max(80),
});

function revalidateYear(year: number) {
  revalidatePath(`/tax/forms/${year}`);
  revalidatePath(`/tax/forms/${year}/return`);
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/** Ids, key, version and value only: never the reason text. */
function auditShape(r: {
  id: string;
  taxYear: number;
  targetKind: string;
  targetKey: string;
  version: number;
  valueKind: string;
  valueCents: number | null;
  valueText: string | null;
  authority: string;
}) {
  return {
    id: r.id,
    taxYear: r.taxYear,
    targetKind: r.targetKind,
    targetKey: r.targetKey,
    version: r.version,
    valueKind: r.valueKind,
    valueCents: r.valueCents,
    valueText: r.valueText,
    authority: r.authority,
  } satisfies Prisma.InputJsonValue;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

const SSN_REASON_ERROR = "The reason looks like a Social Security Number; remove it.";

/** Reasons are stored and printed on the PDF cover, so SSN-like text is refused BEFORE any DB or engine call. */
function reasonLooksLikeSsn(reason: string): boolean {
  return containsSsnLikeText(reason);
}

export async function setTaxReturnOverride(input: z.input<typeof setSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = setSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  if (reasonLooksLikeSsn(v.reason)) return { ok: false, error: SSN_REASON_ERROR };

  const author = await db.user.findUnique({ where: { id: user.id }, select: { name: true } });
  if (!author) return { ok: false, error: "Your user record was not found." };

  // The server rebuilds the BASE return itself: client-supplied numbers are never trusted.
  const loaded = await loadBaseAndActive(v.taxYear);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const { entityId, base, engineVersion } = loaded;

  let valueKind: OverrideValueKind;
  let valueCents: number | null = null;
  let valueText: string | null = null;
  let snapshot: ComputedSnapshot;

  if (v.targetKind === "line") {
    const key = LINE_KEYS.find((k) => k === v.targetKey);
    const line = key ? base.lines[key] : undefined;
    const check = checkLineOverrideAgainstBase(v.valueCents, line);
    if (!check.ok || !line) return { ok: false, error: check.ok ? "That line is not on the computed return." : check.error };
    valueKind = "money_cents";
    valueCents = v.valueCents;
    snapshot = lineSnapshot(line, engineVersion);
  } else if (v.targetKind === "decision") {
    const dKey = decisionKeyOf(v.targetKey);
    if (!dKey) return { ok: false, error: "Unknown decision." };
    if (!isValidDecisionChoice(dKey, v.choice)) {
      return { ok: false, error: `"${v.choice}" is not a valid choice for ${DECISION_REGISTRY[dKey].label}.` };
    }
    const decision = base.decisions.find((d) => d.id === DECISION_REGISTRY[dKey].decisionId);
    if (!decision) return { ok: false, error: "That decision is not on the computed return." };
    valueKind = "choice";
    valueText = v.choice;
    snapshot = decisionSnapshot(decision, engineVersion);
  } else {
    const result = base.results.find((r) => r.ruleId === v.targetKey);
    if (!result) return { ok: false, error: "That rule is not on the computed return." };
    if (!isAckableStatus(result.status)) {
      return { ok: false, error: "Only a rule that needs your input or decision, or is missing an input, can be acknowledged." };
    }
    valueKind = "ack";
    snapshot = ruleSnapshot(result.status, engineVersion);
  }

  const targetKind: OverrideTargetKind = v.targetKind;
  const targetKey = v.targetKey;
  const now = new Date();

  try {
    const created = await db.$transaction(async (tx) => {
      const where = { taxYear: v.taxYear, entityId, targetKind, targetKey };
      const latest = await tx.taxReturnOverride.findFirst({
        where,
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const actives = await tx.taxReturnOverride.findMany({
        where: { ...where, archivedAt: null },
        orderBy: { version: "desc" },
      });
      if (actives.length > 0) {
        await tx.taxReturnOverride.updateMany({
          where: { id: { in: actives.map((a) => a.id) }, archivedAt: null },
          data: { archivedAt: now, archivedById: user.id, archiveKind: "superseded" },
        });
      }
      const row = await tx.taxReturnOverride.create({
        data: {
          ...where,
          version: (latest?.version ?? 0) + 1,
          valueKind,
          valueCents,
          valueText,
          computedSnapshot: json(snapshot),
          authority: v.authority,
          reason: v.reason,
          setById: user.id,
          setByName: author.name,
        },
      });
      const previous = actives[0];
      await tx.auditLog.create({
        data: {
          changedBy: user.id,
          changeType: "tax_return_override_set",
          before: previous ? auditShape(previous) : Prisma.JsonNull,
          after: auditShape(row),
        },
      });
      return row;
    });
    revalidateYear(v.taxYear);
    return { ok: true, id: created.id, version: created.version };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return {
        ok: false,
        code: "conflict",
        error: "Someone changed this override just now. Reload the page and try again.",
      };
    }
    throw e;
  }
}

/** Clearing archives the active version (archiveKind "cleared"); the row and its history stay forever. */
export async function clearTaxReturnOverride(input: z.input<typeof clearSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = clearSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  if (reasonLooksLikeSsn(parsed.data.reason)) return { ok: false, error: SSN_REASON_ERROR };

  const row = await db.taxReturnOverride.findFirst({ where: { id: parsed.data.id, archivedAt: null } });
  if (!row) return { ok: false, error: "Override not found (it may already be cleared or replaced)." };

  const cleared = await db.$transaction(async (tx) => {
    const res = await tx.taxReturnOverride.updateMany({
      where: { id: row.id, archivedAt: null },
      data: {
        archivedAt: new Date(),
        archivedById: user.id,
        archiveKind: "cleared",
        archiveReason: parsed.data.reason,
      },
    });
    if (res.count === 0) return false;
    await tx.auditLog.create({
      data: {
        changedBy: user.id,
        changeType: "tax_return_override_clear",
        before: auditShape(row),
        after: Prisma.JsonNull,
      },
    });
    return true;
  });
  if (!cleared) return { ok: false, error: "Override not found (it may already be cleared or replaced)." };

  revalidateYear(row.taxYear);
  return { ok: true, id: row.id, version: row.version };
}

/** All versions of one target, newest first, archived included. Reasons are returned (tax records) but never logged. */
export async function listTaxReturnOverrideHistory(
  input: z.input<typeof historySchema>
): Promise<OverrideHistoryResult> {
  await requireAuth();
  const parsed = historySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };

  const entityId = await resolvePersonalEntityId();
  if (!entityId) return { ok: false, error: "The Personal entity was not found." };

  const rows = await loadOverrideHistory(parsed.data.taxYear, entityId, parsed.data.targetKind, parsed.data.targetKey);
  const history: OverrideHistoryRow[] = rows.map((r) => ({
    id: r.id,
    version: r.version,
    valueKind: r.valueKind,
    valueCents: r.valueCents,
    valueText: r.valueText,
    authority: r.authority,
    reason: r.reason,
    setByName: r.setByName,
    setAt: r.setAt.toISOString(),
    archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
    archiveKind: r.archiveKind,
    archiveReason: r.archiveReason,
  }));
  return { ok: true, rows: history };
}
