// Read-only loaders of the online-payment feature (Phase 2: the client's view link, Stripe payments, flags, payouts). No writes, explicit
// selects, no auth of its own (pages call `auth()`, owner actions `requireAuth()`; the public page and its actions check the TOKEN through
// `resolvePublicAccess`, the webhook checks the Stripe signature first).
//
// Fail-soft (plan P10): the Phase-2 tables and columns are read ONLY here (never by PROFILE_SELECT or any Phase-1 select). When the
// migration is not applied yet (a missing table P2021 / 42P01 or a missing column P2022 / 42703) a loader answers "not_set_up" and no
// pay link is offered or mintable, while every Phase-1 page keeps working.
//
// Tokens: a raw token is shape-checked and hashed before any query; only the hash is looked up. Nothing here logs a token or a hash.

import { db } from "@/lib/db";
import { evaluateInvoiceToken, hashInvoiceToken, isLiveToken, isPlausibleInvoiceToken } from "@/lib/invoicing/access-token";
import { decimalToCents } from "@/lib/invoicing/cents";
import { DEPOSIT_WINDOW_DAYS } from "@/lib/invoicing/constants";
import { scorePayoutDeposits, type DepositCandidate } from "@/lib/invoicing/deposit-match";
import { isInvoicingSlug } from "@/lib/invoicing/entity-gate";
import { isMissingInvoicingTable, isMissingPayFeature } from "@/lib/invoicing/errors";
import { openStripeFlags, type OpenStripeFlag } from "@/lib/invoicing/stripe/flags";
import type { StripeInvoiceRef, StripePaymentRef, UnmatchedReason } from "@/lib/invoicing/stripe/apply-event";
import { isUuid, toIsoDate } from "@/lib/invoicing/validate";

const notSetUp = (err: unknown) => isMissingPayFeature(err) || isMissingInvoicingTable(err);

// ── Settings ──────────────────────────────────────────────────────────────────────

export type PaySettings = { status: "ok"; stripePayEnabled: boolean; publicTokenTtlDays: number } | { status: "not_set_up" };

export async function loadPaySettings(entityId: string): Promise<PaySettings> {
  try {
    const p = await db.invoicingProfile.findUnique({ where: { entityId }, select: { stripePayEnabled: true, publicTokenTtlDays: true } });
    if (!p) return { status: "not_set_up" };
    // A row read through a client that predates the columns has neither field: treat it as "not set up", never as "on".
    if (typeof p.stripePayEnabled !== "boolean" || typeof p.publicTokenTtlDays !== "number") return { status: "not_set_up" };
    return { status: "ok", stripePayEnabled: p.stripePayEnabled, publicTokenTtlDays: p.publicTokenTtlDays };
  } catch (err) {
    if (notSetUp(err)) return { status: "not_set_up" };
    throw err;
  }
}

// ── The client's link ─────────────────────────────────────────────────────────────

export type PublicAccess = { ok: true; tokenId: string; entityId: string; documentId: string; status: "issued" | "void" } | { ok: false };

/**
 * Validates a client link token on THIS request. Every invalid case (implausible shape, unknown, revoked, expired, not an invoice,
 * a draft or archived document, another entity, invoicing disabled, the Phase-2 tables missing) is the same `{ ok: false }`.
 * The invoice is derived only from the token's own row.
 */
export async function resolvePublicAccess(token: unknown, now: Date): Promise<PublicAccess> {
  if (!isPlausibleInvoiceToken(token)) return { ok: false };
  try {
    const row = await db.billingAccessToken.findUnique({
      where: { tokenHash: hashInvoiceToken(token) },
      select: { id: true, entityId: true, documentId: true, expiresAt: true, revokedAt: true },
    });
    if (!evaluateInvoiceToken(row, now).valid || !row) return { ok: false };
    const doc = await db.billingDocument.findFirst({
      where: { id: row.documentId, entityId: row.entityId, kind: "invoice", archivedAt: null },
      select: { status: true, entity: { select: { slug: true, archivedAt: true } } },
    });
    if (!doc || (doc.status !== "issued" && doc.status !== "void")) return { ok: false };
    if (!isInvoicingSlug(doc.entity.slug) || doc.entity.archivedAt) return { ok: false };
    const profile = await db.invoicingProfile.findUnique({ where: { entityId: row.entityId }, select: { enabled: true } });
    if (!profile || !profile.enabled) return { ok: false };
    return { ok: true, tokenId: row.id, entityId: row.entityId, documentId: row.documentId, status: doc.status };
  } catch (err) {
    if (notSetUp(err)) return { ok: false };
    throw err;
  }
}

export interface LinkView {
  id: string;
  purpose: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  live: boolean;
}

export type InvoiceLinks = { status: "ok"; links: LinkView[]; liveCount: number } | { status: "not_set_up" };

/** The links of one invoice for the owner's "Client link" card (never a token or a hash). */
export async function loadInvoiceLinks(entityId: string, documentId: string, now: Date): Promise<InvoiceLinks> {
  try {
    const rows = await db.billingAccessToken.findMany({
      where: { entityId, documentId },
      select: { id: true, purpose: true, createdAt: true, expiresAt: true, revokedAt: true, firstViewedAt: true, lastViewedAt: true, viewCount: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const links = rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
      firstViewedAt: r.firstViewedAt ? r.firstViewedAt.toISOString() : null,
      lastViewedAt: r.lastViewedAt ? r.lastViewedAt.toISOString() : null,
      viewCount: r.viewCount,
      live: isLiveToken(r, now),
    }));
    return { status: "ok", links, liveCount: links.filter((l) => l.live).length };
  } catch (err) {
    if (notSetUp(err)) return { status: "not_set_up" };
    throw err;
  }
}

// ── Flags and the online-payments overview ────────────────────────────────────────

const FLAG_KINDS = ["stripe_flag", "stripe_flag_reviewed"];

export interface FlagView extends OpenStripeFlag {
  invoiceNumber: string | null;
}

async function flagRows(where: { entityId: string; documentId?: string }) {
  const rows = await db.billingEvent.findMany({
    where: { ...where, kind: { in: FLAG_KINDS } },
    select: { id: true, kind: true, documentId: true, paymentId: true, createdAt: true, data: true },
    // Newest first so that past the cap the OLDEST rows drop, never a new flag; a "reviewed" row is always newer than its flag, so
    // a kept flag keeps its review. `openStripeFlags` re-sorts oldest-first for display.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 2000,
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    documentId: r.documentId,
    paymentId: r.paymentId,
    createdAt: r.createdAt.toISOString(),
    data: (typeof r.data === "object" && r.data !== null && !Array.isArray(r.data) ? r.data : {}) as Record<string, string | number | boolean | null>,
  }));
}

async function withNumbers(entityId: string, flags: OpenStripeFlag[]): Promise<FlagView[]> {
  const ids = [...new Set(flags.map((f) => f.documentId).filter((x): x is string => x !== null))];
  const docs = ids.length ? await db.billingDocument.findMany({ where: { id: { in: ids }, entityId }, select: { id: true, displayNumber: true } }) : [];
  const num = new Map(docs.map((d) => [d.id, d.displayNumber]));
  return flags.map((f) => ({ ...f, invoiceNumber: f.documentId ? (num.get(f.documentId) ?? null) : null }));
}

/** Open flags of one invoice (the "Needs your review" box on the invoice page). */
export async function loadInvoiceStripeFlags(entityId: string, documentId: string): Promise<FlagView[]> {
  try {
    return await withNumbers(entityId, openStripeFlags(await flagRows({ entityId, documentId })));
  } catch (err) {
    if (notSetUp(err)) return [];
    throw err;
  }
}

export interface StripePaymentView {
  id: string;
  receivedOn: string;
  amountCents: number;
  feeCents: number;
  feeKnown: boolean;
  method: string;
  clientName: string;
  invoiceNumbers: string[];
  depositLinked: boolean;
}

export interface UnmatchedEventView {
  id: string;
  type: string;
  outcome: string;
  receivedAt: string;
}

export type OnlinePaymentsOverview =
  | { status: "ok"; flags: FlagView[]; feeUnknown: StripePaymentView[]; awaitingDeposit: StripePaymentView[]; unmatched: UnmatchedEventView[] }
  | { status: "not_set_up" };

const UNMATCHED_REASONS: UnmatchedReason[] = ["metadata", "reference", "invoice", "entity", "currency", "amount", "payment_intent", "status", "payment"];
const UNMATCHED_OUTCOMES = [...UNMATCHED_REASONS.map((r) => `unmatched_${r}`), "unsupported_format"];

export async function loadOnlinePaymentsOverview(entityId: string): Promise<OnlinePaymentsOverview> {
  try {
    const flags = await withNumbers(entityId, openStripeFlags(await flagRows({ entityId })));
    const pays = await db.billingPayment.findMany({
      where: { entityId, source: "stripe", status: "recorded" },
      select: {
        id: true,
        receivedOn: true,
        amountCents: true,
        feeCents: true,
        method: true,
        stripeFeeStatus: true,
        depositTransactionId: true,
        client: { select: { name: true } },
        allocations: { where: { voidedAt: null }, select: { invoice: { select: { displayNumber: true } } } },
      },
      orderBy: { receivedOn: "desc" },
      take: 500,
    });
    const views: StripePaymentView[] = pays.map((p) => ({
      id: p.id,
      receivedOn: toIsoDate(p.receivedOn),
      amountCents: p.amountCents,
      feeCents: p.feeCents,
      feeKnown: p.stripeFeeStatus === "known",
      method: p.method,
      clientName: p.client.name,
      invoiceNumbers: p.allocations.map((a) => a.invoice.displayNumber).filter((x): x is string => x !== null),
      depositLinked: p.depositTransactionId !== null,
    }));
    const unmatchedRows = await db.stripeEvent.findMany({
      where: { outcome: { in: UNMATCHED_OUTCOMES } },
      select: { id: true, type: true, outcome: true, receivedAt: true },
      orderBy: { receivedAt: "desc" },
      take: 200,
    });
    return {
      status: "ok",
      flags,
      feeUnknown: views.filter((v) => !v.feeKnown),
      awaitingDeposit: views.filter((v) => v.feeKnown && !v.depositLinked),
      unmatched: unmatchedRows.map((r) => ({ id: r.id, type: r.type, outcome: r.outcome, receivedAt: r.receivedAt.toISOString() })),
    };
  } catch (err) {
    if (notSetUp(err)) return { status: "not_set_up" };
    throw err;
  }
}

/** The PaymentIntent of a Stripe payment whose fee is still unknown (for "Fetch fee"). */
export async function loadStripePaymentForFee(entityId: string, paymentId: string): Promise<{ paymentIntentId: string; feeKnown: boolean; depositLinked: boolean } | null> {
  const p = await db.billingPayment.findFirst({
    where: { id: paymentId, entityId, source: "stripe", status: "recorded" },
    select: { stripePaymentIntentId: true, stripeFeeStatus: true, depositTransactionId: true },
  });
  if (!p || !p.stripePaymentIntentId) return null;
  return { paymentIntentId: p.stripePaymentIntentId, feeKnown: p.stripeFeeStatus === "known", depositLinked: p.depositTransactionId !== null };
}

// ── Payouts (one bank deposit for several Stripe payments) ────────────────────────

export interface PayoutCandidateView {
  transactionId: string;
  postedAt: string;
  amountCents: number;
  text: string;
  remainingCents: number;
  score: number;
  reasons: string[];
}

/**
 * Bank deposits that could be the payout of the chosen Stripe payments (sum of their nets after the fee), best match first. Only posted,
 * positive, live, non-transfer rows of the entity within the window after the payments. The owner always confirms.
 */
export async function loadPayoutCandidates(entityId: string, paymentIds: string[]): Promise<{ netCents: number; candidates: PayoutCandidateView[] } | null> {
  const ids = [...new Set(paymentIds)].filter(isUuid);
  if (ids.length === 0) return null;
  const pays = await db.billingPayment.findMany({
    where: { id: { in: ids }, entityId, status: "recorded", depositTransactionId: null },
    select: { id: true, amountCents: true, feeCents: true, receivedOn: true },
  });
  if (pays.length !== ids.length) return null;
  const netCents = pays.reduce((s, p) => s + p.amountCents - p.feeCents, 0);
  const earliest = Math.min(...pays.map((p) => p.receivedOn.getTime()));
  const latest = Math.max(...pays.map((p) => p.receivedOn.getTime()));
  const from = new Date(earliest);
  const to = new Date(latest + DEPOSIT_WINDOW_DAYS * 86_400_000);
  const rows = await db.transaction.findMany({
    where: { entityId, archivedAt: null, transferPairId: null, pending: false, amount: { gt: 0 }, postedAt: { gte: from, lte: to } },
    select: { id: true, postedAt: true, amount: true, payeeRaw: true, description: true },
    orderBy: { postedAt: "desc" },
    take: 200,
  });
  if (rows.length === 0) return { netCents, candidates: [] };
  const linked = await db.billingPayment.findMany({
    where: { depositTransactionId: { in: rows.map((r) => r.id) }, status: "recorded" },
    select: { depositTransactionId: true, amountCents: true, feeCents: true },
  });
  const linkedNet = new Map<string, number>();
  for (const l of linked) if (l.depositTransactionId) linkedNet.set(l.depositTransactionId, (linkedNet.get(l.depositTransactionId) ?? 0) + l.amountCents - l.feeCents);
  const candidates: DepositCandidate[] = rows.map((r) => ({
    transactionId: r.id,
    postedAt: r.postedAt,
    amountCents: decimalToCents(r.amount),
    text: `${r.payeeRaw ?? ""} ${r.description ?? ""}`.trim(),
    alreadyLinkedNetCents: linkedNet.get(r.id) ?? 0,
  }));
  const byId = new Map(candidates.map((c) => [c.transactionId, c]));
  const scored = scorePayoutDeposits(netCents, new Date(latest), candidates);
  return {
    netCents,
    candidates: scored.slice(0, 15).map((s) => {
      const c = byId.get(s.transactionId)!;
      return { transactionId: c.transactionId, postedAt: toIsoDate(c.postedAt), amountCents: c.amountCents, text: c.text.slice(0, 80), remainingCents: s.remainingCents, score: s.score, reasons: s.reasons };
    }),
  };
}

// ── Webhook lookups (called only AFTER the signature was verified) ────────────────

/** True when this Stripe event id was already decided (a replay). */
export async function loadStripeEventSeen(eventId: string): Promise<boolean> {
  return (await db.stripeEvent.findUnique({ where: { id: eventId }, select: { id: true } })) !== null;
}

/** Our invoice named by a session's metadata, with the facts the webhook decision checks. Null when the id is not ours. */
export async function loadInvoiceForStripe(invoiceId: string): Promise<StripeInvoiceRef | null> {
  if (!isUuid(invoiceId)) return null;
  const d = await db.billingDocument.findFirst({
    where: { id: invoiceId, archivedAt: null },
    select: { id: true, entityId: true, kind: true, status: true, clientId: true, entity: { select: { slug: true } } },
  });
  if (!d) return null;
  const profile = await db.invoicingProfile.findUnique({ where: { entityId: d.entityId }, select: { enabled: true } });
  return { id: d.id, entityId: d.entityId, kind: d.kind, status: d.status, clientId: d.clientId, allowListed: isInvoicingSlug(d.entity.slug), profileEnabled: Boolean(profile?.enabled) };
}

/** A recorded Stripe payment by its PaymentIntent id (refund / dispute events), with the invoices it is applied to. */
export async function loadStripePaymentByIntent(paymentIntentId: string): Promise<StripePaymentRef | null> {
  const p = await db.billingPayment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true, entityId: true, allocations: { where: { voidedAt: null }, select: { invoiceId: true } } },
  });
  if (!p) return null;
  return { id: p.id, entityId: p.entityId, invoiceIds: p.allocations.map((a) => a.invoiceId) };
}
