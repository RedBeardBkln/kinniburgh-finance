// Pure rules for turning a donation_receipt document's reading into a donation-log
// entry (donation-receipt-document-type). No DB, no "use server": shared by the
// loaders, the server actions and the client panels. Client-safe.
//
// What this module NEVER does: create a donation, compute a deductible or
// reduced amount, or value non-cash property. It reads the receipt's EFFECTIVE
// values (the owner's corrections win; a corrected null clears the AI value),
// builds an editable PREFILL for the donation form, and reports advisory flags.
//
// Wording about what a written acknowledgment contains follows IRS,
// "Charitable contributions - written acknowledgments" (read 2026-10-03): for a
// gift of $250 or more it normally includes the organization's name, the cash
// amount or a DESCRIPTION (not a value) of non-cash property, and either a
// statement that no goods or services were provided or a description and
// good-faith estimate of their value (or a statement that they were entirely
// intangible religious benefits). The app stays advisory ("normally", "your CPA
// decides") and computes nothing from it.

import type { DonationFlagLevel } from "@/lib/donation-substantiation";
import type { DonationConflict, DonationKind, DonationSubstantiation } from "@/lib/donations";
import { countCorrections } from "@/lib/extraction-corrections";
import { isUsableExtraction } from "@/lib/document-extraction-state";
import { resolveTaxDocForCompute, type TaxExtractionPolicy } from "@/lib/tax-extraction-policy";
import { centsToDollarsInput, formatCentsDisplay } from "@/lib/tax-extraction-schema";
import { formatDateEt, parseIsoDateNoonUtc } from "@/lib/tax-log-dates";

export const IRS_ACK_SOURCE = "IRS, Charitable contributions - written acknowledgments";

// ── Reading ───────────────────────────────────────────────────────────────────

export interface DonationReceiptReading {
  organizationName: string | null;
  organizationEIN: string | null;
  giftDate: string | null;
  cashAmountCents: number | null;
  nonCashDescription: string | null;
  coversMultipleGifts: boolean | null;
  readsAsWrittenAcknowledgment: boolean | null;
  noGoodsOrServicesStated: boolean | null;
  benefitStatement: string | null;
}

export const EMPTY_RECEIPT_READING: DonationReceiptReading = {
  organizationName: null,
  organizationEIN: null,
  giftDate: null,
  cashAmountCents: null,
  nonCashDescription: null,
  coversMultipleGifts: null,
  readsAsWrittenAcknowledgment: null,
  noGoodsOrServicesStated: null,
  benefitStatement: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * Typed view of the nine receipt fields from an EFFECTIVE `data` object.
 * Defensive: anything of the wrong type becomes null, never a guess.
 */
export function readDonationReceipt(effectiveData: unknown): DonationReceiptReading {
  if (!isRecord(effectiveData)) return { ...EMPTY_RECEIPT_READING };
  const cents = effectiveData.cashAmountCents;
  return {
    organizationName: textOrNull(effectiveData.organizationName),
    organizationEIN: textOrNull(effectiveData.organizationEIN),
    giftDate: textOrNull(effectiveData.giftDate),
    cashAmountCents: typeof cents === "number" && Number.isSafeInteger(cents) && cents >= 0 ? cents : null,
    nonCashDescription: textOrNull(effectiveData.nonCashDescription),
    coversMultipleGifts: boolOrNull(effectiveData.coversMultipleGifts),
    readsAsWrittenAcknowledgment: boolOrNull(effectiveData.readsAsWrittenAcknowledgment),
    noGoodsOrServicesStated: boolOrNull(effectiveData.noGoodsOrServicesStated),
    benefitStatement: textOrNull(effectiveData.benefitStatement),
  };
}

// ── Prefill ───────────────────────────────────────────────────────────────────

/** Initial values for the donation form (all strings, as typed by the owner). */
export interface DonationPrefill {
  /** "YYYY-MM-DD", or "" when the receipt gives no usable date (never defaults to today). */
  date: string;
  recipient: string;
  /** Dollars as typed ("250.00"), or "" (non-cash gifts and unknown amounts are left for the owner). */
  amount: string;
  kind: DonationKind;
  substantiation: DonationSubstantiation;
  notes: string;
}

export const EMPTY_PREFILL: DonationPrefill = {
  date: "",
  recipient: "",
  amount: "",
  kind: "cash",
  substantiation: "none",
  notes: "",
};

/**
 * Receipt reading -> donation form prefill. Nothing is invented: a missing date
 * or amount stays blank, a non-cash gift's value is never filled in (the letter
 * describes goods, the donor determines their value), and the evidence type is
 * "written acknowledgment" only when the reading says the document reads as one
 * AND the letter states whether goods or services were provided (otherwise
 * "none" - the owner can change it before saving).
 */
export function buildDonationPrefill(reading: DonationReceiptReading): DonationPrefill {
  const cash = reading.cashAmountCents !== null && reading.cashAmountCents > 0;
  const kind: DonationKind = cash ? "cash" : reading.nonCashDescription !== null ? "noncash" : "cash";
  const date = reading.giftDate !== null && parseIsoDateNoonUtc(reading.giftDate) !== null ? reading.giftDate : "";

  const notes: string[] = [];
  if (reading.organizationEIN) notes.push(`EIN ${reading.organizationEIN} (as printed on the letter)`);
  if (reading.nonCashDescription) notes.push(`Non-cash items per the letter: ${reading.nonCashDescription}`);
  if (reading.coversMultipleGifts === true) notes.push("Letter lists more than one gift");

  return {
    date,
    recipient: reading.organizationName ?? "",
    amount: cash && reading.cashAmountCents !== null ? centsToDollarsInput(reading.cashAmountCents) : "",
    kind,
    substantiation: readsAsCompleteAcknowledgment(reading) ? "written_acknowledgment" : "none",
    notes: notes.join("\n"),
  };
}

/**
 * True only when the reading says the document reads as a written acknowledgment
 * AND the letter actually answers the goods-or-services question (a stated
 * "no goods or services" true/false, or a benefit/value text). Per
 * IRS, "Charitable contributions - written acknowledgments", an acknowledgment
 * for $250 or more must address goods or services, so a letter silent on it is
 * not treated as complete evidence by the prefill (the owner can still choose it).
 */
function readsAsCompleteAcknowledgment(reading: DonationReceiptReading): boolean {
  if (reading.readsAsWrittenAcknowledgment !== true) return false;
  return reading.noGoodsOrServicesStated !== null || reading.benefitStatement !== null;
}

// ── Flags (advisory; never block saving, never compute an amount) ─────────────

export type ReceiptFlagCode =
  | "receipt_goods_services"
  | "receipt_ack_wording_conflict"
  | "receipt_goods_services_not_stated"
  | "receipt_not_acknowledgment"
  | "receipt_multiple_gifts"
  | "receipt_cash_and_noncash"
  | "receipt_noncash_value_needed";

export interface ReceiptFlag {
  code: ReceiptFlagCode;
  level: DonationFlagLevel;
  message: string;
}

const BENEFIT_QUOTE_MAX = 200;

/**
 * Flags from the receipt's effective reading. `prefill` mode (the review panel
 * and the "waiting" card) adds notes about how the form was prefilled; `saved`
 * mode (a row already in the donation log) keeps only what is still true of the
 * saved gift: the goods/services and acknowledgment-wording flags. No flag
 * contains arithmetic or a computed dollar figure; the only number a message can
 * carry is the receipt's own benefit text, quoted.
 */
export function receiptFlags(
  reading: DonationReceiptReading,
  options: { mode?: "prefill" | "saved" } = {}
): ReceiptFlag[] {
  const mode = options.mode ?? "prefill";
  const flags: ReceiptFlag[] = [];

  const goodsProvided =
    reading.noGoodsOrServicesStated === false ||
    (reading.benefitStatement !== null && reading.noGoodsOrServicesStated !== true);

  if (goodsProvided) {
    const quoted =
      reading.benefitStatement !== null
        ? reading.benefitStatement.slice(0, BENEFIT_QUOTE_MAX)
        : "no description";
    flags.push({
      code: "receipt_goods_services",
      level: "cpa",
      message:
        `CPA: the letter says goods or services were provided: "${quoted}". ` +
        "The deductible part of this gift may be reduced - your CPA decides. " +
        "This app does not compute a reduced amount.",
    });
  } else if (reading.noGoodsOrServicesStated === true && reading.benefitStatement !== null) {
    flags.push({
      code: "receipt_ack_wording_conflict",
      level: "info",
      message:
        "The letter reads as saying no goods or services were provided, but a benefit statement was also read. Check the document.",
    });
  } else if (reading.noGoodsOrServicesStated === null) {
    flags.push({
      code: "receipt_goods_services_not_stated",
      level: "info",
      message:
        "The letter does not state whether goods or services were provided. A written acknowledgment normally states that none were, " +
        "describes them with a good-faith estimate of their value, or says they were entirely intangible religious benefits " +
        `(${IRS_ACK_SOURCE}). ` +
        (mode === "prefill"
          ? "The record type was left at 'No record yet'; you can still choose written acknowledgment yourself. "
          : "") +
        "Ask the charity for a complete acknowledgment or confirm with your CPA.",
    });
  }

  if (reading.readsAsWrittenAcknowledgment === false) {
    flags.push({
      code: "receipt_not_acknowledgment",
      level: "info",
      message:
        "This document does not read as a written acknowledgment (pledge, appeal, invoice or bank record?). " +
        "The record type was left at 'No record yet' - choose it yourself.",
    });
  }

  if (mode === "prefill") {
    if (reading.coversMultipleGifts === true) {
      flags.push({
        code: "receipt_multiple_gifts",
        level: "info",
        message:
          "This letter lists more than one gift, so date and amount were left blank. Log each gift separately; " +
          "the same letter can support each one (you will be asked to confirm).",
      });
    }
    const cash = reading.cashAmountCents !== null && reading.cashAmountCents > 0;
    if (cash && reading.nonCashDescription !== null) {
      flags.push({
        code: "receipt_cash_and_noncash",
        level: "info",
        message: "Prefilled as the cash gift; add the non-cash items as a separate gift.",
      });
    }
    if (!cash && reading.nonCashDescription !== null) {
      flags.push({
        code: "receipt_noncash_value_needed",
        level: "info",
        message:
          "The letter describes donated goods but does not value them. Enter the fair market value you determine, or ask your CPA.",
      });
    }
  }

  return flags;
}

// ── Duplicate detection and the double-link rule ──────────────────────────────

const LEGAL_SUFFIXES = new Set(["inc", "incorporated", "llc", "ltd", "corp", "corporation", "co"]);

/**
 * Recipient name for comparison only: case, accents, punctuation, "&" vs "and",
 * a leading "The" and trailing legal suffixes (Inc, LLC, Ltd, Corp, Co, ...) are
 * ignored. Words that distinguish charities (Foundation, Fund, Society) are kept.
 */
export function normalizeRecipient(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");
  if (words[0] === "the") words.shift();
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

export interface DuplicateCandidate {
  /** "YYYY-MM-DD" */
  dateIso: string;
  amountCents: number;
  recipient: string;
}

/**
 * Existing gifts that look like the same gift: same calendar date AND same
 * amount AND the same recipient after normalization. A different date (recurring
 * monthly gifts are legitimate) or a different amount or charity is never a
 * duplicate.
 */
export function findDuplicateDonations(
  candidate: DuplicateCandidate,
  existing: readonly DonationConflict[]
): DonationConflict[] {
  const wanted = normalizeRecipient(candidate.recipient);
  if (wanted === "") return [];
  return existing.filter(
    (e) =>
      e.dateIso === candidate.dateIso &&
      e.amountCents === candidate.amountCents &&
      normalizeRecipient(e.recipient) === wanted
  );
}

/**
 * The double-link rule: a receipt that is already attached to a (non-archived)
 * gift needs the owner's explicit confirmation before it is attached to
 * another (an annual letter can legitimately support several gifts). The gift
 * being edited is excluded from `linked`.
 */
export function receiptLinkNeedsConfirmation(
  linked: readonly { id: string }[],
  excludeDonationId: string | undefined,
  confirmShared: boolean
): boolean {
  const others = linked.filter((l) => l.id !== excludeDonationId);
  return others.length > 0 && !confirmShared;
}

// ── View used by the review panel and the "waiting" card ──────────────────────

export interface ReceiptDocRow {
  id: string;
  documentName: string | null;
  docType: string;
  taxYear: number | null;
  entityId: string;
  extractionStatus: string | null;
  extractionData: unknown;
  extractionCorrections: unknown;
  extractionConfirmedAt: Date | null;
}

export interface LinkedGiftView {
  id: string;
  dateIso: string;
  dateLabel: string;
  recipient: string;
  amountCents: number;
  /** Calendar year of the gift (for the link to that year's log). */
  year: number;
}

export type ReceiptState = "ready" | "not_extracted" | "withheld_by_policy" | "not_personal";

export interface ReceiptGiftView {
  documentId: string;
  name: string;
  docTaxYear: number | null;
  state: ReceiptState;
  verified: boolean;
  correctionCount: number;
  reading: DonationReceiptReading;
  prefill: DonationPrefill;
  flags: ReceiptFlag[];
  /** "Org - Jun 15, 2025 - $250.00" from the effective reading ("" when nothing was read). */
  summary: string;
  linkedGifts: LinkedGiftView[];
}

function summaryOf(reading: DonationReceiptReading): string {
  const parts: string[] = [];
  if (reading.organizationName) parts.push(reading.organizationName);
  const d = reading.giftDate ? parseIsoDateNoonUtc(reading.giftDate) : null;
  if (d) parts.push(formatDateEt(d));
  if (reading.cashAmountCents !== null && reading.cashAmountCents > 0) {
    parts.push(formatCentsDisplay(reading.cashAmountCents));
  } else if (reading.nonCashDescription) {
    parts.push("non-cash");
  }
  return parts.join(" - ");
}

/**
 * One receipt document -> the serializable view both pages render. Reads ONLY
 * through resolveTaxDocForCompute (effective values, corrections win, the
 * TAX_EXTRACTION_POLICY is honored), never raw extractionData.
 */
export function buildReceiptGiftView(
  row: ReceiptDocRow,
  ctx: { personalEntityId: string | null; linkedGifts: LinkedGiftView[] },
  policy?: TaxExtractionPolicy
): ReceiptGiftView {
  const name = row.documentName && row.documentName.trim() !== "" ? row.documentName : "Donation receipt";
  const base = {
    documentId: row.id,
    name,
    docTaxYear: row.taxYear,
    correctionCount: countCorrections(row.extractionCorrections),
    linkedGifts: ctx.linkedGifts,
  };
  const empty = (state: ReceiptState, verified = false): ReceiptGiftView => ({
    ...base,
    state,
    verified,
    reading: { ...EMPTY_RECEIPT_READING },
    prefill: { ...EMPTY_PREFILL },
    flags: [],
    summary: "",
  });

  if (ctx.personalEntityId === null || row.entityId !== ctx.personalEntityId) return empty("not_personal");

  const resolved = resolveTaxDocForCompute(
    {
      docType: row.docType,
      extractionStatus: row.extractionStatus,
      extractionData: row.extractionData,
      extractionCorrections: row.extractionCorrections,
      extractionConfirmedAt: row.extractionConfirmedAt,
    },
    policy
  );
  if (resolved.excludedByPolicy) return empty("withheld_by_policy");
  if (!isUsableExtraction("donation_receipt", row.extractionData)) return empty("not_extracted", resolved.verified);

  const effective = resolved.extractionData;
  const reading = readDonationReceipt(isRecord(effective) ? effective.data : null);
  return {
    ...base,
    state: "ready",
    verified: resolved.verified,
    reading,
    prefill: buildDonationPrefill(reading),
    flags: receiptFlags(reading, { mode: "prefill" }),
    summary: summaryOf(reading),
  };
}
