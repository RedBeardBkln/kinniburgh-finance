// DB-aware store for the append-only SMS consent log (twilio-sms-consent). The ONLY file that touches the SmsConsentEvent table
// (a source-reading test pins it). Not a "use server" module and no auth of its own: callers (the settings page, the
// requireAuth()-gated actions in actions/sms-consent.ts, and the review-text recipient resolver) own authorization and always
// pass the user id from the session or the batch, never from a client.
//
// INSERT-ONLY: the only writes are one `create` of a consent event and one `create` of an AuditLog row, in one transaction.
// Nothing here updates, upserts or deletes a consent row. The AuditLog row holds the event id, kind, seq and wording version
// only: never the phone number.
//
// Two readers with opposite failure modes, on purpose:
//  - `loadSmsConsentState` is for DISPLAY and is fail-soft (a missing table or any error becomes a state, never a throw).
//  - `readSendableNumber` is for the SENDER and is fail-closed (anything but a current, valid consent is a fixed error, so the
//    caller records a visible failed send).
// Nothing here logs a phone number; only an error's name is logged.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  consentAuditPayload,
  foldConsentState,
  normalizeUsMobile,
  planConsentEvent,
  type ConsentEventRow,
  type ConsentRequest,
  type FoldedConsentState,
  type SmsConsentKind,
} from "@/lib/sms-consent";

export function isMissingTable(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2021";
}

export const SMS_TABLE_MISSING_ERROR =
  "Text messages are not set up yet (the database update for text consent has not been applied).";
export const SMS_NO_CONSENT_ERROR =
  "The assignee has not agreed to text messages (or has turned them off) in Settings > Notifications, so no text was sent.";
export const SMS_CONSENT_READ_ERROR = "Text-message consent could not be checked, so no text was sent.";
export const SMS_CONSENT_CONFLICT_ERROR = "This changed in another tab. Refresh and try again.";

const ROW_SELECT = {
  seq: true,
  kind: true,
  phoneE164: true,
  wordingVersion: true,
  wordingSha256: true,
  createdAt: true,
} as const;

type Reader = { smsConsentEvent: { findMany: typeof db.smsConsentEvent.findMany } };

async function readRows(client: Reader, userId: string): Promise<ConsentEventRow[]> {
  return client.smsConsentEvent.findMany({ where: { userId }, orderBy: { seq: "asc" }, select: ROW_SELECT });
}

function logName(tag: string, e: unknown): void {
  console.error(tag, e instanceof Error ? e.name : "unknown error");
}

export type SmsConsentLoad = { state: "ok"; consent: FoldedConsentState } | { state: "table_missing" } | { state: "error" };

/** For display. Never throws. */
export async function loadSmsConsentState(userId: string): Promise<SmsConsentLoad> {
  try {
    return { state: "ok", consent: foldConsentState(await readRows(db, userId)) };
  } catch (e) {
    if (isMissingTable(e)) return { state: "table_missing" };
    logName("sms consent state could not be loaded:", e);
    return { state: "error" };
  }
}

export type SendableNumber = { ok: true; phoneE164: string } | { ok: false; error: string };

/** For the sender: the user's number only when their CURRENT consent is on and the stored number is valid. Never throws. */
export async function readSendableNumber(userId: string): Promise<SendableNumber> {
  let state: FoldedConsentState;
  try {
    state = foldConsentState(await readRows(db, userId));
  } catch (e) {
    if (isMissingTable(e)) return { ok: false, error: SMS_TABLE_MISSING_ERROR };
    logName("sms consent could not be read for a send:", e);
    return { ok: false, error: SMS_CONSENT_READ_ERROR };
  }
  if (state.status !== "on") return { ok: false, error: SMS_NO_CONSENT_ERROR };
  const checked = normalizeUsMobile(state.phoneE164);
  if (!checked.ok || checked.e164 !== state.phoneE164) return { ok: false, error: SMS_NO_CONSENT_ERROR };
  return { ok: true, phoneE164: checked.e164 };
}

export type AppendConsentResult =
  | { ok: true; written: true; kind: SmsConsentKind; seq: number }
  | { ok: true; written: false; message: string }
  | { ok: false; error: string; code?: "conflict" | "table_missing" | "refused" };

/**
 * One transaction: read the user's events, re-plan the request against them, insert the event, audit it. A second tab racing
 * for the same seq hits the unique (userId, seq) index (P2002) and gets a conflict result; nothing is written.
 */
export async function appendConsentEvent(userId: string, request: ConsentRequest): Promise<AppendConsentResult> {
  try {
    return await db.$transaction(async (tx): Promise<AppendConsentResult> => {
      const rows = await readRows(tx, userId);
      const plan = planConsentEvent(foldConsentState(rows), request);
      if (plan.kind === "refused") return { ok: false, code: "refused", error: plan.error };
      if (plan.kind === "noop") return { ok: true, written: false, message: plan.message };
      const seq = rows.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
      const created = await tx.smsConsentEvent.create({
        data: {
          userId,
          seq,
          kind: plan.row.kind,
          phoneE164: plan.row.phoneE164,
          wordingVersion: plan.row.wordingVersion,
          wordingSha256: plan.row.wordingSha256,
          method: plan.row.method,
        },
        select: { id: true, seq: true },
      });
      await tx.auditLog.create({
        data: {
          changedBy: userId,
          changeType: plan.row.kind === "consented" ? "sms_consent" : "sms_consent_withdrawn",
          before: Prisma.JsonNull,
          after: consentAuditPayload({
            id: created.id,
            kind: plan.row.kind,
            seq: created.seq,
            wordingVersion: plan.row.wordingVersion,
          }) satisfies Prisma.InputJsonValue,
        },
      });
      return { ok: true, written: true, kind: plan.row.kind, seq: created.seq };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, code: "conflict", error: SMS_CONSENT_CONFLICT_ERROR };
    }
    if (isMissingTable(e)) return { ok: false, code: "table_missing", error: SMS_TABLE_MISSING_ERROR };
    throw e;
  }
}
