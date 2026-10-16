// Read-only gate and profile loader (plan D5, D6). No writes, explicit selects, fail-soft when the migration is not applied. It never
// selects an encrypted column (those are read only by lib/invoicing/tin-store.ts). No auth of its own: pages call `auth()` first and
// pass the signed-in user id; actions call `requireAuth()` first and then `requireInvoicingEntity`.

import { db } from "@/lib/db";
import { getEntityBySlug } from "@/lib/entity";
import { isInvoicingSlug } from "@/lib/invoicing/entity-gate";
import { InvoicingRefusal, isMissingInvoicingTable } from "@/lib/invoicing/errors";
import { readGlMap, type GlMap } from "@/lib/invoicing/gl-map";
import { resolveInvoicingOwner, type OwnerResolution } from "@/lib/invoicing/owner";
import { toIsoDate } from "@/lib/invoicing/validate";

export interface EntityLite {
  id: string;
  name: string;
  slug: string;
  dbaName: string | null;
}

/** The profile as the pages see it: no encrypted value, dates as ISO strings. */
export interface ProfileView {
  enabled: boolean;
  goLiveOn: string;
  invoicePrefix: string;
  nextInvoiceNumber: number;
  quotePrefix: string;
  nextQuoteNumber: number;
  numberPad: number;
  defaultNetDays: number;
  termsLabel: string;
  businessAddress: string | null;
  replyToEmail: string | null;
  fromName: string | null;
  einLast4: string | null;
  showEinOnInvoice: boolean;
  logoKey: string | null;
  logoMime: string | null;
  footerText: string | null;
  termsText: string | null;
  remitToMailingAddress: string | null;
  checkPayableTo: string | null;
  /** Bank / ACH text is stored (encrypted); the text itself is never in this object. */
  hasRemitBank: boolean;
  remitToUpdatedAt: string | null;
  includeRemitToByDefault: boolean;
  glMap: GlMap | null;
  /** Number, address, GL map set: an invoice can be issued. */
  setupComplete: boolean;
  setupMissing: string[];
}

const PROFILE_SELECT = {
  enabled: true,
  goLiveOn: true,
  invoicePrefix: true,
  nextInvoiceNumber: true,
  quotePrefix: true,
  nextQuoteNumber: true,
  numberPad: true,
  defaultNetDays: true,
  termsLabel: true,
  businessAddress: true,
  replyToEmail: true,
  fromName: true,
  einLast4: true,
  showEinOnInvoice: true,
  logoKey: true,
  logoMime: true,
  footerText: true,
  termsText: true,
  remitToMailingAddress: true,
  checkPayableTo: true,
  remitToUpdatedAt: true,
  includeRemitToByDefault: true,
  glMap: true,
} as const;

export async function loadProfile(entityId: string): Promise<ProfileView | null> {
  const p = await db.invoicingProfile.findUnique({ where: { entityId }, select: PROFILE_SELECT });
  if (!p) return null;
  const glMap = readGlMap(p.glMap);
  const missing: string[] = [];
  if (!glMap) missing.push("the account map");
  if (!p.businessAddress) missing.push("the business address");
  return {
    enabled: p.enabled,
    goLiveOn: toIsoDate(p.goLiveOn),
    invoicePrefix: p.invoicePrefix,
    nextInvoiceNumber: p.nextInvoiceNumber,
    quotePrefix: p.quotePrefix,
    nextQuoteNumber: p.nextQuoteNumber,
    numberPad: p.numberPad,
    defaultNetDays: p.defaultNetDays,
    termsLabel: p.termsLabel,
    businessAddress: p.businessAddress,
    replyToEmail: p.replyToEmail,
    fromName: p.fromName,
    einLast4: p.einLast4,
    showEinOnInvoice: p.showEinOnInvoice,
    logoKey: p.logoKey,
    logoMime: p.logoMime,
    footerText: p.footerText,
    termsText: p.termsText,
    remitToMailingAddress: p.remitToMailingAddress,
    checkPayableTo: p.checkPayableTo,
    hasRemitBank: p.remitToUpdatedAt !== null,
    remitToUpdatedAt: p.remitToUpdatedAt ? toIsoDate(p.remitToUpdatedAt) : null,
    includeRemitToByDefault: p.includeRemitToByDefault,
    glMap,
    setupComplete: p.enabled && missing.length === 0,
    setupMissing: p.enabled ? missing : ["invoicing switched on"],
  };
}

/** The owner rule, fail-closed (a read failure is "not allowed"). */
export async function resolveOwnerFor(userId: string, entityName: string): Promise<OwnerResolution> {
  try {
    const users = await db.user.findMany({ select: { id: true, name: true } });
    return resolveInvoicingOwner(users, entityName, userId);
  } catch (err) {
    console.error("Invoicing owner could not be resolved", err instanceof Error ? err.name : "UnknownError");
    return { allowed: false, ownerName: null, reason: "The owner's account could not be checked just now. Try again shortly." };
  }
}

export type InvoicingContext =
  | { status: "not_allowed" }
  | { status: "not_migrated"; entity: EntityLite }
  | { status: "needs_setup"; entity: EntityLite; owner: OwnerResolution }
  | { status: "ready"; entity: EntityLite; profile: ProfileView; owner: OwnerResolution };

/** What a page needs before it renders anything (the slug allow-list, the profile row, the owner rule). */
export async function loadInvoicingContext(slug: string, userId: string): Promise<InvoicingContext> {
  if (!isInvoicingSlug(slug)) return { status: "not_allowed" };
  const entity = await db.entity.findFirst({ where: { slug, archivedAt: null }, select: { id: true, name: true, slug: true, dbaName: true } });
  if (!entity || !entity.slug) return { status: "not_allowed" };
  const lite: EntityLite = { id: entity.id, name: entity.name, slug: entity.slug, dbaName: entity.dbaName };
  const owner = await resolveOwnerFor(userId, entity.name);
  try {
    const profile = await loadProfile(entity.id);
    if (!profile || !profile.enabled) return { status: "needs_setup", entity: lite, owner };
    return { status: "ready", entity: lite, profile, owner };
  } catch (err) {
    if (isMissingInvoicingTable(err)) return { status: "not_migrated", entity: lite };
    throw err;
  }
}

/** For actions: the allow-listed entity with an enabled profile, or a refusal (404-like, static sentence). */
export async function requireInvoicingEntity(slug: string): Promise<{ entity: EntityLite; profile: ProfileView }> {
  if (!isInvoicingSlug(slug)) throw new InvoicingRefusal("Invoicing is not available for this business.");
  const base = await getEntityBySlug(slug);
  if (!base || !base.slug) throw new InvoicingRefusal("Invoicing is not available for this business.");
  const row = await db.entity.findFirst({ where: { id: base.id, archivedAt: null }, select: { id: true, name: true, slug: true, dbaName: true } });
  if (!row || !row.slug) throw new InvoicingRefusal("Invoicing is not available for this business.");
  const profile = await loadProfile(row.id);
  if (!profile || !profile.enabled) throw new InvoicingRefusal("Invoicing is not set up for this business yet.");
  return { entity: { id: row.id, name: row.name, slug: row.slug, dbaName: row.dbaName }, profile };
}

/** For setup (the profile does not exist yet): only the allow-listed entity is returned. */
export async function requireInvoicingEntityForSetup(slug: string): Promise<EntityLite> {
  if (!isInvoicingSlug(slug)) throw new InvoicingRefusal("Invoicing is not available for this business.");
  const row = await db.entity.findFirst({ where: { slug, archivedAt: null }, select: { id: true, name: true, slug: true, dbaName: true } });
  if (!row || !row.slug) throw new InvoicingRefusal("Invoicing is not available for this business.");
  return { id: row.id, name: row.name, slug: row.slug, dbaName: row.dbaName };
}

/** Owner-only operations: refuse (fail closed) unless the signed-in user is THE owner. */
export async function requireInvoicingOwner(userId: string, entityName: string): Promise<void> {
  const r = await resolveOwnerFor(userId, entityName);
  if (!r.allowed) throw new InvoicingRefusal(r.reason ?? "Only the owner can do this.");
}
