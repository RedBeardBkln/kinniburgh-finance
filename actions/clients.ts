"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, sessionUser, type ActionError } from "@/lib/invoicing/action-kit";
import { CONTACT_ROLES, MAX_ADDRESS, MAX_NAME, MAX_NET_DAYS, MAX_NOTES } from "@/lib/invoicing/constants";
import { userMessageFor } from "@/lib/invoicing/errors";
import { requireInvoicingEntity, requireInvoicingOwner } from "@/lib/invoicing/gate-build";
import * as store from "@/lib/invoicing/store";
import { encryptEinDigits, revealClientEin as readClientEin } from "@/lib/invoicing/tin-store";
import { normalizeEin } from "@/lib/invoicing/tin";
import { cleanEmail, cleanText, isUuid, parseCalendarDate } from "@/lib/invoicing/validate";

// Clients, contacts, client EIN and the W-9 link (plan task 1.5). Every export starts with `await requireAuth();` (a test pins it) and
// then resolves the entity through the gate and the owner rule. EVERY export is owner-only (fail closed; owner decision 2026-10-16: Eva and any other
// signed-in non-owner has read-only access); a guard test pins the owner gate on every export.
// A client EIN is stored encrypted (lib/encrypt.ts through tin-store.ts) with only the last four shown; it is never logged and the
// AuditLog rows carry ids only. Archive-only: nothing is deleted. "W-9 on file" means a linked, non-archived Document of docType w9.

async function requireAuth(): Promise<{ id: string; name: string | null }> {
  return sessionUser();
}

type Result = { success: true } | ActionError;
const slugSchema = z.string().min(1).max(60);
const opt = (max: number) => z.string().max(max).optional().nullable();

function refresh(slug: string, clientId?: string) {
  revalidatePath(`/business/${slug}/clients`);
  if (clientId) revalidatePath(`/business/${slug}/clients/${clientId}`);
}

const clientSchema = z.object({
  slug: slugSchema,
  name: z.string().max(MAX_NAME + 40),
  addressLine1: opt(MAX_ADDRESS),
  addressLine2: opt(MAX_ADDRESS),
  city: opt(80),
  state: opt(40),
  postalCode: opt(20),
  country: opt(60),
  defaultNetDays: z.number().int().min(0).max(MAX_NET_DAYS).nullable().optional(),
  defaultTaxable: z.boolean().optional(),
  notes: opt(MAX_NOTES),
});
export type ClientInput = z.input<typeof clientSchema>;

function cleanClient(d: z.infer<typeof clientSchema>): { data: store.ClientData } | ActionError {
  const name = cleanText(d.name, { label: "Client name", max: MAX_NAME, required: true });
  if (!name.ok) return { error: name.error };
  const l1 = cleanText(d.addressLine1, { label: "Address line 1", max: MAX_ADDRESS });
  if (!l1.ok) return { error: l1.error };
  const l2 = cleanText(d.addressLine2, { label: "Address line 2", max: MAX_ADDRESS });
  if (!l2.ok) return { error: l2.error };
  const city = cleanText(d.city, { label: "City", max: 80 });
  if (!city.ok) return { error: city.error };
  const state = cleanText(d.state, { label: "State", max: 40 });
  if (!state.ok) return { error: state.error };
  const zip = cleanText(d.postalCode, { label: "Postal code", max: 20 });
  if (!zip.ok) return { error: zip.error };
  const country = cleanText(d.country, { label: "Country", max: 60 });
  if (!country.ok) return { error: country.error };
  const notes = cleanText(d.notes, { label: "Notes", max: MAX_NOTES, multiline: true, noAccountNumbers: true });
  if (!notes.ok) return { error: notes.error };
  return {
    data: {
      name: name.value ?? "",
      addressLine1: l1.value,
      addressLine2: l2.value,
      city: city.value,
      state: state.value,
      postalCode: zip.value,
      country: country.value ?? "US",
      defaultNetDays: d.defaultNetDays ?? null,
      defaultTaxable: d.defaultTaxable === true,
      notes: notes.value,
    },
  };
}

export async function createClient(input: ClientInput): Promise<{ success: true; id: string } | ActionError> {
  const user = await requireAuth();
  const parsed = clientSchema.safeParse(input);
  if (!parsed.success) return { error: "Some of the client details are invalid." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const c = cleanClient(parsed.data);
    if ("error" in c) return c;
    const id = await store.createClient(entity.id, user.id, c.data);
    await audit(user.id, "invoicing_client_create", { entityId: entity.id, clientId: id });
    refresh(parsed.data.slug);
    return { success: true, id };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

export async function updateClient(input: ClientInput & { id: string }): Promise<Result> {
  const user = await requireAuth();
  const parsed = clientSchema.extend({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { error: "Some of the client details are invalid." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const c = cleanClient(parsed.data);
    if ("error" in c) return c;
    await store.updateClient(entity.id, parsed.data.id, c.data);
    await audit(user.id, "invoicing_client_update", { entityId: entity.id, clientId: parsed.data.id });
    refresh(parsed.data.slug, parsed.data.id);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const idSchema = z.object({ slug: slugSchema, id: z.string().uuid() });

/** Archives a client (it leaves the lists and pickers; its invoices and payments stay). Nothing is deleted. */
export async function archiveClient(input: z.input<typeof idSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    await store.archiveClient(entity.id, parsed.data.id);
    await audit(user.id, "invoicing_client_archive", { entityId: entity.id, clientId: parsed.data.id });
    refresh(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const contactSchema = z.object({
  slug: slugSchema,
  clientId: z.string().uuid(),
  name: z.string().max(MAX_NAME + 40),
  email: z.string().max(300),
  phone: opt(40),
  role: z.enum(CONTACT_ROLES),
  roleLabel: opt(60),
  receivesInvoices: z.boolean(),
});
export type ContactInput = z.input<typeof contactSchema>;

function cleanContact(d: z.infer<typeof contactSchema>): { data: store.ContactData } | ActionError {
  const name = cleanText(d.name, { label: "Contact name", max: MAX_NAME, required: true });
  if (!name.ok) return { error: name.error };
  const email = cleanEmail(d.email, "Contact e-mail");
  if (!email.ok) return { error: email.error };
  const phone = cleanText(d.phone, { label: "Phone", max: 40, noAccountNumbers: true });
  if (!phone.ok) return { error: phone.error };
  const label = cleanText(d.roleLabel, { label: "Role label", max: 60 });
  if (!label.ok) return { error: label.error };
  if (d.role === "other" && !label.value) return { error: "Describe the role when you choose Other." };
  return {
    data: {
      name: name.value ?? "",
      email: email.value,
      phone: phone.value,
      role: d.role,
      roleLabel: d.role === "other" ? label.value : null,
      receivesInvoices: d.receivesInvoices,
    },
  };
}

export async function addContact(input: ContactInput): Promise<Result> {
  const user = await requireAuth();
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return { error: "Some of the contact details are invalid." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const c = cleanContact(parsed.data);
    if ("error" in c) return c;
    const id = await store.addContact(entity.id, parsed.data.clientId, c.data);
    await audit(user.id, "invoicing_contact_add", { entityId: entity.id, clientId: parsed.data.clientId, contactId: id });
    refresh(parsed.data.slug, parsed.data.clientId);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

export async function updateContact(input: ContactInput & { contactId: string }): Promise<Result> {
  const user = await requireAuth();
  const parsed = contactSchema.extend({ contactId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { error: "Some of the contact details are invalid." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const c = cleanContact(parsed.data);
    if ("error" in c) return c;
    await store.updateContact(entity.id, parsed.data.contactId, c.data);
    await audit(user.id, "invoicing_contact_update", { entityId: entity.id, contactId: parsed.data.contactId });
    refresh(parsed.data.slug, parsed.data.clientId);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

export async function archiveContact(input: { slug: string; clientId: string; contactId: string }): Promise<Result> {
  const user = await requireAuth();
  const parsed = z.object({ slug: slugSchema, clientId: z.string().uuid(), contactId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    await store.archiveContact(entity.id, parsed.data.contactId);
    await audit(user.id, "invoicing_contact_archive", { entityId: entity.id, contactId: parsed.data.contactId });
    refresh(parsed.data.slug, parsed.data.clientId);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const einSchema = z.object({ slug: slugSchema, id: z.string().uuid(), ein: z.string().max(20) });

/** Sets (or, with an empty value, clears) a client's EIN. Encrypted; only the last four are shown. OWNER ONLY. */
export async function setClientEin(input: z.input<typeof einSchema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = einSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    // Owner-only, fail closed, like revealClientEin: a stored TIN feeds the 1099 side later, so Eva (who may draft) cannot overwrite or clear it.
    await requireInvoicingOwner(user.id, entity.name);
    if (parsed.data.ein.trim() === "") {
      await store.setClientEinEncrypted(entity.id, parsed.data.id, null, null);
      await audit(user.id, "invoicing_client_ein_cleared", { entityId: entity.id, clientId: parsed.data.id });
    } else {
      const ein = normalizeEin(parsed.data.ein, "EIN");
      if (!ein.ok) return { error: ein.error };
      await store.setClientEinEncrypted(entity.id, parsed.data.id, encryptEinDigits(ein.digits), ein.last4);
      await audit(user.id, "invoicing_client_ein_set", { entityId: entity.id, clientId: parsed.data.id });
    }
    refresh(parsed.data.slug, parsed.data.id);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

/** The owner's explicit reveal of a client's EIN (XX-XXXXXXX). Id-only audit row. */
export async function revealClientEin(input: { slug: string; id: string }): Promise<{ success: true; ein: string | null } | ActionError> {
  const user = await requireAuth();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const ein = await readClientEin(entity.id, parsed.data.id);
    await audit(user.id, "invoicing_client_ein_reveal", { entityId: entity.id, clientId: parsed.data.id });
    return { success: true, ein };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const w9Schema = z.object({ slug: slugSchema, clientId: z.string().uuid(), documentId: z.string().uuid().nullable(), receivedOn: z.string().max(10).nullable().optional() });

/**
 * Links an uploaded W-9 (a Document of docType w9 in this business's vault) to the client, or unlinks it (documentId null). "On file"
 * is true exactly when the linked document exists and is not archived; a date alone never counts.
 */
export async function linkClientW9(input: z.input<typeof w9Schema>): Promise<Result> {
  const user = await requireAuth();
  const parsed = w9Schema.safeParse(input);
  if (!parsed.success || (parsed.data.documentId !== null && !isUuid(parsed.data.documentId))) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    let received: Date | null = null;
    if (parsed.data.documentId && parsed.data.receivedOn) {
      received = parseCalendarDate(parsed.data.receivedOn);
      if (!received) return { error: "The received date must be a real date (YYYY-MM-DD)." };
    }
    await store.setClientW9(entity.id, parsed.data.clientId, parsed.data.documentId, received);
    await audit(user.id, parsed.data.documentId ? "invoicing_client_w9_link" : "invoicing_client_w9_unlink", {
      entityId: entity.id,
      clientId: parsed.data.clientId,
      documentId: parsed.data.documentId,
    });
    refresh(parsed.data.slug, parsed.data.clientId);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}
