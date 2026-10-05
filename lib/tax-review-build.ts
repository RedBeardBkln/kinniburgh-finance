import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { getEntityBySlug } from "@/lib/entity";
import { buildTy2025FromRaw, loadTy2025RawInputs } from "@/lib/tax2025-build";
import { buildTy2025ReturnWithOverrides, resolvePersonalEntityId, type OverridesBuildDeps, type Ty2025OverriddenBuild } from "@/lib/tax2025-overrides-build";
import { formatOverrideNote } from "@/lib/tax2025/overrides";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import type { FormCatalog } from "@/lib/tax2025/pdf/catalog";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { catalogPath, formsRoot, listFormIds, SUPPORTED_YEAR } from "@/lib/tax2025/pdf/registry";
import type { PdfReturnView } from "@/lib/tax2025/pdf/types";
import type { RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { computeReturnFingerprint, FINGERPRINT_VERSION, type FingerprintQuestionnaireInput, type ReturnFingerprint } from "@/lib/tax-review/fingerprint";
import { assembleL1Context } from "@/lib/tax-review/l1/assemble";
import type { LineLabelTable } from "@/lib/tax-review/l1/context";
import { engineGateState } from "@/lib/tax-review/l1/engine-state";
import { L1_VERSION, runL1, type L1Result } from "@/lib/tax-review/l1/run-l1";
import { runL2, type L2Result } from "@/lib/tax-review/l2";
import type { GateEngineState } from "@/lib/tax-review/gate";

// ── DB-aware loader and runner of the AI Return Reviewer's deterministic layers ──────────────────────────────
// STRICTLY READ-ONLY: it only reads (the engine loaders, the override rows, the questionnaire answers, files under
// data/forms). It writes nothing: the actions persist a run through lib/tax-review-store.ts after calling this.
// No auth here and no "use server": callers authenticate first (requireAuth()) and pass only what a client may see
// (findings and counts), never `raw`, `facts` or the view.
//
// ONE read of the raw inputs: the return is computed from the SAME raw inputs the source-document checks compare against
// (buildTy2025FromRaw), so a document edited between two loads can never make the review disagree with itself. The
// fingerprint is computed from exactly those inputs.

export interface ReviewBuildDeps {
  loadRaw?: (taxYear: 2025) => Promise<RawTy2025Inputs | { error: string }>;
  overrides?: Omit<OverridesBuildDeps, "build">;
  loadQuestionnaires?: (taxYear: number, entityId: string) => Promise<FingerprintQuestionnaireInput[]>;
  ekcName?: () => Promise<string | null>;
  now?: () => Date;
  formData?: () => FormData;
}

export interface FormData {
  catalogs: Record<string, FormCatalog>;
  lineLabels: LineLabelTable;
  blankFormIds: ReadonlySet<string>;
}

let formDataCache: FormData | null = null;

/** Field catalogs of the blank forms, the independent printed-line label table and the pinned blank ids (read once per process). */
export function loadFormData(): FormData {
  if (formDataCache !== null) return formDataCache;
  const catalogs: Record<string, FormCatalog> = {};
  for (const m of FORM_MAPS) catalogs[m.formId] = JSON.parse(readFileSync(catalogPath(m.formId), "utf8")) as FormCatalog;
  const rawLabels = JSON.parse(readFileSync(path.join(formsRoot(), String(SUPPORTED_YEAR), "line-labels.json"), "utf8")) as Record<string, Record<string, string>>;
  const lineLabels: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(rawLabels)) if (!k.startsWith("_")) lineLabels[k] = v;
  formDataCache = { catalogs, lineLabels, blankFormIds: new Set(listFormIds()) };
  return formDataCache;
}

async function defaultQuestionnaires(taxYear: number, entityId: string): Promise<FingerprintQuestionnaireInput[]> {
  const rows = await db.taxQuestionnaire.findMany({ where: { taxYear, entityId }, select: { questionnaireId: true, definitionVersion: true, answers: true }, orderBy: { questionnaireId: "asc" } });
  return rows.map((r) => ({ questionnaireId: r.questionnaireId, definitionVersion: r.definitionVersion, answers: r.answers }));
}

async function defaultEkcName(): Promise<string | null> {
  return (await getEntityBySlug("ek-consulting"))?.name ?? null;
}

export interface ReviewInputs {
  entityId: string;
  built: Ty2025OverriddenBuild;
  raw: RawTy2025Inputs;
  view: PdfReturnView;
  ekcName: string | null;
  questionnaires: FingerprintQuestionnaireInput[];
  fingerprint: ReturnFingerprint;
  engineVersion: string;
  generatedAt: string;
}

/** Loads everything the review (and the approval / clean-copy fingerprint) needs, from ONE read of the raw inputs. */
export async function loadReviewInputs(year: 2025, generatedBy: string, deps: ReviewBuildDeps = {}): Promise<ReviewInputs | { error: string }> {
  let captured: RawTy2025Inputs | null = null;
  const built = await buildTy2025ReturnWithOverrides(year, {
    ...(deps.overrides ?? {}),
    build: async (y, decisions) => {
      const raw = await (deps.loadRaw ?? loadTy2025RawInputs)(y);
      if ("error" in raw) return raw;
      captured = raw;
      return buildTy2025FromRaw(raw, decisions);
    },
  });
  if ("error" in built) return built;
  const raw = captured as RawTy2025Inputs | null;
  if (raw === null) return { error: "The review could not read the return inputs." };
  const entityId = await (deps.overrides?.resolveEntityId ?? resolvePersonalEntityId)();
  if (!entityId) return { error: "The Personal entity was not found." };
  let questionnaires: FingerprintQuestionnaireInput[];
  try {
    questionnaires = await (deps.loadQuestionnaires ?? defaultQuestionnaires)(year, entityId);
  } catch (err) {
    // fail closed: a fingerprint without the questionnaire answers would not notice a changed answer
    console.error("tax review: questionnaire answers could not be read:", err instanceof Error ? err.name : "unknown error");
    return { error: "The questionnaire answers could not be read, so the review cannot bind to the return. Try again; nothing was changed." };
  }
  const ekcName = await (deps.ekcName ?? defaultEkcName)();
  const generatedAt = (deps.now ?? (() => new Date()))().toISOString();
  const view = toPdfReturnView(built.ret, built.facts, {
    generatedAt,
    generatedBy,
    ekcName,
    overrides: { effective: built.effective, formatNote: formatOverrideNote },
  });
  const fingerprint = computeReturnFingerprint({
    engineVersion: built.ret.engineVersion,
    viewFingerprint: view.fingerprint,
    answers: view.answers,
    header: view.header,
    facts: built.facts,
    documents: raw.documents,
    questionnaires,
    overrides: built.overrideRows,
    decisions: view.decisions,
  });
  return { entityId, built, raw, view, ekcName, questionnaires, fingerprint, engineVersion: built.ret.engineVersion, generatedAt };
}

/** The current return fingerprint v2 (what a run, an approval and a clean-copy download are bound to). Cheap: no packet is built. */
export async function currentReturnFingerprint(year: 2025, generatedBy: string, deps: ReviewBuildDeps = {}): Promise<{ entityId: string; fingerprint: ReturnFingerprint; engineVersion: string } | { error: string }> {
  const inputs = await loadReviewInputs(year, generatedBy, deps);
  if ("error" in inputs) return inputs;
  return { entityId: inputs.entityId, fingerprint: inputs.fingerprint, engineVersion: inputs.engineVersion };
}

export interface ReviewRunResult {
  entityId: string;
  fingerprint: ReturnFingerprint;
  engineVersion: string;
  l1: L1Result;
  l2: L2Result;
  /** For the gate (counts only). */
  engine: GateEngineState;
  /** Stored on the run row: versions and digests only (no value). */
  config: { fingerprintVersion: number; fingerprintParts: ReturnFingerprint["parts"]; l1Version: number; l2Version: number; mode: "draft" | "final" };
  l1Summary: unknown;
  l2Summary: unknown;
}

/** Builds the packet in-process (as the download does) and runs L1; L2 is the not-run stub until the oracle exists. Read-only. */
export async function runReviewForYear(year: 2025, generatedBy: string, mode: "draft" | "final" = "draft", deps: ReviewBuildDeps = {}): Promise<ReviewRunResult | { error: string }> {
  const inputs = await loadReviewInputs(year, generatedBy, deps);
  if ("error" in inputs) return inputs;
  const { catalogs, lineLabels, blankFormIds } = (deps.formData ?? loadFormData)();
  const ctx = await assembleL1Context({
    ret: inputs.built.ret,
    effective: inputs.built.effective,
    facts: inputs.built.facts,
    raw: inputs.raw,
    overrideRows: inputs.built.overrideRows,
    maps: FORM_MAPS,
    mode,
    generatedAt: inputs.generatedAt,
    generatedBy,
    ekcName: inputs.ekcName,
    catalogs,
    lineLabels,
    blankFormIds,
    sheetDocuments: inputs.raw.documents.map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, legacyFormat: d.legacyFormat, subjectType: d.subjectType })),
    // the final package is built the way the ?final=1 route builds it, so "the package can be released" is part of the review
    includeFinalPackage: mode === "draft",
  });
  const l1 = await runL1(ctx);
  const l2 = runL2();
  return {
    entityId: inputs.entityId,
    fingerprint: inputs.fingerprint,
    engineVersion: inputs.engineVersion,
    l1,
    l2,
    engine: engineGateState(ctx),
    config: { fingerprintVersion: FINGERPRINT_VERSION, fingerprintParts: inputs.fingerprint.parts, l1Version: L1_VERSION, l2Version: 0, mode },
    l1Summary: { ...l1.summary, status: l1.status },
    l2Summary: { status: l2.status, coverage: l2.coverage },
  };
}
