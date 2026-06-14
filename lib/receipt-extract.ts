import Anthropic from "@anthropic-ai/sdk";

export interface ExtractedReceipt {
  vendor: string | null;
  receiptDate: string | null; // ISO date "YYYY-MM-DD"
  totalDollars: string | null; // e.g. "42.50"
  description: string | null;
  glCode: string | null;
  raw: string;
}

const SYSTEM_PROMPT = `You are a receipt data extractor. Given a receipt image or document, extract the following fields and return ONLY valid JSON — no markdown, no explanation:

{
  "vendor": "store or vendor name",
  "receiptDate": "YYYY-MM-DD",
  "totalDollars": "12.50",
  "description": "brief description of what was purchased",
  "glCode": "expense category (e.g. Meals, Office Supplies, Utilities, Travel, Groceries)"
}

Rules:
- Return null for any field you cannot determine with confidence.
- totalDollars must be a decimal string with exactly 2 decimal places (e.g. "12.50"), no $ sign.
- receiptDate must be ISO format YYYY-MM-DD.
- If there are multiple items, summarize them in description.`;

export function parseExtractedResponse(text: string): ExtractedReceipt {
  const raw = text.trim();
  try {
    const jsonText = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return {
      vendor: typeof parsed.vendor === "string" ? parsed.vendor : null,
      receiptDate: typeof parsed.receiptDate === "string" ? parsed.receiptDate : null,
      totalDollars: typeof parsed.totalDollars === "string" ? parsed.totalDollars : null,
      description: typeof parsed.description === "string" ? parsed.description : null,
      glCode: typeof parsed.glCode === "string" ? parsed.glCode : null,
      raw,
    };
  } catch {
    return { vendor: null, receiptDate: null, totalDollars: null, description: null, glCode: null, raw };
  }
}

export async function extractReceiptData(
  buffer: Buffer,
  mimeType: string
): Promise<ExtractedReceipt> {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const base64 = buffer.toString("base64");

    type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    const isImage = mimeType.startsWith("image/");
    const isPdf = mimeType === "application/pdf";

    if (!isImage && !isPdf) {
      return { vendor: null, receiptDate: null, totalDollars: null, description: null, glCode: null, raw: "" };
    }

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
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
                { type: "text", text: "Extract the receipt data." },
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
                { type: "text", text: "Extract the receipt data." },
              ],
        },
      ],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    return parseExtractedResponse(text);
  } catch (err) {
    console.error("Receipt extraction failed:", err);
    return { vendor: null, receiptDate: null, totalDollars: null, description: null, glCode: null, raw: "" };
  }
}
