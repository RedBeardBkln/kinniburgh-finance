// Tool: list_insurance. Shaper is PURE and unit-tested; the read is queries/insurance.ts (explicit select; no policy number, notes or Vault).

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { INSURANCE_CAP, loadInsurance, type InsuranceRow } from "@/lib/advisor/queries/insurance";
import { safeDescriptive, safeField } from "@/lib/advisor/scrub";
import { dollarsOf, isoDay } from "@/lib/advisor/tools/format";
import { optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const schema = z.object({ entity: optional(shortText) }).strict();
type Input = z.output<typeof schema>;

export function shapeInsurance(rows: readonly InsuranceRow[]): ToolOutput {
  let premiumCents = 0;
  const shaped = rows.slice(0, INSURANCE_CAP).map((p) => {
    premiumCents += p.monthlyPremiumCents ?? 0;
    const latest = p.cashValueEntries[0] ?? null;
    return {
      insurer: safeDescriptive(p.insurer, 80),
      policy_type: safeField(p.policyType, 20),
      entity: safeField(p.entity.name, 80),
      face_amount: dollarsOf(p.faceAmountCents),
      monthly_premium: dollarsOf(p.monthlyPremiumCents),
      effective: isoDay(p.effectiveDate),
      expires: isoDay(p.expiryDate),
      latest_cash_value: latest === null ? null : dollarsOf(latest.cashValueCents),
      cash_value_as_of: latest === null ? null : isoDay(latest.asOf),
    };
  });
  return {
    data: {
      rows: shaped,
      total_monthly_premiums: dollarsOf(premiumCents),
      notes: ["Policy numbers and the policy documents are not available to the assistant. Cash value is the most recent entry on file, with its date."],
    },
    rows: shaped.length,
    links: [links.documents()],
  };
}

export const listInsuranceTool = defineTool<Input>({
  name: "list_insurance",
  description:
    "Lists the household's insurance policies on file: insurer, type (term, whole, universal life, property, auto, motorcycle, other), entity, face amount, monthly premium, effective and expiry dates, and the latest cash value with its date, plus the total of monthly premiums. Policy numbers and documents are not available. entity (name or slug) is optional. Up to 30 policies.",
  inputJsonSchema: {
    type: "object",
    properties: { entity: { type: "string", description: "Optional. Entity name or slug to restrict to." } },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up insurance",
  summarizeArgs: (i) => `entity=${i.entity === undefined ? "all" : "set"}`,
  run: async (_ctx, i) => shapeInsurance(await loadInsurance(i.entity !== undefined ? { entity: i.entity } : {})),
  maxChars: LIMITS.toolResultChars,
  phase: 2,
});
