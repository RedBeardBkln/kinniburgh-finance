"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import {
  getDocumentFileSignedUrl,
  downloadDocumentFile,
  downloadTaxFile,
  getTaxSignedUploadUrl,
} from "@/lib/supabase-storage";
import { extractDocument, classifyDocType, type ExtractedDocument } from "@/lib/doc-extract";
import { generateDocumentName } from "@/lib/doc-naming";
import { parseModelJson } from "@/lib/model-json";
import { TAX_QUESTION_BANK, baseOpportunitiesForHousehold } from "@/lib/tax-guidance";
import {
  MAX_SIZE_BYTES,
  buildTaxDocumentFileKey,
  validateTaxDocumentFile,
} from "@/lib/tax-document-upload";
import Anthropic from "@anthropic-ai/sdk";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

// ── Workspace creation ────────────────────────────────────────────────────────

const PERSONAL_ENTITY_NAME = "Personal";

/**
 * Creates (or returns) a personal tax workspace for a year. The 2025 personal
 * return is on extension (filed and accepted by the IRS) — deadline Oct 15, 2026.
 */
export async function ensurePersonalWorkspace(taxYear: number) {
  await requireAuth();

  const entity = await db.entity.findFirst({
    where: { name: PERSONAL_ENTITY_NAME, type: "personal" },
  });
  if (!entity) throw new Error("Personal entity not found");

  const existing = await db.taxWorkspace.findUnique({
    where: { entityId_taxYear: { entityId: entity.id, taxYear } },
    include: { questions: true },
  });

  if (existing) {
    // Seed the question bank on first open so the user is prompted for
    // missing information with full context.
    if (existing.questions.length === 0) {
      await db.taxQuestion.createMany({
        data: TAX_QUESTION_BANK.map((q) => ({
          workspaceId: existing.id,
          key: q.key,
          category: q.category,
          question: `${q.question}\n\n${q.context}`,
          options: (q.options ?? null) as unknown as never,
        })),
        skipDuplicates: true,
      });
    }
    return existing.id;
  }

  const isExtensionYear = taxYear === 2025;
  const workspace = await db.taxWorkspace.create({
    data: {
      entityId: entity.id,
      taxYear,
      status: isExtensionYear ? "extended" : "in_progress",
      deadline: isExtensionYear
        ? new Date("2026-10-15T04:00:00Z") // extended deadline — confirm with CPA
        : new Date(`${taxYear + 1}-04-15T04:00:00Z`),
      notes: isExtensionYear
        ? "2025 personal return — extension filed and accepted by the IRS. " +
          "Extended filing deadline: October 15, 2026 (confirm with CPA). " +
          "Note: the extension moved the filing deadline, NOT the payment deadline — " +
          "any balance due has been accruing interest since April 15, 2026."
        : "Personal federal + CT state return. Draft is prepared by the platform and reviewed by your CPA.",
    },
  });

  await db.taxQuestion.createMany({
    data: TAX_QUESTION_BANK.map((q) => ({
      workspaceId: workspace.id,
      key: q.key,
      category: q.category,
      question: `${q.question}\n\n${q.context}`,
      options: (q.options ?? null) as unknown as never,
    })),
    skipDuplicates: true,
  });

  revalidatePath("/tax");
  return workspace.id;
}

// ── Question answering ───────────────────────────────────────────────────────

const answerSchema = z.object({
  questionId: z.string().uuid(),
  answer: z.string().max(4000).nullable(),
  skippedReason: z.string().max(1000).optional(),
});

export async function answerTaxQuestion(input: z.input<typeof answerSchema>) {
  await requireAuth();
  const parsed = answerSchema.parse(input);

  await db.taxQuestion.update({
    where: { id: parsed.questionId },
    data: {
      answer: (parsed.answer ?? null) as unknown as never,
      answeredAt: parsed.answer ? new Date() : null,
      skippedReason: parsed.skippedReason ?? null,
    },
  });

  revalidatePath("/tax");
  return { success: true };
}

export async function getWorkspaceQuestions(workspaceId: string) {
  await requireAuth();
  return db.taxQuestion.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
  });
}

// ── Document intake (taxes bucket, two-phase direct-to-storage) ─────────────
//
// Raw file bytes never travel through a Server Action's request body — Vercel
// enforces a hard, non-configurable 4.5MB cap on Serverless Function request
// bodies, which broke uploads over ~4.4MB (and any batch whose combined size
// crossed that line) when this used to send FormData with the file attached
// directly. Instead: (1) requestTaxDocumentUploadSlot mints a signed Supabase
// Storage upload URL, (2) the client PUTs the file bytes straight to storage,
// bypassing the Next.js server entirely, (3) finalizeTaxDocumentUpload
// creates the Document row and runs extraction inline. Unlike bank
// statements, extraction here runs inline for extractable docTypes in BOTH
// single-file and multi-file (batch) client flows — uploadTaxDocumentCore's
// extraction logic was never batch-vs-single gated, and this refactor
// preserves that exactly (each file gets its own finalize call, so "batch"
// and "single" are now the same code path from the server's perspective).

const TAX_DOC_TYPES = [
  "w2",
  "1099",
  "k1",
  "extension",
  "property_tax",
  "mortgage_interest",
  "tax_return",
  "bank_statement",
  "other",
] as const;

interface UploadedTaxDoc {
  documentId: string;
  documentName: string | null;
  extraction: ExtractedDocument | null;
}

/**
 * Core single-file upload logic, invoked once per file by
 * finalizeTaxDocumentUpload (both single-file and batch client flows use the
 * same finalize action, once per file). Takes an already-generated
 * documentId/fileKey (minted by requestTaxDocumentUploadSlot) and the
 * already-uploaded buffer — it no longer generates its own docId/fileKey or
 * uploads bytes to storage itself, since the client's direct PUT already put
 * them there. Everything else (the db.document.create, the
 * extractable-docType check, the classifyDocType/extractDocument/
 * generateDocumentName calls, the two db.document.update branches for
 * extraction success/failure, the non-extractable-doc naming fallback) is
 * byte-for-byte identical to the pre-fix implementation.
 */
async function uploadTaxDocumentCore(input: {
  documentId: string;
  fileKey: string;
  buffer: Buffer;
  mimeType: string;
  entityId: string;
  taxYear: number | null;
  docType: (typeof TAX_DOC_TYPES)[number];
  notes: string | undefined;
}): Promise<UploadedTaxDoc> {
  const { documentId: docId, fileKey, buffer, mimeType, entityId, taxYear, docType, notes } = input;

  await db.document.create({
    data: {
      id: docId,
      entityId,
      taxYear: taxYear ?? undefined,
      docType,
      fileKey,
      notes,
    },
  });

  // Extract immediately (tax docs: W-2/1099/1098/returns have structured data)
  let extraction: ExtractedDocument | null = null;
  let documentName: string | null = null;
  const extractable =
    docType === "w2" || docType === "1099" || docType === "k1" ||
    docType === "mortgage_interest" || docType === "tax_return" ||
    docType === "property_tax";

  if (extractable) {
    try {
      const mappedType = classifyDocType(docType, fileKey);
      extraction = await extractDocument(buffer, mimeType, mappedType);
      // Autogenerate a human-friendly name from the parsed data
      documentName = generateDocumentName(docType, taxYear, extraction);
      await db.document.update({
        where: { id: docId },
        data: {
          documentName,
          extractionStatus: "complete",
          extractionData: extraction as unknown as Prisma.InputJsonValue,
          extractionModel: "claude-sonnet-4-6",
          extractedAt: new Date(),
        },
      });
    } catch {
      await db.document.update({
        where: { id: docId },
        data: { extractionStatus: "failed" },
      });
    }
  }

  // Non-extractable docs still get a type + year name
  if (!documentName) {
    documentName = generateDocumentName(docType, taxYear, null);
    await db.document.update({
      where: { id: docId },
      data: { documentName },
    });
  }

  return { documentId: docId, documentName, extraction };
}

const requestSlotSchema = z.object({
  entityId: z.string().uuid(),
  fileType: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
});

export type RequestTaxDocumentUploadSlotInput = z.input<typeof requestSlotSchema>;

export async function requestTaxDocumentUploadSlot(
  input: RequestTaxDocumentUploadSlotInput
): Promise<
  | { ok: true; documentId: string; fileKey: string; uploadUrl: string }
  | { ok: false; error: string }
> {
  await requireAuth();

  const parsed = requestSlotSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { entityId, fileType, fileSize } = parsed.data;

  const validation = validateTaxDocumentFile(fileType, fileSize);
  if (!validation.ok) return { ok: false, error: validation.error };

  const documentId = randomUUID();
  const fileKey = buildTaxDocumentFileKey(entityId, documentId, fileType);
  if (!fileKey) {
    // Should be unreachable given validateTaxDocumentFile above, but keep
    // this typed-safe rather than asserting non-null.
    return { ok: false, error: "Unsupported file type" };
  }

  try {
    const uploadUrl = await getTaxSignedUploadUrl(fileKey);
    return { ok: true, documentId, fileKey, uploadUrl };
  } catch (e) {
    return {
      ok: false,
      error: `Could not prepare upload: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }
}

const finalizeSchema = z.object({
  documentId: z.string().uuid(),
  fileKey: z.string().min(1),
  entityId: z.string().uuid(),
  fileType: z.string().min(1),
  taxYear: z.number().int().nullable(),
  docType: z.enum(TAX_DOC_TYPES),
  notes: z.string().optional(),
});

export type FinalizeTaxDocumentUploadInput = z.input<typeof finalizeSchema>;

export async function finalizeTaxDocumentUpload(
  input: FinalizeTaxDocumentUploadInput
): Promise<
  | { ok: true; documentId: string; documentName: string | null; extraction: ExtractedDocument | null }
  | { ok: false; error: string }
> {
  await requireAuth();

  const parsed = finalizeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { documentId, fileKey, entityId, fileType, taxYear, docType, notes } = parsed.data;

  if (taxYear !== null && (taxYear < 2000 || taxYear > 2100)) {
    return { ok: false, error: "Invalid tax year" };
  }

  // Defense-in-depth: reject if the client-supplied fileKey doesn't match
  // what the server would have generated for this documentId/entityId/type.
  const expectedFileKey = buildTaxDocumentFileKey(entityId, documentId, fileType);
  if (expectedFileKey !== fileKey) {
    return { ok: false, error: "Upload reference mismatch" };
  }

  // downloadTaxFile does double duty here: it's both the source bytes for
  // inline extraction AND the authoritative proof the client's direct PUT
  // actually landed in storage before we write any DB rows.
  let buffer: Buffer;
  try {
    buffer = await downloadTaxFile(fileKey);
  } catch {
    return {
      ok: false,
      error: "Upload did not complete — file not found in storage. Please try again.",
    };
  }

  // Authoritative size check — the client-reported fileSize at slot-request
  // time is trust-but-verify only; this inspects the real uploaded bytes.
  if (buffer.length > MAX_SIZE_BYTES) {
    return { ok: false, error: "File exceeds 20MB limit" };
  }

  const result = await uploadTaxDocumentCore({
    documentId,
    fileKey,
    buffer,
    mimeType: fileType,
    entityId,
    taxYear,
    docType,
    notes,
  });

  revalidatePath("/documents");
  revalidatePath("/tax");
  return { ok: true, ...result };
}

// ── Edit document name / type ────────────────────────────────────────────────

const updateDocSchema = z.object({
  documentId: z.string().uuid(),
  documentName: z.string().min(1).max(200),
  docType: z.enum(TAX_DOC_TYPES),
});

export async function updateTaxDocument(
  input: z.input<typeof updateDocSchema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = updateDocSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  const doc = await db.document.findUnique({ where: { id: parsed.data.documentId } });
  if (!doc || doc.archivedAt) return { error: "Document not found" };

  await db.document.update({
    where: { id: parsed.data.documentId },
    data: {
      documentName: parsed.data.documentName.trim(),
      docType: parsed.data.docType,
    },
  });

  revalidatePath("/tax");
  revalidatePath("/documents");
  return { success: true };
}

export async function getTaxDocumentSignedUrl(documentId: string) {
  await requireAuth();
  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
  // A Document's fileKey can come from any upload path (tax-specific,
  // generic document-vault, or bank-statement) — bucket/prefix resolution is
  // centralized in lib/supabase-storage.ts's getDocumentFileSignedUrl so all
  // three agree on where a given fileKey's bytes actually live.
  return getDocumentFileSignedUrl(doc.fileKey);
}

export async function downloadTaxDocument(documentId: string): Promise<Buffer> {
  await requireAuth();
  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
  return downloadDocumentFile(doc.fileKey);
}

// ── AI tax review ─────────────────────────────────────────────────────────────

export interface TaxReviewResult {
  summary: string;
  opportunities: {
    key: string;
    title: string;
    explanation: string;
    value: string;
    risk: "conservative" | "moderate" | "aggressive";
    caveat: string;
    forms: string[];
  }[];
  nextSteps: string[];
  warnings: string[];
}

/**
 * Generates the AI tax review: parses uploaded document extractions + the user's
 * answers, then asks Claude for guidance that maximizes the refund legitimately.
 * PRIVACY: all data stays inside this stack — it goes to Anthropic's API solely
 * for processing and is covered by the system prompt's confidentiality rules.
 * No other external service receives any of it.
 */
export async function generateTaxReview(workspaceId: string): Promise<
  { success: true; review: TaxReviewResult } | { error: string }
> {
  await requireAuth();

  const workspace = await db.taxWorkspace.findUnique({
    where: { id: workspaceId },
    include: { entity: true, questions: true },
  });
  if (!workspace) return { error: "Workspace not found" };

  const docs = await db.document.findMany({
    where: { entityId: workspace.entityId, taxYear: workspace.taxYear, archivedAt: null },
    orderBy: { createdAt: "desc" },
  });

  // Assemble the extraction summary (only structured data — no raw PII dumps)
  const docSummaries = docs
    .map((d) => {
      const data = d.extractionData as ExtractedDocument | null;
      if (!data) return `- ${d.docType}: uploaded (not extracted)`;
      return `- ${d.docType}: ${data.summary ?? "no summary"}${
        data.data ? ` — ${JSON.stringify(data.data).slice(0, 500)}` : ""
      }`;
    })
    .join("\n");

  const answers = workspace.questions
    .filter((q) => q.answer !== null)
    .map((q) => `- ${q.key}: ${JSON.stringify(q.answer)}`)
    .join("\n");

  const baseOps = baseOpportunitiesForHousehold();

  const systemPrompt = `You are the tax preparation assistant inside the Kinniburgh family's private financial platform. The household's directive: maximize the federal and state refund and avoid owing additional tax, using every deduction, credit, and election the tax law legitimately allows.

NON-NEGOTIABLE RULES:
1. NEVER suggest hiding income, fabricating deductions, mischaracterizing expenses, or any position that violates the tax law. The objective is maximum LEGITIMATE refund — a disallowed position costs the original tax plus 20–75% penalties and interest, which defeats the objective.
2. For each strategy, state its honest risk level and any legal implications. Aggressive positions are surfaced with their true weight — never disguised as safe.
3. Only reference facts from the provided documents and answers. If data is missing, say exactly what's needed. Never invent numbers.
4. All dollar figures must come from the user's documents. Estimates must be labeled as estimates.
5. Output is a DRAFT for the household's CPA to review and sign off on — you prepare, humans decide.
6. CONFIDENTIALITY: everything you receive is the family's private financial data, used only inside this session to produce the review. Do not ask it to be shared elsewhere, and never output more identifying detail than the task requires (mask SSNs/EINs as ···last4).

Return ONLY valid JSON, no preamble or postamble:
{
  "summary": "2-3 sentence overview of the tax situation and the refund-maximizing approach",
  "opportunities": [
    {
      "key": "stable_key",
      "title": "short title",
      "explanation": "what it is, why it applies here, and what's needed to claim it — 2-4 sentences max",
      "value": "estimated value or 'needs data' — labeled honestly",
      "risk": "conservative" | "moderate" | "aggressive",
      "caveat": "honest legal/financial implication; empty only for conservative items",
      "forms": ["Form/Schedule names"]
    }
  ],
  "nextSteps": ["ordered concrete next steps for this household"],
  "warnings": ["anything the household must be careful about — deadlines, interest accrual, audit triggers, missing documents"]
}

Be concise: cap at 10 opportunities, keep each explanation under 60 words, and keep nextSteps/warnings under 12 items each. Order opportunities by expected dollar impact. Do NOT repeat the full schema or restate these instructions in the output.

Ground the review in these known household facts: mortgage interest ~$4,700/mo (PennyMac, accelerated payments), property taxes on two properties (primary + 56 Arbor Rd), CT state taxes, EK Consulting LLC (single-member, Schedule C, 2025 return on extension — deadline Oct 15, 2026), Sudden Valley rental LLC (Airbnb income, JCSB x0626, owned free and clear, first filing Q1 2027), solar system on primary residence (EnerBank/Regions financed), business mileage tracked in the app. The 2025 personal return is on EXTENSION — payment deadline was April 15, 2026, so any balance due accrues interest now.`;

  const userContent = `Tax year: ${workspace.taxYear}
Entity: ${workspace.entity.name}

## Extracted documents
${docSummaries || "None uploaded yet."}

## User's answers to planning questions
${answers || "No questions answered yet."}

## Candidate opportunities already identified by the platform
${baseOps.map((o) => `- ${o.title} [risk: ${o.risk}]`).join("\n")}

Review all of this and produce the JSON review per your instructions. Add opportunities the platform missed, exclude ones the answers ruled out, and order everything by expected dollar impact.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    if (message.stop_reason === "max_tokens") {
      console.error("Tax review truncated at max_tokens — response incomplete");
      return {
        error:
          "The AI review was too long to generate in one pass — try again (or answer more planning questions first).",
      };
    }

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const parsed = parseModelJson<TaxReviewResult>(text);

    revalidatePath("/tax");
    return { success: true, review: parsed };
  } catch (err) {
    console.error("Tax review generation failed:", err);
    return { error: "AI review failed to generate — try again in a moment." };
  }
}