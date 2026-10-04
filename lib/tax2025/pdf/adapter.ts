// THE adapter (plan sections 5.3 and 9/T9): the only file of the PDF layer that reads
// the engine's shapes. It turns a real Ty2025Return (+ the Ty2025Facts it was computed
// from) into the plain, JSON-safe PdfReturnView every other PDF module depends on.
//
//   - money is INTEGER DOLLARS (the engine already rounded every line with roundLine);
//     table rows from facts (cents) are converted with the engine's own rounding; no
//     Decimal ever leaves this file, and `results` (which holds Decimals) is only read
//     for decision/alternative text, never copied;
//   - nothing is invented: a line the engine marks missing / needs-CPA / not-yet-computed
//     keeps that status and no amount (the blank policy in policy.ts then leaves it blank);
//   - the T7 override module (lib/tax2025/overrides.ts) is NOT in this branch. The
//     `overrides` option is a structural placeholder shaped like its EffectiveReturn
//     (plan 7.4); T9b passes `{ effective, formatNote: formatOverrideNote }`.
//
// Pure: no I/O, no clock (the caller supplies generatedAt / generatedBy).

import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { centsToDollars, roundLine } from "@/lib/tax2025/money";
import { ctPropertyTaxRows } from "@/lib/tax2025/pdf/ct-property-tax";
import { F8949_BOX_CELL, F8949_TOTAL_COLUMNS } from "@/lib/tax2025/pdf/f8949-layout";
import { fingerprintOf } from "@/lib/tax2025/pdf/format";
import type {
  PdfAnswer,
  PdfDecision,
  PdfFormRequirement,
  PdfLine,
  PdfLineStatus,
  PdfOpenItem,
  PdfOverrideEntry,
  PdfReturnView,
  PdfTableRow,
  TableKey,
} from "@/lib/tax2025/pdf/types";
import {
  LINE_KEYS,
  hasAmount,
  lineMeta,
  type Headline,
  type LineKey,
  type OpenItem,
  type RuleAlternative,
  type RuleDecision,
  type RuleStatus,
  type ReturnLine,
  type Ty2025Return,
} from "@/lib/tax2025/types";

// ── Table column ids (the maps' MapTable rows must use these names) ───────────

export const TABLE_COLUMNS = {
  "schb.interest": { label: "payer", amount: "amount" },
  "schb.dividends": { label: "payer", amount: "amount" },
  /** CT-1040 withholding rows 18a-18e: employer, FEIN, CT wages, CT tax withheld. */
  "ct.withholding": { label: "employer", ein: "ein", wages: "wages", amount: "withheld" },
  "schc.otherExpenses": { label: "label", amount: "amount" },
  /** CT-1040 Schedule 3 rows 60-62 (built by ct-property-tax.ts, whose columns are CT_PROPERTY_TABLE_COLUMNS). */
  "ct.propertyTax": { label: "description", amount: "amount" },
} as const;

export const PAYER_NOT_READ = "Payer not read";
export const EMPLOYER_NOT_READ = "Employer not read";

// ── Override placeholder (structural subset of overrides.ts EffectiveReturn) ──

/** The part of an applied line override the adapter needs (AppliedLineOverride in overrides.ts satisfies it). */
export interface LineOverrideLike {
  was: { status: RuleStatus; amount: number | null };
  /** Override value in whole dollars. */
  nowAmount: number;
  /** Non-null when the base changed after the override was set. */
  stale: object | null;
}

export interface EffectiveLineLike<O extends LineOverrideLike> {
  base: ReturnLine;
  effective: { amount: number | null; status: RuleStatus | "overridden" };
  override?: O;
  stale?: object;
}

export interface EffectiveReturnLike<O extends LineOverrideLike> {
  lines: Partial<Record<LineKey, EffectiveLineLike<O>>>;
  /** Adjusted open items (acknowledged blocking items removed, override items added). */
  openItems: readonly OpenItem[];
  acknowledged: ReadonlyArray<{ ruleId: string }>;
  decisions: readonly RuleDecision[];
  headline: Headline;
}

export interface AdapterOverrides<O extends LineOverrideLike> {
  effective: EffectiveReturnLike<O>;
  /** formatOverrideNote from overrides.ts: the single note string used by sheet, CSV and PDF. */
  formatNote: (override: O) => string;
}

export interface ToPdfViewOptions<O extends LineOverrideLike = LineOverrideLike> {
  /** ISO timestamp the view is built (shown in America/New_York on the cover). */
  generatedAt: string;
  /** Display name of the signed-in user who generated the packet. */
  generatedBy: string;
  /** EK Consulting's name for the Schedule C business-name field (facts do not carry it). */
  ekcName?: string | null;
  /**
   * Household answers the engine does not carry yet (digital assets, Schedule C accounting
   * method / material participation / principal business / business code / home square
   * footage: Phase 1b attestations). Passed through as given, never invented; they cannot
   * override `filingStatus`, which is fixed by the engine (MFJ only).
   */
  answers?: Readonly<Record<string, PdfAnswer>>;
  overrides?: AdapterOverrides<O>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Integer cents -> whole dollars with the engine's rounding. */
export function centsToWholeDollars(cents: number): number {
  return roundLine(centsToDollars(cents)).toNumber();
}

function sumCentsOrNull(values: ReadonlyArray<number | null>): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function carriesAmount(status: PdfLineStatus): boolean {
  return status === "overridden" || hasAmount(status);
}

function formLabelOfKey(key: string, lines: Partial<Record<LineKey, ReturnLine>>): string {
  const known = lines[key as LineKey];
  if (known) return known.form;
  try {
    return lineMeta(key as LineKey).form;
  } catch {
    return "General";
  }
}

// ── Forms required (the engine's verdict, plan C7) ───────────────────────────

/** Plain copy of Ty2025Return.formsRequired: the packet follows the engine's verdict before any line rule (policy.ts). */
function formsRequiredOf(ret: Ty2025Return): Partial<Record<string, PdfFormRequirement>> {
  const out: Partial<Record<string, PdfFormRequirement>> = {};
  for (const [id, v] of Object.entries(ret.formsRequired)) {
    if (v !== undefined) out[id] = { required: v.required, reason: v.reason };
  }
  return out;
}

// ── Decisions ─────────────────────────────────────────────────────────────────

function alternativeText(a: RuleAlternative): string {
  const detail = a.effect?.note ?? a.reasons[0] ?? a.status.replace(/_/g, " ");
  return clip(`${a.label}: ${detail}`, 260);
}

function toPdfDecision(d: RuleDecision, results: Ty2025Return["results"]): PdfDecision {
  const result = results.find((r) => r.decision?.id === d.id);
  const alternatives = result?.alternatives ?? [];
  const inForce = alternatives.find((a) => a.inForce);
  const others = alternatives.filter((a) => !a.inForce);
  const parts: string[] = [];
  if (inForce) parts.push(`In force: ${alternativeText(inForce)}`);
  if (d.status === "default_undecided" && others.length > 0) {
    parts.push(`Alternatives: ${others.map(alternativeText).join(" | ")}`);
  }
  const out: PdfDecision = { id: d.id, label: d.label, chosen: d.chosen, status: d.status };
  if (d.decidedBy !== undefined) out.decidedBy = d.decidedBy;
  if (d.decidedAt !== undefined) out.decidedAt = d.decidedAt;
  if (parts.length > 0) out.effectNote = parts.join(" ");
  return out;
}

/**
 * Lines of a rule whose in-force alternative is the default of an undecided decision
 * (plan 6.4): key -> the decision label for the field tooltip "default, undecided: ...".
 * Only the lines the in-force alternative itself carries are tagged, so e.g. Schedule C
 * line 30 is tagged but gross receipts are not.
 */
function defaultUndecidedLines(ret: Ty2025Return): Map<LineKey, string> {
  const out = new Map<LineKey, string>();
  for (const r of ret.results) {
    if (r.decision?.status !== "default_undecided") continue;
    for (const alt of r.alternatives ?? []) {
      if (!alt.inForce || !alt.isDefault) continue;
      for (const l of alt.lines) {
        if (ret.lines[l.key] !== undefined) out.set(l.key, r.decision.label);
      }
    }
  }
  return out;
}

// ── Tables (from facts) ───────────────────────────────────────────────────────

interface TableBuild {
  tables: Partial<Record<TableKey, PdfTableRow[]>>;
  /** Advisory notes the adapter raises about the tables (ids prefixed "adapter:"). */
  items: PdfOpenItem[];
}

function sumColumn(rows: readonly PdfTableRow[], column: string): number {
  let total = 0;
  for (const r of rows) {
    const v = r.cells[column];
    if (typeof v === "number") total += v;
  }
  return total;
}

function roundingItem(
  id: string,
  formLabel: string,
  lineKey: LineKey,
  rowsTotal: number,
  ret: Ty2025Return,
): PdfOpenItem | null {
  const line = ret.lines[lineKey];
  if (!line || !hasAmount(line.status) || line.amount === null || line.amount === rowsTotal) return null;
  return {
    id,
    severity: "advisory",
    formLabel,
    lineKeys: [lineKey],
    message: `The printed rows (each rounded to whole dollars) total $${rowsTotal} but ${formLabel} line ${line.formLine} is $${line.amount}: the engine rounds the sum once, as the IRS instructs. Difference is rounding only.`,
    action: "Check the rows against the source documents; the line total is the engine's.",
  };
}

function buildTables(ret: Ty2025Return, facts: Ty2025Facts): TableBuild {
  const tables: Partial<Record<TableKey, PdfTableRow[]>> = {};
  const items: PdfOpenItem[] = [];
  const cols = TABLE_COLUMNS;

  // Schedule B Part I / II payers.
  const interestRows: PdfTableRow[] = facts.income.interest.map((i) => {
    const cents = sumCentsOrNull([i.box1Cents, i.box3Cents]);
    return {
      cells: {
        [cols["schb.interest"].label]: i.payer ?? PAYER_NOT_READ,
        [cols["schb.interest"].amount]: cents === null ? null : centsToWholeDollars(cents),
      },
    };
  });
  const dividendRows: PdfTableRow[] = facts.income.dividends.map((d) => ({
    cells: {
      [cols["schb.dividends"].label]: d.payer ?? PAYER_NOT_READ,
      [cols["schb.dividends"].amount]: d.box1aCents === null ? null : centsToWholeDollars(d.box1aCents),
    },
  }));
  tables["schb.interest"] = interestRows;
  tables["schb.dividends"] = dividendRows;
  if (facts.income.interest.some((i) => i.payer === null) || facts.income.dividends.some((d) => d.payer === null)) {
    items.push({
      id: "adapter:schb.payer-not-read",
      severity: "advisory",
      formLabel: "Schedule B",
      lineKeys: ["schb.2", "schb.6"],
      message: `At least one 1099 payer name was not read; the Schedule B row shows "${PAYER_NOT_READ}".`,
      action: "Key the payer name from the 1099.",
    });
  }
  const ri = roundingItem("adapter:schb.interest-rounding", "Schedule B", "schb.2", sumColumn(interestRows, cols["schb.interest"].amount), ret);
  if (ri && interestRows.every((r) => typeof r.cells[cols["schb.interest"].amount] === "number")) items.push(ri);
  const rd = roundingItem("adapter:schb.dividends-rounding", "Schedule B", "schb.6", sumColumn(dividendRows, cols["schb.dividends"].amount), ret);
  if (rd && dividendRows.every((r) => typeof r.cells[cols["schb.dividends"].amount] === "number")) items.push(rd);

  // CT-1040 withholding rows (18a-18e): one per W-2 with CT withholding.
  const ctRows: PdfTableRow[] = [];
  let ctMissingEin = false;
  for (const w of facts.income.w2s) {
    const withheld = w.ctWithheldCents;
    if (withheld === null || withheld === 0) continue;
    const ctWages = w.stateLines.filter((s) => s.stateCode?.toUpperCase() === "CT");
    const wagesCents = ctWages.length > 0 ? sumCentsOrNull(ctWages.map((s) => s.wagesCents)) : null;
    if (w.employerEin === null || w.employerEin.trim() === "") ctMissingEin = true;
    ctRows.push({
      cells: {
        [cols["ct.withholding"].label]: w.employer ?? EMPLOYER_NOT_READ,
        [cols["ct.withholding"].ein]: w.employerEin !== null && w.employerEin.trim() !== "" ? w.employerEin.trim() : null,
        [cols["ct.withholding"].wages]: wagesCents === null ? null : centsToWholeDollars(wagesCents),
        [cols["ct.withholding"].amount]: centsToWholeDollars(withheld),
      },
    });
  }
  tables["ct.withholding"] = ctRows;
  if (ctMissingEin) {
    items.push({
      id: "adapter:ct.withholding-ein",
      severity: "advisory",
      formLabel: "CT-1040",
      lineKeys: [],
      message: "An employer FEIN was not read for a CT withholding row; the FEIN cell is left blank.",
      action: "Key the employer FEIN from the W-2 (box b).",
    });
  }

  // CT-1040 Schedule 3 (property tax credit) rows 60-62: the engine's own qualifying rule
  // (primary residence + up to two motor vehicles); other real estate / personal property never appears.
  tables["ct.propertyTax"] = ctPropertyTaxRows(facts.deductions.propertyTaxBills).rows;

  // Schedule C Part V other expenses (rows only when the engine exposes the items).
  let partVRows: PdfTableRow[] = [];
  if (ret.scheduleC) {
    partVRows = ret.scheduleC.otherExpenseItems.map((o) => ({
      cells: {
        [cols["schc.otherExpenses"].label]: o.name,
        [cols["schc.otherExpenses"].amount]: centsToWholeDollars(o.amountCents),
      },
    }));
    tables["schc.otherExpenses"] = partVRows;
    const rc = roundingItem("adapter:schc.other-rounding", "Schedule C", "schc.27b", sumColumn(partVRows, cols["schc.otherExpenses"].amount), ret);
    if (rc) items.push(rc);
  }
  // A non-zero line 48 / 27b with no Part V rows is never silent (maps tester D3), whether the engine
  // exposed an empty item list or no Schedule C detail at all (books unreadable).
  const l48 = ret.lines["schc.48"];
  const l27b = ret.lines["schc.27b"];
  const otherTotal = [l48, l27b].map((l) => (l && hasAmount(l.status) && l.amount !== null ? l.amount : 0)).find((n) => n !== 0) ?? 0;
  if (partVRows.length === 0 && otherTotal !== 0) {
    items.push({
      id: "adapter:schc.other-no-items",
      severity: "advisory",
      formLabel: "Schedule C",
      lineKeys: ["schc.27b", "schc.48"],
      message: `Schedule C line 48 (other expenses, carried to line 27b) is $${otherTotal} but the engine exposes no per-item data, so the Part V rows are blank.`,
      action: "List the other expenses in Part V from the books.",
    });
  }

  return { tables, items };
}

// ── Form 8949 rows (from the engine's Schedule D detail) ─────────────────────

/** Column (f) code(s) and the text of column (a) of a summary row (IRS Exception 2). */
export const BROKER_NOT_READ = "Broker not read";
export const SEE_ATTACHED_STATEMENT = "see attached statement";

function schdKey(line: string, column: "d" | "e" | "g" | "h"): LineKey | null {
  const key = `schd.${line}.${column}`;
  return (LINE_KEYS as readonly string[]).includes(key) ? (key as LineKey) : null;
}

/** Whole dollars of a Schedule D cell as the view carries it (effective, so CPA overrides print), or null when it has none. */
function cellAmount(lines: Partial<Record<LineKey, PdfLine>>, line: string, column: "d" | "e" | "g" | "h"): number | null {
  const key = schdKey(line, column);
  const l = key === null ? undefined : lines[key];
  if (l === undefined || !carriesAmount(l.status)) return null;
  return l.amount;
}

interface F8949Build {
  tables: Partial<Record<TableKey, PdfTableRow[]>>;
  items: PdfOpenItem[];
}

/**
 * Form 8949 summary rows, one per broker per box (the categories the engine routes through Form 8949; clean A / D
 * categories go straight to Schedule D lines 1a / 8a and never appear here). Every row carries its box so
 * maps/f8949.ts can split them into copies. The Totals rows are the engine's own Schedule D line totals (the
 * numbers on lines 1b / 2 / 3 / 8b / 9 / 10). Rows come from cents with the engine's rounding; a column (g) of
 * zero is blank (a blank is zero); nothing is invented: a null stays blank.
 */
function buildF8949(ret: Ty2025Return, lines: Partial<Record<LineKey, PdfLine>>): F8949Build {
  const items: PdfOpenItem[] = [];
  const detail = ret.scheduleD;
  // No Form 8949 category: no tables at all (the view of a return without sales is unchanged).
  if (!detail || !detail.categories.some((c) => c.routing === "form_8949_summary")) return { tables: {}, items };
  const partI: PdfTableRow[] = [];
  const partII: PdfTableRow[] = [];
  const totalsI: PdfTableRow[] = [];
  const totalsII: PdfTableRow[] = [];
  const dollars = (cents: number | null): number | null => (cents === null ? null : centsToWholeDollars(cents));
  for (const cat of detail.categories) {
    if (cat.routing !== "form_8949_summary") continue;
    const rows = cat.part === "I" ? partI : partII;
    const rowsOfBox: PdfTableRow[] = [];
    for (const r of cat.rows) {
      const wash = r.washSaleCents;
      const row: PdfTableRow = {
        cells: {
          [F8949_BOX_CELL]: cat.box,
          a: `${r.payer ?? BROKER_NOT_READ} - ${SEE_ATTACHED_STATEMENT}`,
          b: null,
          c: null,
          d: dollars(r.proceedsCents),
          e: dollars(r.costCents),
          f: wash !== null && wash > 0 ? "MW" : "M",
          g: wash !== null && wash > 0 ? centsToWholeDollars(wash) : null,
          h: dollars(r.gainCents),
        },
      };
      rows.push(row);
      rowsOfBox.push(row);
    }
    const totalCells: Record<string, string | number | null> = { [F8949_BOX_CELL]: cat.box };
    for (const c of F8949_TOTAL_COLUMNS) {
      const v = cellAmount(lines, cat.line, c);
      totalCells[c] = c === "g" && v === 0 ? null : v;
    }
    (cat.part === "I" ? totalsI : totalsII).push({ cells: totalCells });
    // The printed rows (each rounded) against the Schedule D line (rounded once from cents): rounding only.
    for (const c of F8949_TOTAL_COLUMNS) {
      const total = totalCells[c];
      const cellsOfRows = rowsOfBox.map((r) => r.cells[c]);
      if (typeof total !== "number" || !cellsOfRows.every((v) => v === null || typeof v === "number")) continue;
      const sum = cellsOfRows.reduce<number>((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
      if (sum !== total) {
        items.push({
          id: `adapter:f8949.rounding:${cat.box}:${c}`,
          severity: "advisory",
          formLabel: "Form 8949",
          lineKeys: [],
          message: `Form 8949 box ${cat.box} column (${c}): the printed summary rows (each rounded to whole dollars) total $${sum} but Schedule D line ${cat.line} shows $${total}: the engine rounds the sum once, as the IRS instructs. Difference is rounding only.`,
          action: "Check the rows against the broker's 1099-B; the Schedule D line total is the engine's.",
        });
      }
    }
  }
  return { tables: { "f8949.partI": partI, "f8949.partII": partII, "f8949.totalsI": totalsI, "f8949.totalsII": totalsII }, items };
}

// ── Header ────────────────────────────────────────────────────────────────────

interface HeaderBuild {
  header: PdfReturnView["header"];
  items: PdfOpenItem[];
}

/**
 * The taxpayer is the OWNER OF EK CONSULTING (the engine infers the Schedule C owner from the
 * LLC name): Schedule C and SE print that name and the 1040 lists that person first. When the
 * owner cannot be matched to a household person the taxpayer / spouse names stay blank and an
 * open item says so (nothing is guessed); the schedules that print both names still get them.
 */
function householdOrder(facts: Ty2025Facts): {
  people: Ty2025Facts["household"]["people"];
  taxpayer: Ty2025Facts["household"]["people"][number] | undefined;
  spouse: Ty2025Facts["household"]["people"][number] | undefined;
} {
  const people = facts.household.people.filter((p) => p.name.trim() !== "");
  const ownerId = facts.income.scheduleC.ownerUserId.value;
  const taxpayer = ownerId === null ? undefined : people.find((p) => p.userId === ownerId);
  const spouse = taxpayer ? people.find((p) => p !== taxpayer) : undefined;
  return { people, taxpayer, spouse };
}

function buildHeader(facts: Ty2025Facts, ekcName: string | null): HeaderBuild {
  const { people, taxpayer, spouse } = householdOrder(facts);
  const ordered = taxpayer ? [taxpayer, ...(spouse ? [spouse] : [])] : people.slice(0, 2);
  const names = ordered.map((p) => p.name.trim());
  const items: PdfOpenItem[] = [];
  if (!taxpayer) {
    items.push({
      id: "adapter:header.owner-unknown",
      severity: "advisory",
      formLabel: "General",
      lineKeys: [],
      message:
        "The owner of EK Consulting (the Schedule C proprietor) could not be matched to a household person, so the taxpayer and spouse name fields (Form 1040, Schedules C and SE) are left blank.",
      action: "Key the names, or record who owns EK Consulting.",
    });
  }
  return {
    header: {
      householdNames: names.length > 0 ? names.join(" and ") : null,
      taxpayerName: taxpayer ? taxpayer.name.trim() : null,
      spouseName: spouse ? spouse.name.trim() : null,
      ekcName: ekcName !== null && ekcName.trim() !== "" ? ekcName.trim() : null,
    },
    items,
  };
}

// ── Answers ───────────────────────────────────────────────────────────────────

/**
 * Answers the maps read (checkboxes and text boxes). Only what the engine/facts already carry
 * is derived; everything else stays undefined (unchecked + an advisory "answer needed" item):
 *   filingStatus          the engine's (MFJ only)
 *   schdNotRequired       Form 1040 line 7b box: ret.scheduleD.exception1 (boolean, set whenever the detail exists)
 *   schd.l17 / l20 / l22  Schedule D lines 17 / 20 / 22 from ret.scheduleD ("yes" | "no"); 17 only when line 16 is a gain
 *   schd.qof              Schedule D page 1 QOF box: "no" only when the owner stated none for capital_special_rates
 *   schC.officeSqft       facts home-office square footage, only for an exclusive-use office
 *   digitalAssets         ret.attestations.digitalAssets, "yes" / "no" only when status is "answered"
 *   foreignAccounts, foreignTrust, fincenRequired
 *                         ret.attestations.foreignAccounts is ONE questionnaire question covering foreign
 *                         accounts AND trusts: an answered "No" is "no" for all three Schedule B Part III
 *                         questions; an answered "Yes" does not say which one applies, so none is set
 *                         (the CPA completes Part III; the engine already raises a blocking item)
 *   age65Taxpayer, blindTaxpayer, age65Spouse, blindSpouse
 *                         facts.returnAnswers.people[] (bornBefore1961 / blind), matched by user id to the
 *                         same taxpayer (Schedule C owner) / spouse ordering the header uses; a boolean only
 *                         when the owner answered it (unanswered / "not sure" stays undefined)
 * Not carried by the engine yet (via opts.answers): schC.accountingMethod, schC.materialParticipation,
 * schC.principalBusiness, schC.businessCode, schC.homeSqft.
 */
function buildAnswers(ret: Ty2025Return, facts: Ty2025Facts, extra: Readonly<Record<string, PdfAnswer>> | undefined): Record<string, PdfAnswer> {
  const answers: Record<string, PdfAnswer> = {};
  const sc = facts.income.scheduleC;
  if (sc.homeOfficeEligibility.value === "yes_exclusive" && sc.homeOfficeSqft.value !== null) {
    answers["schC.officeSqft"] = String(sc.homeOfficeSqft.value);
  }
  // Header yes / no questions the owner answered (Phase 1b attestations).
  const att = ret.attestations;
  if (att?.digitalAssets.status === "answered" && att.digitalAssets.value !== null) {
    answers["digitalAssets"] = att.digitalAssets.value ? "yes" : "no";
  }
  if (att?.foreignAccounts.status === "answered" && att.foreignAccounts.value === false) {
    answers["foreignAccounts"] = "no";
    answers["foreignTrust"] = "no";
    answers["fincenRequired"] = "no";
  }
  // Line 12d age / blind boxes, per person.
  const { taxpayer, spouse } = householdOrder(facts);
  const flags = (userId: string | undefined): { age: boolean | null; blind: boolean | null } | null => {
    if (userId === undefined) return null;
    const p = facts.returnAnswers.people.find((x) => x.userId === userId);
    return p ? { age: p.bornBefore1961.value, blind: p.blind.value } : null;
  };
  const t = flags(taxpayer?.userId);
  const s = flags(spouse?.userId);
  if (t?.age != null) answers["age65Taxpayer"] = t.age;
  if (t?.blind != null) answers["blindTaxpayer"] = t.blind;
  if (s?.age != null) answers["age65Spouse"] = s.age;
  if (s?.blind != null) answers["blindSpouse"] = s.blind;
  // Schedule D / Form 1040 line 7b (the engine's Schedule D detail; nothing is set when the detail is absent).
  const sd = ret.scheduleD;
  if (sd) {
    answers["schdNotRequired"] = sd.exception1;
    // Line 17 is asked only when line 16 is a gain (a loss or zero skips lines 17-20). Line 20 follows a Yes on 17.
    const l16 = ret.lines["schd.16"];
    const gain16 = l16 !== undefined && hasAmount(l16.status) && l16.amount !== null && l16.amount > 0;
    if (gain16 && sd.line17 !== null) {
      answers["schd.l17"] = sd.line17 ? "yes" : "no";
      if (sd.line17 && sd.line20 !== null) answers["schd.l20"] = sd.line20 ? "yes" : "no";
    }
    if (sd.line22 !== null) answers["schd.l22"] = sd.line22 ? "yes" : "no";
  }
  // Schedule D page 1: "did you dispose of an investment in a qualified opportunity fund?" is part of the owner's
  // "capital_special_rates" none-group statement (collectibles, QSB stock, depreciated real estate, QOF). Only a
  // stated "none" answers it ("no"); a yes / not-sure / missing statement leaves both boxes unchecked.
  if (facts.statedNone.capital_special_rates?.value === true) answers["schd.qof"] = "no";
  for (const [k, v] of Object.entries(extra ?? {})) answers[k] = v;
  answers["filingStatus"] = ret.filingStatus;
  return answers;
}

// ── The adapter ───────────────────────────────────────────────────────────────

export function toPdfReturnView<O extends LineOverrideLike = LineOverrideLike>(
  ret: Ty2025Return,
  facts: Ty2025Facts,
  opts: ToPdfViewOptions<O>,
): PdfReturnView {
  const ov = opts.overrides;
  const undecided = defaultUndecidedLines(ret);

  const lines: Partial<Record<LineKey, PdfLine>> = {};
  const fingerprintLines: Partial<Record<LineKey, ReturnLine>> = {};
  const overrideEntries: PdfOverrideEntry[] = [];

  for (const key of LINE_KEYS) {
    const base = ret.lines[key];
    if (!base) continue;
    const eff = ov?.effective.lines[key];
    const status: PdfLineStatus = eff ? eff.effective.status : base.status;
    const amount = carriesAmount(status) ? (eff ? eff.effective.amount : base.amount) : null;
    const line: PdfLine = {
      key,
      status,
      amount,
      reason: base.reason,
      formLabel: base.form,
      formLine: base.formLine,
      label: base.label,
    };
    if (base.informational === true) line.informational = true;
    const label = undecided.get(key);
    if (label !== undefined) line.defaultUndecided = label;
    if (eff?.override && ov) {
      const o = eff.override;
      const stale = o.stale !== null || eff.stale !== undefined;
      const note = ov.formatNote(o);
      line.override = { note, computedAmount: o.was.amount, stale };
      overrideEntries.push({ key, formLabel: base.form, formLine: base.formLine, note, stale });
    }
    lines[key] = line;
    fingerprintLines[key] = { ...base, status: status === "overridden" ? base.status : status, amount };
  }

  // Open items: the effective (override-adjusted) list when given, else the engine's own.
  const engineItems: readonly OpenItem[] = ov ? ov.effective.openItems : ret.openItems;
  const openItems: PdfOpenItem[] = engineItems.map((i) => ({
    id: i.id,
    severity: i.severity,
    formLabel: i.lineKeys.length > 0 ? formLabelOfKey(i.lineKeys[0] as string, ret.lines) : "General",
    lineKeys: [...i.lineKeys],
    message: i.message,
    action: i.action,
  }));

  const decisionsSource: readonly RuleDecision[] = ov ? ov.effective.decisions : ret.decisions;
  const decisions = decisionsSource.map((d) => toPdfDecision(d, ret.results));
  const headline = ov ? ov.effective.headline : ret.headline;

  const formsRequired = formsRequiredOf(ret);
  const built = buildTables(ret, facts);
  openItems.push(...built.items);
  const f8949 = buildF8949(ret, lines);
  built.tables = { ...built.tables, ...f8949.tables };
  openItems.push(...f8949.items);

  const answers = buildAnswers(ret, facts, opts.answers);
  const header = buildHeader(facts, opts.ekcName ?? null);
  openItems.push(...header.items);

  // Fingerprint of the return state (never `results`: it carries Decimals and rule internals).
  // It also covers the table rows (Schedule B payers, CT withholding / property tax, Part V) and the forms verdicts,
  // so two packets that differ in any of them never share a fingerprint.
  const fingerprint = fingerprintOf({
    lines: fingerprintLines,
    openItems: engineItems,
    decisions: decisionsSource,
    headline,
    tables: built.tables,
    formsRequired,
  });

  return {
    taxYear: ret.taxYear,
    filingStatus: ret.filingStatus,
    generatedAt: opts.generatedAt,
    generatedBy: opts.generatedBy,
    fingerprint,
    engineVersion: ret.engineVersion,
    formsRequired,
    lines,
    header: header.header,
    answers,
    tables: built.tables,
    openItems,
    decisions,
    overrides: overrideEntries,
    acknowledged: ov ? ov.effective.acknowledged.map((a) => a.ruleId) : [],
    headline,
    citations: [...ret.citations],
  };
}
