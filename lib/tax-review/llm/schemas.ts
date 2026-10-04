// Output schemas of the AI review passes (ai-return-reviewer, B3): the zod schemas the response is validated against and the plain
// JSON schemas sent as output_config.format (structured output) so the model is constrained to the same shape.
//
// The outer object is strict (an unexpected top-level key fails the task); each finding is parsed on its own, so one malformed
// finding is rejected with a reason class instead of throwing away the whole answer. Unknown keys INSIDE a finding are stripped:
// a model that adds `status: "accepted"` or any gate field changes nothing (the gate is code, and nothing here reads such a key).
//
// PURE.

import { z } from "zod";
import { FINDING_AREAS, SEVERITIES, SOURCE_KINDS } from "@/lib/tax-review/types";

export const SCHEMA_VERSION = 1;

export const MAX_FINDINGS_PER_TASK = 20;

export const modelEvidenceSchema = z.object({ ref: z.string().min(1).max(120), amount: z.number().int().nullable() });
export const modelSourceSchema = z.object({ kind: z.enum(SOURCE_KINDS), id: z.string().min(1).max(120), quote: z.string().max(700).nullable() });

/** One finding as the model writes it. `category` is checked against the task's list by the validator (unknown -> "other"). */
export const modelFindingSchema = z.object({
  category: z.string().min(1).max(40),
  severity: z.enum(SEVERITIES),
  area: z.enum(FINDING_AREAS),
  form: z.string().max(40).nullable(),
  lineKey: z.string().max(80).nullable(),
  message: z.string().min(10).max(900),
  evidence: z.array(modelEvidenceSchema).max(12),
  sources: z.array(modelSourceSchema).max(4),
  legalClaim: z.boolean(),
  recommendedAction: z.string().min(5).max(500),
});
export type ModelFinding = z.infer<typeof modelFindingSchema>;

/** Output of a finding task: findings are validated one by one afterwards. */
export const findingsOutputSchema = z.object({ findings: z.array(z.unknown()).max(60) }).strict();
export type FindingsOutput = z.infer<typeof findingsOutputSchema>;

export const modelChallengeSchema = z.object({ findingKey: z.string().regex(/^[0-9a-f]{16}$/), note: z.string().min(5).max(400) });
export type ModelChallenge = z.infer<typeof modelChallengeSchema>;

/** Output of the adversarial pass: new findings plus challenges against earlier findings (annotation only). */
export const adversarialOutputSchema = z.object({ findings: z.array(z.unknown()).max(60), challenges: z.array(z.unknown()).max(60) }).strict();
export type AdversarialOutput = z.infer<typeof adversarialOutputSchema>;

export const modelNarrationSchema = z.object({
  id: z.string().min(1).max(120),
  recommendedPosition: z.string().min(5).max(500),
  alternative: z.string().max(400).nullable(),
  rationale: z.string().max(500).nullable(),
  sources: z.array(modelSourceSchema).max(3),
});
export type ModelNarration = z.infer<typeof modelNarrationSchema>;

export const registerOutputSchema = z.object({ entries: z.array(z.unknown()).max(80) }).strict();
export type RegisterOutput = z.infer<typeof registerOutputSchema>;

// ── JSON schemas for output_config.format ─────────────────────────────────────

type JsonSchema = Record<string, unknown>;

const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: "null" }] });

function findingJsonSchema(categories: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      category: { type: "string", enum: [...categories] },
      severity: { type: "string", enum: [...SEVERITIES] },
      area: { type: "string", enum: [...FINDING_AREAS] },
      form: nullable({ type: "string" }),
      lineKey: nullable({ type: "string" }),
      message: { type: "string" },
      evidence: { type: "array", items: { type: "object", properties: { ref: { type: "string" }, amount: nullable({ type: "integer" }) }, required: ["ref", "amount"], additionalProperties: false } },
      sources: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: [...SOURCE_KINDS] }, id: { type: "string" }, quote: nullable({ type: "string" }) }, required: ["kind", "id", "quote"], additionalProperties: false } },
      legalClaim: { type: "boolean" },
      recommendedAction: { type: "string" },
    },
    required: ["category", "severity", "area", "form", "lineKey", "message", "evidence", "sources", "legalClaim", "recommendedAction"],
    additionalProperties: false,
  };
}

export function findingsJsonSchema(categories: readonly string[]): JsonSchema {
  return { type: "object", properties: { findings: { type: "array", items: findingJsonSchema(categories) } }, required: ["findings"], additionalProperties: false };
}

export function adversarialJsonSchema(categories: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      findings: { type: "array", items: findingJsonSchema(categories) },
      challenges: { type: "array", items: { type: "object", properties: { findingKey: { type: "string" }, note: { type: "string" } }, required: ["findingKey", "note"], additionalProperties: false } },
    },
    required: ["findings", "challenges"],
    additionalProperties: false,
  };
}

export function registerJsonSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            recommendedPosition: { type: "string" },
            alternative: nullable({ type: "string" }),
            rationale: nullable({ type: "string" }),
            sources: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: [...SOURCE_KINDS] }, id: { type: "string" }, quote: nullable({ type: "string" }) }, required: ["kind", "id", "quote"], additionalProperties: false } },
          },
          required: ["id", "recommendedPosition", "alternative", "rationale", "sources"],
          additionalProperties: false,
        },
      },
    },
    required: ["entries"],
    additionalProperties: false,
  };
}
