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
import { fingerprintOf } from "@/lib/tax2025/pdf/format";
import type {
  PdfAnswer,
  PdfDecision,
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

  // Schedule C Part V other expenses (only when the engine exposes the items).
  if (ret.scheduleC) {
    const rows: PdfTableRow[] = ret.scheduleC.otherExpenseItems.map((o) => ({
      cells: {
        [cols["schc.otherExpenses"].label]: o.name,
        [cols["schc.otherExpenses"].amount]: centsToWholeDollars(o.amountCents),
      },
    }));
    tables["schc.otherExpenses"] = rows;
    const rc = roundingItem("adapter:schc.other-rounding", "Schedule C", "schc.27b", sumColumn(rows, cols["schc.otherExpenses"].amount), ret);
    if (rc) items.push(rc);
    const l27b = ret.lines["schc.27b"];
    if (rows.length === 0 && l27b && hasAmount(l27b.status) && l27b.amount !== null && l27b.amount !== 0) {
      items.push({
        id: "adapter:schc.other-no-items",
        severity: "advisory",
        formLabel: "Schedule C",
        lineKeys: ["schc.27b", "schc.48"],
        message: `Schedule C line 27b (other expenses) is $${l27b.amount} but the engine exposes no per-item data, so the Part V rows are blank.`,
        action: "List the other expenses in Part V from the books.",
      });
    }
  }

  return { tables, items };
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
function buildHeader(facts: Ty2025Facts, ekcName: string | null): HeaderBuild {
  const people = facts.household.people.filter((p) => p.name.trim() !== "");
  const ownerId = facts.income.scheduleC.ownerUserId.value;
  const taxpayer = ownerId === null ? undefined : people.find((p) => p.userId === ownerId);
  const spouse = taxpayer ? people.find((p) => p !== taxpayer) : undefined;
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
 *   schC.officeSqft       facts home-office square footage, only for an exclusive-use office
 * Not carried by the engine yet (arrive with Phase 1b attestations, or via opts.answers):
 *   digitalAssets, schC.accountingMethod, schC.materialParticipation, schC.principalBusiness,
 *   schC.businessCode, schC.homeSqft.
 */
function buildAnswers(ret: Ty2025Return, facts: Ty2025Facts, extra: Readonly<Record<string, PdfAnswer>> | undefined): Record<string, PdfAnswer> {
  const answers: Record<string, PdfAnswer> = {};
  const sc = facts.income.scheduleC;
  if (sc.homeOfficeEligibility.value === "yes_exclusive" && sc.homeOfficeSqft.value !== null) {
    answers["schC.officeSqft"] = String(sc.homeOfficeSqft.value);
  }
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

  const built = buildTables(ret, facts);
  openItems.push(...built.items);

  const answers = buildAnswers(ret, facts, opts.answers);
  const header = buildHeader(facts, opts.ekcName ?? null);
  openItems.push(...header.items);

  // Fingerprint of the return state (never `results`: it carries Decimals and rule internals).
  const fingerprint = fingerprintOf({ lines: fingerprintLines, openItems: engineItems, decisions: decisionsSource, headline });

  return {
    taxYear: ret.taxYear,
    filingStatus: ret.filingStatus,
    generatedAt: opts.generatedAt,
    generatedBy: opts.generatedBy,
    fingerprint,
    engineVersion: ret.engineVersion,
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
