import { db } from "@/lib/db";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { assembleL1Context } from "@/lib/tax-review/l1/assemble";
import { bindFiles, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { estimateAiRun } from "@/lib/tax-review/llm/run";
import { reviewModelId, priceFromEnv, type EnvLike, type RunEstimate } from "@/lib/tax-review/llm/model";
import { buildReviewPayload, serializePayload, type SerializedPayload } from "@/lib/tax-review/llm/payload";
import { buildRegister, type RegisterEntry } from "@/lib/tax-review/llm/register";
import type { ScrubConfig } from "@/lib/tax-review/llm/scrub";
import { sameProperty } from "@/lib/tax-review/llm/address";
import type { AcceptedFinding, RecordedDecision } from "@/lib/tax-review/llm/owner-statements";
import type { DispositionRow } from "@/lib/tax-review/gate";
import { businessUseKeyOf } from "@/lib/tax2025/business-use";
import type { OverrideRow } from "@/lib/tax2025/overrides";
import { isEntityActiveForYear, isEntityUnformed } from "@/lib/tax-entities";
import { getRunWithFindings, listDispositions, listRuns } from "@/lib/tax-review-store";
import type { SourcePack } from "@/lib/tax-review/llm/sources";
import type { Finding } from "@/lib/tax-review/types";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { Ty2025Return } from "@/lib/tax2025/types";
import { loadFormData, loadReviewInputs, type ReviewBuildDeps } from "@/lib/tax-review-build";
import { loadSourcePack } from "@/lib/tax-review-sources";
import { RedactionError } from "@/lib/tax-review/redact";

// ── DB-aware preparation of an AI review (ai-return-reviewer, Phase B) ──────────────────────────────────────
// READ-ONLY: it reads the return inputs (the same single read the checks use), the entity names and the committed source pack, and builds
// the redacted payload and the cost estimate. It writes nothing and calls no model. No auth here and no "use server": callers
// (actions/tax-review.ts) call requireAuth() first. Only the redacted payload, the estimate and counts leave this module, never `raw` or
// `facts`.

// Only the entity that is ACTIVE in the tax year keeps a name-like label; every other business (not yet formed, formed after the tax
// year, archived) is scrubbed to a neutral placeholder if its name appears in a document, so the model never learns of it.
const ENTITY_LABELS: Record<string, { label: string; aliases: string[] }> = {
  "ek-consulting": { label: "the Consulting LLC", aliases: ["EK Consulting", "EKC"] },
  "sudden-valley": { label: "the Property Management LLC", aliases: ["Sudden Valley"] },
};
const PRIMARY_LABEL = "the primary residence";
const INACTIVE_ENTITY_LABEL = "[business name removed]";
const INACTIVE_ENTITY_ALIASES: Record<string, string[]> = { "sudden-valley": ["Sudden Valley"] };

export interface EntityNameRow {
  name: string;
  slug: string | null;
  /** The facts that say whether the entity existed in the tax year (lib/tax-entities.ts); absent = taken as active. */
  type?: string;
  foundedDate?: Date | null;
  taxStatusNotes?: string | null;
  archivedAt?: Date | null;
}

/** True when the business could have had activity in the tax year: not archived, not unformed, not formed after the year (lib/tax-entities.ts). */
export function entityActiveInYear(row: EntityNameRow, year: number): boolean {
  if (row.archivedAt !== undefined && row.archivedAt !== null) return false;
  const facts = { type: row.type ?? "business", foundedDate: row.foundedDate ?? null, taxStatusNotes: row.taxStatusNotes ?? null };
  return !isEntityUnformed(facts) && isEntityActiveForYear(facts, year);
}

/**
 * Generic labels for the business entities (the personal entity's name is a generic word and is left alone). `labels` (what the payload
 * lists as the entities of the year) holds ONLY the entities active in `year`: an unformed, archived or not-yet-existing entity is scrubbed
 * to a neutral placeholder and never listed.
 */
export function scrubEntitiesFor(rows: readonly EntityNameRow[], year: number = 2025): { entities: NonNullable<ScrubConfig["entities"]>; labels: string[] } {
  const entities: { name: string; label: string; aliases?: string[] }[] = [];
  const labels: string[] = [];
  let other = 0;
  for (const r of rows) {
    if (r.slug === "personal" || r.name.trim().toLowerCase() === "personal" || r.type === "personal") continue;
    if (!entityActiveInYear(r, year)) {
      entities.push({ name: r.name, label: INACTIVE_ENTITY_LABEL, aliases: r.slug === null ? [] : (INACTIVE_ENTITY_ALIASES[r.slug] ?? []) });
      continue;
    }
    const known = r.slug === null ? undefined : ENTITY_LABELS[r.slug];
    if (known !== undefined) {
      entities.push({ name: r.name, label: known.label, aliases: known.aliases });
      labels.push(known.label);
    } else {
      other += 1;
      const label = `business entity ${other}`;
      entities.push({ name: r.name, label });
      labels.push(label);
    }
  }
  return { entities, labels: [...new Set(labels)] };
}

/**
 * Known street addresses (primary residence, mortgaged and taxed properties) mapped to generic property labels. The SAME property gets the
 * SAME label however it is written (Rd / Road, case, punctuation, a different town or zip: lib/tax-review/llm/address.ts), and a property tax
 * bill the engine classified as the primary residence's is labelled "the primary residence" even if its address reads differently.
 */
export function scrubAddressesFor(facts: Ty2025Facts, primaryResidence: string | null): ScrubConfig["addresses"] {
  const out: { address: string; label: string }[] = [];
  const groups: { rep: string; label: string }[] = [];
  let n = 0;
  const record = (a: string, label: string): void => {
    if (!out.some((o) => o.address === a && o.label === label)) out.push({ address: a, label });
  };
  const add = (address: string | null | undefined, primary: boolean): void => {
    const a = (address ?? "").trim();
    if (a === "") return;
    const group = groups.find((g) => sameProperty(g.rep, a));
    if (group !== undefined) {
      record(a, group.label);
      return;
    }
    let label: string;
    if (primary) label = PRIMARY_LABEL;
    else {
      n += 1;
      label = `other property ${String.fromCharCode(64 + n)}`;
    }
    groups.push({ rep: a, label });
    record(a, label);
  };
  // the primary residence first, so that no other property can take its label, whatever order the documents come in
  add(primaryResidence, true);
  add(facts.deductions.primaryResidenceAddress.value, true);
  for (const b of facts.deductions.propertyTaxBills) if (b.kind === "primary_residence") add(b.address, true);
  for (const m of facts.deductions.mortgages) add(m.propertyAddress, false);
  for (const b of facts.deductions.propertyTaxBills) add(b.address, false);
  return out;
}

const dollarText = (cents: number): string => String(Math.round(cents / 100));

/** The value of a recorded row as the payload shows it: whole dollars for a line, "70.5%" for a business-use percentage, else the stored choice. */
function recordedValueOf(r: OverrideRow): string | null {
  if (r.targetKind === "line") return r.valueCents === null ? null : dollarText(r.valueCents);
  if (r.targetKind === "decision" && businessUseKeyOf(r.targetKey) !== null) return r.valueText === null ? null : `${r.valueText}%`;
  return r.valueText;
}

/** The owner's recorded decisions / overrides (active rows only) with the reason given for each, as plain data for the payload. */
export function recordedDecisionsOf(rows: readonly OverrideRow[]): RecordedDecision[] {
  return rows
    .filter((r) => r.archivedAt === null)
    .map((r) => ({ kind: r.targetKind, target: r.targetKey, value: recordedValueOf(r), reason: r.reason }));
}

/**
 * The findings the owner accepted (the latest disposition of the finding key is "accepted") with the reason he gave, and what the finding said
 * when a stored finding of that key is known.
 */
export function acceptedFindingsOf(dispositions: readonly DispositionRow[], messageByKey: ReadonlyMap<string, string>): AcceptedFinding[] {
  const latest = new Map<string, DispositionRow>();
  for (const d of dispositions) {
    const have = latest.get(d.findingKey);
    if (have === undefined || new Date(d.at).getTime() >= new Date(have.at).getTime()) latest.set(d.findingKey, d);
  }
  return [...latest.values()].filter((d) => d.action === "accepted").map((d) => ({ key: d.findingKey, about: messageByKey.get(d.findingKey) ?? null, reason: d.reason }));
}

/**
 * READ-ONLY: the findings the owner accepted, with the reason he gave and what the finding said (from the newest stored runs, or from the
 * deterministic findings of this run). A failure to read them is not an error: the payload simply carries no accepted findings.
 */
async function loadAcceptedFindings(year: 2025, entityId: string, l1Findings: readonly Finding[]): Promise<AcceptedFinding[]> {
  try {
    const dispositions = await listDispositions(year, entityId);
    if (!dispositions.some((d) => d.action === "accepted")) return [];
    const messageByKey = new Map<string, string>();
    for (const f of l1Findings) messageByKey.set(f.key, f.message);
    for (const run of await listRuns(year, entityId, 5)) {
      const stored = await getRunWithFindings(run.id, entityId);
      for (const f of stored?.findings ?? []) if (!messageByKey.has(f.key)) messageByKey.set(f.key, f.message);
    }
    return acceptedFindingsOf(dispositions, messageByKey);
  } catch (err) {
    console.error("tax review: accepted findings could not be read for the AI review:", err instanceof Error ? err.name : "unknown error");
    return [];
  }
}

export interface AiPrep {
  serialized: SerializedPayload;
  estimate: RunEstimate;
  model: string;
  pack: SourcePack;
  ret: Ty2025Return;
  facts: Ty2025Facts;
  register: RegisterEntry[];
  /** Return fingerprint v2 (64 hex) the payload was built for. */
  fingerprint: string;
  entityId: string;
}

/**
 * Builds the redacted payload for the CURRENT return and the cost estimate. `l1Findings` are the stored L1 findings of the run the AI
 * review will attach to. Returns { error } (plain language) when the payload cannot be built or the redaction guard refuses it.
 */
export async function prepareAiReview(
  year: 2025,
  generatedBy: string,
  l1Findings: readonly Finding[],
  env: EnvLike = process.env,
  deps: ReviewBuildDeps = {}
): Promise<AiPrep | { error: string }> {
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
    mode: "draft",
    generatedAt: inputs.generatedAt,
    generatedBy,
    ekcName: inputs.ekcName,
    catalogs,
    lineLabels,
    blankFormIds,
    sheetDocuments: inputs.raw.documents.map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, legacyFormat: d.legacyFormat, subjectType: d.subjectType })),
    includeFinalPackage: false,
  });
  const read = await readPacketFiles(ctx.packet.files);
  const bindings = bindFiles(ctx, read);
  const entityRows = await db.entity.findMany({ select: { name: true, slug: true, type: true, foundedDate: true, taxStatusNotes: true, archivedAt: true } });
  const scrubEntities = scrubEntitiesFor(entityRows, year);
  const ownerRecords = { recordedDecisions: recordedDecisionsOf(inputs.built.overrideRows), acceptedFindings: await loadAcceptedFindings(year, inputs.entityId, l1Findings) };
  const people = inputs.raw.people.map((p) => ({ userId: p.userId, name: p.name }));
  const facts = inputs.built.facts;
  const ret = inputs.built.ret;
  const payload = buildReviewPayload(
    {
      ret,
      view: inputs.view,
      facts,
      documents: inputs.raw.documents.map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, extractionStatus: d.extractionStatus, subjectType: d.subjectType, subjectUserId: d.subjectUserId, ...(d.reextractIncomplete !== undefined ? { reextractIncomplete: d.reextractIncomplete } : {}) })),
      bindings,
      l1Findings,
      entityLabels: scrubEntities.labels,
      ownerRecords,
      // TAX_REVIEW_PAYER_NAMES=generic sends "Employer A" / "Payer B" instead of the names read from the documents
      payerNames: env["TAX_REVIEW_PAYER_NAMES"] === "generic" ? "generic" : "keep",
    },
    people
  );
  let serialized: SerializedPayload;
  try {
    serialized = serializePayload(payload, people, { entities: scrubEntities.entities, addresses: scrubAddressesFor(facts, inputs.raw.primaryResidence?.address ?? null) });
  } catch (err) {
    // the redaction guard refused the whole payload (an identifier-shaped string was left): nothing is sent
    console.error("tax review: payload refused:", err instanceof Error ? err.name : "unknown error", err instanceof RedactionError ? err.issues.join(",") : "");
    return { error: "The review payload was refused because it still contained something that looks like a taxpayer number or an account number. Nothing was sent." };
  }
  let pack: SourcePack;
  try {
    pack = loadSourcePack();
  } catch (err) {
    console.error("tax review: source pack could not be read:", err instanceof Error ? err.name : "unknown error");
    return { error: "The pinned source pack could not be read, so the AI review cannot run." };
  }
  const model = reviewModelId(env);
  const register = buildRegister({ ret, facts });
  const estimate = estimateAiRun(serialized.payload, pack, priceFromEnv(env), model, register);
  return { serialized, estimate, model, pack, ret, facts, register, fingerprint: inputs.fingerprint.fingerprint, entityId: inputs.entityId };
}
