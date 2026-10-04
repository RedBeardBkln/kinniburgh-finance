import { db } from "@/lib/db";
import { loadFormsPageData } from "@/lib/tax-forms-build";
import { listQuestionnaireEntries, type FormsPageData } from "@/lib/tax-forms";
import {
  activeFlags,
  boundPlanningConflict,
  boundPlanningHasValue,
  buildSummary,
  effectiveAnswers,
  parseStoredAnswers,
  questionnaireHref,
  renderCopy,
  resolveQuestionnaireScope,
  type BoundNodeInfo,
  type EffectiveAnswers,
  type PlanningAnswerInput,
  type QuestionnaireContext,
  type QuestionnaireDef,
  type QuestionnaireRowInput,
  type QuestionnaireSummary,
  type ScopeEntity,
  type StoredAnswers,
} from "@/lib/tax-questionnaire";
import { questionnaireById } from "@/lib/tax-questionnaire-content";
import { NO_PREFILL, computePrefillStates, prefillNodeIdsFor, type QuestionnairePrefill } from "@/lib/tax-prefill";
import { loadPrefillSuggestions } from "@/lib/tax-prefill-build";

// ── Read-only DB helpers for the questionnaire pages ─────────────────────────
// STRICTLY READ-ONLY: never calls ensurePersonalWorkspace / ensureTaxWorkspace and
// never writes (the Forms page must not create a workspace while rendering). Every
// read of the new table is wrapped so the pages still render if the migration has
// not been applied yet.

interface QuestionnaireBase {
  entities: ScopeEntity[];
  personalId: string | null;
  ekcActive: boolean;
  svActive: boolean;
  planning: PlanningAnswerInput[];
  rows: QuestionnaireRowInput[];
  userNames: Record<string, string>;
}

async function loadBase(year: number): Promise<QuestionnaireBase> {
  const [entities, users, rows] = await Promise.all([
    db.entity.findMany({
      where: { archivedAt: null, type: { in: ["personal", "business"] } },
      select: { id: true, name: true, slug: true, type: true, foundedDate: true, taxStatusNotes: true },
    }),
    // id + name only - never email / password hash / TOTP secret.
    db.user.findMany({ select: { id: true, name: true } }),
    db.taxQuestionnaire
      .findMany({
        where: { taxYear: year },
        select: {
          taxYear: true,
          entityId: true,
          questionnaireId: true,
          definitionVersion: true,
          answers: true,
          note: true,
          noteUpdatedAt: true,
          noteUpdatedById: true,
        },
      })
      .catch((): QuestionnaireRowInput[] => []),
  ]);

  const personal = entities.find((e) => e.type === "personal") ?? null;
  const workspace = personal
    ? await db.taxWorkspace.findUnique({
        where: { entityId_taxYear: { entityId: personal.id, taxYear: year } },
        select: { questions: { select: { key: true, answer: true, skippedReason: true, answeredAt: true } } },
      })
    : null;

  const userNames: Record<string, string> = {};
  for (const u of users) userNames[u.id] = u.name;

  return {
    entities,
    personalId: personal?.id ?? null,
    ...activeFlags(entities, year),
    planning: (workspace?.questions ?? []).map((q) => ({
      key: q.key,
      answer: q.answer,
      skippedReason: q.skippedReason,
      answeredAt: q.answeredAt,
    })),
    rows,
    userNames,
  };
}

function rowFor(
  rows: readonly QuestionnaireRowInput[],
  year: number,
  entityId: string,
  questionnaireId: string
): QuestionnaireRowInput | null {
  return rows.find((r) => r.taxYear === year && r.entityId === entityId && r.questionnaireId === questionnaireId) ?? null;
}

function userName(names: Record<string, string>, id: string | null | undefined): string | null {
  return id ? (names[id] ?? null) : null;
}

// ── Questionnaire page ───────────────────────────────────────────────────────

export interface QuestionnaireNeighbor {
  label: string;
  href: string;
}

export interface QuestionnairePageData {
  year: number;
  def: QuestionnaireDef;
  entityId: string;
  entityName: string | null;
  formName: string;
  ctx: QuestionnaireContext;
  effective: EffectiveAnswers;
  bound: Record<string, BoundNodeInfo>;
  prefill: QuestionnairePrefill;
  note: string | null;
  noteMeta: { at: string; byName: string | null } | null;
  stale: boolean;
  userNames: Record<string, string>;
  planningLinks: { key: string; label: string; answer: string | null }[];
  prev: QuestionnaireNeighbor | null;
  next: QuestionnaireNeighbor | null;
}

function planningLinkAnswers(
  def: QuestionnaireDef,
  planning: readonly PlanningAnswerInput[]
): { key: string; label: string; answer: string | null }[] {
  return (def.planningLinks ?? []).map((l) => {
    const row = planning.find((p) => p.key === l.key);
    const answer = row && row.answer !== null && row.answer !== undefined && !row.skippedReason ? String(row.answer) : null;
    return { key: l.key, label: l.label, answer };
  });
}

/** Returns null when this questionnaire does not exist for the year/entity (the page then 404s). */
export async function loadQuestionnairePage(
  year: number,
  questionnaireId: string,
  entityParam: string | null
): Promise<QuestionnairePageData | null> {
  const def = questionnaireById(questionnaireId);
  if (!def) return null;

  const [data, base] = await Promise.all([loadFormsPageData(year), loadBase(year)]);
  const list = listQuestionnaireEntries(data);
  const index = list.findIndex(
    (x) =>
      x.questionnaire.questionnaireId === questionnaireId &&
      (def.scope === "household" || x.questionnaire.entityId === entityParam)
  );
  if (index < 0) return null;
  const hit = list[index]!;
  const entityId = hit.questionnaire.entityId;

  const scope = resolveQuestionnaireScope(def, base.entities, year, entityId);
  if (!scope.ok) return null;

  const row = rowFor(base.rows, year, entityId, questionnaireId);
  const stored: StoredAnswers = row ? parseStoredAnswers(row.answers) : {};
  const effective = effectiveAnswers(def, stored, base.planning, scope.ctx);

  const bound: Record<string, BoundNodeInfo> = {};
  for (const node of def.nodes) {
    if (!node.binding) continue;
    bound[node.id] = {
      hasPlanningValue: boundPlanningHasValue(node, base.planning),
      conflict: boundPlanningConflict(node, base.planning),
    };
  }

  // Suggestions from the household's documents (read-only; a failure just means none). Only the
  // questionnaires that have a prefill rule pay for the extra document load.
  let prefill: QuestionnairePrefill = NO_PREFILL;
  if (year === 2025 && prefillNodeIdsFor(def.id).length > 0) {
    const suggestions = (await loadPrefillSuggestions(year)).filter((s) => s.questionnaireId === def.id);
    if (suggestions.length > 0) {
      const states = computePrefillStates(def.id, suggestions, effective);
      const waiting = Object.values(states).filter((st) => st.state === "suggested" && st.suggestionKey !== null);
      prefill = {
        suggestions,
        states,
        bulkCount: waiting.filter((st) => st.bulk).length,
        weakCount: waiting.filter((st) => !st.bulk).length,
      };
    }
  }

  const neighbor = (i: number): QuestionnaireNeighbor | null => {
    const x = list[i];
    if (!x) return null;
    const d = questionnaireById(x.questionnaire.questionnaireId);
    if (!d) return null;
    const label = d.scope === "entity" ? `${x.entry.formName} - ${x.entry.filer}` : x.entry.formName;
    return { label, href: questionnaireHref(year, d, x.questionnaire.entityId) };
  };

  return {
    year,
    def,
    entityId,
    entityName: def.scope === "entity" ? scope.entityName : null,
    formName: hit.entry.formName,
    ctx: scope.ctx,
    effective,
    bound,
    prefill,
    note: row?.note ?? null,
    noteMeta: row?.noteUpdatedAt
      ? { at: row.noteUpdatedAt.toISOString(), byName: userName(base.userNames, row.noteUpdatedById) }
      : null,
    stale: row !== null && row.definitionVersion !== def.version,
    userNames: base.userNames,
    planningLinks: planningLinkAnswers(def, base.planning),
    prev: neighbor(index - 1),
    next: neighbor(index + 1),
  };
}

// ── CPA summary page ─────────────────────────────────────────────────────────

export interface CpaSummaryBlock {
  key: string;
  title: string;
  formName: string;
  entityId: string;
  entityName: string | null;
  href: string;
  stale: boolean;
  summary: QuestionnaireSummary;
  noteMeta: { at: string; byName: string | null } | null;
  planningLinks: { key: string; label: string; answer: string | null }[];
}

export interface CpaSummaryData {
  year: number;
  householdLabel: string;
  counts: FormsPageData["questionnaireSummary"];
  household: CpaSummaryBlock[];
  entities: { entityId: string; entityName: string; blocks: CpaSummaryBlock[] }[];
  userNames: Record<string, string>;
}

export async function loadCpaSummary(year: number): Promise<CpaSummaryData> {
  const [data, base] = await Promise.all([loadFormsPageData(year), loadBase(year)]);
  const blocks: CpaSummaryBlock[] = [];
  for (const { entry, questionnaire } of listQuestionnaireEntries(data)) {
    const def = questionnaireById(questionnaire.questionnaireId);
    if (!def) continue;
    const scope = resolveQuestionnaireScope(def, base.entities, year, questionnaire.entityId);
    if (!scope.ok) continue;
    const row = rowFor(base.rows, year, questionnaire.entityId, def.id);
    const effective = effectiveAnswers(def, row ? parseStoredAnswers(row.answers) : {}, base.planning, scope.ctx);
    blocks.push({
      key: `${def.id}:${questionnaire.entityId}`,
      title: renderCopy(def.title, scope.ctx),
      formName: entry.formName,
      entityId: questionnaire.entityId,
      entityName: def.scope === "entity" ? scope.entityName : null,
      href: questionnaireHref(year, def, questionnaire.entityId),
      stale: row !== null && row.definitionVersion !== def.version,
      summary: buildSummary(def, scope.ctx, effective, row?.note ?? null),
      noteMeta: row?.noteUpdatedAt
        ? { at: row.noteUpdatedAt.toISOString(), byName: userName(base.userNames, row.noteUpdatedById) }
        : null,
      planningLinks: planningLinkAnswers(def, base.planning),
    });
  }

  const entityGroups = new Map<string, { entityId: string; entityName: string; blocks: CpaSummaryBlock[] }>();
  for (const b of blocks) {
    if (b.entityName === null) continue;
    const g = entityGroups.get(b.entityId) ?? { entityId: b.entityId, entityName: b.entityName, blocks: [] };
    g.blocks.push(b);
    entityGroups.set(b.entityId, g);
  }

  return {
    year,
    householdLabel: data.householdLabel,
    counts: data.questionnaireSummary,
    household: blocks.filter((b) => b.entityName === null),
    entities: Array.from(entityGroups.values()),
    userNames: base.userNames,
  };
}
