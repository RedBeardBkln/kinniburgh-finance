// Memory note categories (client-safe: no imports). Validation and the injected block live in memory.ts.

export const MEMORY_CATEGORIES = ["preference", "household", "tax_context", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export const MEMORY_CATEGORY_LABELS: Readonly<Record<MemoryCategory, string>> = {
  preference: "Preference",
  household: "Household",
  tax_context: "Tax context",
  other: "Other",
};

export function isMemoryCategory(v: unknown): v is MemoryCategory {
  return typeof v === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(v);
}
