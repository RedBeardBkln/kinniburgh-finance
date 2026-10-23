"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, sessionUser, type ActionError } from "@/lib/invoicing/action-kit";
import { invoiceLinkUrl, mintInvoiceToken, tokenExpiry } from "@/lib/invoicing/access-token";
import { MAX_LIVE_LINKS_PER_INVOICE, PAY_FEATURE_NOT_SET_UP } from "@/lib/invoicing/constants";
import { userMessageFor } from "@/lib/invoicing/errors";
import { requireInvoicingEntity, requireInvoicingOwner } from "@/lib/invoicing/gate-build";
import { loadPaySettings } from "@/lib/invoicing/pay-build";
import * as store from "@/lib/invoicing/store";
import { INVOICE_PUBLIC_BASE_URL_INVALID_MESSAGE, payEnvironment } from "@/lib/invoicing/stripe/pay-env";

// The owner's client-link management on an invoice (Phase 2, plan P1 / S4). Every export starts with `await requireAuth();` (a test pins it)
// and is OWNER-ONLY (fail closed): Eva and any other signed-in non-owner see the links card read-only. A new link is shown to the owner
// ONCE (the action returns its URL; only the token's sha256 hash is stored, so it can never be shown again). Links can be made for any
// issued invoice, also while "Online payments" is off (the page then offers the invoice and its PDF only). AuditLog rows carry ids and
// counts only (never a token, a hash or a URL).

async function requireAuth(): Promise<{ id: string; name: string | null }> {
  return sessionUser();
}

const NO_BASE_URL = "The app's public address (NEXTAUTH_URL) is not set in Vercel, so a client link cannot be made.";

const createSchema = z.object({ slug: z.string().min(1).max(60), documentId: z.string().uuid(), requestKey: z.string().uuid() });
const revokeSchema = z.object({ slug: z.string().min(1).max(60), documentId: z.string().uuid() });

function pages(slug: string, documentId: string) {
  revalidatePath(`/business/${slug}/invoices/${documentId}`);
}

type LinkResult = { success: true; url: string } | ActionError;

/**
 * Mints a link for an issued invoice; `replace` revokes every live link of the invoice first, in the same transaction. Called only by
 * the exports below, AFTER their entity gate and owner rule.
 */
async function mintOwnerLink(user: { id: string }, entity: { id: string }, input: z.infer<typeof createSchema>, replace: boolean): Promise<LinkResult> {
  const settings = await loadPaySettings(entity.id);
  if (settings.status !== "ok") return { error: PAY_FEATURE_NOT_SET_UP };
  const env = payEnvironment(process.env);
  if (!env.baseUrl) return { error: env.baseUrlProblem === "invoice_public_base_url_invalid" ? INVOICE_PUBLIC_BASE_URL_INVALID_MESSAGE : NO_BASE_URL };
  const now = new Date();
  const { token, tokenHash } = mintInvoiceToken();
  const r = await store.mintAccessToken({
    entityId: entity.id,
    documentId: input.documentId,
    tokenHash,
    mintKey: `manual:${input.documentId}:${input.requestKey}`,
    purpose: "manual",
    expiresAt: tokenExpiry(now, settings.publicTokenTtlDays),
    createdById: user.id,
    now,
    maxLive: MAX_LIVE_LINKS_PER_INVOICE,
    revokeExisting: replace,
  });
  if (r.revokedCount > 0) await audit(user.id, "invoicing_paylink_revoke", { entityId: entity.id, documentId: input.documentId, count: r.revokedCount });
  await audit(user.id, "invoicing_paylink_create", { entityId: entity.id, documentId: input.documentId, tokenId: r.tokenId });
  pages(input.slug, input.documentId);
  return { success: true, url: invoiceLinkUrl(env.baseUrl, token) };
}

/** Creates a client link (owner only). The URL is returned ONCE for the owner to copy; it is never stored or shown again. */
export async function createPayLink(input: z.input<typeof createSchema>): Promise<LinkResult> {
  const user = await requireAuth();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    return await mintOwnerLink(user, entity, parsed.data, false);
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

/** Revokes every live client link of the invoice (owner only). Links already sent stop working at once. */
export async function revokePayLinks(input: z.input<typeof revokeSchema>): Promise<{ success: true; count: number } | ActionError> {
  const user = await requireAuth();
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const settings = await loadPaySettings(entity.id);
    if (settings.status !== "ok") return { error: PAY_FEATURE_NOT_SET_UP };
    const count = await store.revokeAccessTokens({ entityId: entity.id, documentId: parsed.data.documentId, userId: user.id, now: new Date() });
    await audit(user.id, "invoicing_paylink_revoke", { entityId: entity.id, documentId: parsed.data.documentId, count });
    pages(parsed.data.slug, parsed.data.documentId);
    return { success: true, count };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

/** Replaces the client links of the invoice: revokes every live one and creates a new one, in one transaction (owner only). */
export async function replacePayLink(input: z.input<typeof createSchema>): Promise<LinkResult> {
  const user = await requireAuth();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    return await mintOwnerLink(user, entity, parsed.data, true);
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}
