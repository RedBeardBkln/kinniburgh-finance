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

/**
 * Maps a pathname to the equivalent pathname within another entity bucket.
 *
 * Bucket-scoped pages exist for every bucket (dashboard, transactions, budgets,
 * forecast, accounts, receipts, envelope (personal/sudden-valley/taxes only)).
 * Business-only pages are re-routed to the other bucket's dashboard.
 * Personal-only pages are re-routed to the personal equivalent, or the
 * dashboard if the current bucket doesn't support it (e.g. Envelopes).
 */
const BUCKET_BASES = ["/", "/transactions", "/budgets", "/forecast", "/accounts", "/receipts", "/envelope"];
const PERSONAL_TO_BUSINESS: Record<string, string> = {
  "/personal/income": "/business/{slug}/revenue",
  "/personal/debt-free": "/personal/debt-free",
};

export function bucketPathFor(pathname: string, targetBucket: string): string {
  // Business entity sub-pages: swap the slug
  const businessMatch = /^\/business\/([^/]+)(\/.*)?$/.exec(pathname);
  if (businessMatch && businessMatch[2]) {
    return targetBucket === "personal"
      ? "/"
      : `/business/${targetBucket}${businessMatch[2]}`;
  }

  // Personal-only pages under a business/tax bucket
  if (pathname.startsWith("/personal/")) {
    if (targetBucket === "personal") return pathname;
    const mapped = PERSONAL_TO_BUSINESS[pathname];
    if (mapped && mapped.includes("{slug}")) return mapped.replace("{slug}", targetBucket);
    if (mapped) return mapped;
    return "/";
  }

  if (pathname.startsWith("/tax") || pathname.startsWith("/projects")) {
    return pathname; // aggregate views, not bucket-scoped
  }

  // Bucket-scoped core pages (including detail routes beneath them)
  const base = BUCKET_BASES.find(
    (b) => b !== "/" && (pathname === b || pathname.startsWith(b + "/"))
  );
  if (base) {
    if (base === "/envelope" && !["personal", "sudden-valley", "taxes"].includes(targetBucket)) {
      return "/";
    }
    return pathname;
  }

  return "/";
}
