export const BUCKETS = [
  { slug: "personal", label: "Personal" },
  { slug: "sudden-valley", label: "Sudden Valley" },
  { slug: "ek-consulting", label: "EK Consulting" },
  { slug: "mezzo", label: "Mezzo" },
  { slug: "taxes", label: "Taxes" },
] as const;

export type BucketSlug = (typeof BUCKETS)[number]["slug"];

// null = aggregate view (all entities) — used by the Taxes tab
export const BUCKET_ENTITY_NAMES: Record<BucketSlug, string | null> = {
  personal: "Personal",
  "sudden-valley": "Sudden Valley Property Management, LLC",
  "ek-consulting": "Eric Kinniburgh Consulting, LLC",
  mezzo: "Mezzo",
  taxes: null,
};

// Short label for display in page headings
export const BUCKET_DISPLAY_LABELS: Record<BucketSlug, string> = {
  personal: "Personal",
  "sudden-valley": "Sudden Valley",
  "ek-consulting": "EK Consulting",
  mezzo: "Mezzo",
  taxes: "All Entities",
};
