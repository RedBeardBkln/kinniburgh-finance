export const BUCKETS = [
  { slug: "personal", label: "Personal" },
  { slug: "sudden-valley", label: "Sudden Valley" },
  { slug: "ek-consulting", label: "EK Consulting" },
  { slug: "mezzo", label: "Mezzo" },
] as const;

export type BucketSlug = (typeof BUCKETS)[number]["slug"];

export const BUCKET_ENTITY_NAMES: Record<BucketSlug, string> = {
  personal: "Personal",
  "sudden-valley": "Sudden Valley Property Management, LLC",
  "ek-consulting": "Eric Kinniburgh Consulting, LLC",
  mezzo: "Mezzo",
};
