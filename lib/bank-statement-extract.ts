import Anthropic from "@anthropic-ai/sdk";

// ── Bank statement extraction ─────────────────────────────────────────────────
// A bank statement PDF may cover one or several accounts. We extract one row
// per account with opening/closing balances, plus the statement period.

export interface StatementAccountRow {
  accountMask: string | null;
  institutionName: string | null;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
}

export interface ExtractedStatement {
  summary: string;
  periodStart: string | null; // YYYY-MM-DD
  periodEnd: string | null;   // YYYY-MM-DD
  accounts: StatementAccountRow[];
}

const STATEMENT_PROMPT = `Extract from this bank statement and return ONLY valid JSON (no markdown fences):
{
  "summary": "1-2 sentence description of the statement",
  "periodStart": "YYYY-MM-DD",
  "periodEnd": "YYYY-MM-DD",
  "accounts": [
    {
      "accountMask": "last 4 digits of the account number only",
      "institutionName": "bank name",
      "openingBalanceCents": 0,
      "closingBalanceCents": 0
    }
  ]
}
Rules:
- All dollar amounts in integer cents (negative = negative balance, e.g. credit cards).
- One entry per account covered by the statement; most statements cover exactly one.
- Return null for unknown fields.
- periodStart/periodEnd are the statement's own period dates (e.g. 2026-08-01 to 2026-08-31).
- Do NOT include full account numbers anywhere.`;

export function parseStatementResponse(text: string): ExtractedStatement {
  const raw = text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  try {
    const parsed = JSON.parse(raw) as Partial<ExtractedStatement>;
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    return {
      summary:
        typeof parsed.summary === "string"
          ? parsed.summary
          : "Bank statement",
      periodStart: typeof parsed.periodStart === "string" ? parsed.periodStart : null,
      periodEnd: typeof parsed.periodEnd === "string" ? parsed.periodEnd : null,
      accounts: accounts.map((a) => ({
        accountMask: typeof a?.accountMask === "string" ? a.accountMask : null,
        institutionName: typeof a?.institutionName === "string" ? a.institutionName : null,
        openingBalanceCents:
          typeof a?.openingBalanceCents === "number" ? Math.round(a.openingBalanceCents) : null,
        closingBalanceCents:
          typeof a?.closingBalanceCents === "number" ? Math.round(a.closingBalanceCents) : null,
      })),
    };
  } catch {
    return { summary: "Could not parse statement extraction.", periodStart: null, periodEnd: null, accounts: [] };
  }
}

export async function extractBankStatement(
  buffer: Buffer,
  mimeType: string
): Promise<ExtractedStatement> {
  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType === "application/pdf";
  if (!isImage && !isPdf) {
    return { summary: "Unsupported file type.", periodStart: null, periodEnd: null, accounts: [] };
  }

  try {
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
      max_tokens: 4096,
      system: STATEMENT_PROMPT,
      messages: [{ role: "user", content: [contentBlock, { type: "text", text: "Extract the data." }] }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    return parseStatementResponse(text);
  } catch (err) {
    console.error("Bank statement extraction failed:", err);
    return { summary: "Extraction failed.", periodStart: null, periodEnd: null, accounts: [] };
  }
}