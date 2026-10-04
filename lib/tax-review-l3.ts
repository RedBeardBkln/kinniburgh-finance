import { db } from "@/lib/db";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { assembleL1Context } from "@/lib/tax-review/l1/assemble";
import { bindFiles, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { estimateAiRun } from "@/lib/tax-review/llm/run";
import { reviewModelId, priceFromEnv, type EnvLike, type RunEstimate } from "@/lib/tax-review/llm/model";
import { buildReviewPayload, serializePayload, type SerializedPayload } from "@/lib/tax-review/llm/payload";
import { buildRegister, type RegisterEntry } from "@/lib/tax-review/llm/register";
import type { ScrubConfig } from "@/lib/tax-review/llm/scrub";
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

const ENTITY_LABELS: Record<string, { label: string; aliases: string[] }> = {
  "ek-consulting": { label: "the Consulting LLC", aliases: ["EK Consulting", "EKC"] },
  "sudden-valley": { label: "the Property Management LLC", aliases: ["Sudden Valley"] },
  mezzo: { label: "the third business entity", aliases: [] },
};

export interface EntityNameRow {
  name: string;
  slug: string | null;
}

/** Generic labels for the business entities (the personal entity's name is a generic word and is left alone). */
export function scrubEntitiesFor(rows: readonly EntityNameRow[]): { entities: NonNullable<ScrubConfig["entities"]>; labels: string[] } {
  const entities: { name: string; label: string; aliases?: string[] }[] = [];
  let other = 0;
  for (const r of rows) {
    if (r.slug === "personal" || r.name.trim().toLowerCase() === "personal") continue;
    const known = r.slug === null ? undefined : ENTITY_LABELS[r.slug];
    if (known !== undefined) entities.push({ name: r.name, label: known.label, aliases: known.aliases });
    else {
      other += 1;
      entities.push({ name: r.name, label: `business entity ${other}` });
    }
  }
  return { entities, labels: [...new Set(entities.map((e) => e.label))] };
}

/** Known street addresses (primary residence, mortgaged and taxed properties) mapped to generic property labels. */
export function scrubAddressesFor(facts: Ty2025Facts, primaryResidence: string | null): ScrubConfig["addresses"] {
  const out: { address: string; label: string }[] = [];
  const seen = new Map<string, string>();
  let n = 0;
  const add = (address: string | null | undefined, primary: boolean): void => {
    const a = (address ?? "").trim();
    if (a === "") return;
    // the same street line is the same property, however much of the town / state / zip follows it
    const key = (a.split(",")[0] ?? a).toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) {
      // the longer written form (with town and zip) is scrubbed too, under the same label
      const label = seen.get(key) ?? "";
      if (!out.some((o) => o.address === a)) out.push({ address: a, label });
      return;
    }
    let label: string;
    if (primary) label = "the primary residence";
    else {
      n += 1;
      label = `other property ${String.fromCharCode(64 + n)}`;
    }
    seen.set(key, label);
    out.push({ address: a, label });
  };
  add(primaryResidence, true);
  add(facts.deductions.primaryResidenceAddress.value, true);
  for (const m of facts.deductions.mortgages) add(m.propertyAddress, false);
  for (const b of facts.deductions.propertyTaxBills) add(b.address, false);
  return out;
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
  const entityRows = await db.entity.findMany({ select: { name: true, slug: true } });
  const scrubEntities = scrubEntitiesFor(entityRows);
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
