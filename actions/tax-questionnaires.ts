"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ensurePersonalWorkspace } from "@/actions/tax-planning";
import {
  boundPlanningConflict,
  effectiveAnswers,
  isNodeVisible,
  isPlanningAnswered,
  parseStoredAnswers,
  resolveBoundWrite,
  resolveQuestionnaireScope,
  validateAnswerValue,
  type PlanningAnswerInput,
  type QuestionnaireContext,
  type QuestionnaireDef,
  type ScopeEntity,
  type StoredAnswers,
} from "@/lib/tax-questionnaire";
import { questionnaireById } from "@/lib/tax-questionnaire-content";

// owner-input questionnaires (Forms page "Needs your input" cards). These actions
// store owner-reported facts for your return. The questionnaire row itself never
// changes a form's applicability or readiness; the only side effect outside it
// is writing/clearing the SAME planning answer for the few "bound" questions (one
// source of truth with the Planning screen), which then moves whatever the
// Planning screen would move, through the existing logic. Tax records are never hard-deleted:
// there is no delete here - "reset" empties the row and the audit row keeps every
// prior answer value. Audit rows hold ids / option ids / numbers only - never the
// note text and never option labels.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

type Result = { ok: true } | { ok: false; error: string; code?: "needs_confirm" };

const NOT_IN_WORKSPACE = "That planning question is not part of this workspace";

const scopeFields = {
  taxYear: z.number().int().min(2000).max(2100),
  questionnaireId: z.string().min(1).max(60),
  entityId: z.string().uuid("Invalid entity"),
};

const answerSchema = z.object({
  ...scopeFields,
  nodeId: z.string().min(1).max(60),
  value: z.union([z.string().max(80), z.array(z.string().max(80)).max(12), z.number().int()]),
  /** The owner confirmed the inline "this replaces / clears your Planning answer" step. */
  confirmed: z.boolean().optional(),
});

const noteSchema = z.object({
  ...scopeFields,
  note: z.string().trim().max(2000, "A note can be at most 2000 characters"),
});

const resetSchema = z.object(scopeFields);

const SCOPE_ENTITY_SELECT = { id: true, name: true, slug: true, type: true, foundedDate: true, taxStatusNotes: true } as const;

async function loadScope(
  def: QuestionnaireDef,
  year: number,
  entityId: string
): Promise<{ ok: true; ctx: QuestionnaireContext; entities: ScopeEntity[] } | { ok: false; error: string }> {
  const entities = await db.entity.findMany({
    where: { archivedAt: null, type: { in: ["personal", "business"] } },
    select: SCOPE_ENTITY_SELECT,
  });
  const scope = resolveQuestionnaireScope(def, entities, year, entityId);
  if (!scope.ok) return scope;
  return { ok: true, ctx: scope.ctx, entities };
}

function revalidateAll(year: number, questionnaireId: string, planningTouched: boolean) {
  revalidatePath(`/tax/forms/${year}`);
  revalidatePath(`/tax/forms/${year}/questionnaire/${questionnaireId}`);
  revalidatePath(`/tax/forms/${year}/cpa-summary`);
  if (planningTouched) {
    revalidatePath("/tax");
    revalidatePath(`/tax/personal/${year}`);
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

export async function saveQuestionnaireAnswer(input: z.input<typeof answerSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const { taxYear, questionnaireId, entityId, nodeId, value, confirmed } = parsed.data;

  const def = questionnaireById(questionnaireId);
  if (!def) return { ok: false, error: "Unknown questionnaire" };
  const scope = await loadScope(def, taxYear, entityId);
  if (!scope.ok) return { ok: false, error: scope.error };
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, error: "Unknown question" };

  const row = await db.taxQuestionnaire.findUnique({
    where: { taxYear_entityId_questionnaireId: { taxYear, entityId, questionnaireId } },
  });
  const stored: StoredAnswers = row ? parseStoredAnswers(row.answers) : {};

  // Planning answers are read, never created, here (a workspace is only opened
  // below when a bound answer actually has to be written).
  const personal = scope.entities.find((e) => e.type === "personal") ?? null;
  const workspace = personal
    ? await db.taxWorkspace.findUnique({
        where: { entityId_taxYear: { entityId: personal.id, taxYear } },
        select: { id: true, questions: { select: { key: true, answer: true, skippedReason: true, answeredAt: true } } },
      })
    : null;
  const planning: PlanningAnswerInput[] = (workspace?.questions ?? []).map((q) => ({
    key: q.key,
    answer: q.answer,
    skippedReason: q.skippedReason,
    answeredAt: q.answeredAt,
  }));

  const before = effectiveAnswers(def, stored, planning, scope.ctx);
  if (!isNodeVisible(def, scope.ctx, before, nodeId)) return { ok: false, error: "That question is not shown right now" };

  const checked = validateAnswerValue(node, value, scope.ctx);
  if (!checked.ok) return { ok: false, error: checked.error };

  const bound = resolveBoundWrite(node, checked.value);
  if (bound) {
    const existing = planning.find((p) => p.key === bound.questionKey);
    const existingAnswered = !!existing && isPlanningAnswered(existing);
    // Warn-and-confirm (enforced here so no client can skip it): a local-only
    // choice clears an existing Planning answer; a typed number replaces free text.
    const clobbers = bound.planningValue === null ? existingAnswered : boundPlanningConflict(node, planning) !== null;
    if (clobbers && !confirmed) {
      return {
        ok: false,
        code: "needs_confirm",
        error:
          bound.planningValue === null
            ? "This also clears the answer saved on the Planning screen."
            : "This replaces the written answer saved on the Planning screen.",
      };
    }
  }

  // Opening the Personal workspace on write is the established precedent
  // (answerTaxQuestionByKey); only done when a planning VALUE has to be stored.
  let workspaceId: string | null = workspace?.id ?? null;
  try {
    if (bound && bound.planningValue !== null) workspaceId = await ensurePersonalWorkspace(taxYear);
  } catch {
    return { ok: false, error: "Could not open the Personal tax workspace" };
  }

  const now = new Date();
  const planningKey = bound?.questionKey;
  const previous = before[nodeId]?.value ?? null;
  const auditBase = { taxYear, questionnaireId, entityId, nodeId, ...(planningKey ? { planningKey } : {}) };

  try {
    await db.$transaction(async (tx) => {
      if (bound) {
        if (bound.planningValue !== null) {
          const res = await tx.taxQuestion.updateMany({
            where: { workspaceId: workspaceId ?? "", key: bound.questionKey },
            data: { answer: bound.planningValue as unknown as never, answeredAt: now, skippedReason: null },
          });
          if (res.count === 0) throw new Error(NOT_IN_WORKSPACE);
        } else if (workspaceId) {
          await tx.taxQuestion.updateMany({
            where: { workspaceId, key: bound.questionKey },
            data: { answer: Prisma.DbNull, answeredAt: null, skippedReason: null },
          });
        }
      }

      // A bound node that wrote a planning value keeps only who/when here (the value
      // lives in the planning answer); a local-only value is kept on the row.
      const entry = {
        v: bound && bound.planningValue !== null ? null : checked.value,
        at: now.toISOString(),
        by: user.id,
      };
      const answers = { ...stored, [nodeId]: entry };
      await tx.taxQuestionnaire.upsert({
        where: { taxYear_entityId_questionnaireId: { taxYear, entityId, questionnaireId } },
        create: { taxYear, entityId, questionnaireId, definitionVersion: def.version, answers: json(answers) },
        update: { definitionVersion: def.version, answers: json(answers) },
      });

      await tx.auditLog.create({
        data: {
          changedBy: user.id,
          changeType: "tax_questionnaire_answer",
          before: json({ ...auditBase, value: previous }),
          after: json({ ...auditBase, value: checked.value }),
        },
      });
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message === NOT_IN_WORKSPACE ? NOT_IN_WORKSPACE : "Could not save the answer" };
  }

  revalidateAll(taxYear, questionnaireId, bound !== null);
  return { ok: true };
}

export async function saveQuestionnaireNote(input: z.input<typeof noteSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = noteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const { taxYear, questionnaireId, entityId } = parsed.data;
  const note = parsed.data.note === "" ? null : parsed.data.note;

  const def = questionnaireById(questionnaireId);
  if (!def) return { ok: false, error: "Unknown questionnaire" };
  const scope = await loadScope(def, taxYear, entityId);
  if (!scope.ok) return { ok: false, error: scope.error };

  const row = await db.taxQuestionnaire.findUnique({
    where: { taxYear_entityId_questionnaireId: { taxYear, entityId, questionnaireId } },
    select: { note: true },
  });
  const now = new Date();
  // Only lengths go to the audit trail - never the note text.
  const auditBase = { taxYear, questionnaireId, entityId };

  try {
    await db.$transaction(async (tx) => {
      await tx.taxQuestionnaire.upsert({
        where: { taxYear_entityId_questionnaireId: { taxYear, entityId, questionnaireId } },
        create: {
          taxYear,
          entityId,
          questionnaireId,
          definitionVersion: def.version,
          note,
          noteUpdatedAt: now,
          noteUpdatedById: user.id,
        },
        update: { note, noteUpdatedAt: now, noteUpdatedById: user.id },
      });
      await tx.auditLog.create({
        data: {
          changedBy: user.id,
          changeType: "tax_questionnaire_note",
          before: json({ ...auditBase, noteLength: row?.note?.length ?? 0 }),
          after: json({ ...auditBase, noteLength: note?.length ?? 0 }),
        },
      });
    });
  } catch {
    return { ok: false, error: "Could not save the note" };
  }

  revalidateAll(taxYear, questionnaireId, false);
  return { ok: true };
}

/**
 * Empties this questionnaire's saved answers and note. Not a delete: the row stays
 * and the audit row's `before` keeps every prior answer value. Shared Planning
 * answers are never touched.
 */
export async function resetQuestionnaire(input: z.input<typeof resetSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = resetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const { taxYear, questionnaireId, entityId } = parsed.data;

  const def = questionnaireById(questionnaireId);
  if (!def) return { ok: false, error: "Unknown questionnaire" };
  const scope = await loadScope(def, taxYear, entityId);
  if (!scope.ok) return { ok: false, error: scope.error };

  const row = await db.taxQuestionnaire.findUnique({
    where: { taxYear_entityId_questionnaireId: { taxYear, entityId, questionnaireId } },
  });
  if (!row) return { ok: true };

  const values: Record<string, unknown> = {};
  for (const [nodeId, entry] of Object.entries(parseStoredAnswers(row.answers))) values[nodeId] = entry.v;

  try {
    await db.$transaction(async (tx) => {
      await tx.taxQuestionnaire.update({
        where: { taxYear_entityId_questionnaireId: { taxYear, entityId, questionnaireId } },
        data: { answers: json({}), note: null, noteUpdatedAt: null, noteUpdatedById: null },
      });
      await tx.auditLog.create({
        data: {
          changedBy: user.id,
          changeType: "tax_questionnaire_reset",
          before: json({ taxYear, questionnaireId, entityId, answers: values }),
          after: Prisma.JsonNull,
        },
      });
    });
  } catch {
    return { ok: false, error: "Could not reset the questionnaire" };
  }

  revalidateAll(taxYear, questionnaireId, false);
  return { ok: true };
}
