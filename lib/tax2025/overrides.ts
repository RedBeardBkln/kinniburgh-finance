// TY2025 return overrides: the CPA's recorded instructions layered OVER the
// computed return (plan section 7, .claude/pipeline/ty2025-pdf-forms-and-overrides).
//
// Principles (CLAUDE.md rule 8 and the plan):
//   - PURE: no DB, no I/O. The loader (lib/tax2025-overrides-build.ts, OUTSIDE this
//     tree) feeds rows in.
//   - Overrides never edit inputs and never edit the engine result in place:
//     applyOverrides returns a NEW "effective" view (deep copies; `results` is
//     never touched). Every consumer (sheet, CSV, PDF) reads the effective view
//     so an override can never be silently applied or silently dropped.
//   - Three kinds. "line": pin a line to whole dollars (Tier 1: ONLY that line
//     changes; the lines downstream of it are NOT recomputed, they are flagged via
//     LINE_FLOW and the totals are marked "not recomputed"). "decision": fed into
//     the engine as a recorded decision so the return recomputes consistently.
//     "rule_ack": records that the CPA reviewed a rule; changes no number, only
//     moves the matching blocking open items to an "Acknowledged" list.
//   - A line override on a BLOCKED line (missing input / needs CPA / not yet
//     computed) supplies the value with provenance: the line prints, and every
//     blocking open item whose lines are ALL supplied this way moves to the
//     "resolved by override" list. Totals stay "not computed" (D2).
//   - A line whose computed value or status changed after the override was set is
//     STALE: still applied (it is an explicit instruction) but flagged and counted
//     as a blocking open item. An engine-version change ALONE (value unchanged) is
//     an advisory "engine updated" item, never blocking (D3).
//   - No free-text values: a value is cents (whole dollars) or an enumerated
//     choice id. The reason is free text, is stored and shown, and is never
//     written to AuditLog (the action layer enforces that).
//   - Money is integer cents here (rule 2). Engine line amounts are whole dollars.

import { Decimal } from "@prisma/client/runtime/library";
import { z } from "zod";
import { downstreamOf } from "@/lib/tax2025/line-flow";
import { dollarsToCents } from "@/lib/tax2025/money";
import {
  OVERRIDE_MAX_ABS_DOLLARS,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  formatDollars,
  formatOverrideDate,
} from "@/lib/tax2025/override-format";
import {
  hasAmount,
  type DecisionId,
  type Headline,
  type LineKey,
  type OpenItem,
  type ReturnLine,
  type RuleDecision,
  type RuleStatus,
  type Ty2025Decisions,
  type Ty2025Return,
} from "@/lib/tax2025/types";

// ── Vocabulary ────────────────────────────────────────────────────────────────

export const OVERRIDE_TARGET_KINDS = ["line", "decision", "rule_ack"] as const;
export type OverrideTargetKind = (typeof OVERRIDE_TARGET_KINDS)[number];

export const OVERRIDE_VALUE_KINDS = ["money_cents", "choice", "ack"] as const;
export type OverrideValueKind = (typeof OVERRIDE_VALUE_KINDS)[number];

/** Who instructed it. Eric types it in (no CPA login), so the row also records the human (setByName). */
export const OVERRIDE_AUTHORITIES = ["cpa", "owner"] as const;
export type OverrideAuthority = (typeof OVERRIDE_AUTHORITIES)[number];

export const OVERRIDE_ARCHIVE_KINDS = ["superseded", "cleared"] as const;
export type OverrideArchiveKind = (typeof OVERRIDE_ARCHIVE_KINDS)[number];

export const SUPPORTED_OVERRIDE_TAX_YEARS: readonly number[] = [2025];

// The limits live in override-format.ts (dependency-free) so the client dialog helpers share them.
export { REASON_MIN_LENGTH, REASON_MAX_LENGTH, OVERRIDE_MAX_ABS_DOLLARS };
export const OVERRIDE_MAX_ABS_CENTS = OVERRIDE_MAX_ABS_DOLLARS * 100;

export function isSupportedOverrideTaxYear(year: number): boolean {
  return SUPPORTED_OVERRIDE_TAX_YEARS.includes(year);
}

// ── Decision registry (typed so a new engine decision breaks the build) ──────

type DecisionKey = keyof Ty2025Decisions;
type ChoiceOf<K extends DecisionKey> = NonNullable<Ty2025Decisions[K]>["chosen"];

interface DecisionMeta<K extends DecisionKey> {
  decisionId: DecisionId;
  label: string;
  choices: readonly ChoiceOf<K>[];
}

export const DECISION_REGISTRY: { [K in DecisionKey]-?: DecisionMeta<K> } = {
  homeOfficeMethod: { decisionId: "X1", label: "Home office method (EK Consulting)", choices: ["simplified", "actual"] },
  depreciationElection: {
    decisionId: "X2",
    label: "Depreciation election",
    choices: ["regular_macrs", "bonus", "section_179", "de_minimis"],
  },
  qbiForm: { decisionId: "X3", label: "QBI deduction form", choices: ["8995", "8995a"] },
  arborRoadPropertyTax: {
    decisionId: "X5",
    label: "56 Arbor Rd 2025 property tax",
    choices: ["schedule_a", "capitalize"],
  },
};

export const DECISION_KEYS = Object.keys(DECISION_REGISTRY) as DecisionKey[];

export function decisionKeyOf(raw: string): DecisionKey | null {
  return DECISION_KEYS.find((k) => k === raw) ?? null;
}

/** The registry's choice ids for a decision key, as plain strings (for validation of untrusted input). */
export function decisionChoices(key: DecisionKey): readonly string[] {
  return DECISION_REGISTRY[key].choices;
}

export function isValidDecisionChoice(key: DecisionKey, choice: string): boolean {
  return decisionChoices(key).includes(choice);
}

function pick<T extends string>(choices: readonly T[], v: string): T | null {
  return choices.find((c) => c === v) ?? null;
}

function assertNever(x: never): never {
  throw new Error(`Unhandled decision key: ${String(x)}`);
}

// ── Value validation (shared by the actions and the row parser) ──────────────

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** Whole dollars only, bounded, integer cents. */
export function validateLineOverrideCents(valueCents: number): ValidationResult {
  if (!Number.isSafeInteger(valueCents)) return { ok: false, error: "The override amount must be a whole number of dollars." };
  if (valueCents % 100 !== 0) return { ok: false, error: "Overrides are whole dollars (the amount cannot have cents)." };
  if (Math.abs(valueCents) > OVERRIDE_MAX_ABS_CENTS) {
    return { ok: false, error: `The override amount cannot exceed ${formatDollars(OVERRIDE_MAX_ABS_DOLLARS)}.` };
  }
  return { ok: true };
}

/**
 * Checks an override value against the BASE line: the line must exist on the
 * return (pending keys the engine does not emit yet cannot be overridden), and
 * a value equal to the computed one is rejected ("no change").
 */
export function checkLineOverrideAgainstBase(valueCents: number, line: ReturnLine | undefined): ValidationResult {
  const v = validateLineOverrideCents(valueCents);
  if (!v.ok) return v;
  if (!line) {
    return { ok: false, error: "That line is not on the computed return (lines the engine does not emit yet cannot be overridden)." };
  }
  if (hasAmount(line.status) && line.amount !== null && dollarsToCents(new Decimal(line.amount)) === valueCents) {
    return { ok: false, error: "No change: the override equals the computed value." };
  }
  return { ok: true };
}

export const reasonSchema = z
  .string()
  .trim()
  .min(REASON_MIN_LENGTH, `Give a reason (at least ${REASON_MIN_LENGTH} characters).`)
  .max(REASON_MAX_LENGTH, `The reason can be at most ${REASON_MAX_LENGTH} characters.`);

// ── Action result shapes (shared with the T8 UI) ─────────────────────────────

export type OverrideActionResult =
  | { ok: true; id: string; version: number }
  | { ok: false; error: string; code?: "conflict" };

/** One version of one target, as returned by listTaxReturnOverrideHistory. Reasons are tax records. */
export interface OverrideHistoryRow {
  id: string;
  version: number;
  valueKind: string;
  valueCents: number | null;
  valueText: string | null;
  authority: string;
  reason: string;
  setByName: string;
  /** ISO timestamp. */
  setAt: string;
  archivedAt: string | null;
  archiveKind: string | null;
  archiveReason: string | null;
}

export type OverrideHistoryResult = { ok: true; rows: OverrideHistoryRow[] } | { ok: false; error: string };

// ── Statuses ──────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<RuleStatus, string> = {
  computed: "computed",
  not_applicable: "not applicable",
  missing_input: "missing input",
  needs_cpa_rule_unverified: "needs CPA review (rule not verified)",
  needs_cpa_judgment: "needs CPA judgment",
  not_yet_computed: "not yet computed",
};

function statusLabel(status: string): string {
  return status in STATUS_LABEL ? STATUS_LABEL[status as RuleStatus] : status;
}

/** A rule can be acknowledged only while it asks for CPA attention. */
export function isAckableStatus(status: RuleStatus): boolean {
  return status === "needs_cpa_rule_unverified" || status === "needs_cpa_judgment" || status === "missing_input";
}

// ── Snapshots (server-computed when the override is set) ─────────────────────

export const computedSnapshotSchema = z.object({
  status: z.string().min(1).max(40),
  cents: z.number().int().nullable(),
  engineVersion: z.string().max(40).optional(),
});
export type ComputedSnapshot = z.infer<typeof computedSnapshotSchema>;

function withVersion(s: { status: string; cents: number | null }, engineVersion: string | undefined): ComputedSnapshot {
  return engineVersion === undefined ? s : { ...s, engineVersion };
}

export function lineSnapshot(line: ReturnLine, engineVersion?: string): ComputedSnapshot {
  return withVersion({ status: line.status, cents: line.amount === null ? null : dollarsToCents(new Decimal(line.amount)) }, engineVersion);
}

export function ruleSnapshot(status: RuleStatus, engineVersion?: string): ComputedSnapshot {
  return withVersion({ status, cents: null }, engineVersion);
}

export function decisionSnapshot(decision: RuleDecision, engineVersion?: string): ComputedSnapshot {
  return withVersion({ status: decision.status, cents: null }, engineVersion);
}

// ── Rows ──────────────────────────────────────────────────────────────────────

/** The subset of a TaxReturnOverride row this module reads (a Prisma row satisfies it). */
export interface OverrideRow {
  id: string;
  taxYear: number;
  targetKind: string;
  targetKey: string;
  version: number;
  valueKind: string;
  valueCents: number | null;
  valueText: string | null;
  computedSnapshot: unknown;
  authority: string;
  reason: string;
  setByName: string;
  setAt: Date;
  archivedAt: Date | null;
}

interface ActiveBase {
  id: string;
  taxYear: number;
  targetKey: string;
  version: number;
  authority: OverrideAuthority;
  reason: string;
  setByName: string;
  /** ISO timestamp. */
  setAt: string;
  snapshot: ComputedSnapshot;
}
export interface ActiveLineOverride extends ActiveBase {
  targetKind: "line";
  valueCents: number;
}
export interface ActiveDecisionOverride extends ActiveBase {
  targetKind: "decision";
  choice: string;
}
export interface ActiveAckOverride extends ActiveBase {
  targetKind: "rule_ack";
}
export type ActiveOverride = ActiveLineOverride | ActiveDecisionOverride | ActiveAckOverride;

export type ParsedRow = { ok: true; value: ActiveOverride } | { ok: false; id: string; error: string };

/** Validates one stored row. A row that does not parse is reported, never silently dropped. */
export function parseOverrideRow(row: OverrideRow): ParsedRow {
  const fail = (error: string): ParsedRow => ({ ok: false, id: row.id, error });
  const authority = OVERRIDE_AUTHORITIES.find((a) => a === row.authority);
  if (!authority) return fail(`unknown authority "${row.authority}"`);
  const snap = computedSnapshotSchema.safeParse(row.computedSnapshot);
  if (!snap.success) return fail("the stored computed snapshot is unreadable");
  const common: ActiveBase = {
    id: row.id,
    taxYear: row.taxYear,
    targetKey: row.targetKey,
    version: row.version,
    authority,
    reason: row.reason,
    setByName: row.setByName,
    setAt: row.setAt.toISOString(),
    snapshot: snap.data,
  };
  switch (row.targetKind) {
    case "line": {
      if (row.valueKind !== "money_cents" || row.valueCents === null) return fail("a line override needs a money value");
      const v = validateLineOverrideCents(row.valueCents);
      if (!v.ok) return fail(v.error);
      return { ok: true, value: { ...common, targetKind: "line", valueCents: row.valueCents } };
    }
    case "decision": {
      if (row.valueKind !== "choice" || row.valueText === null || row.valueText === "") {
        return fail("a decision override needs a choice");
      }
      return { ok: true, value: { ...common, targetKind: "decision", choice: row.valueText } };
    }
    case "rule_ack": {
      if (row.valueKind !== "ack") return fail("a rule acknowledgement carries no value");
      return { ok: true, value: { ...common, targetKind: "rule_ack" } };
    }
    default:
      return fail(`unknown target kind "${row.targetKind}"`);
  }
}

export interface InvalidOverride {
  id: string;
  error: string;
}
export interface OverrideAnomaly {
  targetKind: string;
  targetKey: string;
  /** Row ids, highest version first; the first one is the one applied. */
  ids: string[];
  message: string;
}

export interface ActiveSelection {
  active: ActiveOverride[];
  invalid: InvalidOverride[];
  anomalies: OverrideAnomaly[];
}

/**
 * One active override per target: archived rows are ignored, the HIGHEST version
 * wins, and a second active row (a write race) is reported as an anomaly.
 */
export function selectActiveOverrides(rows: readonly OverrideRow[]): ActiveSelection {
  const groups = new Map<string, ActiveOverride[]>();
  const invalid: InvalidOverride[] = [];
  for (const row of rows) {
    if (row.archivedAt !== null) continue;
    const parsed = parseOverrideRow(row);
    if (!parsed.ok) {
      invalid.push({ id: parsed.id, error: parsed.error });
      continue;
    }
    const k = `${parsed.value.targetKind}\u0000${parsed.value.targetKey}`;
    const list = groups.get(k);
    if (list) list.push(parsed.value);
    else groups.set(k, [parsed.value]);
  }
  const active: ActiveOverride[] = [];
  const anomalies: OverrideAnomaly[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.version - a.version);
    const winner = list[0];
    if (!winner) continue;
    active.push(winner);
    if (list.length > 1) {
      anomalies.push({
        targetKind: winner.targetKind,
        targetKey: winner.targetKey,
        ids: list.map((o) => o.id),
        message: `More than one active override exists for ${winner.targetKind} ${winner.targetKey}; the highest version (v${winner.version}) is applied. Re-confirm or clear it to tidy this up.`,
      });
    }
  }
  active.sort((a, b) => `${a.targetKind}:${a.targetKey}`.localeCompare(`${b.targetKind}:${b.targetKey}`));
  return { active, invalid, anomalies };
}

// ── Decisions fed to the engine ───────────────────────────────────────────────

/**
 * Active `decision` overrides as the engine's Ty2025Decisions. Unrecorded
 * decisions are simply absent, so the engine uses its conservative default and
 * marks it "default, undecided". A choice that is no longer in the registry is
 * ignored here (applyOverrides reports it as an orphan).
 */
export function decisionsFromOverrides(rows: readonly OverrideRow[]): Ty2025Decisions {
  const out: Ty2025Decisions = {};
  for (const o of selectActiveOverrides(rows).active) {
    if (o.targetKind !== "decision") continue;
    const key = decisionKeyOf(o.targetKey);
    if (!key) continue;
    const meta = { by: o.setByName, at: o.setAt };
    switch (key) {
      case "homeOfficeMethod": {
        const chosen = pick(DECISION_REGISTRY.homeOfficeMethod.choices, o.choice);
        if (chosen) out.homeOfficeMethod = { chosen, ...meta };
        break;
      }
      case "depreciationElection": {
        const chosen = pick(DECISION_REGISTRY.depreciationElection.choices, o.choice);
        if (chosen) out.depreciationElection = { chosen, ...meta };
        break;
      }
      case "qbiForm": {
        const chosen = pick(DECISION_REGISTRY.qbiForm.choices, o.choice);
        if (chosen) out.qbiForm = { chosen, ...meta };
        break;
      }
      case "arborRoadPropertyTax": {
        const chosen = pick(DECISION_REGISTRY.arborRoadPropertyTax.choices, o.choice);
        if (chosen) out.arborRoadPropertyTax = { chosen, ...meta };
        break;
      }
      default:
        assertNever(key);
    }
  }
  return out;
}


// ── Formatting ────────────────────────────────────────────────────────────────

export { formatDollars, formatOverrideDate };

function describeState(status: string, cents: number | null): string {
  if (status === "computed" && cents !== null) return formatDollars(cents / 100);
  return statusLabel(status);
}

// ── The effective view ────────────────────────────────────────────────────────

export interface StaleInfo {
  /** What the base was when the override was set, e.g. "$12,345" or "missing input". */
  was: string;
  /** What the base is now. */
  now: string;
  message: string;
}

interface AppliedCommon {
  id: string;
  version: number;
  targetKey: string;
  authority: OverrideAuthority;
  reason: string;
  setByName: string;
  /** ISO timestamp. */
  setAt: string;
}
export interface AppliedLineOverride extends AppliedCommon {
  targetKind: "line";
  label: string;
  form: string;
  formLine: string;
  /** The base (computed) line when the override was applied. */
  was: { status: RuleStatus; amount: number | null };
  /** The computed line had no value (missing input / needs CPA / not yet computed): the override SUPPLIES it. */
  wasBlocked: boolean;
  /** The override value in whole dollars. */
  nowAmount: number;
  stale: StaleInfo | null;
}
export interface AppliedDecisionOverride extends AppliedCommon {
  targetKind: "decision";
  decisionId: DecisionId;
  label: string;
  choice: string;
  stale: StaleInfo | null;
}
export interface AppliedAckOverride extends AppliedCommon {
  targetKind: "rule_ack";
  ruleId: string;
  ruleStatus: RuleStatus;
  /** Blocking open items this acknowledgement moved out of the blocking list. */
  items: OpenItem[];
  stale: StaleInfo | null;
}
export type AppliedOverride = AppliedLineOverride | AppliedDecisionOverride | AppliedAckOverride;

export interface EffectiveLine {
  /** The engine's own line, untouched (a copy). */
  base: ReturnLine;
  effective: { amount: number | null; status: RuleStatus | "overridden" };
  override?: AppliedLineOverride;
  stale?: StaleInfo;
  /** Overridden lines this line is downstream of (per LINE_FLOW): "depends on overridden line X: confirm". */
  dependsOnOverridden?: LineKey[];
}

export interface EffectiveDecision extends RuleDecision {
  override?: AppliedDecisionOverride;
}

export interface OrphanOverride {
  id: string;
  targetKind: OverrideTargetKind;
  targetKey: string;
  version: number;
  message: string;
}
export interface StaleOverride {
  id: string;
  targetKind: OverrideTargetKind;
  targetKey: string;
  version: number;
  info: StaleInfo;
}
/** The engine version changed after the override was set but the computed value did NOT (advisory only). */
export interface EngineChangedOverride {
  id: string;
  targetKind: OverrideTargetKind;
  targetKey: string;
  version: number;
  was: string;
  now: string;
  message: string;
}
/** A blocking engine open item whose lines were ALL supplied by line overrides: no longer counted as blocking, still shown. */
export interface ResolvedByOverride {
  item: OpenItem;
  overrideIds: string[];
  /** formatOverrideNote of each override that supplied one of the item's lines. */
  notes: string[];
}

/** The nine headline rows and the line(s) each one is read from (return.ts buildHeadline). */
export const HEADLINE_ROWS = {
  "federal.agi": ["f1040.11a"],
  "federal.taxableIncome": ["f1040.15"],
  "federal.totalTax": ["f1040.24"],
  "federal.totalPayments": ["f1040.33"],
  /** The engine shows owe minus overpaid (positive = owe, negative = refund). */
  "federal.balance": ["f1040.37", "f1040.34"],
  "connecticut.ctAgi": ["ct1040.ctAgi"],
  "connecticut.tax": ["ct1040.6"],
  "connecticut.totalPayments": ["ct1040.18", "ct1040.19", "ct1040.20"],
  "connecticut.balance": ["ct1040.balance"],
} as const satisfies Record<string, readonly LineKey[]>;
export type HeadlineRowId = keyof typeof HEADLINE_ROWS;
export const HEADLINE_ROW_IDS = Object.keys(HEADLINE_ROWS) as HeadlineRowId[];

export interface HeadlineRowState {
  /** A source line of this row is overridden: the row's figure is NOT the engine's. */
  overridden: boolean;
  /** A source line of this row is downstream of an override and was NOT recomputed. */
  dependsOnOverride: boolean;
  /** The row's figure read from the effective lines (whole dollars) when a source line is overridden and every source has a value; else null. */
  effectiveAmount: number | null;
}

export interface EffectiveReturn {
  taxYear: 2025;
  filingStatus: "mfj";
  /** The engine version of the base return these overrides were applied to. */
  engineVersion: string;
  lines: Partial<Record<LineKey, EffectiveLine>>;
  /** Adjusted open items: acknowledged / resolved blocking items removed, override items added. */
  openItems: OpenItem[];
  /** Blocking items moved out by an acknowledgement, still visible to the reader. */
  acknowledged: { ruleId: string; override: AppliedAckOverride; items: OpenItem[] }[];
  /** Blocking items moved out because every line they name was supplied by a line override, still visible to the reader. */
  resolvedByOverride: ResolvedByOverride[];
  decisions: EffectiveDecision[];
  /** A copy of the engine headline with blockingItemCount / complete adjusted. Totals are the ENGINE's, see totalsNotRecomputed and headlineRows. */
  headline: Headline;
  headlineRows: Record<HeadlineRowId, HeadlineRowState>;
  /** True when a line override is in force: headline totals and downstream lines were NOT recomputed. */
  totalsNotRecomputed: boolean;
  applied: {
    lines: AppliedLineOverride[];
    decisions: AppliedDecisionOverride[];
    acks: AppliedAckOverride[];
  };
  stale: StaleOverride[];
  engineChanged: EngineChangedOverride[];
  orphans: OrphanOverride[];
  invalid: InvalidOverride[];
  anomalies: OverrideAnomaly[];
}

export interface ApplyOptions {
  /** Engine version to compare snapshots with. Defaults to base.engineVersion. */
  engineVersion?: string;
}

/** "CPA" or "Owner (Eric/Eva)": the plain labels the UI uses for the two authorities. */
export function authorityLabel(authority: OverrideAuthority): string {
  return authority === "cpa" ? "CPA" : "Owner (Eric/Eva)";
}

function who(o: { authority: OverrideAuthority }): { tag: string; by: string } {
  return o.authority === "cpa" ? { tag: "CPA", by: "per CPA" } : { tag: "Owner", by: "owner" };
}

/**
 * The single string every surface (sheet, CSV, PDF tooltip, cover) shows for an
 * override, so the wording cannot drift. Dates are America/New_York.
 */
export function formatOverrideNote(o: AppliedOverride): string {
  const { tag, by } = who(o);
  const when = formatOverrideDate(o.setAt);
  const tail = `by ${o.setByName} (${by}) on ${when}, reason: ${o.reason}`;
  switch (o.targetKind) {
    case "line": {
      const wasText =
        o.was.status === "computed" && o.was.amount !== null
          ? `${formatDollars(o.was.amount)} computed`
          : statusLabel(o.was.status);
      return `${tag} override: was ${wasText}, now ${formatDollars(o.nowAmount)}, ${tail}`;
    }
    case "decision":
      return `${tag} decision: ${o.label} set to ${o.choice}, ${tail}`;
    case "rule_ack":
      return `${tag} acknowledged rule ${o.ruleId} (reviewed; accepts as shown or will handle outside the app), ${tail}`;
  }
}

function lineWhere(line: ReturnLine): string {
  return `${line.form} line ${line.formLine}`;
}

type SnapshotComparison =
  | { kind: "same" }
  | { kind: "value"; was: string; now: string }
  | { kind: "engine"; was: string; now: string };

/** Value or status moved = "value" (blocking stale); only the engine version moved = "engine" (advisory). */
function compareSnapshot(snapshot: ComputedSnapshot, now: ComputedSnapshot): SnapshotComparison {
  if (snapshot.status !== now.status || snapshot.cents !== now.cents) {
    return { kind: "value", was: describeState(snapshot.status, snapshot.cents), now: describeState(now.status, now.cents) };
  }
  if (snapshot.engineVersion !== undefined && now.engineVersion !== undefined && snapshot.engineVersion !== now.engineVersion) {
    return { kind: "engine", was: `engine ${snapshot.engineVersion}`, now: `engine ${now.engineVersion}` };
  }
  return { kind: "same" };
}

function itemMatchesRule(item: OpenItem, ruleId: string, ruleLineKeys: ReadonlySet<LineKey>): boolean {
  // Real ids: "rule:<ruleId>" (return.ts ruleOpenItems). The bare / "<ruleId>:" forms are kept for older callers.
  if (item.id === `rule:${ruleId}` || item.id === ruleId || item.id.startsWith(`${ruleId}:`)) return true;
  // Conservative: every line the item names must belong to the rule. An item
  // that names no lines, or lines of other rules, is never auto-acknowledged.
  return item.lineKeys.length > 0 && item.lineKeys.every((k) => ruleLineKeys.has(k));
}

function openItem(
  id: string,
  severity: OpenItem["severity"],
  message: string,
  action: string,
  lineKeys: LineKey[]
): OpenItem {
  return { id, severity, message, action, lineKeys, refs: [] };
}

/** The lines (present on the return) that depend on `key` per LINE_FLOW: what a pin on `key` does NOT recompute. */
export function affectedLines(key: LineKey, present: Partial<Record<LineKey, unknown>>): LineKey[] {
  return downstreamOf(key)
    .filter((k) => present[k] !== undefined)
    .sort();
}

/**
 * Applies the active overrides to a computed return WITHOUT mutating it. Pure.
 * `results` is read only for rule ids / statuses / line keys (acks) and is never
 * copied into the output.
 */
export function applyOverrides(
  base: Ty2025Return,
  rows: readonly OverrideRow[],
  opts: ApplyOptions = {}
): EffectiveReturn {
  const { active, invalid, anomalies } = selectActiveOverrides(rows);
  const engineVersion = opts.engineVersion ?? base.engineVersion;

  const lines: Partial<Record<LineKey, EffectiveLine>> = {};
  for (const [key, line] of Object.entries(base.lines)) {
    if (!line) continue;
    const copy = structuredClone(line);
    lines[key as LineKey] = { base: copy, effective: { amount: copy.amount, status: copy.status } };
  }

  const openItems: OpenItem[] = structuredClone(base.openItems);
  const decisions: EffectiveDecision[] = structuredClone(base.decisions);
  const appliedLines: AppliedLineOverride[] = [];
  const appliedDecisions: AppliedDecisionOverride[] = [];
  const appliedAcks: AppliedAckOverride[] = [];
  const acknowledged: EffectiveReturn["acknowledged"] = [];
  const stale: StaleOverride[] = [];
  const engineChanged: EngineChangedOverride[] = [];
  const orphans: OrphanOverride[] = [];
  const extraItems: OpenItem[] = [];
  const dependents = new Map<LineKey, Set<LineKey>>();
  let removedBlocking = 0;

  const common = (o: ActiveOverride) => ({
    id: o.id,
    version: o.version,
    targetKey: o.targetKey,
    authority: o.authority,
    reason: o.reason,
    setByName: o.setByName,
    setAt: o.setAt,
  });
  const orphan = (o: ActiveOverride, message: string) => {
    orphans.push({ id: o.id, targetKind: o.targetKind, targetKey: o.targetKey, version: o.version, message });
    extraItems.push(
      openItem(
        `override-orphan:${o.targetKind}:${o.targetKey}`,
        "advisory",
        message,
        "The override is recorded but not applied. Clear it, or re-enter it against the current return.",
        []
      )
    );
  };
  const markStale = (o: ActiveOverride, info: StaleInfo, lineKeys: LineKey[]) => {
    stale.push({ id: o.id, targetKind: o.targetKind, targetKey: o.targetKey, version: o.version, info });
    extraItems.push(
      openItem(
        `override-stale:${o.targetKind}:${o.targetKey}`,
        "blocking",
        info.message,
        "Re-confirm the override (set it again with a reason) or clear it.",
        lineKeys
      )
    );
  };
  const markEngineChanged = (o: ActiveOverride, what: string, was: string, now: string, valueNote: string) => {
    const message = `${what} was set under ${was}; the return engine is now ${now}. ${valueNote}`;
    engineChanged.push({ id: o.id, targetKind: o.targetKind, targetKey: o.targetKey, version: o.version, was, now, message });
    extraItems.push(
      openItem(`override-engine:${o.targetKind}:${o.targetKey}`, "advisory", message, "Re-confirm it when convenient (set it again with a reason) or clear it.", [])
    );
  };

  for (const o of active) {
    if (o.targetKind === "line") {
      const entry = lines[o.targetKey as LineKey];
      if (!entry) {
        orphan(o, `Override on line ${o.targetKey} cannot be applied: that line is not on the computed return any more.`);
        continue;
      }
      const key = o.targetKey as LineKey;
      const cmp = compareSnapshot(o.snapshot, lineSnapshot(entry.base, engineVersion));
      let staleInfo: StaleInfo | null = null;
      if (cmp.kind === "value") {
        staleInfo = {
          was: cmp.was,
          now: cmp.now,
          message: `Override on ${lineWhere(entry.base)} may be out of date: computed value changed from ${cmp.was} to ${cmp.now} after it was set. Re-confirm or clear.`,
        };
      }
      const applied: AppliedLineOverride = {
        ...common(o),
        targetKind: "line",
        label: entry.base.label,
        form: entry.base.form,
        formLine: entry.base.formLine,
        was: { status: entry.base.status, amount: entry.base.amount },
        wasBlocked: !hasAmount(entry.base.status),
        nowAmount: o.valueCents / 100,
        stale: staleInfo,
      };
      entry.effective = { amount: applied.nowAmount, status: "overridden" };
      entry.override = applied;
      if (staleInfo) {
        entry.stale = staleInfo;
        markStale(o, staleInfo, [key]);
      } else if (cmp.kind === "engine") {
        markEngineChanged(
          o,
          `Override on ${lineWhere(entry.base)}`,
          cmp.was,
          cmp.now,
          `The computed value did not change (${describeState(o.snapshot.status, o.snapshot.cents)}).`
        );
      }
      appliedLines.push(applied);
      for (const d of downstreamOf(key)) {
        if (d === key) continue;
        const set = dependents.get(d) ?? new Set<LineKey>();
        set.add(key);
        dependents.set(d, set);
      }
    } else if (o.targetKind === "decision") {
      const dKey = decisionKeyOf(o.targetKey);
      if (!dKey) {
        orphan(o, `Decision override "${o.targetKey}" is not a decision this engine knows.`);
        continue;
      }
      const meta = DECISION_REGISTRY[dKey];
      if (!isValidDecisionChoice(dKey, o.choice)) {
        orphan(o, `Decision override ${meta.label} = "${o.choice}" is no longer a valid choice.`);
        continue;
      }
      const target = decisions.find((d) => d.id === meta.decisionId);
      if (!target) {
        orphan(o, `Decision override ${meta.label} cannot be shown: the computed return carries no ${meta.decisionId} decision.`);
        continue;
      }
      // A decision's own effect is the status flip from default_undecided to decided, which is expected, so it
      // is never blocking-stale; an engine version change is an advisory note only.
      const versionChanged =
        o.snapshot.engineVersion !== undefined && o.snapshot.engineVersion !== engineVersion;
      const applied: AppliedDecisionOverride = {
        ...common(o),
        targetKind: "decision",
        decisionId: meta.decisionId,
        label: meta.label,
        choice: o.choice,
        stale: null,
      };
      target.override = applied;
      appliedDecisions.push(applied);
      if (versionChanged) {
        markEngineChanged(
          o,
          `Decision ${meta.label}`,
          `engine ${o.snapshot.engineVersion ?? "?"}`,
          `engine ${engineVersion}`,
          "The decision is applied as recorded."
        );
      }
      if (target.chosen !== o.choice || target.status !== "decided") {
        extraItems.push(
          openItem(
            `override-decision-not-reflected:${dKey}`,
            "blocking",
            `The ${meta.label} decision (${o.choice}) is recorded but the computed return does not reflect it.`,
            "Recompute the return with the recorded decisions (decisionsFromOverrides) before relying on these numbers.",
            []
          )
        );
      }
    } else {
      const result = base.results.find((r) => r.ruleId === o.targetKey);
      if (!result) {
        orphan(o, `Acknowledgement of rule ${o.targetKey} cannot be applied: that rule is not on the computed return any more.`);
        continue;
      }
      const ackStale = o.snapshot.status !== result.status;
      const staleInfo: StaleInfo | null = ackStale
        ? {
            was: statusLabel(o.snapshot.status),
            now: statusLabel(result.status),
            message: `Acknowledgement of rule ${result.ruleId} may be out of date: its status changed from ${statusLabel(o.snapshot.status)} to ${statusLabel(result.status)} after it was recorded. Re-confirm or clear.`,
          }
        : null;
      const applied: AppliedAckOverride = {
        ...common(o),
        targetKind: "rule_ack",
        ruleId: result.ruleId,
        ruleStatus: result.status,
        items: [],
        stale: staleInfo,
      };
      if (staleInfo) {
        // Conservative: what is shown is not what the CPA reviewed, so nothing is un-blocked.
        markStale(o, staleInfo, []);
      } else {
        if (o.snapshot.engineVersion !== undefined && o.snapshot.engineVersion !== engineVersion) {
          markEngineChanged(
            o,
            `Acknowledgement of rule ${result.ruleId}`,
            `engine ${o.snapshot.engineVersion}`,
            `engine ${engineVersion}`,
            "The rule's status did not change."
          );
        }
        if (isAckableStatus(result.status)) {
          const ruleKeys = new Set<LineKey>(result.lines.map((l) => l.key));
          for (let i = openItems.length - 1; i >= 0; i--) {
            const item = openItems[i];
            if (!item || item.severity !== "blocking" || !itemMatchesRule(item, result.ruleId, ruleKeys)) continue;
            applied.items.unshift(item);
            openItems.splice(i, 1);
            removedBlocking += 1;
          }
          if (applied.items.length > 0) acknowledged.push({ ruleId: result.ruleId, override: applied, items: applied.items });
        }
      }
      appliedAcks.push(applied);
    }
  }

  // D2: a blocking engine item whose lines are ALL supplied by (fresh) overrides on blocked lines is resolved.
  const supplier = new Map<LineKey, AppliedLineOverride>();
  for (const l of appliedLines) if (l.wasBlocked && l.stale === null) supplier.set(l.targetKey as LineKey, l);
  const resolvedByOverride: ResolvedByOverride[] = [];
  const keptItems: OpenItem[] = [];
  for (const item of openItems) {
    if (item.severity === "blocking" && item.lineKeys.length > 0 && item.lineKeys.every((k) => supplier.has(k))) {
      const used = [...new Set(item.lineKeys.map((k) => supplier.get(k)))].filter((x): x is AppliedLineOverride => x !== undefined);
      resolvedByOverride.push({ item, overrideIds: used.map((u) => u.id), notes: used.map((u) => formatOverrideNote(u)) });
    } else {
      keptItems.push(item);
    }
  }

  // Dependents of overridden lines.
  for (const [dep, sources] of dependents) {
    const entry = lines[dep];
    if (!entry) continue;
    entry.dependsOnOverridden = [...sources].sort();
  }
  for (const l of appliedLines) {
    const key = l.targetKey as LineKey;
    const present = [...dependents.entries()]
      .filter(([dep, sources]) => sources.has(key) && lines[dep] !== undefined)
      .map(([dep]) => dep)
      .sort();
    if (present.length > 0) {
      extraItems.push(
        openItem(
          `override-downstream:${key}`,
          "advisory",
          `Line ${l.form} ${l.formLine} is overridden; these lines depend on it and were NOT recomputed: ${present.join(", ")}.`,
          "Confirm each dependent line, override it too, or change a decision instead.",
          present
        )
      );
    }
  }

  for (const inv of invalid) {
    extraItems.push(
      openItem(
        `override-invalid:${inv.id}`,
        "blocking",
        `A recorded override could not be read (${inv.error}) and was NOT applied.`,
        "Clear it and enter it again.",
        []
      )
    );
  }
  for (const a of anomalies) {
    extraItems.push(openItem(`override-conflict:${a.targetKind}:${a.targetKey}`, "advisory", a.message, "Re-confirm or clear the override.", []));
  }

  const finalItems = [...keptItems, ...extraItems];
  const headline = structuredClone(base.headline);
  const addedBlocking = extraItems.filter((i) => i.severity === "blocking").length;
  headline.blockingItemCount = Math.max(0, headline.blockingItemCount - removedBlocking - resolvedByOverride.length + addedBlocking);
  const totalsNotRecomputed = appliedLines.length > 0;
  headline.complete = base.headline.complete && headline.blockingItemCount === 0 && !totalsNotRecomputed;

  const headlineRows = {} as Record<HeadlineRowId, HeadlineRowState>;
  for (const id of HEADLINE_ROW_IDS) {
    const sources: readonly LineKey[] = HEADLINE_ROWS[id];
    const overridden = sources.some((k) => lines[k]?.override !== undefined);
    const dependsOnOverride = sources.some((k) => dependents.has(k));
    const amounts = sources.map((k) => lines[k]?.effective.amount ?? null);
    let effectiveAmount: number | null = null;
    if (overridden && amounts.every((a): a is number => a !== null)) {
      // Whole-dollar integers: plain arithmetic is exact. Federal balance = owe - overpaid (as the engine shows it).
      effectiveAmount = id === "federal.balance" ? amounts.reduce((a, b) => a - b) : amounts.reduce((a, b) => a + b, 0);
    }
    headlineRows[id] = { overridden, dependsOnOverride, effectiveAmount };
  }

  return {
    taxYear: base.taxYear,
    filingStatus: base.filingStatus,
    engineVersion: base.engineVersion,
    lines,
    openItems: finalItems,
    acknowledged,
    resolvedByOverride,
    decisions,
    headline,
    headlineRows,
    totalsNotRecomputed,
    applied: { lines: appliedLines, decisions: appliedDecisions, acks: appliedAcks },
    stale,
    engineChanged,
    orphans,
    invalid,
    anomalies,
  };
}
