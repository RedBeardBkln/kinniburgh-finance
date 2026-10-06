// Mixed-use (shared household / business) GL accounts: the owner's business-use PERCENTAGE decision.
//
// A list, not code: adding another shared account later (a cell phone, software) is ONE new entry in
// BUSINESS_USE_ACCOUNTS (new `key`, next `decisionId`, `mapAccount`, `label`, `what`) and nothing else.
//
// Dependency-free on purpose (types only): it is imported by the engine (lib/tax2025/rules/schedule-c.ts),
// the override feed, the review sheet and the client dialog helpers. Integer arithmetic only (a percent is
// stored as TENTHS of a percent, 0..1000), so nothing here ships a float or a Decimal to the client.
//
// The percentage is an OWNER ATTESTATION (a recorded decision plus a written basis), not a tax constant and
// not verified by any document. Schedule C instructions, "Line 25 Utilities" (irs.gov/instructions/i1040sc,
// read 2026-10-06): "Deduct utility expenses only for your trade or business." See specs/09.

export interface BusinessUseAccountDef {
  /** Neutral, name-free key. Stored as TaxReturnOverride.targetKey = `businessUse.<key>`. */
  key: string;
  /** Engine decision id; must match the DECISION_SHAPE of lib/tax-review/links.ts. X6 first, X7 ... later. */
  decisionId: `X${number}`;
  /** The `account` of the GL_SCHEDULE_C_MAP entry (aliases resolve to it through findGlMapEntry). */
  mapAccount: string;
  /** Neutral decision label: no person, property or business name (it travels to the AI payload). */
  label: string;
  /** Plain words for the sheet dialog: what the account is. */
  what: string;
}

export const BUSINESS_USE_ACCOUNTS = [
  {
    key: "internet_phone",
    decisionId: "X6",
    mapAccount: "Utilities:Internet & TV services",
    label: "Business-use share of the shared internet and phone service (Schedule C line 25)",
    what: "the shared household internet and phone service booked in the EK Consulting books",
  },
] as const satisfies readonly BusinessUseAccountDef[];

/** One list entry with its literal types (so `decisionId` is assignable to the engine's DecisionId). */
export type BusinessUseAccount = (typeof BUSINESS_USE_ACCOUNTS)[number];
export type BusinessUseDecisionId = BusinessUseAccount["decisionId"];

/** The prefix of TaxReturnOverride.targetKey for a business-use decision. */
export const BUSINESS_USE_TARGET_PREFIX = "businessUse.";

/** 100% in tenths of a percent: the most a percentage can be. */
export const BUSINESS_USE_MAX_TENTHS = 1000;

/** No decision recorded: 100% (today's behaviour), flagged "default, undecided". */
export const BUSINESS_USE_DEFAULT_TENTHS = BUSINESS_USE_MAX_TENTHS;

/** cents x tenths of a percent / this = dollars (100 cents per dollar x 1,000 tenths per whole). Not a tax number: unit scaling. */
export const BUSINESS_USE_CENTS_TENTHS_PER_DOLLAR = 100_000;

export function businessUseTargetKey(def: Pick<BusinessUseAccountDef, "key">): string {
  return `${BUSINESS_USE_TARGET_PREFIX}${def.key}`;
}

/** The list entry for a `businessUse.<key>` override target (exact match only; prefixes and prototype names are null). */
export function businessUseKeyOf(targetKey: string): BusinessUseAccount | null {
  if (!targetKey.startsWith(BUSINESS_USE_TARGET_PREFIX)) return null;
  const key = targetKey.slice(BUSINESS_USE_TARGET_PREFIX.length);
  return BUSINESS_USE_ACCOUNTS.find((a) => a.key === key) ?? null;
}

export function businessUseDefByKey(key: string): BusinessUseAccount | null {
  return BUSINESS_USE_ACCOUNTS.find((a) => a.key === key) ?? null;
}

export function businessUseDefByDecisionId(id: string): BusinessUseAccount | null {
  return BUSINESS_USE_ACCOUNTS.find((a) => a.decisionId === id) ?? null;
}

export const BUSINESS_USE_PERCENT_ERROR = "Enter a percentage from 0 to 100, with at most one decimal.";

export type ParsedBusinessUsePercent =
  | { ok: true; tenths: number; canonical: string }
  | { ok: false; error: string };

const PERCENT_SHAPE = /^\s*(\d{1,3})(?:\.(\d))?\s*%?\s*$/;

/** "70", "70.5", " 70 ", "70%" -> tenths (0..1000) and the canonical text ("70", "70.5"). Anything else is refused. */
export function parseBusinessUsePercent(text: string): ParsedBusinessUsePercent {
  const m = PERCENT_SHAPE.exec(text);
  if (!m) return { ok: false, error: BUSINESS_USE_PERCENT_ERROR };
  const whole = parseInt(m[1] ?? "", 10);
  const frac = m[2] === undefined ? 0 : parseInt(m[2], 10);
  const tenths = whole * 10 + frac;
  if (!Number.isInteger(tenths) || tenths < 0 || tenths > BUSINESS_USE_MAX_TENTHS) return { ok: false, error: BUSINESS_USE_PERCENT_ERROR };
  return { ok: true, tenths, canonical: canonicalPercentText(tenths) };
}

/** 700 -> "70", 705 -> "70.5". */
export function canonicalPercentText(tenths: number): string {
  const tenth = tenths % 10;
  const whole = (tenths - tenth) / 10;
  return tenth === 0 ? String(whole) : `${whole}.${tenth}`;
}

/** 1000 -> "100%", 705 -> "70.5%". */
export function formatBusinessUsePercent(tenths: number): string {
  return `${canonicalPercentText(tenths)}%`;
}

/** The tenths of an already formatted percent ("70%", "70.5%") or a canonical value ("70.5"); null when malformed. */
export function tenthsOfPercentText(text: string): number | null {
  const parsed = parseBusinessUsePercent(text);
  return parsed.ok ? parsed.tenths : null;
}

/** Dollars from an amount in cents x tenths-of-a-percent (cents x tenths / 100_000 = dollars): round half away from zero ONCE (the IRS whole-dollar rule). Integer math only. */
export function roundMilliCentsToDollars(milliCents: number): number {
  const sign = milliCents < 0 ? -1 : 1;
  const abs = milliCents < 0 ? -milliCents : milliCents;
  const rem = abs % BUSINESS_USE_CENTS_TENTHS_PER_DOLLAR;
  const whole = (abs - rem) / BUSINESS_USE_CENTS_TENTHS_PER_DOLLAR;
  return sign * (rem * 2 >= BUSINESS_USE_CENTS_TENTHS_PER_DOLLAR ? whole + 1 : whole);
}

/** A share of integer cents at `tenths` tenths of a percent, rounded half up to whole cents (non-negative cents). Integer math only. */
export function shareCents(cents: number, tenths: number): number {
  const n = cents * tenths;
  const rem = n % BUSINESS_USE_MAX_TENTHS;
  const whole = (n - rem) / BUSINESS_USE_MAX_TENTHS;
  return rem * 2 >= BUSINESS_USE_MAX_TENTHS ? whole + 1 : whole;
}

/** Whole dollars or dollars and cents from integer cents, e.g. "$2,610" / "$783.05" / "-$0.50" (the engine's `fmt` convention). */
export function formatCentsText(cents: number): string {
  const abs = cents < 0 ? -cents : cents;
  const c = abs % 100;
  const dollars = (abs - c) / 100;
  const body = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = cents < 0 ? "-" : "";
  return c === 0 ? `${sign}$${body}` : `${sign}$${body}.${c < 10 ? "0" : ""}${c}`;
}
