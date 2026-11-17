"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { maskPhone, normalizeUsMobile } from "@/lib/sms-consent";
import { appendConsentEvent } from "@/lib/sms-consent-store";
import { SMS_NOT_SET_UP_TEXT } from "@/lib/sms-consent-text";
import { describeOptInConfirmation, sendOptInConfirmation } from "@/lib/sms-opt-in-confirmation";

// The signed-in person's own consent to review-queue text messages (twilio-sms-consent). Each call adds at most one row to the
// append-only consent log; nothing is updated or deleted. The user id ALWAYS comes from the session: no export takes a user id,
// so nobody can record or withdraw consent for someone else. The phone number is never logged and never written to AuditLog.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

export type SmsConsentActionResult =
  | { ok: true; status: "on" | "off"; masked: string | null; message: string }
  | { ok: false; error: string };

const saveSchema = z.object({
  phone: z.string().max(32, "That is too long for a phone number."),
  agreed: z.boolean(),
  wordingVersion: z.string().max(40),
});

const PATH = "/settings/notifications";

/** Turn texts on (or change the number): the typed number, the ticked box and the wording version the page showed. */
export async function saveSmsConsent(input: { phone: string; agreed: boolean; wordingVersion: string }): Promise<SmsConsentActionResult> {
  const user = await requireAuth();
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input." };
  const phone = normalizeUsMobile(parsed.data.phone);
  if (!phone.ok) return { ok: false, error: phone.error };
  try {
    const res = await appendConsentEvent(user.id, {
      action: "consent",
      phoneE164: phone.e164,
      agreed: parsed.data.agreed,
      wordingVersion: parsed.data.wordingVersion,
    });
    if (!res.ok) return { ok: false, error: res.code === "table_missing" ? SMS_NOT_SET_UP_TEXT : res.error };
    revalidatePath(PATH);
    // A NEW consent row (first opt-in or a changed number) is confirmed by text; "already on" sends nothing. The confirmation
    // never fails the save: its outcome is only one more sentence in the message.
    const confirmation = res.written ? describeOptInConfirmation(await sendOptInConfirmation(phone.e164)) : null;
    return {
      ok: true,
      status: "on",
      masked: maskPhone(phone.e164),
      message: res.written ? `Texts are on. ${confirmation}` : res.message,
    };
  } catch (e) {
    console.error("[sms-consent] saving consent failed:", e instanceof Error ? e.name : "unknown error");
    return { ok: false, error: "Your text-message setting could not be saved. Try again." };
  }
}

/** Stop texts. Takes nothing from the client: the withdrawn row carries the number whose consent is withdrawn. */
export async function withdrawSmsConsent(): Promise<SmsConsentActionResult> {
  const user = await requireAuth();
  try {
    const res = await appendConsentEvent(user.id, { action: "withdraw" });
    if (!res.ok) return { ok: false, error: res.code === "table_missing" ? SMS_NOT_SET_UP_TEXT : res.error };
    revalidatePath(PATH);
    return { ok: true, status: "off", masked: null, message: res.written ? "Texts are off." : res.message };
  } catch (e) {
    console.error("[sms-consent] withdrawing consent failed:", e instanceof Error ? e.name : "unknown error");
    return { ok: false, error: "Your text-message setting could not be saved. Try again." };
  }
}
