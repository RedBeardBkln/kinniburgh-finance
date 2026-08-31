"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { uploadTaxFile, downloadTaxFile } from "@/lib/supabase-storage";
import { extractDocument, classifyDocType, type ExtractedDocument } from "@/lib/doc-extract";
import { TAX_QUESTION_BANK, baseOpportunitiesForHousehold } from "@/lib/tax-guidance";
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

// ── Document intake (taxes bucket) ───────────────────────────────────────────

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

const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
const MAX_SIZE = 20 * 1024 * 1024;

export async function uploadTaxDocument(
  formData: FormData
): Promise<{ documentId: string; extraction: ExtractedDocument | null }> {
  const user = await requireAuth();

  const file = formData.get("file");
  if (!(file instanceof Blob)) throw new Error("No file provided");
  if (file.size > MAX_SIZE) throw new Error("File exceeds 20MB limit");
  const mimeType = file.type;
  if (!ALLOWED_MIME.includes(mimeType as (typeof ALLOWED_MIME)[number])) {
    throw new Error("Unsupported file type. Upload PDF, JPEG, PNG, or WebP.");
  }

  const entityId = z.string().uuid().parse(formData.get("entityId"));
  const taxYear = formData.get("taxYear") ? Number(formData.get("taxYear")) : null;
  if (taxYear !== null && (taxYear < 2000 || taxYear > 2100)) {
    throw new Error("Invalid tax year");
  }
  const docType = z.enum(TAX_DOC_TYPES).parse(formData.get("docType"));
  const notes = formData.get("notes")?.toString() || undefined;

  const ext = mimeType === "application/pdf" ? "pdf" : mimeType.split("/")[1];
  const docId = randomUUID();
  const fileKey = `taxes/${entityId}/${docId}.${ext}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadTaxFile(buffer, fileKey, mimeType);

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
  const extractable =
    docType === "w2" || docType === "1099" || docType === "k1" ||
    docType === "mortgage_interest" || docType === "tax_return" ||
    docType === "property_tax";

  if (extractable) {
    try {
      const mappedType = classifyDocType(docType, fileKey);
      extraction = await extractDocument(buffer, mimeType, mappedType);
      await db.document.update({
        where: { id: docId },
        data: {
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

  revalidatePath("/documents");
  revalidatePath("/tax");
  return { documentId: docId, extraction };
}

export async function getTaxDocumentSignedUrl(documentId: string) {
  await requireAuth();
  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
  return getTaxSignedUrlSafe(doc.fileKey);
}

async function getTaxSignedUrlSafe(fileKey: string): Promise<string> {
  // fileKey for tax docs starts with "taxes/" — sign against the taxes bucket
  const { getTaxSignedUrl } = await import("@/lib/supabase-storage");
  const key = fileKey.startsWith("taxes/") ? fileKey.slice("taxes/".length) : fileKey;
  return getTaxSignedUrl(key);
}

export async function downloadTaxDocument(documentId: string): Promise<Buffer> {
  await requireAuth();
  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
  const key = doc.fileKey.startsWith("taxes/") ? doc.fileKey.slice("taxes/".length) : doc.fileKey;
  return downloadTaxFile(key);
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

Return ONLY valid JSON:
{
  "summary": "2-3 sentence overview of the tax situation and the refund-maximizing approach",
  "opportunities": [
    {
      "key": "stable_key",
      "title": "short title",
      "explanation": "what it is, why it applies here, and what's needed to claim it",
      "value": "estimated value or 'needs data' — labeled honestly",
      "risk": "conservative" | "moderate" | "aggressive",
      "caveat": "honest legal/financial implication; empty only for conservative items",
      "forms": ["Form/Schedule names"]
    }
  ],
  "nextSteps": ["ordered concrete next steps for this household"],
  "warnings": ["anything the household must be careful about — deadlines, interest accrual, audit triggers, missing documents"]
}

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
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const jsonText = text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(jsonText) as TaxReviewResult;

    revalidatePath("/tax");
    return { success: true, review: parsed };
  } catch {
    return { error: "AI review failed to generate — try again in a moment." };
  }
}