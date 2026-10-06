// L2 oracle: the ledger the independent calculator writes its printed lines into, plus the shape of what it needs as input.
// Pure: no DB, no network, no clock.

import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import type { Maybe } from "@/lib/tax-review/l2/money";

/** What the oracle reads from the engine's Schedule C classification (the GL-account to Schedule C line map is an INPUT, not recomputed). */
export interface SchCDetailInput {
  lines: readonly { lineId: string; amountCents: number; accounts: readonly { rawCents: number }[] }[];
  otherExpenseItems: readonly { amountCents: number }[];
  unmapped: readonly unknown[];
  needsCpa: readonly unknown[];
  homeOfficeActualCandidates: readonly unknown[];
  vehicleActual: readonly unknown[];
  mileage: { entries: number; miles: number; deductionCents: number };
  cogsTotalCents: number;
  booksInterest: readonly { amountCents: number }[];
}

export interface OracleDecisions {
  homeOffice: "simplified" | "actual";
  qbiForm: "8995" | "8995a";
  arbor: "schedule_a" | "capitalize";
}

export interface OracleInputs {
  facts: Ty2025Facts;
  decisions: OracleDecisions;
  schC: SchCDetailInput | null;
  /** The printed amount of an engine line (whole dollars) or null when it has no amount. Used ONLY for "taken from the engine" inputs. */
  engineAmount: (key: string) => Maybe<number>;
}

export interface Abstention {
  /** The form / area the oracle did not recompute for this return. */
  area: string;
  reason: string;
}

/** One recomputed line: the value the oracle expects (whole dollars) and the lines it was derived from. */
export interface OracleLine {
  key: string;
  value: Maybe<number>;
  deps: readonly string[];
  /** "oracle" = recomputed from the facts; "engine" = a rare / stated line taken from the engine as an input (never diffed). */
  source: "oracle" | "engine";
  note?: string;
}

/** The oracle's output for one return. */
export class Ledger {
  readonly lines = new Map<string, OracleLine>();
  readonly abstentions: Abstention[] = [];
  /**
   * What the calculator worked out about which forms are needed from the FACTS (not from a printed line): form id -> required, null =
   * could not tell. Read by predictForms (forms-required.ts).
   */
  readonly formHints: Record<string, Maybe<boolean>> = {};

  /** Records a recomputed line and returns its value. */
  put(key: string, value: Maybe<number>, deps: readonly string[] = [], note?: string): Maybe<number> {
    this.lines.set(key, { key, value, deps, source: "oracle", ...(note !== undefined ? { note } : {}) });
    return value;
  }

  /** Records an input that comes from the engine (a rare line the owner stated, or a computation outside the oracle's scope). */
  engineInput(key: string, value: Maybe<number>, note?: string): Maybe<number> {
    this.lines.set(key, { key, value, deps: [], source: "engine", ...(note !== undefined ? { note } : {}) });
    return value;
  }

  get(key: string): Maybe<number> {
    return this.lines.get(key)?.value ?? null;
  }

  abstain(area: string, reason: string): void {
    if (!this.abstentions.some((a) => a.area === area && a.reason === reason)) this.abstentions.push({ area, reason });
  }
}

/** The "none" group a catalog line belongs to, if any (data in line-catalog.ts). */
export function noneGroupOf(key: string): string | null {
  try {
    return lineMeta(key as LineKey).group ?? null;
  } catch {
    return null;
  }
}
