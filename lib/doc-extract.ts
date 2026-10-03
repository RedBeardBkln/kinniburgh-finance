import Anthropic from "@anthropic-ai/sdk";
import {
  buildTaxExtractionPrompt,
  normalizeTaxExtraction,
  schemaTypeForDocType,
  type TaxSchemaDocType,
} from "@/lib/tax-extraction-schema";

export type DocType =
  | "bank_statement"
  | "credit_card_statement"
  | "mortgage_statement"
  | "insurance_policy"
  | "utility_bill"
  | "w2"
  | "1099"
  | "k1"
  | "form_1098"
  | "property_tax"
  | "tax_return"
  | "donation_receipt"
  | "other";

export interface TransactionRow {
  date: string;        // YYYY-MM-DD
  description: string;
  amountCents: number; // negative = outflow, positive = inflow
  lineType?: "charge" | "payment"; // credit_card_statement rows only; undefined elsewhere (treated as "charge")
}

export interface ExtractedDocument {
  docType: DocType;
  summary: string;
  period?: string; // YYYY-MM for statements, YYYY for annual
  data: Record<string, unknown>;
  /**
   * Stamped by the tax normalizer (lib/tax-extraction-schema). Absent = an
   * extraction made before the expanded tax schemas ("older format").
   */
  schemaVersion?: number;
  transactionRows?: TransactionRow[];
  // Non-fatal caveats the reviewer should see before trusting the rows (e.g.
  // the extraction hit its row cap and may be missing transactions).
  warnings?: string[];
}

// The prompts ask for at most this many rows. Hitting it exactly almost
// certainly means rows were cut off, so it is surfaced as a warning.
export const MAX_TRANSACTION_ROWS = 200;

const STATEMENT_DOC_TYPES: ReadonlySet<DocType> = new Set(["bank_statement", "credit_card_statement"]);

// ── Per-type extraction prompts ───────────────────────────────────────────────

const PROMPTS: Record<DocType, string> = {
  bank_statement: `Extract from this bank statement and return ONLY valid JSON:
{
  "docType": "bank_statement",
  "summary": "1-2 sentence description of the statement",
  "period": "YYYY-MM",
  "data": {
    "accountMask": "last 4 digits only",
    "institutionName": "bank name",
    "openingBalanceCents": 0,
    "closingBalanceCents": 0,
    "periodStart": "YYYY-MM-DD",
    "periodEnd": "YYYY-MM-DD"
  },
  "transactionRows": [
    { "date": "YYYY-MM-DD", "description": "payee/description", "amountCents": -1234 }
  ]
}
Rules: amounts in integer cents (negative=debit/outflow, positive=credit/inflow). Return null for unknown fields. Return at most 200 transaction rows.`,

  credit_card_statement: `Extract from this credit card statement and return ONLY valid JSON:
{
  "docType": "credit_card_statement",
  "summary": "1-2 sentence description of the statement",
  "period": "YYYY-MM",
  "data": {
    "accountMask": "last 4 digits only",
    "institutionName": "card issuer name",
    "openingBalanceCents": 0,
    "closingBalanceCents": 0,
    "statementBalanceCents": 0,
    "minimumPaymentCents": 0,
    "paymentDueDate": "YYYY-MM-DD",
    "periodStart": "YYYY-MM-DD",
    "periodEnd": "YYYY-MM-DD"
  },
  "transactionRows": [
    { "date": "YYYY-MM-DD", "description": "merchant/description", "amountCents": -1234, "lineType": "charge" }
  ]
}
Rules: amounts in integer cents (negative=charge/purchase, positive=payment or merchant refund/credit). Classify each row's "lineType" as either "charge" or "payment":
- "payment": ONLY a payment made TO the card issuer that pays down the balance (description patterns like "PAYMENT", "AUTOPAY", "THANK YOU", "ONLINE PYMT").
- "charge": every purchase, fee, interest charge, AND merchant refund/credit (a refund is not a payment to the issuer — don't conflate the two just because both can be positive amounts).
- If not confident whether a row is a payment-to-issuer vs. a charge, default to "charge" (a human reviews every row before import either way; a false-negative "payment" that gets imported is worse than a false-negative "charge" that gets excluded).
Return null for unknown fields. Return at most 200 transaction rows.`,

  mortgage_statement: `Extract from this mortgage statement and return ONLY valid JSON:
{
  "docType": "mortgage_statement",
  "summary": "1-2 sentence description",
  "period": "YYYY-MM",
  "data": {
    "servicerName": "servicer",
    "loanNumber": "masked last 4",
    "principalBalanceCents": 0,
    "interestRate": 0.0,
    "monthlyPaymentCents": 0,
    "principalCents": 0,
    "interestCents": 0,
    "escrowBalanceCents": 0,
    "nextPaymentDate": "YYYY-MM-DD",
    "propertyAddress": "address"
  }
}
Rules: amounts in integer cents. interestRate as decimal (e.g. 0.0675 for 6.75%). Return null for unknown fields.`,

  insurance_policy: `Extract from this insurance policy document and return ONLY valid JSON:
{
  "docType": "insurance_policy",
  "summary": "1-2 sentence description of the policy",
  "data": {
    "policyType": "term|whole|ul|property|auto|motorcycle|other",
    "insurer": "company name",
    "policyNumber": "policy number",
    "faceAmountCents": 0,
    "monthlyPremiumCents": 0,
    "effectiveDate": "YYYY-MM-DD",
    "expiryDate": "YYYY-MM-DD",
    "cashValueCents": 0
  }
}
Rules: amounts in integer cents. cashValueCents is 0 if not applicable (term). Return null for unknown fields.`,

  utility_bill: `Extract from this utility bill and return ONLY valid JSON:
{
  "docType": "utility_bill",
  "summary": "1-2 sentence description",
  "period": "YYYY-MM",
  "data": {
    "provider": "utility company name",
    "accountNumber": "masked last 4",
    "periodStart": "YYYY-MM-DD",
    "periodEnd": "YYYY-MM-DD",
    "amountDueCents": 0,
    "usageKwh": 0.0,
    "gridCreditCents": 0
  }
}
Rules: amountDueCents and gridCreditCents in integer cents. usageKwh as decimal. Return null for unknown fields.`,

  // Tax documents: generated from the schema registry (lib/tax-extraction-schema)
  // so the prompt, normalizer and review form cannot drift apart.
  w2: buildTaxExtractionPrompt("w2"),
  "1099": buildTaxExtractionPrompt("1099"),
  form_1098: buildTaxExtractionPrompt("form_1098"),
  property_tax: buildTaxExtractionPrompt("property_tax"),
  k1: buildTaxExtractionPrompt("k1"),
  tax_return: buildTaxExtractionPrompt("tax_return"),
  donation_receipt: buildTaxExtractionPrompt("donation_receipt"),

  other: `Summarize this document and return ONLY valid JSON:
{
  "docType": "other",
  "summary": "1-2 sentence description of what this document is",
  "data": {}
}`,
};

// ── Classification ────────────────────────────────────────────────────────────

const TYPE_KEYWORDS: Array<[DocType, RegExp]> = [
  ["bank_statement", /bank.?statement|account.?statement|checking|savings.?statement/i],
  ["mortgage_statement", /mortgage|loan.?statement|pennymac|escrow/i],
  ["insurance_policy", /policy|insurance|northwestern|nwm|premium|face.?amount|cash.?value/i],
  ["utility_bill", /electric|eversource|utility|kwh|gas.?bill|water.?bill/i],
  ["w2", /w-?2|wage.?tax|employer/i],
  ["1099", /1099/i],
  ["k1", /schedule.?k-?1|k1|partnership|s-?corp/i],
  ["tax_return", /tax.?return|form.?1040|1065|1120/i],
];

export function classifyDocType(docType: string, fileName?: string): DocType {
  const mapped: Record<string, DocType> = {
    w2: "w2",
    "1099": "1099",
    k1: "k1",
    statement: "bank_statement",
    bank_statement: "bank_statement",
    mortgage_statement: "mortgage_statement",
    insurance_policy: "insurance_policy",
    utility_bill: "utility_bill",
    tax_return: "tax_return",
    policy: "insurance_policy",
    // An annual Form 1098 has its own box shape; the monthly mortgage-statement
    // prompt (mortgage_statement above) is for statements only.
    mortgage_interest: "form_1098",
    form_1098: "form_1098",
    property_tax: "property_tax",
    // No TYPE_KEYWORDS entry on purpose: a file name is never enough to guess a
    // donation receipt; the owner picks the type.
    donation_receipt: "donation_receipt",
  };

  if (mapped[docType]) return mapped[docType]!;

  if (fileName) {
    for (const [type, pattern] of TYPE_KEYWORDS) {
      if (pattern.test(fileName)) return type;
    }
  }

  return "other";
}

// ── Core extraction ───────────────────────────────────────────────────────────

/**
 * Output budget per type. A 200-row statement is ~7k+ output tokens; the old
 * 4096 cap cut long statements off mid-array. Consolidated 1099s, K-1s and
 * property-tax bills (many installments) are long too; a `max_tokens` stop
 * throws in extractDocumentOrThrow, so under-sizing is a failure, never a
 * silent truncation.
 */
function maxTokensFor(docType: DocType): number {
  if (STATEMENT_DOC_TYPES.has(docType)) return 16000;
  if (docType === "1099" || docType === "k1" || docType === "property_tax") return 8192;
  return 4096;
}

/**
 * Tax documents only: the one post-parse clean-up (drops unknown keys, scrubs
 * SSN/ITIN-shaped text, enforces EIN format and integer cents, stamps
 * schemaVersion). Returns the input untouched for every other type.
 */
function normalizeIfTax(docType: DocType, result: ExtractedDocument): ExtractedDocument {
  const schemaType: TaxSchemaDocType | null = schemaTypeForDocType(docType);
  if (!schemaType) return result;
  const normalized = normalizeTaxExtraction(schemaType, result);
  const { warnings, ...rest } = normalized;
  return {
    ...rest,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function parseExtractionResponse(text: string): ExtractedDocument {
  const raw = text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  try {
    const parsed = JSON.parse(raw) as ExtractedDocument;
    return parsed;
  } catch {
    return {
      docType: "other",
      summary: "Could not parse extraction response.",
      data: { raw },
    };
  }
}

/**
 * Strict JSON parse for extraction output: tolerates markdown fences and
 * surrounding prose, but THROWS when no JSON object can be recovered, instead
 * of returning a fake "successful" stub the way parseExtractionResponse does.
 */
export function parseExtractionStrict(text: string): ExtractedDocument {
  const stripped = text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  const candidates = [stripped];
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(stripped.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as ExtractedDocument;
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error("Extraction response was not valid JSON");
}

/**
 * Runs extraction and THROWS on any failure: unsupported file, API error,
 * output cut off at max_tokens, unparseable JSON, or (for statements) a
 * response with no transactionRows array. Use this wherever a failure must be
 * recorded as a failure. A truncated response used to be saved as a
 * successful extraction with the raw text as its only data.
 */
export async function extractDocumentOrThrow(
  buffer: Buffer,
  mimeType: string,
  docType: DocType
): Promise<ExtractedDocument> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const base64 = buffer.toString("base64");
  const systemPrompt = PROMPTS[docType];

  type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType === "application/pdf";

  if (!isImage && !isPdf) throw new Error("Unsupported file type");

  const contentBlock = isImage
    ? {
        type: "image" as const,
        source: { type: "base64" as const, media_type: mimeType as ImageMediaType, data: base64 },
      }
    : {
        type: "document" as const,
        source: { type: "base64" as const, media_type: "application/pdf" as const, data: base64 },
      };

  const isStatement = STATEMENT_DOC_TYPES.has(docType);
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokensFor(docType),
    system: systemPrompt,
    messages: [{ role: "user", content: [contentBlock, { type: "text", text: "Extract the data." }] }],
  });

  if (message.stop_reason === "max_tokens") {
    throw new Error("Extraction output was cut off before it finished");
  }

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const parsed = parseExtractionStrict(text);
  if (typeof parsed.data !== "object" || parsed.data === null) parsed.data = {};
  const result = normalizeIfTax(docType, parsed);

  if (isStatement) {
    if (!Array.isArray(result.transactionRows)) {
      throw new Error("Statement extraction returned no transactionRows array");
    }
    if (result.transactionRows.length >= MAX_TRANSACTION_ROWS) {
      result.warnings = [
        ...(result.warnings ?? []),
        `Extraction returned ${result.transactionRows.length} rows, the maximum it will read — the statement may contain more transactions than are listed here. Verify against the PDF.`,
      ];
    }
  }
  return result;
}

/**
 * Lenient wrapper kept for callers that want a value back no matter what
 * (insurance and tax-planning uploads). On failure it returns a stub instead
 * of throwing — callers that must record failure use extractDocumentOrThrow.
 */
export async function extractDocument(
  buffer: Buffer,
  mimeType: string,
  docType: DocType
): Promise<ExtractedDocument> {
  try {
    const isImage = mimeType.startsWith("image/");
    const isPdf = mimeType === "application/pdf";
    if (!isImage && !isPdf) {
      return { docType: "other", summary: "Unsupported file type.", data: {} };
    }
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const base64 = buffer.toString("base64");

    type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    const contentBlock = isImage
      ? {
          type: "image" as const,
          source: { type: "base64" as const, media_type: mimeType as ImageMediaType, data: base64 },
        }
      : {
          type: "document" as const,
          source: { type: "base64" as const, media_type: "application/pdf" as const, data: base64 },
        };

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokensFor(docType),
      system: PROMPTS[docType],
      messages: [{ role: "user", content: [contentBlock, { type: "text", text: "Extract the data." }] }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const parsed = parseExtractionResponse(text);
    // The unparseable-response stub must stay recognisable (findUnparseableExtractions
    // keys on its summary), so only a real parse is normalized.
    return parsed.summary === "Could not parse extraction response." ? parsed : normalizeIfTax(docType, parsed);
  } catch (err) {
    console.error("Document extraction failed:", err);
    return { docType, summary: "Extraction failed.", data: {} };
  }
}

export type { PayoffScenario } from "@/lib/payoff-math";
export { computeCCPayoff, computePayoffScenarios } from "@/lib/payoff-math";
