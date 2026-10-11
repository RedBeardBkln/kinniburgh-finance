// Pure parser and validator for the owner's utility usage history (utility-usage-upload, seasonal energy step 3): CSV
// text, pasted rows or one month at a time -> checked rows. No database, no clock (callers pass `today`, the New York
// calendar day as YYYY-MM-DD), no Next.js. Nothing in the text is ever interpreted as code, SQL or HTML.
//
// Contract (.claude/pipeline/utility-usage-upload/01-plan.md section 4):
//   * Hygiene first: over-size input, control characters, an unterminated quote, too many rows / columns or an over-long
//     cell refuse the WHOLE input with one error (never a partial parse).
//   * Our own RFC-4180 tokenizer with a delimiter sniff (tab, comma, semicolon, pipe); csv-parse is not used.
//   * The column mapping is only SUGGESTED from the header; the preview is always computed with the mapping the owner
//     confirms (role per column index). Unmapped columns are discarded and never stored.
//   * Numbers go straight to Decimal from the cleaned string, never via a float; no silent rounding (too many decimals is
//     an error). Month and date cells are US order and strict; two-digit years, Excel serials and day-first dates are refused.
//   * Hard sanity ranges per kind; softer ones are warnings. Note text is refused when it could be a formula (a cell that
//     starts with = + @ TAB or CR) or looks like an SSN / EIN / account number.
//   * The server re-parses the SAME text with the SAME mapping on save; the client never sends parsed rows.

import { Decimal } from "@prisma/client/runtime/library";
import { containsPrivateIdentifier } from "@/lib/tax-facts/validate";

export type UsageKind = "electric" | "oil" | "firewood";
export type UsageUnit = "kwh" | "gal" | "cord" | "face_cord";
export type ColumnRole = "month" | "periodEnd" | "quantity" | "cost" | "unit" | "note" | "ignore";
export type RowStatus = "new" | "unchanged" | "conflict" | "fills_cost" | "duplicate_in_file" | "error";

export const COLUMN_ROLES: readonly ColumnRole[] = ["month", "periodEnd", "quantity", "cost", "unit", "note", "ignore"];
export const MAX_TEXT_CHARS = 200_000;
export const MAX_ROWS = 600;
export const MAX_COLUMNS = 20;
export const MAX_CELL = 200;
export const MAX_NOTE = 120;
export const MAX_AGE_MONTHS = 120;
export const MAX_PERIOD_SPAN_DAYS = 62;

const ZERO = new Decimal(0);
const SNIP = 40;

export interface ParseInput {
  kind: UsageKind;
  text: string;
  /** The New York calendar day, YYYY-MM-DD. */
  today: string;
  /** Firewood only: the unit used when a row has no unit cell. Default "cord". */
  defaultUnit?: UsageUnit;
  /** One role per column index; missing entries mean "ignore". When absent the header-based suggestion is used. */
  mapping?: readonly ColumnRole[];
  site: { solarLiveFrom: string | null };
}

export interface ParsedRow {
  /** 1-based line of the input where this record starts. */
  line: number;
  /** Idempotency key WITHOUT the entity (see liveKeyOf); null when the row has an error. */
  key: string | null;
  /** YYYY-MM */
  period: string | null;
  /** YYYY-MM-DD */
  occurredOn: string | null;
  /** Canonical string with 3 decimals; null when the row has an error. */
  quantity: string | null;
  unit: UsageUnit | null;
  costCents: number | null;
  note: string | null;
  status: RowStatus;
  warnings: string[];
  errors: string[];
  /** The live saved row this one would replace (conflict / fills_cost). Set by classifyAgainstLive. */
  matchedId?: string;
}

export interface ColumnInfo {
  index: number;
  /** The header text (at most 40 characters), or null when the input has no header row. */
  header: string | null;
  /** The first data cell (at most 40 characters). */
  sample: string;
}

export interface ParseSummary {
  rowCount: number;
  /** Distinct periods among rows that are not errors. */
  months: number;
  first: string | null;
  last: string | null;
  counts: Record<RowStatus, number>;
}

export type ParseOutcome =
  | { ok: false; error: string }
  | {
      ok: true;
      delimiter: "," | "\t" | ";" | "|";
      hasHeader: boolean;
      /** True when the input was a recap table (years down, month names across) that was expanded to one row per month. */
      wide: boolean;
      columns: ColumnInfo[];
      /** The mapping the rows were computed with (the owner's, else the suggestion). */
      mapping: ColumnRole[];
      suggested: ColumnRole[];
      /** Set when the mapping cannot produce rows (for example no quantity column); rows is empty then. */
      mappingError: string | null;
      rows: ParsedRow[];
      summary: ParseSummary;
    };

/** A parse that produced a table (rows, possibly with a mapping error). */
export type ParseOk = Extract<ParseOutcome, { ok: true }>;

export function emptyCounts(): Record<RowStatus, number> {
  return { new: 0, unchanged: 0, conflict: 0, fills_cost: 0, duplicate_in_file: 0, error: 0 };
}

// ── Small helpers ───────────────────────────────────────────────────────────────

function snip(s: string): string {
  const clean = s.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  return clean.length > SNIP ? `${clean.slice(0, SNIP)}...` : clean;
}

function periodIdx(period: string): number {
  return Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7)) - 1;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function isValidIsoDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

function epochDay(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00.000Z`) / 86_400_000);
}

function isoOfEpochDay(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

/** The row's idempotency key without the entity. Electric: one row per month. Oil / firewood: per date and quantity. */
export function rowKeyOf(kind: UsageKind, period: string, occurredOn: string, quantity: string): string {
  return kind === "electric" ? `electric|${period}` : `${kind}|${occurredOn}|${quantity}`;
}

/** The unique `liveKey` stored on a live row. */
export function liveKeyOf(entityId: string, rowKey: string): string {
  return `${entityId}|${rowKey}`;
}

export function unitOfKind(kind: UsageKind, unit?: UsageUnit): UsageUnit {
  if (kind === "electric") return "kwh";
  if (kind === "oil") return "gal";
  return unit === "face_cord" ? "face_cord" : "cord";
}

export function unitLabel(unit: UsageUnit): string {
  return unit === "kwh" ? "kWh" : unit === "gal" ? "gallons" : unit === "cord" ? "cords" : "face cords";
}

// ── Month / date cells ──────────────────────────────────────────────────────────

const MONTH_WORDS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export type MonthCell = { ok: true; period: string; day: number | null } | { ok: false; error: string };

function ymCell(y: number, mo: number, d: number | null): MonthCell {
  if (!Number.isInteger(y) || y < 1900 || y > 2200) return { ok: false, error: `the year ${y} is not usable` };
  if (mo < 1 || mo > 12) return { ok: false, error: `month ${mo} is not a month (use 1 to 12)` };
  if (d !== null && (d < 1 || d > daysInMonth(y, mo))) return { ok: false, error: `${y}-${pad2(mo)}-${pad2(d)} is not a real date` };
  return { ok: true, period: `${y}-${pad2(mo)}`, day: d };
}

/** One month or date cell, US order. Accepts YYYY-MM, YYYY/MM, M/YYYY, Jan 2024, January 2024, Jan, 2024, YYYY-MM-DD, M/D/YYYY, Mon D, YYYY. */
export function parseMonthCell(raw: string): MonthCell {
  const s = raw.trim().replace(/\s+/g, " ");
  if (s === "") return { ok: false, error: "the month is blank" };
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/](\d{1,2})$/.exec(s))) return ymCell(Number(m[1]), Number(m[2]), null);
  if ((m = /^(\d{1,2})\/(\d{4})$/.exec(s))) return ymCell(Number(m[2]), Number(m[1]), null);
  if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s))) return ymCell(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {
    const a = Number(m[1]);
    if (a > 12) return { ok: false, error: `"${snip(s)}": day first is not supported; write month/day/year` };
    return ymCell(Number(m[3]), a, Number(m[2]));
  }
  if ((m = /^([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(s))) {
    const mo = MONTH_WORDS[m[1]!.toLowerCase()];
    if (mo !== undefined) return ymCell(Number(m[2]), mo, null);
  }
  if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s))) {
    const mo = MONTH_WORDS[m[1]!.toLowerCase()];
    if (mo !== undefined) return ymCell(Number(m[3]), mo, Number(m[2]));
  }
  if (/^[A-Za-z]{3,9}[-\s./']\d{2}$/.test(s) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2}$/.test(s) || /^\d{1,2}[/-]\d{2}$/.test(s)) {
    return { ok: false, error: `"${snip(s)}": two-digit years are ambiguous; write a four-digit year` };
  }
  if (/^\d{5,6}(\.\d+)?$/.test(s)) return { ok: false, error: `"${snip(s)}" looks like a spreadsheet date number; save the file with real month names or dates` };
  if (/^\d{4}$/.test(s)) return { ok: false, error: `"${snip(s)}" is only a year; a month is needed` };
  return { ok: false, error: `"${snip(s)}" is not a month I can read (use 2024-01, 1/2024, Jan 2024 or a full date like 1/15/2024)` };
}

// ── Numbers ─────────────────────────────────────────────────────────────────────

type NumberCell = { kind: "absent" } | { kind: "ok"; value: Decimal } | { kind: "error"; error: string };

/** Strips one trailing unit word that belongs to the kind. */
function stripUnitWord(s: string, kind: UsageKind): string {
  const re = kind === "electric" ? /\s*kwh$/i : kind === "oil" ? /\s*(gallons?|gals?)$/i : /\s*cords?$/i;
  return s.replace(re, "");
}

export function parseNumberCell(raw: string, opts: { maxDecimals: number; kind?: UsageKind }): NumberCell {
  let s = raw.trim();
  if (s === "" || s === "-" || /^(n\/a|na)$/i.test(s)) return { kind: "absent" };
  let neg = false;
  const paren = /^\(([^()]*)\)$/.exec(s);
  if (paren) {
    neg = true;
    s = paren[1]!.trim();
  }
  if (opts.kind) s = stripUnitWord(s, opts.kind).trim();
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1).trim();
  }
  if (s.startsWith("$")) s = s.slice(1).trim();
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s) || /^\d+,\d{1,2}$/.test(s)) {
    return { kind: "error", error: `"${snip(raw)}" looks like a comma decimal; write decimals with a point (1234.5)` };
  }
  if (!/^(\d+|\d{1,3}(,\d{3})+)?(\.\d+)?$/.test(s) || s === "" || s === ".") {
    return { kind: "error", error: `"${snip(raw)}" is not a plain number (a comma is only a thousands separator)` };
  }
  const clean = s.replace(/,/g, "");
  const intPart = clean.split(".")[0] ?? "";
  if (intPart.length > 9) return { kind: "error", error: `"${snip(raw)}" is too large` };
  const frac = clean.includes(".") ? clean.split(".")[1]! : "";
  if (frac.length > opts.maxDecimals) {
    return { kind: "error", error: `"${snip(raw)}" has more than ${opts.maxDecimals} decimal place${opts.maxDecimals === 1 ? "" : "s"}; it is not rounded for you` };
  }
  let value = new Decimal(clean.startsWith(".") ? `0${clean}` : clean);
  if (neg) value = value.negated();
  if (value.isZero()) value = ZERO;
  return { kind: "ok", value };
}

// ── Tokenizer ───────────────────────────────────────────────────────────────────

const DELIMS = ["\t", ",", ";", "|"] as const;
type Delim = (typeof DELIMS)[number];

function sniffDelimiter(text: string): Delim {
  const nl = text.indexOf("\n");
  // The first non-blank physical line.
  let start = 0;
  let end = nl < 0 ? text.length : nl;
  while (text.slice(start, end).trim() === "" && end < text.length) {
    start = end + 1;
    const n2 = text.indexOf("\n", start);
    end = n2 < 0 ? text.length : n2;
  }
  const line = text.slice(start, end);
  const counts = new Map<string, number>(DELIMS.map((d) => [d, 0]));
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best: Delim = ",";
  let bestN = 0;
  for (const d of DELIMS) {
    const n = counts.get(d) ?? 0;
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

interface Tokenized {
  records: string[][];
  lines: number[];
}

/** RFC-4180: quoted fields, "" escape, embedded delimiters and newlines inside quotes. Blank records are skipped. */
function tokenize(text: string, delim: Delim): Tokenized | { error: string } {
  const records: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let cell = "";
  let inQuote = false;
  let quoteLine = 1;
  let line = 1;
  let recordLine = 1;
  let atFieldStart = true;
  const endRecord = () => {
    row.push(cell);
    if (!(row.length === 1 && row[0]!.trim() === "")) {
      records.push(row);
      lines.push(recordLine);
    }
    row = [];
    cell = "";
    atFieldStart = true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && atFieldStart) {
      inQuote = true;
      quoteLine = line;
      atFieldStart = false;
      continue;
    }
    if (ch === delim) {
      row.push(cell);
      cell = "";
      atFieldStart = true;
      continue;
    }
    if (ch === "\n") {
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    cell += ch;
    atFieldStart = false;
  }
  if (inQuote) return { error: `A quoted value that starts on line ${quoteLine} is never closed (a missing closing quote).` };
  if (cell !== "" || row.length > 0) endRecord();
  return { records, lines };
}

// ── Header and mapping ──────────────────────────────────────────────────────────

type RoleName = Exclude<ColumnRole, "ignore">;
const ALIASES: Record<RoleName, readonly string[]> = {
  month: ["month", "period", "billingperiod", "billmonth", "date", "billdate", "deliverydate", "serviceperiodstart"],
  periodEnd: ["periodend", "serviceperiodend", "enddate"],
  quantity: ["kwh", "usage", "usagekwh", "totalkwh", "kwhused", "gallons", "gal", "quantity", "qty", "cords", "cord", "units"],
  cost: ["cost", "amount", "total", "totalbill", "amountdue", "charges", "bill"],
  unit: ["unit", "uom"],
  note: ["note", "notes", "comment", "solarcredit", "credit"],
};
const ROLE_ORDER: readonly RoleName[] = ["month", "periodEnd", "quantity", "cost", "unit", "note"];

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A suggested role per column, from the header text when there is one, else by position (month, quantity, cost, unit or note). */
export function suggestMapping(header: readonly string[] | null, count: number, kind: UsageKind): ColumnRole[] {
  const out: ColumnRole[] = new Array<ColumnRole>(count).fill("ignore");
  const used = new Set<RoleName>();
  if (header) {
    header.forEach((h, i) => {
      if (i >= count) return;
      const n = normHeader(h);
      for (const role of ROLE_ORDER) {
        if (used.has(role)) continue;
        if (role === "periodEnd" && kind !== "electric") continue;
        if (role === "unit" && kind !== "firewood") continue;
        if (ALIASES[role].includes(n)) {
          out[i] = role;
          used.add(role);
          break;
        }
      }
    });
    return out;
  }
  const order: ColumnRole[] = ["month", "quantity", "cost", kind === "firewood" ? "unit" : "note", "note"];
  for (let i = 0; i < Math.min(count, order.length); i++) {
    const r = order[i]!;
    if (r === "note" && out.includes("note")) continue;
    out[i] = r;
  }
  return out;
}

function validateMapping(mapping: readonly ColumnRole[], kind: UsageKind): string | null {
  const count = (r: ColumnRole) => mapping.filter((x) => x === r).length;
  if (count("month") !== 1) return "Choose exactly one column for the month.";
  if (count("quantity") !== 1) return `Choose exactly one column for the ${kind === "electric" ? "kWh" : kind === "oil" ? "gallons" : "cords"}.`;
  for (const r of ["cost", "unit", "note", "periodEnd"] as const) {
    if (count(r) > 1) return `Choose at most one column for ${r === "periodEnd" ? "the period end" : `the ${r}`}.`;
  }
  if (count("periodEnd") > 0 && kind !== "electric") return "A period-end column is only used for electric bills.";
  if (count("unit") > 0 && kind !== "firewood") return "A unit column is only used for firewood.";
  return null;
}

// ── Row building ────────────────────────────────────────────────────────────────

interface RowCtx {
  kind: UsageKind;
  today: string;
  defaultUnit: UsageUnit;
  solarLiveFrom: string | null;
  idx: Partial<Record<RoleName, number>>;
}

const FIREWOOD_UNIT_WORDS: Record<string, UsageUnit> = {
  cord: "cord", cords: "cord", "face cord": "face_cord", "face cords": "face_cord", facecord: "face_cord", facecords: "face_cord", face_cord: "face_cord", face_cords: "face_cord",
};

function cellAt(cells: readonly string[], i: number | undefined): string {
  return i === undefined ? "" : (cells[i] ?? "");
}

/** Whitespace and invisible characters a spreadsheet may skip before it reads a formula (trim() removes them, so the check must too). */
const INVISIBLE_LEAD = /^[\s ﻿​-‍⁠]+/;

/**
 * True when a note could be run as a formula if the data is ever exported: its first character is TAB, CR or LF (a CR is
 * turned into LF before the cell is read, so a leading line break stands for it), or the first visible character after any
 * whitespace / NBSP / BOM / zero-width characters is = + or @. The caller checks the value it will STORE.
 */
function hasFormulaStart(value: string): boolean {
  if (/^[\t\r\n]/.test(value)) return true;
  return /^[=+@]/.test(value.replace(INVISIBLE_LEAD, ""));
}

function errorRow(line: number, errors: string[], warnings: string[] = []): ParsedRow {
  return { line, key: null, period: null, occurredOn: null, quantity: null, unit: null, costCents: null, note: null, status: "error", warnings, errors };
}

/** The usage month of an electric row with a period end: the month containing the midpoint of start..end. */
function midpointPeriod(startIso: string, endIso: string): { ok: true; period: string } | { ok: false; error: string } {
  const a = epochDay(startIso);
  const b = epochDay(endIso);
  if (b < a) return { ok: false, error: "the period end is before the period start" };
  if (b - a > MAX_PERIOD_SPAN_DAYS) return { ok: false, error: `the billing period is longer than ${MAX_PERIOD_SPAN_DAYS} days` };
  return { ok: true, period: isoOfEpochDay(Math.floor((a + b) / 2)).slice(0, 7) };
}

function buildRow(cells: readonly string[], line: number, ctx: RowCtx): ParsedRow {
  const { kind, today } = ctx;
  const errors: string[] = [];
  const warnings: string[] = [];
  const todayPeriod = today.slice(0, 7);

  // Month / date
  let period: string | null = null;
  let occurredOn: string | null = null;
  const mc = parseMonthCell(cellAt(cells, ctx.idx.month));
  if (!mc.ok) {
    errors.push(mc.error);
  } else if (ctx.idx.periodEnd !== undefined) {
    const ec = parseMonthCell(cellAt(cells, ctx.idx.periodEnd));
    if (!ec.ok) errors.push(`period end: ${ec.error}`);
    else if (mc.day === null || ec.day === null) errors.push("a period start and end need full dates (for example 1/15/2024)");
    else {
      const mid = midpointPeriod(`${mc.period}-${pad2(mc.day)}`, `${ec.period}-${pad2(ec.day)}`);
      if (!mid.ok) errors.push(mid.error);
      else {
        period = mid.period;
        occurredOn = `${period}-01`;
      }
    }
  } else {
    period = mc.period;
    occurredOn = kind === "electric" ? `${period}-01` : `${period}-${pad2(mc.day ?? 1)}`;
  }
  if (period !== null && occurredOn !== null) {
    if (period > todayPeriod) errors.push("that month is in the future");
    else if (kind === "electric" && period === todayPeriod) errors.push("the current month is not finished yet; add it once its bill is in");
    else if (kind !== "electric" && occurredOn > today) errors.push("that date is in the future");
    else if (periodIdx(todayPeriod) - periodIdx(period) > MAX_AGE_MONTHS) errors.push(`that month is more than ${MAX_AGE_MONTHS / 12} years ago`);
    else if (kind === "electric" && ctx.solarLiveFrom !== null && period < ctx.solarLiveFrom) {
      warnings.push(`kept, not used by the estimate (before solar went live in ${ctx.solarLiveFrom})`);
    }
  }

  // Unit
  let unit: UsageUnit = unitOfKind(kind, ctx.defaultUnit);
  if (kind === "firewood" && ctx.idx.unit !== undefined) {
    const raw = cellAt(cells, ctx.idx.unit).trim().toLowerCase().replace(/\s+/g, " ");
    if (raw !== "") {
      const u = FIREWOOD_UNIT_WORDS[raw];
      if (u) unit = u;
      else errors.push(`the unit "${snip(raw)}" is not cord or face cord`);
    }
  }

  // Quantity
  let quantity: Decimal | null = null;
  const qRaw = cellAt(cells, ctx.idx.quantity);
  const q = parseNumberCell(qRaw, { maxDecimals: 3, kind });
  if (q.kind === "absent") errors.push("the quantity is blank (a row without a quantity is not usage)");
  else if (q.kind === "error") errors.push(q.error);
  else {
    quantity = q.value;
    if (kind === "electric") {
      if (q.value.isNegative()) errors.push("negative kWh is refused: enter the kWh bought from the grid, and put a surplus in the note");
      else if (q.value.greaterThan(20000)) errors.push("more than 20,000 kWh in a month is not plausible");
      else if (q.value.greaterThan(5000)) warnings.push("more than 5,000 kWh in a month is unusually high");
    } else if (kind === "oil") {
      if (!q.value.greaterThan(0)) errors.push("gallons must be more than 0 (leave a month with no delivery out)");
      else if (q.value.greaterThan(2000)) errors.push("more than 2,000 gallons in one delivery is not plausible");
      else if (q.value.greaterThan(800)) warnings.push("more than 800 gallons in one delivery is unusually large");
    } else {
      const [lo, hi] = unit === "face_cord" ? [0.5, 60] : [0.25, 20];
      if (q.value.lessThan(lo) || q.value.greaterThan(hi)) errors.push(`${unitLabel(unit)} must be between ${lo} and ${hi}`);
    }
  }

  // Cost
  let costCents: number | null = null;
  let costDollars: Decimal | null = null;
  if (ctx.idx.cost !== undefined) {
    const cRaw = cellAt(cells, ctx.idx.cost);
    const c = parseNumberCell(cRaw, { maxDecimals: 2 });
    if (c.kind === "error") errors.push(`cost: ${c.error}`);
    else if (c.kind === "ok") {
      const [lo, hi] = kind === "electric" ? [-5000, 20000] : [0, 50000];
      if (c.value.lessThan(lo) || c.value.greaterThan(hi)) errors.push(`the cost must be between ${lo.toLocaleString("en-US")}.00 and ${hi.toLocaleString("en-US")}.00`);
      else {
        costDollars = c.value;
        costCents = Number(c.value.times(100).toFixed(0));
      }
    }
  }
  if (quantity !== null && costDollars !== null && errors.length === 0) {
    if (kind === "oil" && quantity.greaterThan(0)) {
      const perGal = costDollars.div(quantity);
      if (perGal.lessThan("0.5") || perGal.greaterThan(12)) errors.push("the cost and gallons do not look like the same delivery (price per gallon is outside $0.50 to $12.00)");
    }
    if (kind === "electric" && quantity.greaterThan(0) && costDollars.div(quantity).greaterThan(2)) {
      warnings.push("the cost is more than $2.00 per kWh, which is unusually high");
    }
  }

  // Note
  let note: string | null = null;
  if (ctx.idx.note !== undefined) {
    const raw = cellAt(cells, ctx.idx.note);
    // `t` is what would be stored (control characters, outer whitespace and leading invisible characters removed); a note is
    // refused when the raw cell OR the stored value starts like a formula (a leading line break or TAB counts, see hasFormulaStart).
    const t = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().replace(INVISIBLE_LEAD, "").trim();
    if (t !== "") {
      if (hasFormulaStart(raw) || hasFormulaStart(t)) errors.push("the note starts with = + @ or a tab, which spreadsheets can run as a formula");
      else if (t.length > MAX_NOTE) errors.push(`the note is longer than ${MAX_NOTE} characters`);
      else if (containsPrivateIdentifier(t)) errors.push("the note looks like it holds a personal number (SSN, EIN or account number); leave that out");
      else note = t;
    }
  }

  if (errors.length > 0 || period === null || occurredOn === null || quantity === null) {
    return errorRow(line, errors.length > 0 ? errors : ["this row could not be read"], warnings);
  }
  const qty = quantity.toFixed(3);
  return {
    line,
    key: rowKeyOf(kind, period, occurredOn, qty),
    period,
    occurredOn,
    quantity: qty,
    unit,
    costCents,
    note,
    status: "new",
    warnings,
    errors: [],
  };
}

function sameValues(a: ParsedRow, b: ParsedRow): boolean {
  return a.quantity === b.quantity && a.costCents === b.costCents && a.unit === b.unit && (a.note ?? "") === (b.note ?? "");
}

function looksLikeData(cell: string): boolean {
  const n = parseNumberCell(cell, { maxDecimals: 9 });
  if (n.kind === "ok") return true;
  return parseMonthCell(cell).ok;
}

function fatal(error: string): ParseOutcome {
  return { ok: false, error };
}

function summarize(rows: readonly ParsedRow[]): ParseSummary {
  const counts = emptyCounts();
  const periods = new Set<string>();
  for (const r of rows) {
    counts[r.status] += 1;
    if (r.status !== "error" && r.period) periods.add(r.period);
  }
  const sorted = [...periods].sort();
  return { rowCount: rows.length, months: periods.size, first: sorted[0] ?? null, last: sorted[sorted.length - 1] ?? null, counts };
}

// ── Wide recap tables ───────────────────────────────────────────────────────────

const TOTAL_ROW = /^(total|totals|average|avg|mean|sum|annual|year)\b/i;

/**
 * A header with at least 6 different month names (Jan..Dec or full names) and a four-digit year in the first column of the
 * rows under it becomes one row per year and month: [YYYY-MM, value]. Blank, dash and n/a cells are months with no value (no
 * row). A total / average line is ignored; any other first cell that is not a year becomes a row that reports an error.
 */
function detectWide(records: string[][], lines: number[]): { records: string[][]; lines: number[] } | null {
  const head = records[0];
  if (!head || records.length < 2) return null;
  const monthOfCol = head.map((c) => MONTH_WORDS[c.trim().toLowerCase().replace(/\.$/, "")] ?? 0);
  const named = monthOfCol.filter((m) => m > 0);
  if (named.length < 6 || new Set(named).size !== named.length) return null;
  const out: string[][] = [["Month", "Quantity"]];
  const outLines: number[] = [lines[0] ?? 1];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r]!;
    const yearCell = (rec[0] ?? "").trim();
    const line = lines[r] ?? r + 1;
    if (TOTAL_ROW.test(yearCell)) continue;
    if (!/^\d{4}$/.test(yearCell)) {
      out.push([yearCell, ""]);
      outLines.push(line);
      continue;
    }
    monthOfCol.forEach((m, c) => {
      if (m === 0) return;
      const cell = (rec[c] ?? "").trim();
      if (cell === "" || cell === "-" || /^(n\/a|na)$/i.test(cell)) return;
      out.push([`${yearCell}-${pad2(m)}`, cell]);
      outLines.push(line);
    });
  }
  return { records: out, lines: outLines };
}

// ── The parser ──────────────────────────────────────────────────────────────────

export function parseUsageText(input: ParseInput): ParseOutcome {
  const { kind, today } = input;
  if (!isValidIsoDay(today)) return fatal("Today's date was not usable.");
  if (typeof input.text !== "string") return fatal("There is nothing to read.");
  if (input.text.length > MAX_TEXT_CHARS) {
    return fatal(`That is too much text (${input.text.length.toLocaleString("en-US")} characters; the limit is ${MAX_TEXT_CHARS.toLocaleString("en-US")}). Split the history into smaller parts.`);
  }
  let text = input.text.charCodeAt(0) === 0xfeff ? input.text.slice(1) : input.text;
  text = text.replace(/\r\n?/g, "\n");
  const bad = /[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/.exec(text);
  if (bad) {
    const ln = text.slice(0, bad.index).split("\n").length;
    return fatal(`Line ${ln} contains a control character, so this does not look like plain text. Nothing was read.`);
  }
  if (text.trim() === "") return fatal("There is nothing to read: the text is empty.");

  const delimiter = sniffDelimiter(text);
  const tok = tokenize(text, delimiter);
  if ("error" in tok) return fatal(tok.error);
  let records = tok.records;
  let lines = tok.lines;
  if (records.length === 0) return fatal("There is nothing to read: no rows were found.");

  let columnCount = 0;
  for (let r = 0; r < records.length; r++) {
    const rec = records[r]!;
    if (rec.length > MAX_COLUMNS) return fatal(`Line ${lines[r]} has ${rec.length} columns; the limit is ${MAX_COLUMNS}.`);
    for (const c of rec) {
      if (c.length > MAX_CELL) return fatal(`A value on line ${lines[r]} is longer than ${MAX_CELL} characters, so this does not look like a usage table. Nothing was read.`);
    }
    if (rec.length > columnCount) columnCount = rec.length;
  }

  // The utility's yearly recap often has years down and month names across; it is read as one row per month (kWh only: a
  // cost cannot sit in the same table, so the amounts arrive in a second paste that fills them in).
  let wide = false;
  if (kind === "electric") {
    const w = detectWide(records, lines);
    if (w) {
      records = w.records;
      lines = w.lines;
      columnCount = 2;
      wide = true;
    }
  }

  const first = records[0]!;
  const hasHeader = !first.some((c) => c.trim() !== "" && looksLikeData(c));
  const dataRecords = hasHeader ? records.slice(1) : records;
  const dataLines = hasHeader ? lines.slice(1) : lines;
  if (dataRecords.length === 0) return fatal("The header was read but there are no data rows under it.");
  if (dataRecords.length > MAX_ROWS) return fatal(`That is ${dataRecords.length.toLocaleString("en-US")} rows; the limit is ${MAX_ROWS}. Split the history into smaller parts.`);

  const header = hasHeader ? first.map((h) => h.trim()) : null;
  const suggested = suggestMapping(header, columnCount, kind);
  const chosen = input.mapping;
  const mapping: ColumnRole[] = Array.from({ length: columnCount }, (_, i) => (chosen ? (chosen[i] ?? "ignore") : (suggested[i] ?? "ignore")));
  const sampleRec = dataRecords[0]!;
  const columns: ColumnInfo[] = Array.from({ length: columnCount }, (_, i) => ({
    index: i,
    header: header ? snip(header[i] ?? "") : null,
    sample: snip(sampleRec[i] ?? ""),
  }));

  const mappingError = validateMapping(mapping, kind);
  const base = { ok: true as const, delimiter, hasHeader, wide, columns, mapping, suggested };
  if (mappingError) return { ...base, mappingError, rows: [], summary: summarize([]) };

  const idx: Partial<Record<RoleName, number>> = {};
  mapping.forEach((r, i) => {
    if (r !== "ignore") idx[r] = i;
  });
  const ctx: RowCtx = { kind, today, defaultUnit: input.defaultUnit ?? "cord", solarLiveFrom: input.site.solarLiveFrom, idx };
  const rows = dataRecords.map((rec, i) => buildRow(rec, dataLines[i]!, ctx));

  // Firewood: one upload may not mix units. The minority rows are errors (a tie goes to the unit of the first row).
  if (kind === "firewood") {
    const tally = new Map<UsageUnit, number>();
    for (const r of rows) if (r.unit && r.status !== "error") tally.set(r.unit, (tally.get(r.unit) ?? 0) + 1);
    if (tally.size > 1) {
      const firstUnit = rows.find((r) => r.unit && r.status !== "error")?.unit ?? "cord";
      let major: UsageUnit = firstUnit;
      for (const [u, n] of tally) if (n > (tally.get(major) ?? 0)) major = u;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.status !== "error" && r.unit && r.unit !== major) {
          rows[i] = errorRow(r.line, [`this upload mixes cords and face cords; most rows are ${unitLabel(major)}, so this one is refused`], r.warnings);
        }
      }
    }
  }

  // Duplicates inside the file.
  const seen = new Map<string, ParsedRow>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.status === "error" || r.key === null) continue;
    const prev = seen.get(r.key);
    if (!prev) {
      seen.set(r.key, r);
      continue;
    }
    if (sameValues(prev, r)) {
      rows[i] = { ...r, status: "duplicate_in_file", warnings: [...r.warnings, `same as line ${prev.line}; ignored`] };
    } else {
      rows[i] = errorRow(r.line, [`line ${prev.line} already has this ${kind === "electric" ? "month" : "date and quantity"} with different values; keep one of them`], r.warnings);
    }
  }
  return { ...base, mappingError: null, rows, summary: summarize(rows) };
}

// ── Against the saved rows ──────────────────────────────────────────────────────

/** A saved (live) row as the classification needs it. */
export interface LiveUsage {
  id: string;
  key: string;
  occurredOn: string;
  quantity: string;
  costCents: number | null;
}

/** Marks each `new` row as unchanged / conflict / fills_cost against the saved rows. Other statuses pass through. */
export function classifyAgainstLive(kind: UsageKind, rows: readonly ParsedRow[], live: readonly LiveUsage[]): ParsedRow[] {
  const byKey = new Map(live.map((l) => [l.key, l]));
  return rows.map((r) => {
    if (r.status !== "new" || r.key === null) return r;
    const saved = byKey.get(r.key);
    if (saved) {
      const sameQty = new Decimal(saved.quantity).equals(new Decimal(r.quantity ?? "0"));
      if (sameQty) {
        if (r.costCents === null || r.costCents === saved.costCents) return { ...r, status: "unchanged" as const, matchedId: saved.id };
        if (saved.costCents === null) return { ...r, status: "fills_cost" as const, matchedId: saved.id };
      }
      return {
        ...r,
        status: "conflict" as const,
        matchedId: saved.id,
        warnings: [...r.warnings, "a different saved value exists for this; tick Replace to archive the old one and save this one"],
      };
    }
    if (kind !== "electric") {
      const sameDay = live.find((l) => l.occurredOn === r.occurredOn);
      if (sameDay) {
        return { ...r, warnings: [...r.warnings, "a delivery on this date with a different quantity is already saved; this one is added as another delivery"] };
      }
    }
    return r;
  });
}

export interface WritePlan {
  insert: ParsedRow[];
  /** Live row ids to archive in the same transaction (a ticked conflict or a cost fill). */
  archiveIds: string[];
  replaced: number;
  skipped: number;
}

/**
 * What a save writes. Refuses (error) when any row has an error unless `skipBadRows`. `conflict` rows are written only when
 * their key is in `replaceKeys`; `unchanged`, `duplicate_in_file` and error rows are never written.
 */
export function planWrites(rows: readonly ParsedRow[], opts: { replaceKeys: readonly string[]; skipBadRows: boolean }): { ok: true; plan: WritePlan } | { ok: false; error: string } {
  const bad = rows.filter((r) => r.status === "error").length;
  if (bad > 0 && !opts.skipBadRows) {
    return { ok: false, error: `${bad} row${bad === 1 ? " has" : "s have"} an error. Fix ${bad === 1 ? "it" : "them"}, or tick "skip rows with errors" to save the rest.` };
  }
  const replace = new Set(opts.replaceKeys);
  const insert: ParsedRow[] = [];
  const archiveIds: string[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (r.status === "new") insert.push(r);
    else if (r.status === "fills_cost") {
      insert.push(r);
      if (r.matchedId) archiveIds.push(r.matchedId);
    } else if (r.status === "conflict" && r.key !== null && replace.has(r.key)) {
      insert.push(r);
      if (r.matchedId) archiveIds.push(r.matchedId);
    } else skipped += 1;
  }
  return { ok: true, plan: { insert, archiveIds, replaced: archiveIds.length, skipped } };
}
