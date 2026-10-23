"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, sessionUser, type ActionError } from "@/lib/invoicing/action-kit";
import { loadGlCodesLite } from "@/lib/invoicing/catalog-build";
import { LOGO_MAX_BYTES, LOGO_MAX_LABEL, LOGO_MIME_TYPES, MAX_ADDRESS, MAX_NAME, MAX_NET_DAYS, MAX_NOTES, MAX_NUMBER_PAD, GL_ROLES } from "@/lib/invoicing/constants";
import { userMessageFor, InvoicingRefusal } from "@/lib/invoicing/errors";
import { PAY_FEATURE_NOT_SET_UP, PUBLIC_TOKEN_TTL_MAX_DAYS, PUBLIC_TOKEN_TTL_MIN_DAYS } from "@/lib/invoicing/constants";
import { loadPaySettings } from "@/lib/invoicing/pay-build";
import { STRIPE_MODE_MISMATCH_MESSAGE, STRIPE_NOT_CONFIGURED_MESSAGE } from "@/lib/invoicing/stripe/preflight";
import { INVOICE_PUBLIC_BASE_URL_INVALID_MESSAGE, payEnvironment } from "@/lib/invoicing/stripe/pay-env";
import { requireInvoicingEntity, requireInvoicingEntityForSetup, requireInvoicingOwner } from "@/lib/invoicing/gate-build";
import { validateGlMap } from "@/lib/invoicing/gl-map";
import { QUOTE_PREFIX_RULE_MESSAGE, isValidDocumentNumber, isValidPrefix, isValidQuotePrefix } from "@/lib/invoicing/numbering";
import * as store from "@/lib/invoicing/store";
import { encryptEinDigits, encryptRemitText, readBusinessEin, readRemitText } from "@/lib/invoicing/tin-store";
import { normalizeEin } from "@/lib/invoicing/tin";
import { cleanEmail, cleanText, parseCalendarDate } from "@/lib/invoicing/validate";
import { uploadLogoFile } from "@/lib/supabase-storage";

// Owner-only setup and settings for invoicing (plan task 1.4). Every export starts with `await requireAuth();` (a test pins it), then
// resolves the entity through the gate (slug allow-list; the profile row for everything except the first setup) and the owner rule
// (fail closed). The owner TYPES the numbers (first invoice number, go-live, terms, footer, addresses) on the screen: nothing is
// baked into code or seeded. AuditLog rows carry ids and counts only (never an address, an EIN, bank text or a name).

async function requireAuth(): Promise<{ id: string; name: string | null }> {
  return sessionUser();
}

type Ok = { success: true };
type Result = Ok | ActionError;

const slugSchema = z.string().min(1).max(60);
const oneLine = (max: number) => z.string().max(max).optional().nullable();

function paths(slug: string) {
  revalidatePath(`/business/${slug}/invoicing/settings`);
  revalidatePath(`/business/${slug}/invoices`);
}

function textOrError(raw: unknown, opts: Parameters<typeof cleanText>[1]): { value: string | null } | ActionError {
  const r = cleanText(raw, opts);
  return r.ok ? { value: r.value } : { error: r.error };
}

const glMapSchema = z.object(Object.fromEntries(GL_ROLES.map((r) => [r, z.string().uuid()])) as Record<(typeof GL_ROLES)[number], z.ZodString>);

const setupSchema = z.object({
  slug: slugSchema,
  goLiveOn: z.string().max(10),
  invoicePrefix: z.string().max(12),
  nextInvoiceNumber: z.number().int(),
  quotePrefix: z.string().max(12),
  nextQuoteNumber: z.number().int(),
  numberPad: z.number().int().min(0).max(MAX_NUMBER_PAD),
  defaultNetDays: z.number().int().min(0).max(MAX_NET_DAYS),
  termsLabel: z.string().min(1).max(60),
  businessAddress: oneLine(MAX_ADDRESS),
  replyToEmail: oneLine(254),
  fromName: oneLine(MAX_NAME),
  footerText: oneLine(MAX_NOTES),
  termsText: oneLine(MAX_NOTES),
  remitToMailingAddress: oneLine(MAX_ADDRESS),
  checkPayableTo: oneLine(MAX_NAME),
  glMap: glMapSchema,
});
export type SetupInvoicingInput = z.input<typeof setupSchema>;

/** First-time setup. The owner enters every value; the GL accounts are checked against the entity's own chart (by id, type and archive state). */
export async function setupInvoicing(input: SetupInvoicingInput): Promise<Result> {
  const user = await requireAuth();
  const parsed = setupSchema.safeParse(input);
  if (!parsed.success) return { error: "Some of the setup values are missing or invalid." };
  const d = parsed.data;
  try {
    const entity = await requireInvoicingEntityForSetup(d.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const goLive = parseCalendarDate(d.goLiveOn);
    if (!goLive) return { error: "The start date must be a real date (YYYY-MM-DD)." };
    if (!isValidPrefix(d.invoicePrefix)) return { error: "The number prefix may only use letters, digits and . _ - / (up to 12 characters)." };
    if (!isValidDocumentNumber(d.nextInvoiceNumber)) return { error: "The first invoice number must be a whole number of 1 or more." };
    if (!isValidQuotePrefix(d.quotePrefix, d.invoicePrefix)) return { error: QUOTE_PREFIX_RULE_MESSAGE };
    if (!isValidDocumentNumber(d.nextQuoteNumber)) return { error: "The first quote number must be a whole number of 1 or more." };
    const address = textOrError(d.businessAddress, { label: "Business address", max: MAX_ADDRESS, multiline: true, required: true });
    if ("error" in address) return address;
    const reply = d.replyToEmail && d.replyToEmail.trim() !== "" ? cleanEmail(d.replyToEmail, "Reply-to e-mail") : null;
    if (reply && !reply.ok) return { error: reply.error };
    const fromName = textOrError(d.fromName, { label: "From name", max: MAX_NAME });
    if ("error" in fromName) return fromName;
    const footer = textOrError(d.footerText, { label: "Footer", max: MAX_NOTES, multiline: true });
    if ("error" in footer) return footer;
    const terms = textOrError(d.termsText, { label: "Terms text", max: MAX_NOTES, multiline: true });
    if ("error" in terms) return terms;
    const termsLabel = textOrError(d.termsLabel, { label: "Payment terms", max: 60, required: true });
    if ("error" in termsLabel) return termsLabel;
    const mailing = textOrError(d.remitToMailingAddress, { label: "Remit-to mailing address", max: MAX_ADDRESS, multiline: true });
    if ("error" in mailing) return mailing;
    const payee = textOrError(d.checkPayableTo, { label: "Check payable to", max: MAX_NAME });
    if ("error" in payee) return payee;

    const codes = await loadGlCodesLite(entity.id);
    const map = validateGlMap(d.glMap, entity.id, codes);
    if (!map.ok) return { error: map.error };

    await store.createProfile(entity.id, {
      goLiveOn: goLive,
      invoicePrefix: d.invoicePrefix,
      nextInvoiceNumber: d.nextInvoiceNumber,
      quotePrefix: d.quotePrefix,
      nextQuoteNumber: d.nextQuoteNumber,
      numberPad: d.numberPad,
      defaultNetDays: d.defaultNetDays,
      termsLabel: termsLabel.value ?? "Due upon receipt",
      glMap: map.map,
      businessAddress: address.value,
      replyToEmail: reply && reply.ok ? reply.value : null,
      fromName: fromName.value,
      footerText: footer.value,
      termsText: terms.value,
      remitToMailingAddress: mailing.value,
      checkPayableTo: payee.value,
    });
    await audit(user.id, "invoicing_setup", { entityId: entity.id });
    paths(d.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const updateSchema = z.object({
  slug: slugSchema,
  invoicePrefix: z.string().max(12),
  numberPad: z.number().int().min(0).max(MAX_NUMBER_PAD),
  defaultNetDays: z.number().int().min(0).max(MAX_NET_DAYS),
  termsLabel: z.string().min(1).max(60),
  businessAddress: oneLine(MAX_ADDRESS),
  replyToEmail: oneLine(254),
  fromName: oneLine(MAX_NAME),
  footerText: oneLine(MAX_NOTES),
  termsText: oneLine(MAX_NOTES),
  showEinOnInvoice: z.boolean(),
  quotePrefix: z.string().max(12),
  nextQuoteNumber: z.number().int(),
  glMap: glMapSchema,
});
export type UpdateInvoicingProfileInput = z.input<typeof updateSchema>;

/** Business block, numbering formats (invoice prefix, quote prefix and the quote counter), terms and the GL map. Counters can only be raised (the invoice counter has its own action). */
export async function updateInvoicingProfile(input: UpdateInvoicingProfileInput): Promise<Result> {
  const user = await requireAuth();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { error: "Some of the values are missing or invalid." };
  const d = parsed.data;
  try {
    const { entity, profile } = await requireInvoicingEntity(d.slug);
    await requireInvoicingOwner(user.id, entity.name);
    if (!isValidPrefix(d.invoicePrefix)) return { error: "A number prefix may only use letters, digits and . _ - / (up to 12 characters)." };
    if (!isValidQuotePrefix(d.quotePrefix, d.invoicePrefix)) return { error: QUOTE_PREFIX_RULE_MESSAGE };
    if (!isValidDocumentNumber(d.nextQuoteNumber)) return { error: "The next quote number must be a whole number of 1 or more." };
    if (d.nextQuoteNumber < profile.nextQuoteNumber) return { error: "The quote counter can only go up." };
    const address = textOrError(d.businessAddress, { label: "Business address", max: MAX_ADDRESS, multiline: true, required: true });
    if ("error" in address) return address;
    const reply = d.replyToEmail && d.replyToEmail.trim() !== "" ? cleanEmail(d.replyToEmail, "Reply-to e-mail") : null;
    if (reply && !reply.ok) return { error: reply.error };
    const fromName = textOrError(d.fromName, { label: "From name", max: MAX_NAME });
    if ("error" in fromName) return fromName;
    const footer = textOrError(d.footerText, { label: "Footer", max: MAX_NOTES, multiline: true });
    if ("error" in footer) return footer;
    const terms = textOrError(d.termsText, { label: "Terms text", max: MAX_NOTES, multiline: true });
    if ("error" in terms) return terms;
    const termsLabel = textOrError(d.termsLabel, { label: "Payment terms", max: 60, required: true });
    if ("error" in termsLabel) return termsLabel;
    const codes = await loadGlCodesLite(entity.id);
    const map = validateGlMap(d.glMap, entity.id, codes);
    if (!map.ok) return { error: map.error };

    // The counter has its own guarded write (row lock, never a number already used) and goes FIRST, so a refused counter saves nothing.
    if (d.nextQuoteNumber > profile.nextQuoteNumber) await store.setQuoteCounter(entity.id, d.nextQuoteNumber);
    await store.updateProfile(entity.id, {
      invoicePrefix: d.invoicePrefix,
      numberPad: d.numberPad,
      defaultNetDays: d.defaultNetDays,
      termsLabel: termsLabel.value ?? "Due upon receipt",
      businessAddress: address.value,
      replyToEmail: reply && reply.ok ? reply.value : null,
      fromName: fromName.value,
      footerText: footer.value,
      termsText: terms.value,
      showEinOnInvoice: d.showEinOnInvoice,
      quotePrefix: d.quotePrefix,
      glMap: map.map,
    });
    await audit(user.id, "invoicing_profile_update", { entityId: entity.id });
    paths(d.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const counterSchema = z.object({ slug: slugSchema, nextInvoiceNumber: z.number().int() });

/** Raises the invoice counter (it can only go up, never to a number already used; numbers are never reused). */
export async function setInvoiceCounterAction(input: z.input<typeof counterSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = counterSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter a whole number." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    await store.setInvoiceCounter(entity.id, parsed.data.nextInvoiceNumber);
    await audit(user.id, "invoicing_counter", { entityId: entity.id, next: parsed.data.nextInvoiceNumber });
    paths(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const mailingSchema = z.object({ slug: slugSchema, remitToMailingAddress: oneLine(MAX_ADDRESS), checkPayableTo: oneLine(MAX_NAME) });

/** The ordinary (non-secret) remit-to: mailing address and check payee. Printed on every invoice whenever set. */
export async function setRemitMailing(input: z.input<typeof mailingSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = mailingSchema.safeParse(input);
  if (!parsed.success) return { error: "Some of the values are invalid." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const mailing = textOrError(parsed.data.remitToMailingAddress, { label: "Remit-to mailing address", max: MAX_ADDRESS, multiline: true });
    if ("error" in mailing) return mailing;
    const payee = textOrError(parsed.data.checkPayableTo, { label: "Check payable to", max: MAX_NAME });
    if ("error" in payee) return payee;
    await store.updateProfile(entity.id, { remitToMailingAddress: mailing.value, checkPayableTo: payee.value });
    await audit(user.id, "invoicing_remit_mailing", { entityId: entity.id });
    paths(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const bankSchema = z.object({ slug: slugSchema, text: z.string().max(1200), includeByDefault: z.boolean() });

// A routing number is nine digits, so the SSN-like check that every other free field uses would refuse it. For THIS field only
// (the owner-approved remit-to exception, 2026-10-15) contiguous digits are allowed; a hyphen / space grouped like an SSN (3-2-4)
// is still refused, and control characters are stripped. The text is stored encrypted and is never logged.
const SSN_GROUPED = /\b\d{3}[-\s.]\d{2}[-\s.]\d{4}\b/;

/**
 * Owner-typed bank / ACH instruction text, stored encrypted. OPTIONAL: it stays empty (and the include option disabled) until the
 * owner supplies it (open question Q15). An empty `text` clears it. It prints on a PDF only for a document that ticks "include
 * bank details".
 */
export async function setRemitBankText(input: z.input<typeof bankSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = bankSchema.safeParse(input);
  if (!parsed.success) return { error: "The bank text is too long (1,200 characters at most)." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const text = parsed.data.text
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .trim();
    if (text === "") {
      await store.setRemitBankEncrypted(entity.id, null, user.id);
      await audit(user.id, "invoicing_remit_bank_cleared", { entityId: entity.id });
    } else {
      if (SSN_GROUPED.test(text)) return { error: "That looks like a Social Security Number. Only bank, routing and payment instructions belong here." };
      // ONE write: the encrypted text, its approval stamp and the include-by-default flag together (never two calls).
      await store.setRemitBankEncrypted(entity.id, encryptRemitText(text), user.id, parsed.data.includeByDefault);
      // The audit row records THAT it changed, never the text.
      await audit(user.id, "invoicing_remit_bank_set", { entityId: entity.id });
    }
    paths(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const revealSchema = z.object({ slug: slugSchema });

/** The owner's explicit reveal of the stored bank text (for the settings form's Replace flow). Id-only audit row. */
export async function revealRemitBankText(input: z.input<typeof revealSchema>): Promise<{ success: true; text: string | null } | ActionError> {
  const user = await requireAuth();
  const parsed = revealSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const text = await readRemitText(entity.id);
    await audit(user.id, "invoicing_remit_bank_reveal", { entityId: entity.id });
    return { success: true, text };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const einSchema = z.object({ slug: slugSchema, ein: z.string().max(20) });

/** Sets (or, with an empty value, clears) the business EIN. Stored encrypted; only the last four are ever shown. */
export async function setBusinessEin(input: z.input<typeof einSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = einSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    if (parsed.data.ein.trim() === "") {
      await store.setBusinessEinEncrypted(entity.id, null, null);
      await store.updateProfile(entity.id, { showEinOnInvoice: false });
      await audit(user.id, "invoicing_ein_cleared", { entityId: entity.id });
    } else {
      const ein = normalizeEin(parsed.data.ein, "EIN");
      if (!ein.ok) return { error: ein.error };
      await store.setBusinessEinEncrypted(entity.id, encryptEinDigits(ein.digits), ein.last4);
      await audit(user.id, "invoicing_ein_set", { entityId: entity.id });
    }
    paths(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

/** The owner's explicit reveal of the business EIN (XX-XXXXXXX). Id-only audit row. */
export async function revealBusinessEin(input: z.input<typeof revealSchema>): Promise<{ success: true; ein: string | null } | ActionError> {
  const user = await requireAuth();
  const parsed = revealSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const ein = await readBusinessEin(entity.id);
    await audit(user.id, "invoicing_ein_reveal", { entityId: entity.id });
    return { success: true, ein };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

/**
 * Uploads the invoice logo (PNG or JPEG, 512 KB at most (LOGO_MAX_BYTES): the only formats pdf-lib can embed). Small enough to travel through the server
 * action, so the two-phase signed-URL pattern is not used. The type is checked by the file's own first bytes, not its name.
 */
export async function uploadInvoiceLogo(formData: FormData): Promise<Result> {
  const user = await requireAuth();
  try {
    const slug = formData.get("slug");
    const file = formData.get("file");
    if (typeof slug !== "string" || !(file instanceof File)) return { error: "Choose a logo file." };
    const { entity } = await requireInvoicingEntity(slug);
    await requireInvoicingOwner(user.id, entity.name);
    if (file.size === 0) return { error: "Choose a logo file." };
    if (file.size > LOGO_MAX_BYTES) return { error: `The logo must be ${LOGO_MAX_LABEL} or smaller.` };
    const bytes = Buffer.from(await file.arrayBuffer());
    const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isPng && !isJpeg) return { error: "The logo must be a PNG or JPEG image." };
    const mime = isPng ? LOGO_MIME_TYPES[0] : LOGO_MIME_TYPES[1];
    const key = `invoicing/${entity.id}/logo-${randomUUID()}.${isPng ? "png" : "jpg"}`;
    try {
      await uploadLogoFile(bytes, key, mime);
    } catch (err) {
      console.error("Invoice logo upload failed", err instanceof Error ? err.name : "UnknownError");
      throw new InvoicingRefusal("The logo could not be uploaded just now. Try again.");
    }
    await store.setLogo(entity.id, key, mime);
    await audit(user.id, "invoicing_logo_set", { entityId: entity.id });
    paths(slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

/** Removes the logo from the profile (the stored file is kept; nothing is deleted from storage). */
export async function removeInvoiceLogo(input: z.input<typeof revealSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = revealSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    await store.setLogo(entity.id, null, null);
    await audit(user.id, "invoicing_logo_removed", { entityId: entity.id });
    paths(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const onlineSchema = z.object({ slug: slugSchema, enabled: z.boolean() });

/**
 * Turns "Online payments" (the Stripe pay link in e-mails, PDFs and on the client's link page) on or off (owner only; default off).
 * Turning it ON is refused unless STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_MODE pass the pre-flight (a key of the same mode)
 * and a usable public address exists (INVOICE_PUBLIC_BASE_URL when set, which must then be valid, else NEXTAUTH_URL; https in live mode).
 * The refusal names the variables, never a value. Turning it OFF is
 * always allowed.
 */
export async function setOnlinePayments(input: z.input<typeof onlineSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = onlineSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const settings = await loadPaySettings(entity.id);
    if (settings.status !== "ok") return { error: PAY_FEATURE_NOT_SET_UP };
    if (parsed.data.enabled) {
      const env = payEnvironment(process.env);
      if (!env.preflight.ok) return { error: env.preflight.category === "mode_mismatch" ? STRIPE_MODE_MISMATCH_MESSAGE : STRIPE_NOT_CONFIGURED_MESSAGE };
      if (!env.baseUrl) {
        if (env.baseUrlProblem === "invoice_public_base_url_invalid") return { error: `Online payments need a usable client link address: ${INVOICE_PUBLIC_BASE_URL_INVALID_MESSAGE}` };
        return { error: env.mode === "live" ? "Online payments need the app's public https address: NEXTAUTH_URL must start with https:// in live mode." : "Online payments need the app's public address: set NEXTAUTH_URL in Vercel." };
      }
    }
    await store.updatePaySettings(entity.id, { stripePayEnabled: parsed.data.enabled });
    await audit(user.id, "invoicing_online_payments", { entityId: entity.id, enabled: parsed.data.enabled });
    paths(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const ttlSchema = z.object({ slug: slugSchema, days: z.number().int() });

/** Sets how long a NEW client link stays valid, in days (7 to 365; owner only). Links already made keep their own expiry. */
export async function setPublicLinkTtl(input: z.input<typeof ttlSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = ttlSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter a whole number of days." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const days = parsed.data.days;
    if (days < PUBLIC_TOKEN_TTL_MIN_DAYS || days > PUBLIC_TOKEN_TTL_MAX_DAYS) return { error: `A link must stay valid between ${PUBLIC_TOKEN_TTL_MIN_DAYS} and ${PUBLIC_TOKEN_TTL_MAX_DAYS} days.` };
    const settings = await loadPaySettings(entity.id);
    if (settings.status !== "ok") return { error: PAY_FEATURE_NOT_SET_UP };
    await store.updatePaySettings(entity.id, { publicTokenTtlDays: days });
    await audit(user.id, "invoicing_link_ttl", { entityId: entity.id, days });
    paths(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}
