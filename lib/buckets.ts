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
 * Infers the active nav bucket from a pathname alone (ignoring the `?bucket=`
 * query param), for the aggregate views (Taxes/Projects) and business
 * sub-pages whose bucket is baked into the URL. Returns null when the
 * pathname doesn't imply a bucket (callers should fall back to `?bucket=`).
 *
 * This hard-locks any `/tax*`/`/projects*` pathname to "taxes"/"projects"
 * regardless of `?bucket=` — that's intentional, so the Taxes/Projects tab
 * stays highlighted (and their dedicated sidebar stays shown) no matter which
 * entity's workspace is being viewed underneath.
 */
export function inferBucketFromPathname(pathname: string): string | null {
  if (pathname.startsWith("/tax")) return "taxes";
  if (pathname.startsWith("/projects")) return "projects";
  if (pathname.startsWith("/business/")) {
    const slug = pathname.split("/")[2];
    return slug ?? null;
  }
  return null;
}

/**
 * Maps a pathname to the equivalent pathname within another entity bucket.
 *
 * Bucket-scoped pages exist for every bucket (dashboard, transactions, budgets,
 * forecast, accounts, receipts, envelope (personal/sudden-valley/taxes only)).
 * Business-only pages are re-routed to the other bucket's dashboard.
 * Personal-only pages are re-routed to the personal equivalent, or the
 * dashboard if the current bucket doesn't support it (e.g. Envelopes).
 * Switching *to* Taxes/Projects lands on their overview page (or stays put if
 * already there); switching *away* from them has no per-entity equivalent, so
 * it falls through to the target bucket's dashboard.
 */
const BUCKET_BASES = ["/", "/transactions", "/budgets", "/forecast", "/accounts", "/receipts", "/envelope"];
const PERSONAL_TO_BUSINESS: Record<string, string> = {
  "/personal/income": "/business/{slug}/revenue",
  "/personal/debt-free": "/personal/debt-free",
};

export function bucketPathFor(pathname: string, targetBucket: string): string {
  // Switching to an aggregate view: land on its overview, or stay put if
  // already there. Checked first so it takes priority over the business
  // slug-swap below (which would otherwise try to build "/business/taxes/...").
  if (targetBucket === "taxes") {
    return pathname.startsWith("/tax") ? pathname : "/tax";
  }
  if (targetBucket === "projects") {
    return pathname.startsWith("/projects") ? pathname : "/projects";
  }

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

  // Aggregate views (Taxes/Projects) have no bucket-scoped equivalent —
  // fall through to the target bucket's dashboard.
  if (pathname.startsWith("/tax") || pathname.startsWith("/projects")) {
    return "/";
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
