"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  effectiveAnswers,
  isNodeVisible,
  parseStoredAnswers,
  resolveQuestionnaireScope,
  type EffectiveAnswers,
  type PlanningAnswerInput,
  type QuestionnaireDef,
  type ScopeEntity,
  type StoredAnswers,
} from "@/lib/tax-questionnaire";
import { questionnaireById } from "@/lib/tax-questionnaire-content";
import { buildAnswerSource, combineContributions, computePrefillStates, type PrefillEvaluation, type PrefillSuggestion } from "@/lib/tax-prefill";
import { loadPrefillSuggestions } from "@/lib/tax-prefill-build";

// "Answer from your documents": accepting a suggestion. The suggestion is NEVER trusted from
// the client: the server recomputes the value from the document ids the owner chose (the
// input has no value field at all), rejects ids that are not candidates for that answer,
// validates with the same validator and visibility rules as saveQuestionnaireAnswer, and writes
// the answer WITH a provenance record `src` (kind, stable field code, document ids, basis, the
// document's value at accept time) inside the existing answers JSON. One transaction, one
// audit row holding ids / option ids / cents / field codes only - never an employer name, a
// label or free text. Nothing is deleted. Reading the suggestions never writes (see
// lib/tax-prefill-build.ts); a bound (Planning-shared) node is never prefilled in this version.
//
// "Keep my answer" / "Answer myself" is the existing saveQuestionnaireAnswer (a fresh entry with no `src`).

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

type Result = { ok: true; accepted: string[] } | { ok: false; error: string };

const acceptSchema = z.object({
  taxYear: z.literal(2025),
  questionnaireId: z.string().min(1).max(60),
  entityId: z.string().uuid("Invalid entity"),
  /** "items": the listed nodes. "bulk": every STRONG suggestion that is still waiting (the server decides which). */
  mode: z.enum(["items", "bulk"]),
  items: z
    .array(
      z.object({
        nodeId: z.string().min(1).max(60),
        /** The documents to take the answer from; omitted = the suggestion's default documents. */
        documentIds: z.array(z.string().uuid()).max(12).optional(),
      })
    )
    .max(40),
});

const SCOPE_ENTITY_SELECT = { id: true, name: true, slug: true, type: true, foundedDate: true, taxStatusNotes: true } as const;

function json(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

interface Chosen {
  suggestion: PrefillSuggestion;
  evaluation: PrefillEvaluation;
  docIds: string[];
}

export async function acceptPrefillSuggestions(input: z.input<typeof acceptSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = acceptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const { taxYear, questionnaireId, entityId, mode, items } = parsed.data;
  if (mode === "items" && items.length === 0) return { ok: false, error: "Nothing to accept" };

  const def: QuestionnaireDef | null = questionnaireById(questionnaireId);
  if (!def) return { ok: false, error: "Unknown questionnaire" };

  const entities: ScopeEntity[] = await db.entity.findMany({
    where: { archivedAt: null, type: { in: ["personal", "business"] } },
    select: SCOPE_ENTITY_SELECT,
  });
  const scope = resolveQuestionnaireScope(def, entities, taxYear, entityId);
  if (!scope.ok) return { ok: false, error: scope.error };

  const row = await db.taxQuestionnaire.findUnique({
    where: { taxYear_entityId_questionnaireId: { taxYear, entityId, questionnaireId } },
  });
  const stored: StoredAnswers = row ? parseStoredAnswers(row.answers) : {};

  // Planning answers are only READ (a workspace is never opened here).
  const personal = entities.find((e) => e.type === "personal") ?? null;
  const workspace = personal
    ? await db.taxWorkspace.findUnique({
        where: { entityId_taxYear: { entityId: personal.id, taxYear } },
        select: { questions: { select: { key: true, answer: true, skippedReason: true, answeredAt: true } } },
      })
    : null;
  const planning: PlanningAnswerInput[] = (workspace?.questions ?? []).map((q) => ({
    key: q.key,
    answer: q.answer,
    skippedReason: q.skippedReason,
    answeredAt: q.answeredAt,
  }));
  const before: EffectiveAnswers = effectiveAnswers(def, stored, planning, scope.ctx);

  // The suggestions are recomputed on the server from the documents as they are right now.
  const all = (await loadPrefillSuggestions(taxYear)).filter((s) => s.questionnaireId === questionnaireId);

  const chosen: Chosen[] = [];
  if (mode === "bulk") {
    const states = computePrefillStates(questionnaireId, all, before);
    for (const s of all) {
      const primary = s.nodeIds[0];
      const st = primary ? states[primary] : undefined;
      if (!st || !st.bulk || st.suggestionKey !== s.key) continue;
      const ev = combineContributions(s, s.docIds);
      if (!ev || ev.strength !== "strong") continue;
      chosen.push({ suggestion: s, evaluation: ev, docIds: s.docIds });
    }
    if (chosen.length === 0) return { ok: false, error: "There is nothing to accept right now" };
  } else {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.nodeId)) return { ok: false, error: "The same question was listed twice" };
      seen.add(item.nodeId);
      const s = all.find((x) => x.nodeIds[0] === item.nodeId);
      if (!s) return { ok: false, error: "There is no suggestion for that question right now" };
      const docIds = item.documentIds ?? s.docIds;
      const ev = combineContributions(s, docIds);
      if (!ev) {
        return {
          ok: false,
          error: s.needsPick && (item.documentIds ?? []).length === 0 ? "Pick the document to use first" : "Those documents cannot be used for this answer",
        };
      }
      chosen.push({ suggestion: s, evaluation: ev, docIds: s.kind === "planning" ? [] : docIds });
    }
  }

  // Validate on the AFTER state (a dependent amount is only shown after its gate answer), exactly like a normal save.
  const now = new Date();
  const after: EffectiveAnswers = { ...before };
  for (const c of chosen) {
    for (const a of c.evaluation.answers) {
      const node = def.nodes.find((n) => n.id === a.nodeId);
      if (!node) return { ok: false, error: "Unknown question" };
      if (node.binding) return { ok: false, error: "That question is shared with the Planning screen and cannot be filled this way" };
      after[a.nodeId] = { value: a.value, source: "questionnaire", at: now.toISOString(), by: user.id };
    }
  }
  for (const c of chosen) {
    for (const a of c.evaluation.answers) {
      if (!isNodeVisible(def, scope.ctx, after, a.nodeId)) return { ok: false, error: "That question is not shown right now" };
    }
  }

  const entries: StoredAnswers = {};
  const auditNodes: { nodeId: string; previous: unknown; value: unknown; field: string; docIds: string[]; basis: string }[] = [];
  for (const c of chosen) {
    const src = buildAnswerSource(c.suggestion, c.evaluation, c.docIds);
    for (const a of c.evaluation.answers) {
      entries[a.nodeId] = { v: a.value, at: now.toISOString(), by: user.id, src };
      auditNodes.push({
        nodeId: a.nodeId,
        previous: before[a.nodeId]?.value ?? null,
        value: a.value,
        field: src.field,
        docIds: src.docIds,
        basis: src.basis,
      });
    }
  }
  const answers: StoredAnswers = { ...stored, ...entries };
  const auditBase = { taxYear, questionnaireId, entityId };

  try {
    await db.$transaction(async (tx) => {
      await tx.taxQuestionnaire.upsert({
        where: { taxYear_entityId_questionnaireId: { taxYear, entityId, questionnaireId } },
        create: { taxYear, entityId, questionnaireId, definitionVersion: def.version, answers: json(answers) },
        update: { definitionVersion: def.version, answers: json(answers) },
      });
      await tx.auditLog.create({
        data: {
          changedBy: user.id,
          changeType: "tax_questionnaire_prefill_accept",
          before: json({ ...auditBase, nodes: auditNodes.map((n) => ({ nodeId: n.nodeId, value: n.previous })) }),
          after: json({
            ...auditBase,
            mode,
            nodes: auditNodes.map((n) => ({ nodeId: n.nodeId, value: n.value, field: n.field, docIds: n.docIds, basis: n.basis })),
          }),
        },
      });
    });
  } catch {
    return { ok: false, error: "Could not save the answers" };
  }

  revalidatePath(`/tax/forms/${taxYear}`);
  revalidatePath(`/tax/forms/${taxYear}/questionnaire/${questionnaireId}`);
  revalidatePath(`/tax/forms/${taxYear}/cpa-summary`);
  return { ok: true, accepted: Object.keys(entries) };
}
