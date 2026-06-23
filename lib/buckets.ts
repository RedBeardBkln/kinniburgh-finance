// BucketSlug is now a plain string — nav tabs are database-driven.
// Use getEntityBySlug() from lib/entity.ts for entity lookups.
export type BucketSlug = string;

// Kept for backward compat; prefer getEntityBySlug() in new code.
export const BUCKET_ENTITY_NAMES: Record<string, string | null> = {
  personal: "Personal",
  "sudden-valley": "Sudden Valley Property Management, LLC",
  "ek-consulting": "Eric Kinniburgh Consulting, LLC",
  mezzo: "Mezzo",
  taxes: null,
};

export const BUCKET_DISPLAY_LABELS: Record<string, string> = {
  personal: "Personal",
  "sudden-valley": "Sudden Valley",
  "ek-consulting": "EK Consulting",
  mezzo: "Mezzo",
  taxes: "All Entities",
};
