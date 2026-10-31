"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, sessionUser, todayNY, type ActionError } from "@/lib/invoicing/action-kit";
import { BenchtopError, fetchBenchtopClients, fetchBenchtopEntries, looksLikeBenchtopKey } from "@/lib/invoicing/benchtop/client";
import { syncInvoiceTime } from "@/lib/invoicing/benchtop/sync";
import { documentTimeEntryIds, parseHourlyRate, pendingTimeSync, type BenchtopEntry } from "@/lib/invoicing/benchtop/time-lines";
import { loadTimeEntriesInUse } from "@/lib/invoicing/benchtop-build";
import { loadClient } from "@/lib/invoicing/clients-build";
import { loadInvoiceDetail } from "@/lib/invoicing/documents-build";
import { InvoicingRefusal, userMessageFor } from "@/lib/invoicing/errors";
import { requireInvoicingEntity, requireInvoicingOwner } from "@/lib/invoicing/gate-build";
import * as store from "@/lib/invoicing/store";
import { encryptBenchtopKey, readBenchtopKey } from "@/lib/invoicing/tin-store";

// Benchtop time import (CLAUDE.md "Benchtop time import"): the owner's Benchtop connection key, linking a client to its Benchtop
// client with a default hourly rate, reading a client's unbilled Benchtop time into an invoice draft, and retrying the billed /
// unbilled update for an issued or void invoice. Every export starts with `await requireAuth();` and is owner-only (Eva and any other
// non-owner are read-only in invoicing; guard and Eva tests pin both). The key never leaves the server except to Benchtop.

async function requireAuth(): Promise<{ id: string; name: string | null }> {
  return sessionUser();
}

const slugSchema = z.string().min(1).max(60);
const uuid = z.string().uuid();

/** Benchtop's own failures are fixed sentences; anything else goes through the usual mapping. */
const messageFor = (err: unknown) => (err instanceof BenchtopError ? err.message : userMessageFor(err));

async function requireKey(entityId: string): Promise<string> {
  const key = await readBenchtopKey(entityId);
  if (!key) throw new InvoicingRefusal("Benchtop is not connected. Save a Benchtop connection key in Invoicing settings first.");
  return key;
}

const keySchema = z.object({ slug: slugSchema, key: z.string().max(200) });

/** Saves the Benchtop connection key after checking Benchtop accepts it; an empty key disconnects. */
export async function saveBenchtopKey(input: z.input<typeof keySchema>): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = keySchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const key = parsed.data.key.trim();
    if (key === "") {
      await store.setBenchtopKeyEncrypted(entity.id, null, null);
      await audit(user.id, "invoicing_benchtop_disconnected", { entityId: entity.id });
    } else {
      if (!looksLikeBenchtopKey(key)) return { error: "That is not a Benchtop connection key (it starts with btk_). Copy it again from Benchtop: Settings > Invoicing connection." };
      await fetchBenchtopClients(key); // refuses a key Benchtop does not accept, before anything is stored
      await store.setBenchtopKeyEncrypted(entity.id, encryptBenchtopKey(key), key.slice(-4));
      await audit(user.id, "invoicing_benchtop_connected", { entityId: entity.id });
    }
    revalidatePath(`/business/${parsed.data.slug}/invoicing/settings`);
    return { success: true };
  } catch (err) {
    return { error: messageFor(err) };
  }
}

/** The Benchtop clients the connected login logs time against, for linking. */
export async function listBenchtopClients(input: { slug: string }): Promise<{ success: true; clients: { id: string; name: string }[] } | ActionError> {
  const user = await requireAuth();
  const parsed = z.object({ slug: slugSchema }).safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    return { success: true, clients: await fetchBenchtopClients(await requireKey(entity.id)) };
  } catch (err) {
    return { error: messageFor(err) };
  }
}

const linkSchema = z.object({ slug: slugSchema, clientId: uuid, benchtopClientId: uuid.nullable(), hourlyRate: z.string().max(20) });

/** Links a client to its Benchtop client (null unlinks) and sets its default hourly rate (blank clears it). */
export async function linkClientToBenchtop(input: z.input<typeof linkSchema>): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  const { slug, clientId, benchtopClientId } = parsed.data;
  try {
    const { entity } = await requireInvoicingEntity(slug);
    await requireInvoicingOwner(user.id, entity.name);
    const rateText = parsed.data.hourlyRate.trim();
    const hourlyRateCents = rateText === "" ? null : parseHourlyRate(rateText);
    if (rateText !== "" && hourlyRateCents === null) return { error: "Enter the hourly rate in dollars, for example 175 or 175.50." };
    await store.setClientBenchtop(entity.id, clientId, { benchtopClientId: benchtopClientId?.toLowerCase() ?? null, hourlyRateCents });
    await audit(user.id, "invoicing_client_benchtop_link", { entityId: entity.id, clientId, linked: benchtopClientId !== null, rateCents: hourlyRateCents });
    revalidatePath(`/business/${slug}/clients/${clientId}`);
    return { success: true };
  } catch (err) {
    return { error: messageFor(err) };
  }
}

const timeSchema = z.object({
  slug: slugSchema,
  clientId: uuid,
  documentId: uuid.nullable(),
  from: z.string().datetime({ offset: true }).nullable(),
  to: z.string().datetime({ offset: true }).nullable(),
});

export type ImportableEntry = BenchtopEntry & { inUse: string | null };
type BenchtopTimeResult = { success: true; entries: ImportableEntry[]; truncated: boolean; rateCents: number | null } | ActionError;

/**
 * The client's finished, unbilled Benchtop time (started within from/to when given), each marked with the invoice it is already on
 * (another draft or an issued invoice), plus the client's default hourly rate. Reads only; the editor adds the chosen time as lines.
 */
export async function fetchBenchtopTime(input: z.input<typeof timeSchema>): Promise<BenchtopTimeResult> {
  const user = await requireAuth();
  const parsed = timeSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  const { slug, clientId, documentId, from, to } = parsed.data;
  try {
    const { entity } = await requireInvoicingEntity(slug);
    await requireInvoicingOwner(user.id, entity.name);
    const client = await loadClient(entity.id, clientId);
    if (!client) return { error: "That client was not found or is archived." };
    if (!client.benchtopClientId) return { error: "This client is not linked to a Benchtop client yet. Link it on the client's page." };
    const key = await requireKey(entity.id);
    const { entries, truncated } = await fetchBenchtopEntries(key, client.benchtopClientId, { from: from ?? undefined, to: to ?? undefined });
    const inUse = await loadTimeEntriesInUse(entity.id, entries.map((e) => e.id), documentId);
    return { success: true, entries: entries.map((e) => ({ ...e, inUse: inUse.get(e.id) ?? null })), truncated, rateCents: client.hourlyRateCents };
  } catch (err) {
    return { error: messageFor(err) };
  }
}

const syncSchema = z.object({ slug: slugSchema, documentId: uuid });

/** Tries again to mark an issued invoice's Benchtop time billed (or a void invoice's unbilled). */
export async function syncBenchtopTime(input: z.input<typeof syncSchema>): Promise<{ success: true; note: string | null } | ActionError> {
  const user = await requireAuth();
  const parsed = syncSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  const { slug, documentId } = parsed.data;
  try {
    const { entity } = await requireInvoicingEntity(slug);
    await requireInvoicingOwner(user.id, entity.name);
    const detail = await loadInvoiceDetail(entity.id, documentId, todayNY());
    if (!detail || !detail.displayNumber) return { error: "That invoice was not found." };
    const entryIds = documentTimeEntryIds(detail.lines);
    const pending = pendingTimeSync(detail.status, entryIds.length, detail.events);
    if (!pending) return { success: true, note: null };
    const r = await syncInvoiceTime({ entityId: entity.id, userId: user.id, documentId, direction: pending.direction, invoiceRef: detail.displayNumber, entryIds });
    revalidatePath(`/business/${slug}/invoices/${documentId}`);
    return r.ok ? { success: true, note: r.note } : { error: r.error };
  } catch (err) {
    return { error: messageFor(err) };
  }
}
