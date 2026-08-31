// Server-only: Anthropic extraction for paystubs.
// Pure helpers live in lib/paystub-math.ts (client-safe).

import Anthropic from "@anthropic-ai/sdk";
import {
  EMPTY_PAYSTUB,
  parseExtractedPaystub,
  type ExtractedPaystub,
} from "@/lib/paystub-math";

export type {
  ExtractedPaystub,
  LabeledAmount,
  PayFrequency,
  PaystubMath,
} from "@/lib/paystub-math";
export {
  verifyPaystubMath,
  inferPayFrequency,
  parseExtractedPaystub,
} from "@/lib/paystub-math";

const SYSTEM_PROMPT = `You are a paystub data extractor. Given a paystub image or PDF, extract the fields below and return ONLY valid JSON — no markdown, no explanation:

{
  "employeeName": "employee name",
  "employerName": "employer name",
  "payPeriodStart": "YYYY-MM-DD",
  "payPeriodEnd": "YYYY-MM-DD",
  "payDate": "YYYY-MM-DD",
  "payFrequency": "weekly | biweekly | semi_monthly | monthly",
  "grossPayCents": 0,
  "pretaxDeductions": [{ "label": "401(k) employee", "amountCents": 10000 }],
  "taxBreakdown": [{ "label": "Federal Income Tax", "amountCents": 42000 }],
  "additionalWithholding": [{ "label": "Federal extra (W-4)", "amountCents": 5000 }],
  "netPayCents": 0
}

Rules:
- All amounts in INTEGER CENTS (e.g. $1,234.56 → 123456). Never floats.
- COMPLETENESS IS CRITICAL: list EVERY deduction line item printed on the stub, in its own category. Read the entire deductions/withholdings section line by line — do not summarize or skip lines. Include every 401(k)/403(b)/457, HSA, FSA, dental/vision/health premium, life/disability insurance, union dues, garnishments, parking/commuter, ESPP, and any other labeled deduction.
- pretaxDeductions: deductions taken BEFORE taxes (traditional 401k, HSA, FSA, health/dental/vision premiums, etc.).
- taxBreakdown: every TAX withholding (Federal, Social Security, Medicare, state, local, SDI etc.).
- additionalWithholding: EXTRA federal or state tax money elected beyond the normal calculated tax lines (e.g. "Additional Federal Withholding", W-4 line 4c/4b amounts, extra state withholding). Do NOT include regular calculated tax lines here — those belong in taxBreakdown.
- Post-tax deductions (Roth 401(k), garnishments, etc.): include them in pretaxDeductions ONLY if the stub shows them in the pre-tax section; otherwise leave them out — the math check accounts for post-tax items separately.
- payFrequency: infer from the pay period length ONLY if the stub states it or the dates make it unambiguous; otherwise null.
- Return null for any field you cannot read with confidence. Empty arrays for lists you cannot read.
- Dates must be ISO format YYYY-MM-DD.`;

export async function extractPaystubData(
  buffer: Buffer,
  mimeType: string
): Promise<ExtractedPaystub> {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const base64 = buffer.toString("base64");

    type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    const isImage = mimeType.startsWith("image/");
    const isPdf = mimeType === "application/pdf";

    if (!isImage && !isPdf) {
      return { ...EMPTY_PAYSTUB, raw: "" };
    }

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: isImage
            ? [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mimeType as ImageMediaType,
                    data: base64,
                  },
                },
                { type: "text", text: "Extract the paystub data." },
              ]
            : [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf" as const,
                    data: base64,
                  },
                },
                { type: "text", text: "Extract the paystub data." },
              ],
        },
      ],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    return parseExtractedPaystub(text);
  } catch (err) {
    console.error("Paystub extraction failed:", err);
    return { ...EMPTY_PAYSTUB, raw: "" };
  }
}