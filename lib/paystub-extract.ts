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
  "netPayCents": 0
}

Rules:
- All amounts in INTEGER CENTS (e.g. $1,234.56 → 123456). Never floats.
- pretaxDeductions: every deduction taken BEFORE taxes (401k, HSA, FSA, health/dental/vision premiums, etc.). Do NOT include post-tax deductions like Roth 401(k).
- taxBreakdown: every tax withholding (Federal, Social Security, Medicare, state, local).
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