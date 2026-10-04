// Schedule D (Form 1040), Capital Gains and Losses, and the Form 8949 summary rows, TY2025, MFJ.
//
// Sources (all read on 2026-10-04): the 2025 Schedule D form text (Created 10/6/25), the 2025 Instructions for Schedule D (Dec 11, 2025:
// "Lines 1a and 8a", "Capital Loss Carryover Worksheet", "Line 21", the Schedule D Tax Worksheet, "Rounding Off to Whole Dollars"),
// the 2025 Instructions for Form 8949 (boxes A-L, Exception 1 and Exception 2, column (f) codes) and the 2025 Form 1040 instructions
// (line 7a Exceptions 1 and 2, line 7b, Qualified Dividends and Capital Gain Tax Worksheet line 3).
//
// What it does
//   * Takes the broker's per-category summary rows (1099-B / 1099-DA box totals, per Form 8949 box) and routes each (information return,
//     box) category:
//       - box A / G (short) or D / J (long), with NO wash sale, NO accrued market discount and the owner's confirmation that the broker
//         could not know of any adjustment: Schedule D line 1a / 8a (Exception 1 of the Form 8949 instructions; no Form 8949, no attached
//         statement, columns d, e, h only);
//       - everything else: Form 8949 as an "Exception 2" summary row per broker ("<broker> - see attached statement" in column (a),
//         columns (b) and (c) blank, code "M" plus "W" when wash sales are present, column (g) = the wash sale loss disallowed as a POSITIVE
//         number, column (h) = (d) - (e) + (g)); totals land on Schedule D line 1b / 2 / 3 / 8b / 9 / 10.
//   * Combines lines 1a-6 into line 7, 8a-14 into line 15, and 7 + 15 into line 16. Each (h) cell, line 7, line 15 and line 16 are figured
//     from the cent-accurate amounts and rounded ONCE ("If you have to add two or more amounts to figure the amount to enter on a line,
//     include cents when adding the amounts and round off only the total"), so a printed line can differ by $1 from the sum of the printed
//     lines above it; that is what the IRS rule produces.
//   * Part III: a gain goes to 1040 line 7a; a loss is limited to the smaller of the loss or $3,000 (line 21; 1040 line 7a is the negative
//     of line 21); zero prints 0. Lines 18 / 19 (28% rate and unrecaptured section 1250 gain) are read from the owner's statement that no
//     collectibles / QSB / depreciated-real-estate gain exists; anything else needs the Schedule D Tax Worksheet, which is NOT implemented
//     (needs_cpa_judgment on the tax).
//   * `qdcg.3` is the Qualified Dividends and Capital Gain Tax Worksheet line 3: the smaller of Schedule D line 15 or 16 (0 if either is a
//     loss), NOT 1040 line 7a (a short-term gain with a long-term loss makes 7a positive while this line is 0). With no Schedule D
//     (Exception 1: only capital gain distributions) it is 1040 line 7a.
//
// Schedule D lines 4, 5, 11, 12 (capital_gain_other) and 18, 19 (capital_special_rates) are "none group" lines: return.ts emits them from the
// owner's statements (an unstated group is not_yet_computed, a Yes needs the CPA); this rule only READS the same statements (it does not
// emit those keys) so it can block line 7 / 15 / 16 / the tax with the right reason.
//
// Never computed (blocked with a plain reason, never 0): Section 1256 contracts / Form 6781, lines 4, 5, 11, 12 unless the owner states none,
// accrued market discount (code B), 1099-DA digital assets are computed but carry a blocking item (2025 digital-asset reporting is new),
// collectibles / QSB / section 1250 gain (lines 18, 19), Form 4952, and wash sales the broker could not see (owner statement required).
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import type { BrokerBox } from "@/lib/tax2025/facts";
import { LINE_CATALOG, lineMeta } from "@/lib/tax2025/line-catalog";
import { D, ZERO, dollarsToCents, fmt, maxD, minD, roundLine } from "@/lib/tax2025/money";
import {
  aggregateStatus,
  worstBlocked,
  type LineKey,
  type OpenItem,
  type Ref,
  type RuleLine,
  type RuleResult,
  type RuleStatus,
  type ScheduleDCategory,
  type ScheduleDDetail,
  type ScheduleDLineId,
  type ScheduleDSummaryRow,
} from "@/lib/tax2025/types";

type Form8949Box = BrokerBox;
type RoutableRow = BrokerRowInput & { form: "1099-B" | "1099-DA"; box: Form8949Box };

// ── Inputs ────────────────────────────────────────────────────────────────────

/** One category row of a broker's sales summary, in dollars (Decimal). null = not read (never 0). */
export interface BrokerRowInput {
  docId: string;
  payer: string | null;
  refs: Ref[];
  /** null = the information return was not read: the row cannot be routed (missing_input). */
  form: "1099-B" | "1099-DA" | null;
  /** null = the Form 8949 box was not read: the row cannot be routed (missing_input). */
  box: Form8949Box | null;
  proceeds: Decimal | null;
  cost: Decimal | null;
  /** 1099-B box 1f, unsigned. */
  accruedMarketDiscount: Decimal | null;
  /** 1099-B box 1g wash sale loss disallowed, unsigned. */
  washSale: Decimal | null;
  /** Broker-printed net gain or (loss), signed; a cross-check only. */
  brokerGain: Decimal | null;
}

/** An owner answer plus where it came from. */
export interface AnsRef<T> {
  a: Ans<T>;
  refs: Ref[];
}

export interface ScheduleDInput {
  /** The provisional pass: every unresolved input is assumed (0 / "no") and listed in `assumptions` instead of blocking. */
  fill: boolean;
  rows: BrokerRowInput[];
  /** 1099 documents with a 1099-B signal whose sales summary was never read. */
  unreadDocuments: { docId: string; payer: string | null; refs: Ref[] }[];
  /**
   * The capture side is not wired (facts carry no capitalGains), so a 1099-B only shows up as old "other box" lines: the unread documents
   * are a CPA matter (needs_cpa_judgment), as before, instead of "re-extract and verify the summary" (missing_input).
   */
  unreadIsLegacy?: boolean;
  section1256: { present: boolean; aggregate: Decimal | null; refs: Ref[] };
  /** Every 1099-DIV box 2b / 2c / 2d is confirmed zero, or there is no 1099-DIV (1040 line 7a Exception 1 needs it for the 7b box). */
  dividendBoxes2b2dZero: boolean;
  /** A Form 1099-DA (digital assets) is present, whether or not rows were read from it. */
  digitalAssetsPresent: boolean;
  /** 1099-DIV box 2a total, dollars; null = not known (no 1099-DIV and none confirmed, or a legacy document). */
  capGainDistributions: Decimal | null;
  capGainDistributionRefs: Ref[];
  /** Stated capital loss carryover from 2024 as POSITIVE dollars. */
  carryoverShort: AnsRef<Decimal>;
  carryoverLong: AnsRef<Decimal>;
  /** true = the broker statement lists every sale. */
  salesComplete: AnsRef<boolean>;
  /** true = confirmed nothing the broker could not know (wash sales elsewhere, inherited / gifted / related-party basis, wrong cost). */
  noBrokerAdjustments: AnsRef<boolean>;
  /** true = confirmed no Form 6252 / 4684 / 6781 / 8824 / 2439 or K-1 capital item (lines 4, 5, 11, 12). */
  otherLinesNone: AnsRef<boolean>;
  /** true = confirmed no collectibles / QSB stock / depreciated-real-estate gain / QOF (lines 18, 19). */
  specialRatesNone: AnsRef<boolean>;
  /** The header "digital assets" question (a 1099-DA row must agree with a Yes). */
  digitalAssets: Ans<boolean>;
  /** Form 1040 line 3a, whole dollars (line 22); null = not known. */
  qualifiedDividends: Decimal | null;
}

export interface ScheduleDOutput {
  result: RuleResult;
  detail: ScheduleDDetail;
  openItems: OpenItem[];
  /** Provisional pass only: what was assumed. */
  assumptions: string[];
  /** The tax worksheet that would be needed but is not implemented: the caller blocks Form 1040 line 16 with it. */
  taxBlock: { status: "missing_input" | "needs_cpa_judgment"; reason: string } | null;
}

// ── Box table ─────────────────────────────────────────────────────────────────

interface BoxInfo {
  part: "I" | "II";
  /** Line the category's Form 8949 totals land on. */
  line: ScheduleDLineId;
  /** Line a clean category may be entered on directly (no Form 8949); null = always Form 8949. */
  direct: "1a" | "8a" | null;
  expectedForm: "1099-B" | "1099-DA";
  /** The box is for transactions with NO 1099-B / 1099-DA: a broker summary never has one. */
  noInformationReturn: boolean;
}

const BOX_INFO: Readonly<Record<Form8949Box, BoxInfo>> = {
  A: { part: "I", line: "1b", direct: "1a", expectedForm: "1099-B", noInformationReturn: false },
  B: { part: "I", line: "2", direct: null, expectedForm: "1099-B", noInformationReturn: false },
  C: { part: "I", line: "3", direct: null, expectedForm: "1099-B", noInformationReturn: true },
  D: { part: "II", line: "8b", direct: "8a", expectedForm: "1099-B", noInformationReturn: false },
  E: { part: "II", line: "9", direct: null, expectedForm: "1099-B", noInformationReturn: false },
  F: { part: "II", line: "10", direct: null, expectedForm: "1099-B", noInformationReturn: true },
  G: { part: "I", line: "1b", direct: "1a", expectedForm: "1099-DA", noInformationReturn: false },
  H: { part: "I", line: "2", direct: null, expectedForm: "1099-DA", noInformationReturn: false },
  I: { part: "I", line: "3", direct: null, expectedForm: "1099-DA", noInformationReturn: true },
  J: { part: "II", line: "8b", direct: "8a", expectedForm: "1099-DA", noInformationReturn: false },
  K: { part: "II", line: "9", direct: null, expectedForm: "1099-DA", noInformationReturn: false },
  L: { part: "II", line: "10", direct: null, expectedForm: "1099-DA", noInformationReturn: true },
};

const BOX_ORDER: readonly Form8949Box[] = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
const PART_I_LINES: readonly ScheduleDLineId[] = ["1a", "1b", "2", "3"];
const PART_II_LINES: readonly ScheduleDLineId[] = ["8a", "8b", "9", "10"];

type Col = "d" | "e" | "g" | "h";

function cellKey(line: ScheduleDLineId, col: Col): LineKey {
  return `schd.${line}.${col}` as LineKey;
}

// ── Small value algebra: an amount is known or blocked, never defaulted ──────

type Blocked = Exclude<RuleStatus, "computed" | "not_applicable">;
interface Block {
  status: Blocked;
  reason: string;
}
type Amt = { ok: true; value: Decimal; na: boolean; refs: Ref[]; note?: string } | { ok: false; block: Block };

const known = (value: Decimal, refs: Ref[] = [], na = false, note?: string): Amt => (note === undefined ? { ok: true, value, na, refs } : { ok: true, value, na, refs, note });
const blockedAmt = (status: Blocked, reason: string): Amt => ({ ok: false, block: { status, reason } });

function dedupRefs(refs: readonly Ref[]): Ref[] {
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const r of refs) {
    const id = `${r.kind}:${r.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

function worstOf(blocks: readonly Block[]): Block | null {
  const status = worstBlocked(blocks.map((b) => b.status));
  if (status === null) return null;
  const first = blocks.find((b) => b.status === status);
  return { status, reason: first?.reason ?? "Not computed." };
}

/** Sum of amounts; blocked with the worst component status when any component is blocked. */
function addAmts(parts: readonly Amt[], what: string): Amt {
  const blocks = parts.flatMap((p) => (p.ok ? [] : [p.block]));
  const worst = worstOf(blocks);
  if (worst !== null) return blockedAmt(worst.status, `${what} cannot be figured yet: ${worst.reason}`);
  let total = ZERO;
  let refs: Ref[] = [];
  for (const p of parts) {
    if (p.ok) {
      total = total.plus(p.value);
      refs = refs.concat(p.refs);
    }
  }
  return known(total, dedupRefs(refs));
}

const sumNullable = (values: readonly (Decimal | null)[]): Decimal | null => {
  let t = ZERO;
  for (const v of values) {
    if (v === null) return null;
    t = t.plus(v);
  }
  return t;
};

const cents = (d: Decimal | null): number | null => (d === null ? null : dollarsToCents(d));

// ── Category assembly ─────────────────────────────────────────────────────────

interface Cat {
  form: "1099-B" | "1099-DA";
  box: Form8949Box;
  info: BoxInfo;
  rows: BrokerRowInput[];
  proceeds: Decimal | null;
  cost: Decimal | null;
  wash: Decimal | null;
  discount: Decimal | null;
  brokerGain: Decimal | null;
  refs: Ref[];
  docIds: string[];
  payers: string[];
}

function buildCategories(rows: readonly RoutableRow[]): Cat[] {
  const byKey = new Map<string, RoutableRow[]>();
  for (const r of rows) {
    const key = `${r.form}:${r.box}`;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const cats: Cat[] = [];
  for (const [, rs] of byKey) {
    const first = rs[0];
    if (first === undefined) continue;
    const payers: string[] = [];
    for (const r of rs) if (r.payer !== null && r.payer.trim() !== "" && !payers.includes(r.payer.trim())) payers.push(r.payer.trim());
    cats.push({
      form: first.form,
      box: first.box,
      info: BOX_INFO[first.box],
      rows: rs,
      proceeds: sumNullable(rs.map((r) => r.proceeds)),
      cost: sumNullable(rs.map((r) => r.cost)),
      wash: sumNullable(rs.map((r) => r.washSale)),
      discount: sumNullable(rs.map((r) => r.accruedMarketDiscount)),
      brokerGain: sumNullable(rs.map((r) => r.brokerGain)),
      refs: dedupRefs(rs.flatMap((r) => r.refs)),
      docIds: [...new Set(rs.map((r) => r.docId))],
      payers,
    });
  }
  return cats.sort((a, b) => BOX_ORDER.indexOf(a.box) - BOX_ORDER.indexOf(b.box) || (a.form < b.form ? -1 : 1));
}

/** One Form 8949 summary row per broker (the instructions: "If you have statements from more than one broker, report the totals from each broker on a separate row"). */
function summaryRows(cat: Cat): ScheduleDSummaryRow[] {
  const groups = new Map<string, BrokerRowInput[]>();
  for (const r of cat.rows) {
    const key = r.payer !== null && r.payer.trim() !== "" ? `p:${r.payer.trim().toLowerCase()}` : `d:${r.docId}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((rs): ScheduleDSummaryRow => {
    const proceeds = sumNullable(rs.map((r) => r.proceeds));
    const cost = sumNullable(rs.map((r) => r.cost));
    const wash = sumNullable(rs.map((r) => r.washSale));
    const gain = proceeds !== null && cost !== null && wash !== null ? proceeds.minus(cost).plus(wash) : null;
    return {
      docIds: [...new Set(rs.map((r) => r.docId))],
      payer: rs[0]?.payer ?? null,
      proceedsCents: cents(proceeds),
      costCents: cents(cost),
      washSaleCents: cents(wash),
      gainCents: cents(gain),
      brokerGainCents: cents(sumNullable(rs.map((r) => r.brokerGain))),
    };
  });
}

const brokerName = (cat: Cat): string => (cat.payers.length > 0 ? cat.payers.join(" / ") : "Broker");

// ── The rule ──────────────────────────────────────────────────────────────────

const CITATIONS = ["CAPITAL_LOSS_LIMIT_MFJ", "CAPITAL_LOSS_LIMIT_MFS"];

const CT_NOTE =
  "Connecticut: the CT-1040 starts from federal AGI, so these capital gains / losses (including the $3,000 limit) flow through. Searching the CT-1040 instructions (Rev. 12/25, read 2026-10-04) found no adjustment for ordinary capital gains; the only capital-gain-related modifications are for gain or loss on the sale of Connecticut state or local government bonds (Schedule 1 lines 35 and 47). Inferred from the absence of an adjustment: the CPA confirms, and checks that no Connecticut bond is among the sales.";

/** Builds an amount line (or a blocked line) from an Amt. */
function amtLine(key: LineKey, amt: Amt, reason?: string, refs?: Ref[]): RuleLine {
  const m = lineMeta(key);
  const base = { key, label: m.label, formLine: m.formLine };
  if (amt.ok) {
    const l: RuleLine = { ...base, amount: roundLine(amt.value), exact: amt.value, status: amt.na ? "not_applicable" : "computed", refs: refs ?? amt.refs };
    const why = reason ?? amt.note;
    if (why !== undefined) l.reason = why;
    else if (amt.na) l.reason = "Nothing to report on this line.";
    return l;
  }
  return { ...base, amount: null, exact: null, status: amt.block.status, reason: amt.block.reason, ...(refs ? { refs } : {}) };
}

const stateOf = (a: Ans<boolean>): "yes" | "no" | "unsure" | "missing" => (a.state === "answered" ? (a.value ? "yes" : "no") : a.state);

export function computeScheduleD(input: ScheduleDInput): ScheduleDOutput {
  const fill = input.fill;
  const assumptions: string[] = [];
  const assume = (what: string): void => {
    assumptions.push(what);
  };
  const items: OpenItem[] = [];
  const reasons: string[] = [];
  const lines: RuleLine[] = [];
  const emit = (key: LineKey, amt: Amt, reason?: string, refs?: Ref[]): void => {
    lines.push(amtLine(key, amt, reason, refs));
  };

  // A category row with every figure zero is ignored (it must not route anything to Form 8949); a row whose form or box was not read
  // cannot be routed and is set aside (it blocks Schedule D below).
  // (only when all five figures are KNOWN zeros: an unread cost / wash sale / discount is unknown, never zero)
  const isZeroRow = (r: BrokerRowInput): boolean =>
    [r.proceeds, r.cost, r.accruedMarketDiscount, r.washSale, r.brokerGain].every((v) => v !== null && v.isZero());
  const keptRows = input.rows.filter((r) => !isZeroRow(r));
  const incompleteRows = keptRows.filter((r) => r.form === null || r.box === null);
  const rows: RoutableRow[] = keptRows.filter((r): r is RoutableRow => r.form !== null && r.box !== null);
  const hasRows = rows.length > 0 || incompleteRows.length > 0;
  const unread = input.unreadDocuments;
  const allRowRefs = dedupRefs(rows.flatMap((r) => r.refs));
  const salesState = stateOf(input.salesComplete.a);
  const adjState = stateOf(input.noBrokerAdjustments.a);
  const otherState = stateOf(input.otherLinesNone.a);
  const specialState = stateOf(input.specialRatesNone.a);
  const shortCarry = input.carryoverShort.a;
  const longCarry = input.carryoverLong.a;
  const carryPositive =
    (shortCarry.state === "answered" && !shortCarry.value.isZero()) || (longCarry.state === "answered" && !longCarry.value.isZero());
  const carryUnsure = shortCarry.state === "unsure" || longCarry.state === "unsure";
  const gainDistributions = input.capGainDistributions;
  const da = input.digitalAssetsPresent || rows.some((r) => r.form === "1099-DA");

  // ── Is Schedule D required? ────────────────────────────────────────────────
  const anyTrue = hasRows || input.section1256.present || carryPositive || otherState === "no" || specialState === "no";
  const anyUnknown = unread.length > 0 || (input.digitalAssetsPresent && !hasRows) || salesState === "no" || salesState === "unsure" || carryUnsure || otherState === "unsure" || specialState === "unsure";
  const required: boolean | "blocking" = anyTrue ? true : anyUnknown ? "blocking" : false;

  const emptyDetail: ScheduleDDetail = {
    required,
    exception1: required === false && input.dividendBoxes2b2dZero,
    boxes2b2dUnconfirmed: required === false && !input.dividendBoxes2b2dZero,
    form8949Required: false,
    categories: [],
    line17: null,
    line20: null,
    line22: null,
    taxWorksheetNeeded: false,
    carryoverOut: null,
  };

  // ── Exception 1: no Schedule D ─────────────────────────────────────────────
  if (required === false) {
    const why =
      "Schedule D is not required (Form 1040 line 7a, Exception 1): no capital transactions are on file, no capital loss carryover is stated and no other capital item is indicated, so the only capital gains are capital gain distributions (Form 1099-DIV box 2a), which go straight on line 7a, and the line 7b \"Schedule D not required\" box applies. The owner is asked about a 2024 capital loss carryover (Return completeness question cgco); an unanswered question does not block a household with no sales, so the CPA should glance at the 2024 Schedule D line 21 for such a household. The line 7b box needs every 1099-DIV box 2b, 2c and 2d to be zero (see the open item on those boxes).";
    const na = (key: LineKey): void => emit(key, known(ZERO, [], true), why);
    for (const l of [...PART_I_LINES, ...PART_II_LINES]) {
      na(cellKey(l, "d"));
      na(cellKey(l, "e"));
      if (l !== "1a" && l !== "8a") na(cellKey(l, "g"));
      na(cellKey(l, "h"));
    }
    for (const id of ["6", "7", "13", "14", "15", "16", "21"] as const) na(`schd.${id}` as LineKey);
    const noScheduleD = "No Schedule D is filed: the Qualified Dividends and Capital Gain Tax Worksheet line 3 is the amount on Form 1040 line 7a.";
    if (gainDistributions !== null) {
      emit("f1040.7a", known(gainDistributions, input.capGainDistributionRefs), "Capital gain distributions only (Form 1099-DIV box 2a): Schedule D is not required, so the amount goes directly on line 7a (Exception 1).");
      emit("qdcg.3", known(gainDistributions, input.capGainDistributionRefs), noScheduleD);
    } else if (fill) {
      assume("Capital gain distributions, assumed $0");
      emit("f1040.7a", known(ZERO), "Capital gain distributions assumed $0 (no 1099-DIV on file and none confirmed).");
      emit("qdcg.3", known(ZERO), noScheduleD);
    } else {
      const reason = "Capital gain distributions (Form 1099-DIV box 2a) are not known: no 1099 dividend income is on file and the owner has not confirmed there is none.";
      emit("f1040.7a", blockedAmt("missing_input", reason));
      emit("qdcg.3", blockedAmt("missing_input", reason));
    }
    return {
      result: {
        ruleId: "schedule-d",
        form: "Schedule D",
        status: aggregateStatus(lines),
        lines,
        reasons: [why],
        citations: CITATIONS,
        inputsUsed: [],
        inputsMissing: gainDistributions === null && !fill ? ["Capital gain distributions (1099-DIV box 2a)"] : [],
      },
      detail: emptyDetail,
      openItems: [],
      assumptions,
      taxBlock: null,
    };
  }

  // ── Schedule D is (or may be) required ─────────────────────────────────────

  // Global gates: anything that makes the whole set of sales untrustworthy
  const gateBlocks: Block[] = [];
  if (unread.length > 0) {
    const names = unread.map((u) => u.payer ?? u.docId).join(", ");
    if (fill) assume(`${unread.length} 1099 document(s) (${names}) show 1099-B sales that were not read: assumed no sales from them`);
    else if (input.unreadIsLegacy === true) gateBlocks.push({ status: "needs_cpa_judgment", reason: "A 1099 reports sales (1099-B boxes): Schedule D / Form 8949 are not computed from them yet (the category summary is not captured), so the CPA figures the capital gain." });
    else gateBlocks.push({ status: "missing_input", reason: `A 1099 (${names}) shows 1099-B sales but its sales summary has not been read: re-extract the document and verify the category totals.` });
  }
  if (incompleteRows.length > 0) {
    if (fill) assume(`${incompleteRows.length} sales summary row(s) with no Form 8949 box or information return read: left out`);
    else gateBlocks.push({ status: "missing_input", reason: `${incompleteRows.length} sales summary row(s) have no Form 8949 box or information return read (1099-B / 1099-DA), so they cannot be routed to a Schedule D line: fix them on the document review screen.` });
  }
  if (salesState === "no" || salesState === "unsure") {
    const reason =
      salesState === "no"
        ? "The owner says the broker statement does not list every sale (another broker, or a sale outside a brokerage account): those sales are not on file."
        : "The owner is not sure the broker statement lists every sale: the CPA decides whether other sales exist.";
    if (fill) assume(`Sales completeness (${salesState === "no" ? "the owner says some sales are missing" : "not sure"}): computed from the broker statement only`);
    else gateBlocks.push({ status: "needs_cpa_judgment", reason });
  } else if (salesState === "missing" && hasRows) {
    if (fill) assume("Whether the broker statement lists every sale is not answered: assumed yes");
    else gateBlocks.push({ status: "missing_input", reason: "It is not known whether the broker statement lists every sale (other broker, sale outside a brokerage account): answer the capital gains questions." });
  }
  if (hasRows) {
    if (adjState === "no" || adjState === "unsure") {
      const reason =
        adjState === "no"
          ? "The owner says the broker could not know of an adjustment (a wash sale in another account, inherited / gifted / related-party basis, or a wrong cost): the Form 8949 adjustments are not collected, so the CPA must decide them."
          : "The owner is not sure whether the broker missed an adjustment (wash sale elsewhere, inherited / gifted / related-party basis, wrong cost): the CPA decides.";
      if (fill) assume(`Broker adjustments (${adjState === "no" ? "the owner says there are some" : "not sure"}): totals used as printed`);
      else gateBlocks.push({ status: "needs_cpa_judgment", reason });
    } else if (adjState === "missing") {
      if (fill) assume("Whether the broker missed an adjustment is not answered: assumed none");
      else gateBlocks.push({ status: "missing_input", reason: "It is not known whether the broker could not know of an adjustment (wash sale elsewhere, inherited / gifted / related-party basis, wrong cost): answer the capital gains questions." });
    }
  }
  if (!hasRows && (specialState === "no" || specialState === "unsure")) {
    // a collectibles / QSB / depreciated-real-estate / QOF item with no sale on file: the sale is somewhere this return does not have
    if (fill) assume("The owner reports (or is unsure about) a collectibles / QSB / depreciated real estate / QOF sale, but no sale is on file: ignored");
    else gateBlocks.push({ status: "needs_cpa_judgment", reason: "The owner reports (or is not sure about) a sale of collectibles, qualified small business stock, depreciated real estate or a partnership interest, or a QOF investment, but no such sale is on file: the CPA decides." });
  }
  const gate = worstOf(gateBlocks);

  // Capture side not wired and a 1099-B shows up only as old "other box" lines: everything Schedule D owns waits for the CPA, as before.
  if (input.unreadIsLegacy === true && unread.length > 0 && !fill && gate !== null) {
    for (const meta of LINE_CATALOG) {
      if (meta.key.startsWith("schd.") && meta.group === undefined) emit(meta.key, blockedAmt(gate.status, gate.reason));
    }
    emit("f1040.7a", blockedAmt(gate.status, gate.reason));
    emit("qdcg.3", blockedAmt(gate.status, gate.reason));
    return {
      result: { ruleId: "schedule-d", form: "Schedule D", status: aggregateStatus(lines), lines, reasons: [gate.reason], citations: CITATIONS, inputsUsed: [], inputsMissing: [] },
      detail: { ...emptyDetail, required: "blocking", exception1: false, boxes2b2dUnconfirmed: false, form8949Required: "blocking" },
      openItems: [],
      assumptions,
      taxBlock: null,
    };
  }

  // Categories: problems and routing
  const cats = buildCategories(rows);
  const catBlock = new Map<Cat, Block>();
  const routedLine = new Map<Cat, ScheduleDLineId>();
  for (const cat of cats) {
    const probs: Block[] = [];
    const where = `${cat.form} box ${cat.box}`;
    const soft = (status: Blocked, reason: string, assumed: string): void => {
      if (fill) assume(assumed);
      else probs.push({ status, reason });
    };
    if (cat.form !== cat.info.expectedForm) {
      soft("needs_cpa_judgment", `A ${cat.form} row carries Form 8949 box ${cat.box}, which belongs to ${cat.info.expectedForm}: the box and the information return disagree.`, `${where}: box and information return disagree, computed as read`);
    }
    if (cat.info.noInformationReturn) {
      soft("needs_cpa_judgment", `${where}: boxes C, F, I and L are for transactions with no information return; a broker summary never has them, so this row needs the CPA.`, `${where}: a box for transactions with no information return, computed as read`);
    }
    const missingWhat: string[] = [];
    if (cat.proceeds === null) missingWhat.push("proceeds");
    if (cat.cost === null) missingWhat.push("cost or other basis");
    if (cat.wash === null) missingWhat.push("wash sale loss disallowed (box 1g)");
    if (cat.discount === null) missingWhat.push("accrued market discount (box 1f)");
    if (missingWhat.length > 0) {
      soft("missing_input", `${where}: ${missingWhat.join(", ")} not read from the 1099 (never assumed $0): fix it on the review screen.`, `${where}: ${missingWhat.join(", ")} not read, assumed $0`);
    }
    if (cat.discount !== null && !cat.discount.isZero()) {
      soft("needs_cpa_judgment", `${where}: accrued market discount ${fmt(cat.discount)} (1099-B box 1f) needs the Form 8949 code B worksheet, which is not modeled.`, `${where}: accrued market discount ${fmt(cat.discount)} not modeled (code B), ignored`);
    }
    const worst = worstOf(probs);
    if (worst !== null) catBlock.set(cat, worst);
    const clean =
      cat.info.direct !== null && cat.form === cat.info.expectedForm && cat.wash !== null && cat.wash.isZero() && cat.discount !== null && cat.discount.isZero();
    routedLine.set(cat, clean && cat.info.direct !== null ? cat.info.direct : cat.info.line);
  }
  const undeterminedRouting = (cat: Cat): boolean => cat.info.direct !== null && (cat.wash === null || cat.discount === null);

  // Per transaction line: the blocks that apply
  const lineBlocks = new Map<ScheduleDLineId, Block[]>();
  const addLineBlock = (l: ScheduleDLineId, b: Block): void => {
    lineBlocks.set(l, [...(lineBlocks.get(l) ?? []), b]);
  };
  for (const cat of cats) {
    const b = catBlock.get(cat);
    if (b === undefined) continue;
    if (undeterminedRouting(cat) && cat.info.direct !== null) {
      addLineBlock(cat.info.direct, b);
      addLineBlock(cat.info.line, b);
    } else {
      const l = routedLine.get(cat);
      if (l !== undefined) addLineBlock(l, b);
    }
  }

  // Cells
  const cellAmounts = new Map<string, Amt>();
  for (const part of [PART_I_LINES, PART_II_LINES]) {
    for (const l of part) {
      const worstLine = worstOf([...(gate ? [gate] : []), ...(lineBlocks.get(l) ?? [])]);
      const onLine = cats.filter((c) => routedLine.get(c) === l);
      const hasG = l !== "1a" && l !== "8a";
      const columns: Col[] = hasG ? ["d", "e", "g", "h"] : ["d", "e", "h"];
      if (worstLine !== null) {
        for (const c of columns) cellAmounts.set(`${l}.${c}`, blockedAmt(worstLine.status, worstLine.reason));
        continue;
      }
      if (onLine.length === 0) {
        for (const c of columns) cellAmounts.set(`${l}.${c}`, known(ZERO, [], true, "No transactions are reported on this line."));
        continue;
      }
      const refs = dedupRefs(onLine.flatMap((c) => c.refs));
      const d = onLine.reduce((t, c) => t.plus(c.proceeds ?? ZERO), ZERO);
      const e = onLine.reduce((t, c) => t.plus(c.cost ?? ZERO), ZERO);
      const g = hasG ? onLine.reduce((t, c) => t.plus(c.wash ?? ZERO), ZERO) : ZERO;
      cellAmounts.set(`${l}.d`, known(d, refs));
      cellAmounts.set(`${l}.e`, known(e, refs));
      if (hasG) cellAmounts.set(`${l}.g`, known(g, refs));
      // (h) = (d) - (e) + (g) from the cent-accurate amounts, rounded once (the printed d, e, g are each rounded on their own)
      cellAmounts.set(`${l}.h`, known(d.minus(e).plus(g), refs));
    }
  }
  const cell = (l: ScheduleDLineId, c: Col): Amt => cellAmounts.get(`${l}.${c}`) ?? blockedAmt("missing_input", "Not computed.");
  for (const part of [PART_I_LINES, PART_II_LINES]) {
    for (const l of part) {
      emit(cellKey(l, "d"), cell(l, "d"));
      emit(cellKey(l, "e"), cell(l, "e"));
      if (l !== "1a" && l !== "8a") emit(cellKey(l, "g"), cell(l, "g"));
      emit(cellKey(l, "h"), cell(l, "h"));
    }
  }

  // Lines 4, 5, 11, 12 (Forms 6252 / 4684 / 6781 / 8824 / 2439, K-1 capital items)
  const otherLine = (label: string, form6781: boolean): Amt => {
    if (form6781 && input.section1256.present) {
      if (fill) {
        assume(`Schedule D line ${label}: Section 1256 contracts (Form 6781) are present and not modeled, assumed $0`);
        return known(ZERO, input.section1256.refs, true);
      }
      return blockedAmt("needs_cpa_judgment", "A Section 1256 section (futures / index options taxed at year end, Form 6781) is present: the 60/40 short / long split is not modeled, so the CPA figures this line.");
    }
    if (otherState === "yes") return known(ZERO, input.otherLinesNone.refs, true, "Stated by the owner: no installment sale, casualty or theft, Section 1256 contract, like-kind exchange, Form 2439 gain or K-1 capital item.");
    if (fill) {
      assume(`Schedule D line ${label} (Forms 6252 / 4684 / 6781 / 8824 / 2439 or a K-1 capital item), ${otherState === "missing" ? "not stated" : "the owner says there is one or is not sure"}, assumed $0`);
      return known(ZERO, input.otherLinesNone.refs, true);
    }
    if (otherState === "no") return blockedAmt("needs_cpa_judgment", "The owner says there is an installment sale, casualty or theft, Section 1256 contract, like-kind exchange, Form 2439 gain or K-1 capital item: those amounts are not collected, so the CPA figures this line.");
    if (otherState === "unsure") return blockedAmt("needs_cpa_judgment", "The owner is not sure whether there is an installment sale, casualty or theft, Section 1256 contract, like-kind exchange, Form 2439 gain or K-1 capital item: the CPA decides.");
    return blockedAmt("missing_input", "Needs an owner statement that there is no installment sale (Form 6252), casualty or theft loss (Form 4684), Section 1256 contract (Form 6781), like-kind exchange (Form 8824), Form 2439 gain or K-1 capital gain / loss.");
  };
  // (the lines themselves are emitted by the capital_gain_other "none group" statement in return.ts; this only needs their values)
  const l4 = otherLine("4", true);
  const l5 = otherLine("5", false);
  const l11 = otherLine("11", true);
  const l12 = otherLine("12", false);

  // Line 13: capital gain distributions
  let l13: Amt;
  if (gainDistributions !== null) l13 = known(gainDistributions, input.capGainDistributionRefs, gainDistributions.isZero(), "No capital gain distributions (Form 1099-DIV box 2a is zero).");
  else if (fill) {
    assume("Capital gain distributions, assumed $0");
    l13 = known(ZERO, [], true);
  } else l13 = blockedAmt("missing_input", "Capital gain distributions (Form 1099-DIV box 2a) are not known: no 1099 dividend income is on file and the owner has not confirmed there is none.");
  emit("schd.13", l13, l13.ok && !l13.na ? "Total of Form 1099-DIV box 2a (capital gain distributions), regardless of how long the fund shares were held." : undefined);

  // Lines 6 and 14: carryover from 2024 (positive amounts; the form prints them in parentheses)
  const carryover = (a: Ans<Decimal>, refs: Ref[], name: string): Amt => {
    if (a.state === "answered") {
      if (a.value.isNegative()) return blockedAmt("needs_cpa_judgment", `The ${name} capital loss carryover was entered as a negative number: enter the loss as a positive amount.`);
      return known(a.value, refs, a.value.isZero(), `Stated by the owner: no ${name} capital loss carries over from 2024.`);
    }
    if (fill) {
      assume(`${name} capital loss carryover from 2024, ${a.state === "unsure" ? "the owner is not sure" : "not stated"}, assumed $0`);
      return known(ZERO, refs, true);
    }
    if (a.state === "unsure") return blockedAmt("needs_cpa_judgment", `The owner is not sure whether a ${name} capital loss carries over from 2024: the CPA reads it from the 2024 return (Capital Loss Carryover Worksheet).`);
    return blockedAmt("missing_input", `The ${name} capital loss carryover from 2024 is not stated (answer the carryover question; none = 0).`);
  };
  const l6 = carryover(shortCarry, input.carryoverShort.refs, "short-term");
  const l14 = carryover(longCarry, input.carryoverLong.refs, "long-term");
  emit("schd.6", l6, l6.ok && !l6.na ? "Stated by the owner (2024 Capital Loss Carryover Worksheet line 8); entered as a positive amount and subtracted on line 7." : undefined);
  emit("schd.14", l14, l14.ok && !l14.na ? "Stated by the owner (2024 Capital Loss Carryover Worksheet line 13); entered as a positive amount and subtracted on line 15." : undefined);

  // Lines 7, 15, 16: combined from the cent-accurate amounts and rounded once
  const neg = (a: Amt): Amt => (a.ok ? known(a.value.negated(), a.refs) : a);
  const l7 = addAmts([cell("1a", "h"), cell("1b", "h"), cell("2", "h"), cell("3", "h"), l4, l5, neg(l6)], "Net short-term capital gain or (loss)");
  const l15 = addAmts([cell("8a", "h"), cell("8b", "h"), cell("9", "h"), cell("10", "h"), l11, l12, l13, neg(l14)], "Net long-term capital gain or (loss)");
  const l16 = addAmts([l7, l15], "The combined capital gain or (loss)");
  const withRows = (a: Amt): Ref[] | undefined => (a.ok ? dedupRefs([...allRowRefs, ...a.refs]) : undefined);
  emit("schd.7", l7, l7.ok ? "Lines 1a through 6 combined from cent-accurate amounts and rounded once." : undefined, withRows(l7));
  emit("schd.15", l15, l15.ok ? "Lines 8a through 14 combined from cent-accurate amounts and rounded once." : undefined, withRows(l15));
  emit("schd.16", l16, l16.ok ? "Lines 7 and 15 combined from cent-accurate amounts and rounded once." : undefined, withRows(l16));

  // Part III
  const r7 = l7.ok ? roundLine(l7.value) : null;
  const r15 = l15.ok ? roundLine(l15.value) : null;
  const r16 = l16.ok ? roundLine(l16.value) : null;
  const refs16 = withRows(l16) ?? [];
  const limit = D(K.CAPITAL_LOSS_LIMIT_MFJ.value);

  let line17: boolean | null = null;
  let line20: boolean | null = null;
  let line22: boolean | null = null;
  let taxWorksheetNeeded = false;
  let taxBlock: ScheduleDOutput["taxBlock"] = null;
  let l21: Amt;
  let f7a: Amt;
  let qdcg3: Amt;
  if (r16 === null || r15 === null || r7 === null) {
    const b: Block = !l16.ok ? l16.block : { status: "missing_input", reason: "Not computed." };
    l21 = blockedAmt(b.status, `Depends on Schedule D line 16: ${b.reason}`);
    f7a = blockedAmt(b.status, b.reason);
    qdcg3 = blockedAmt(b.status, b.reason);
  } else {
    f7a = r16.greaterThan(0) ? known(r16, refs16) : r16.lessThan(0) ? known(minD(r16.abs(), limit).negated(), refs16) : known(ZERO, refs16);
    line17 = r15.greaterThan(0) && r16.greaterThan(0);
    qdcg3 = known(line17 ? minD(r15, r16) : ZERO, refs16);
    if (line17) {
      if (specialState === "yes" || fill) {
        if (fill && specialState !== "yes") {
          assume(`Collectibles / QSB / depreciated-real-estate gain (28% rate and unrecaptured section 1250 gain), ${specialState === "missing" ? "not stated" : "the owner says there is one or is not sure"}, assumed none`);
        }
        line20 = true;
      } else {
        const status: Blocked = specialState === "missing" ? "missing_input" : "needs_cpa_judgment";
        const reason =
          specialState === "missing"
            ? "Needs an owner statement that there was no sale of collectibles (including gold or silver trust shares), qualified small business stock, depreciated real estate or a partnership interest and no qualified opportunity fund investment: otherwise lines 18 and 19 (28% rate and unrecaptured section 1250 gain) and the Schedule D Tax Worksheet apply."
            : specialState === "no"
              ? "The owner reports a sale of collectibles, QSB stock, depreciated real estate or a partnership interest, or a QOF investment: lines 18 and 19 and the Schedule D Tax Worksheet apply, which this engine does not compute."
              : "The owner is not sure whether collectibles (including gold or silver trust shares), QSB stock, depreciated real estate or a QOF investment were sold: the CPA decides whether lines 18 and 19 and the Schedule D Tax Worksheet apply.";
        taxWorksheetNeeded = true;
        taxBlock = { status, reason: `${reason} The Schedule D Tax Worksheet is not implemented, so the tax is not computed.` };
      }
    }
    l21 = r16.lessThan(0) ? known(minD(r16.abs(), limit), refs16) : known(ZERO, [], true);
    line22 = line17 === false && input.qualifiedDividends !== null ? input.qualifiedDividends.greaterThan(0) : null;
  }
  // (lines 18 and 19 are emitted by the capital_special_rates "none group" statement in return.ts)
  emit("schd.21", l21, l21.ok && !l21.na && r16 !== null ? `The smaller of the loss on line 16 (${fmt(r16.abs())}) or ${fmt(limit)}; the negative of it is the amount on Form 1040 line 7a.` : l21.ok ? "Skipped: line 16 is not a loss." : undefined);

  // Form 1040 line 7a and the QDCG worksheet line 3
  let f7aReason: string | undefined;
  if (r16 !== null) {
    f7aReason = r16.greaterThan(0)
      ? `A net capital gain: the amount on Schedule D line 16 (${fmt(r16)}).`
      : r16.lessThan(0)
        ? `A net capital loss of ${fmt(r16.abs())} on Schedule D line 16 is limited to ${fmt(minD(r16.abs(), limit))} (the smaller of the loss or ${fmt(limit)}, Schedule D line 21).`
        : "Schedule D line 16 is zero: enter -0-.";
  }
  emit("f1040.7a", f7a, f7aReason);
  emit(
    "qdcg.3",
    qdcg3,
    r15 !== null && r16 !== null
      ? `The smaller of Schedule D line 15 (${fmt(r15)}) or line 16 (${fmt(r16)}), 0 if either is not a gain. This is not Form 1040 line 7a (${fmt(f7a.ok ? f7a.value : ZERO)}).`
      : undefined
  );
  if (r16 !== null && r15 !== null && r7 !== null) {
    reasons.push(
      `Schedule D: net short-term ${fmt(r7)}, net long-term ${fmt(r15)}, combined ${fmt(r16)}${r16.lessThan(0) ? `; the loss is limited to ${fmt(minD(r16.abs(), limit))} on Form 1040 line 7a` : ""}.`
    );
  }

  // ── Detail ─────────────────────────────────────────────────────────────────
  const categories: ScheduleDCategory[] = cats.map((cat): ScheduleDCategory => {
    const line = routedLine.get(cat) ?? cat.info.line;
    const direct = line === cat.info.direct;
    const gain = cat.proceeds !== null && cat.cost !== null && cat.wash !== null ? cat.proceeds.minus(cat.cost).plus(cat.wash) : null;
    return {
      form: cat.form,
      box: cat.box,
      part: cat.info.part,
      line,
      routing: direct ? "schedule_d_direct" : "form_8949_summary",
      proceedsCents: cents(cat.proceeds),
      costCents: cents(cat.cost),
      washSaleCents: cents(cat.wash),
      gainCents: cents(gain),
      codes: direct ? "" : cat.wash !== null && cat.wash.greaterThan(0) ? "MW" : "M",
      description: direct ? "" : `${brokerName(cat)} - see attached statement`,
      rows: summaryRows(cat),
    };
  });
  const anyForm8949 = categories.some((c) => c.routing === "form_8949_summary");
  // Form 8949 is certain when some category cannot go on line 1a / 8a whatever the unread figures turn out to be
  const certain8949 = cats.some((c) => routedLine.get(c) !== c.info.direct && !undeterminedRouting(c));
  const detail: ScheduleDDetail = {
    ...emptyDetail,
    form8949Required: certain8949 ? true : (gate !== null && hasRows) || cats.some(undeterminedRouting) ? "blocking" : false,
    categories,
    line17,
    line20,
    line22,
    taxWorksheetNeeded,
  };

  // ── Open items ─────────────────────────────────────────────────────────────
  for (const cat of cats) {
    if (cat.brokerGain === null || cat.proceeds === null || cat.cost === null || cat.wash === null) continue;
    const before = cat.proceeds.minus(cat.cost);
    const after = before.plus(cat.wash);
    // the broker prints cents: a difference of one cent or less is rounding
    const tolerance = D("0.01");
    if (cat.brokerGain.minus(before).abs().lessThanOrEqualTo(tolerance) || cat.brokerGain.minus(after).abs().lessThanOrEqualTo(tolerance)) continue;
    items.push({
      id: `schd-reconciliation:${cat.form}:${cat.box}`,
      severity: "blocking",
      message: `${cat.form} box ${cat.box}: the broker's printed gain ${fmt(cat.brokerGain)} matches neither proceeds minus cost (${fmt(before)}) nor that plus the wash sale add-back (${fmt(after)}): one of the read figures is probably wrong.`,
      action: "Compare each figure with the summary of proceeds in the PDF on the document review screen and correct it.",
      lineKeys: [],
      refs: cat.refs,
    });
  }
  if (unread.length > 0) {
    items.push({
      id: "schd-unread",
      severity: "blocking",
      message: "A 1099 shows 1099-B sales but its sales summary has not been read, so Schedule D cannot be figured.",
      action: "Re-extract the document on its review screen, compare each category with the PDF, and confirm.",
      lineKeys: ["schd.16", "f1040.7a"],
      refs: unread.flatMap((u) => u.refs),
    });
  }
  if (salesState === "no" || salesState === "unsure" || (salesState === "missing" && hasRows)) {
    items.push({
      id: "schd-other-sales",
      severity: "blocking",
      message:
        salesState === "no"
          ? "The owner says the broker statement does not list every sale (another broker, or a sale outside a brokerage account): Schedule D is incomplete until those sales are added."
          : salesState === "unsure"
            ? "The owner is not sure the broker statement lists every sale: the CPA decides whether other sales exist."
            : "It is not answered whether the broker statement lists every sale.",
      action: "Answer the capital gains questions; add the other sales (their Form 1099-B or statements) if there are any.",
      lineKeys: ["schd.16", "f1040.7a"],
      refs: input.salesComplete.refs,
    });
  }
  if (hasRows && adjState !== "yes") {
    items.push({
      id: "schd-adjustments-owner",
      severity: "blocking",
      message:
        adjState === "missing"
          ? "It is not answered whether the broker could not know of an adjustment (wash sale in another account, inherited / gifted / related-party basis, wrong cost)."
          : "The owner says the broker could not know of an adjustment, or is not sure: the Form 8949 adjustments are not collected here.",
      action: "The CPA decides the Form 8949 adjustments (column (g) and codes); the broker totals are not final until then.",
      lineKeys: ["schd.1a.h", "schd.8a.h", "schd.16"],
      refs: input.noBrokerAdjustments.refs,
    });
  }
  if (input.section1256.present || da) {
    items.push({
      id: "schd-1256-or-1099da",
      severity: "blocking",
      message: [
        input.section1256.present
          ? `A Section 1256 section (futures / index options taxed at year end${input.section1256.aggregate !== null ? `, aggregate ${fmt(input.section1256.aggregate)}` : ""}) is present: Form 6781 is not computed, so Schedule D lines 4 and 11 need the CPA.`
          : "",
        da ? "A Form 1099-DA (digital assets) is present: its rows are computed with the same arithmetic as securities, but the 2025 digital asset reporting rules (basis not reported to the IRS, new boxes G to L) are new and need the CPA's review." : "",
      ]
        .filter((t) => t !== "")
        .join(" "),
      action: "Give the CPA the broker's Section 1256 / digital asset pages.",
      lineKeys: ["schd.4", "schd.11", "schd.16"],
      refs: dedupRefs([...input.section1256.refs, ...rows.filter((r) => r.form === "1099-DA").flatMap((r) => r.refs)]),
    });
  }
  if (da && !(input.digitalAssets.state === "answered" && input.digitalAssets.value === true)) {
    items.push({
      id: "schd-digital-answer",
      severity: "blocking",
      message: "A 1099-DA is on file but the Form 1040 digital assets question is not answered Yes.",
      action: "Answer the digital assets question in the Return completeness questionnaire so the return agrees with the 1099-DA.",
      lineKeys: [],
      refs: dedupRefs(rows.filter((r) => r.form === "1099-DA").flatMap((r) => r.refs)),
    });
  }
  if (hasRows && !taxWorksheetNeeded && (specialState === "no" || specialState === "unsure")) {
    items.push({
      id: "schd-special-rates",
      severity: "advisory",
      message:
        "The owner reports (or is not sure about) a sale of collectibles (including gold or silver trust shares), qualified small business stock, depreciated real estate or a partnership interest, or a QOF investment. Lines 15 and 16 are not both gains, so the Schedule D Tax Worksheet is not needed for the tax, but the 28% Rate Gain and Unrecaptured Section 1250 Gain Worksheets and the page 1 QOF box still need the CPA.",
      action: "The CPA reviews lines 18 and 19 and the QOF box.",
      lineKeys: ["schd.18", "schd.19"],
      refs: input.specialRatesNone.refs,
    });
  }
  if (anyForm8949) {
    items.push({
      id: "schd-attached-statement",
      severity: "advisory",
      message:
        "Form 8949 is filled as one summary row per broker and box (IRS Exception 2: the broker's name followed by \"see attached statement\", code M, plus W where there are wash sales). The broker's own 1099-B detail pages must be attached as the statement. Whether the broker's aggregated pages are an acceptable statement \"in a similar format\" (description, dates, proceeds, basis, adjustment and code, gain), or the CPA keys the transactions, is the CPA's call; an e-filed return with summary rows needs Form 8453 and the attachment mailed.",
      action: "Attach the Robinhood 1099-B pages to the packet; the CPA confirms the approach.",
      lineKeys: ["schd.1b.h", "schd.2.h", "schd.8b.h", "schd.9.h"],
      refs: allRowRefs,
    });
  }
  if (required === true && r16 !== null) {
    items.push({
      id: "schd-rounding",
      severity: "advisory",
      message:
        "A printed Schedule D line can differ by $1 from the sum of the printed cells above it (for example a Form 8949 summary row where column (d) minus (e) plus (g) is one dollar off column (h)). Every (h) cell and lines 7, 15 and 16 are figured from the cents and rounded once, as the Schedule D instructions say (\"include cents when adding the amounts and round off only the total\").",
      action: "No action: the CPA can see the cent-accurate amounts on each line's reason.",
      lineKeys: ["schd.7", "schd.15", "schd.16"],
      refs: [],
    });
    items.push({
      id: "schd-ct-capital-gains",
      severity: "advisory",
      message: CT_NOTE,
      action: "CPA to confirm no Connecticut modification applies to these capital gains or losses.",
      lineKeys: ["ct1040.1"],
      refs: [],
    });
  }

  const result: RuleResult = {
    ruleId: "schedule-d",
    form: "Schedule D",
    status: aggregateStatus(lines),
    lines,
    reasons: reasons.length > 0 ? reasons : ["Schedule D could not be figured yet."],
    citations: CITATIONS,
    inputsUsed: [],
    inputsMissing: [],
  };
  // the first blocking reason leads (it becomes the open item text)
  const firstBlocked = lines.find((l) => l.status !== undefined && l.status !== "computed" && l.status !== "not_applicable" && l.reason !== undefined);
  if (firstBlocked?.reason !== undefined) result.reasons = [firstBlocked.reason, ...result.reasons];
  if (result.status === "missing_input") result.inputsMissing = ["Schedule D inputs (see the reasons on the lines)"];
  return { result, detail, openItems: items, assumptions, taxBlock };
}

// ── Capital loss carryover to 2026 (informational) ───────────────────────────

export interface CarryoverOutInput {
  /** Schedule D line 7 and line 15, signed whole dollars. */
  line7: Decimal;
  line15: Decimal;
  /** Schedule D line 21 (positive). */
  line21: Decimal;
  /** Form 1040 line 15 BEFORE the floor at 0 (line 11b minus line 14); may be negative. */
  taxableIncomeBeforeFloor: Decimal;
}

/**
 * The Capital Loss Carryover Worksheet of the Schedule D instructions applied to the 2025 figures (worksheet lines 1-13). The 2026
 * instructions' worksheet governs the real carryover, so this is provisional. Returns null when there is no loss carryover.
 */
export function computeCapitalLossCarryoverOut(i: CarryoverOutInput): { shortCents: number; longCents: number; totalCents: number } | null {
  const w1 = i.taxableIncomeBeforeFloor;
  const w2 = i.line21;
  const w3 = maxD(ZERO, w1.plus(w2));
  const w4 = minD(w2, w3);
  const shortLoss = i.line7.lessThan(0);
  const w5 = shortLoss ? i.line7.abs() : ZERO;
  const w6 = i.line15.greaterThan(0) ? i.line15 : ZERO;
  const w7 = w4.plus(w6);
  const w8 = shortLoss ? maxD(ZERO, w5.minus(w7)) : ZERO;
  const longLoss = i.line15.lessThan(0);
  const w9 = longLoss ? i.line15.abs() : ZERO;
  const w10 = i.line7.greaterThan(0) ? i.line7 : ZERO;
  const w11 = maxD(ZERO, w4.minus(w5));
  const w12 = w10.plus(w11);
  const w13 = longLoss ? maxD(ZERO, w9.minus(w12)) : ZERO;
  if (w8.isZero() && w13.isZero()) return null;
  return { shortCents: dollarsToCents(w8), longCents: dollarsToCents(w13), totalCents: dollarsToCents(w8.plus(w13)) };
}

export function carryoverOutOpenItem(co: { shortCents: number; longCents: number; totalCents: number }): OpenItem {
  const d = (c: number): string => fmt(D(c).div(D(dollarsToCents(D(1)))));
  return {
    id: "schd-carryover-out",
    severity: "advisory",
    message: `A capital loss carries over to 2026: ${d(co.totalCents)} (short-term ${d(co.shortCents)}, long-term ${d(co.longCents)}), figured with the Capital Loss Carryover Worksheet logic on the 2025 numbers. Provisional: the 2026 worksheet governs.`,
    action: "Keep the 2025 Schedule D and Form 1040 (the 2026 Capital Loss Carryover Worksheet needs them).",
    lineKeys: ["schd.21"],
    refs: [],
  };
}
