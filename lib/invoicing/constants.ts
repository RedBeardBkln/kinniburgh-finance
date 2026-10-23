// Non-tax limits and fixed vocabularies for the invoicing feature (plan 01-plan.md, section 14 task 1.2). PURE, client-safe, no
// imports. There is NO tax number here: invoicing has no tax computation (the `taxable` flag is stored only). Every tax constant of
// the contractor / 1099 phase lives in lib/contractors/constants.ts (not built yet).

// There are NO credit memos (no refunds are ever given): a customer credit is a DEPOSIT, an unapplied payment applied to open invoices.
export const DOCUMENT_KINDS = ["invoice", "quote"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Quote numbers print as Q-2001 (owner decision 2026-10-16). Invoices keep no prefix (first number 3100). The starting numbers are typed by the owner at setup. */
export const DEFAULT_QUOTE_PREFIX = "Q-";

export const BILLING_MODELS = ["general", "hourly", "project", "retainer"] as const;
export type BillingModel = (typeof BILLING_MODELS)[number];

export const PAYMENT_METHODS = ["check", "ach", "wire", "card", "cash", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const CONTACT_ROLES = ["billing", "project_lead", "accounts_payable", "other"] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  billing: "Billing",
  project_lead: "Project lead",
  accounts_payable: "Accounts payable",
  other: "Other",
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  check: "Check",
  ach: "ACH / bank transfer",
  wire: "Wire",
  card: "Card",
  cash: "Cash",
  other: "Other",
};

export const DISCOUNT_KINDS = ["percent", "fixed"] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

export const PRICING_MODES = ["markup", "fixed_price"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

/** The roles of the GL map in InvoicingProfile.glMap and the GL type each role must have (CLAUDE.md: revenue, never "income"). */
export const GL_ROLES = ["ar", "unearned", "discounts", "billableIncome", "processingFees"] as const;
export type GlRole = (typeof GL_ROLES)[number];
export const GL_ROLE_TYPES: Record<GlRole, "asset" | "liability" | "revenue" | "expense"> = {
  ar: "asset",
  unearned: "liability",
  discounts: "revenue", // contra revenue
  billableIncome: "revenue",
  processingFees: "expense",
};
export const GL_ROLE_LABELS: Record<GlRole, string> = {
  ar: "Accounts receivable",
  unearned: "Unearned revenue (deferred)",
  discounts: "Discounts given (contra revenue)",
  billableIncome: "Billable expense income (reimbursables)",
  processingFees: "Payment processing fees",
};
/** Chart-of-accounts names the setup screen PRESELECTS by case-insensitive name match. Never a code number. */
export const GL_ROLE_NAME_HINTS: Record<GlRole, readonly string[]> = {
  ar: ["accounts receivable (a/r)", "accounts receivable"],
  unearned: ["deferred revenue", "unearned revenue", "customer prepayments"],
  discounts: ["refunds to customers", "discounts given", "sales discounts"],
  billableIncome: ["billable expense income"],
  processingFees: ["merchant account fees", "payment processing fees", "bank fees & service charges"],
};
/** Name hint used to preselect the default revenue account for new lines (a hint only; the owner picks). */
export const DEFAULT_SERVICES_GL_NAME_HINT = "services";

// Text limits.
export const MAX_NAME = 120;
export const MAX_LINE_DESCRIPTION = 500;
export const MAX_NOTES = 2000;
export const MAX_SHORT = 200;
export const MAX_ADDRESS = 400;
export const MAX_LINES_PER_DOCUMENT = 200;
export const MAX_ALLOCATIONS_PER_PAYMENT = 100;

// Numbers.
export const MAX_NET_DAYS = 365;
export const MAX_NUMBER_PAD = 12;
export const MAX_DOC_NUMBER = 99_999_999;
/** Largest cent amount a single Int column may hold (Postgres INTEGER). */
export const MAX_CENTS = 2_147_483_647;
/** Largest line quantity (Decimal(12,3) holds up to 999,999,999.999). */
export const MAX_QUANTITY_MILLI = 999_999_999_999;
/** Markup cap in basis points (10,000 = 100 percent; 1,000,000 = 10,000 percent is already absurd). */
export const MAX_MARKUP_BPS = 100_000;

// Logo.
// 512 KB: comfortably below Next's 1 MB default Server Action body limit (the multipart request carries the file plus form overhead),
// so an oversize logo reaches the action and gets the friendly message instead of a framework error.
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_LABEL = "512 KB";
export const LOGO_MIME_TYPES = ["image/png", "image/jpeg"] as const;

// Deposit candidate search window (days either side of the receipt date).
export const DEPOSIT_WINDOW_DAYS = 14;

export const INVOICING_NOT_SET_UP = "Invoicing is not set up yet (the database update that adds it has not been applied).";
/** First setup of a profile on a database without the online-payments migration (P2022 on the INSERT; see lib/invoicing/store.ts). */
export const INVOICING_SETUP_NEEDS_PAY_UPDATE =
  "Invoicing cannot be set up yet (the database update for online payments has not been applied). Nothing was saved.";

// ── Phase 2: online payments (Stripe Checkout) and the client's view link (.claude/pipeline/ek-consulting-stripe-pay-link/01-plan.md) ──

/** Stripe's minimum charge in US cents (https://docs.stripe.com/currencies.md: 0.50 USD). Below it no pay link is offered. */
export const STRIPE_MIN_CHARGE_CENTS = 50;
/** At most this many live (unrevoked, unexpired) client links per invoice; the next one is refused ("Revoke old links first"). */
export const MAX_LIVE_LINKS_PER_INVOICE = 20;
/** Lifetime of a client link in days (InvoicingProfile.publicTokenTtlDays): default 90, the owner may set 7 to 365. */
export const PUBLIC_TOKEN_TTL_DEFAULT_DAYS = 90;
export const PUBLIC_TOKEN_TTL_MIN_DAYS = 7;
export const PUBLIC_TOKEN_TTL_MAX_DAYS = 365;
/** Checkout idempotency time bucket: 10 minutes. Two clicks in the same bucket for the same balance reuse one Checkout Session. */
export const CHECKOUT_BUCKET_MS = 600_000;
/** A Checkout Session expires 2 hours after the start of its bucket (Stripe allows 30 minutes to 24 hours after creation). */
export const CHECKOUT_SESSION_LIFETIME_S = 7_200;

/** Why the webhook flagged a Stripe event for the owner. Flags never reverse anything. */
export const STRIPE_FLAG_REASONS = ["overpayment", "invoice_not_open", "ach_failed", "refunded", "disputed"] as const;
export type StripeFlagReason = (typeof STRIPE_FLAG_REASONS)[number];
export const STRIPE_FLAG_LABELS: Record<StripeFlagReason, string> = {
  overpayment: "Paid more than the balance: the rest is a deposit on account",
  invoice_not_open: "Paid an invoice that was not open: the whole amount is a deposit on account",
  ach_failed: "A bank (ACH) payment failed",
  refunded: "Refunded in Stripe (nothing was reversed here)",
  disputed: "Disputed in Stripe (nothing was reversed here)",
};

export const PAY_FEATURE_NOT_SET_UP = "Online payments are not set up yet (the database update has not been applied).";
/** The one sentence every invalid, revoked, expired or unknown client link shows (no reason is ever leaked). */
export const INVALID_LINK_MESSAGE = "This link is no longer valid. Please contact the sender for a new one.";
