"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { validateMemoryDraft, type MemoryNoteView } from "@/lib/advisor/memory";
import { firstNameOf } from "@/lib/advisor/names";
import { getPerson } from "@/lib/advisor/queries/people";
import * as store from "@/lib/advisor/store";
import type { ConversationSummary, StoredMessage } from "@/lib/advisor/store";
import { cleanUserTitle } from "@/lib/advisor/titles";

// Server actions of the Advisor page: conversation list / resume / rename / archive (private to the signed-in user: the user id is in the
// `where` of every conversation query) and the household memory notes (shared; attribution stored). Every export starts with
// `const user = await requireAuth();`. Nothing here is a tax-return input; AuditLog rows carry ids only.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

const idSchema = z.string().uuid();

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function listMyConversations(): Promise<ConversationSummary[]> {
  const user = await requireAuth();
  return store.listConversations(user.id);
}

export async function getMyConversation(id: string): Promise<{ conversation: ConversationSummary; messages: StoredMessage[] } | null> {
  const user = await requireAuth();
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return null;
  const conversation = await store.getOwnConversation(user.id, parsed.data);
  if (conversation === null) return null;
  return { conversation, messages: await store.loadMessages(user.id, parsed.data) };
}

export async function renameConversation(id: string, title: string): Promise<ActionResult> {
  const user = await requireAuth();
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: "Conversation not found." };
  const clean = cleanUserTitle(typeof title === "string" ? title : "");
  if (clean === null) return { ok: false, error: "Type a title." };
  const done = await store.renameConversation(user.id, parsed.data, clean);
  if (!done) return { ok: false, error: "Conversation not found." };
  revalidatePath("/advisor");
  return { ok: true };
}

export async function archiveConversation(id: string): Promise<ActionResult> {
  const user = await requireAuth();
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: "Conversation not found." };
  const done = await store.archiveConversation(user.id, parsed.data);
  if (!done) return { ok: false, error: "Conversation not found." };
  revalidatePath("/advisor");
  return { ok: true };
}

export async function listMemoryNotes(): Promise<MemoryNoteView[]> {
  await requireAuth();
  return store.listActiveMemory();
}

export async function addMemoryNote(text: string, category: string): Promise<ActionResult> {
  const user = await requireAuth();
  const checked = validateMemoryDraft(typeof text === "string" ? text : "", typeof category === "string" ? category : "");
  if (!checked.ok) return { ok: false, error: checked.error };
  const person = await getPerson(user.id);
  const res = await store.addMemoryNote(checked.value, { id: user.id, firstName: firstNameOf(person?.name) }, "panel");
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/advisor");
  return { ok: true };
}

/**
 * Saves a memory note the assistant SUGGESTED, after the person clicked Save on it. The model-facing tool (propose_memory_note) never writes;
 * this is the only caller of addMemoryNote with source "assistant". The text is validated and scrubbed again here (the client's copy is never
 * trusted), the 50-note cap applies, and the author recorded is the person who clicked. The `source` is a display label only.
 */
export async function confirmMemorySuggestion(text: string, category: string): Promise<ActionResult> {
  const user = await requireAuth();
  const checked = validateMemoryDraft(typeof text === "string" ? text : "", typeof category === "string" ? category : "");
  if (!checked.ok) return { ok: false, error: checked.error };
  const person = await getPerson(user.id);
  const res = await store.addMemoryNote(checked.value, { id: user.id, firstName: firstNameOf(person?.name) }, "assistant");
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/advisor");
  return { ok: true };
}

export async function forgetMemoryNote(id: string): Promise<ActionResult> {
  const user = await requireAuth();
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: "Note not found." };
  const person = await getPerson(user.id);
  const done = await store.forgetMemoryNote(parsed.data, { id: user.id, firstName: firstNameOf(person?.name) });
  if (!done) return { ok: false, error: "Note not found." };
  revalidatePath("/advisor");
  return { ok: true };
}
