// Server-side input validation helper for tools (zod). The error names field paths only, never the values the model sent. PURE.

import { z } from "zod";
import type { Checked } from "@/lib/tax-facts/validate";

export function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): Checked<T> {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const fields = [...new Set(parsed.error.issues.map((i) => (i.path.length > 0 ? i.path.join(".") : "(input)")))].slice(0, 8);
  return { ok: false, error: `Invalid arguments: ${fields.join(", ")}` };
}

/** ISO calendar date string (YYYY-MM-DD) that is a real date. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  });

/** A short free-text filter value (payee, tag, entity, account): control characters rejected, length capped. */
export const shortText = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/);

/** Optional argument that also accepts an explicit null (models sometimes send null for "not set"). */
export const optional = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform((v): z.output<T> | undefined => v ?? undefined);
