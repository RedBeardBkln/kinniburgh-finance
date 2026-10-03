// Static "this line feeds that line" table for the TY2025 return (T7 overrides).
//
// WHY THIS EXISTS: the engine is a set of rule modules, not a line graph, so a
// CPA line override (pin) cannot recompute totals. Instead applyOverrides uses
// this table to FLAG the lines downstream of a pinned line ("depends on
// overridden line X: confirm"). It is display-only: it never changes a number.
//
// Each edge is "SOURCE -> DESTINATION" taken from the printed form flow ("enter
// here and on Form 1040, line 8", "add lines ...") or, for CT-1040, from the
// composition in lib/tax2025/rules/ct.ts. Where the real flow passes through a
// printed line the engine has no key for yet (for example 1040 line 1z, Schedule
// SE line 2, Schedule A lines 7 / 8e), the edge skips that line and connects the
// keys that exist; the downstream closure is the same. Over-flagging is the safe
// failure (a flagged line just asks the CPA to confirm); a missing edge only
// means a dependent is not flagged, so extend this table when 1a/1b add keys.
//
// A test pins that every key named here exists in LINE_KEYS.

import { SCHEDULE_C_LINE_IDS, type LineKey } from "@/lib/tax2025/types";

export type LineFlow = Partial<Record<LineKey, readonly LineKey[]>>;

/** Schedule C expense lines that sum into line 28 (Part II). */
const SCHC_EXPENSE_IDS = SCHEDULE_C_LINE_IDS.filter(
  (id) => id !== "1" && id !== "4" && id !== "6" && id !== "30"
);

function schcExpenseEdges(): LineFlow {
  const out: Partial<Record<LineKey, readonly LineKey[]>> = {};
  for (const id of SCHC_EXPENSE_IDS) out[`schc.${id}`] = ["schc.28"];
  return out;
}

export const LINE_FLOW: LineFlow = {
  // ── Schedule C ────────────────────────────────────────────────────────────
  ...schcExpenseEdges(),
  "schc.1": ["schc.7"], // gross receipts (via lines 3 and 5)
  "schc.4": ["schc.7"], // cost of goods sold (via line 5, Part III line 42)
  "schc.6": ["schc.7"], // other income
  "schc.7": ["schc.29"],
  "schc.28": ["schc.29"],
  "schc.29": ["schc.31"],
  "schc.30": ["schc.31"], // business use of home
  // Net profit: Schedule 1 line 3, Schedule SE (line 2 -> line 3) and Form 8995 (line 1 -> 4).
  "schc.31": ["sch1.3", "se.3", "f8995.4"],

  // ── Schedule SE ───────────────────────────────────────────────────────────
  "se.3": ["se.4a"],
  "se.4a": ["se.4c"],
  "se.4c": ["se.6"],
  "se.6": ["se.9", "se.10", "se.11", "f8959.13"], // 8959 line 8 = Schedule SE line 6
  "se.8a": ["se.9"],
  "se.9": ["se.10"],
  "se.10": ["se.12"],
  "se.11": ["se.12"],
  "se.12": ["se.13", "sch2.4"], // "enter here and on Schedule 2, line 4"
  "se.13": ["sch1.15"], // deduction for one-half of SE tax: "enter here and on Schedule 1, line 15"

  // ── Schedule 1 ────────────────────────────────────────────────────────────
  "sch1.3": ["sch1.10"],
  "sch1.10": ["f1040.8"], // "enter here and on Form 1040 ... line 8"
  "sch1.13": ["sch1.26"],
  "sch1.15": ["sch1.26", "f8995.4"], // reduces QBI (Form 8995 instructions)
  "sch1.16": ["sch1.26", "f8995.4"],
  "sch1.17": ["sch1.26", "f8995.4"],
  "sch1.20": ["sch1.26"],
  "sch1.26": ["f1040.10"],

  // ── Schedule 2 ────────────────────────────────────────────────────────────
  "sch2.amt": ["sch2.3"],
  "sch2.3": ["f1040.17"],
  "sch2.4": ["sch2.21"],
  "sch2.11": ["sch2.21"],
  "sch2.12": ["sch2.21"],
  "sch2.21": ["f1040.23"],

  // ── Screens feeding Schedule 2 ────────────────────────────────────────────
  "f6251.amti": ["f6251.tmt"],
  "f6251.tmt": ["f6251.amt"],
  "f6251.amt": ["sch2.amt"],
  "f8960.nii": ["f8960.niit"],
  "f8960.niit": ["sch2.12"],

  // ── Form 8959 ─────────────────────────────────────────────────────────────
  "f8959.7": ["f8959.18"],
  "f8959.13": ["f8959.18"],
  "f8959.18": ["sch2.11"], // "enter here and on Schedule 2, line 11"
  "f8959.19": ["f8959.22"],
  "f8959.22": ["f8959.24"],
  "f8959.24": ["f1040.25c"], // "enter here and on Form 1040, line 25c"

  // ── Form 8995 (QBI) ───────────────────────────────────────────────────────
  "f8995.4": ["f8995.5"],
  "f8995.5": ["f8995.10"],
  "f8995.10": ["f8995.15"],
  "f8995.11": ["f8995.13"],
  "f8995.12": ["f8995.13"],
  "f8995.13": ["f8995.14"],
  "f8995.14": ["f8995.15"],
  "f8995.15": ["f1040.13a"],

  // ── Schedule A ────────────────────────────────────────────────────────────
  "scha.5a": ["scha.5d"],
  "scha.5b": ["scha.5d"],
  "scha.5c": ["scha.5d"],
  "scha.5d": ["scha.5e"],
  "scha.5e": ["scha.17"], // via line 7
  "scha.8": ["scha.17"], // via lines 8e / 10
  "scha.8c": ["scha.17"],
  "scha.8d": ["scha.17"],
  "scha.11": ["scha.14"],
  "scha.12": ["scha.14"],
  "scha.14": ["scha.17"],
  "scha.17": ["f1040.12"], // "enter on Form 1040, line 12e" when itemizing

  // ── Schedule 3 ────────────────────────────────────────────────────────────
  "sch3.1": ["sch3.8"],
  "sch3.4": ["sch3.8"],
  "sch3.5a": ["sch3.8"],
  "sch3.8": ["f1040.20"],
  "sch3.10": ["sch3.15"],
  "sch3.11": ["sch3.15"],
  "sch3.15": ["f1040.31"],

  // ── Form 1040 ─────────────────────────────────────────────────────────────
  "f1040.1a": ["f1040.9"], // via line 1z
  "f1040.2b": ["f1040.9"],
  "f1040.3a": ["qdcg.25"],
  "f1040.3b": ["f1040.9"],
  "f1040.7": ["f1040.9"],
  "f1040.8": ["f1040.9"],
  "f1040.9": ["f1040.11a"],
  "f1040.10": ["f1040.11a"],
  "f1040.11a": ["f1040.15", "f8995.11", "scha.5e", "scha.14", "ct1040.1"], // AGI drives taxable income, the QBI limit, the SALT phase-down and charity limits, and CT
  "f1040.12": ["f1040.14", "f8995.11"],
  "f1040.13a": ["f1040.14"],
  "f1040.13b": ["f1040.14"],
  "f1040.14": ["f1040.15"],
  "f1040.15": ["f1040.16", "qdcg.25"],
  "qdcg.25": ["f1040.16"],
  "f1040.16": ["f1040.18"],
  "f1040.17": ["f1040.18"],
  "f1040.18": ["f1040.22"],
  "f1040.19": ["f1040.21"],
  "f1040.20": ["f1040.21"],
  "f1040.21": ["f1040.22"],
  "f1040.22": ["f1040.24"],
  "f1040.23": ["f1040.24"],
  "f1040.24": ["f1040.34", "f1040.37"],
  "f1040.25a": ["f1040.25d"],
  "f1040.25b": ["f1040.25d"],
  "f1040.25c": ["f1040.25d"],
  "f1040.25d": ["f1040.33"],
  "f1040.26": ["f1040.33"],
  "f1040.31": ["f1040.33"],
  "f1040.33": ["f1040.34", "f1040.37"],

  // ── Connecticut (follows lib/tax2025/rules/ct.ts) ─────────────────────────
  "ct1040.1": ["ct1040.ctAgi"],
  "ct1040.additions": ["ct1040.ctAgi"],
  "ct1040.subtractions": ["ct1040.ctAgi"],
  "ct1040.ctAgi": ["ct1040.6", "ct1040.9"],
  "ct1040.6": ["ct1040.10"],
  "ct1040.9": ["ct1040.10"],
  "ct1040.10": ["ct1040.balance"],
  "ct1040.11": ["ct1040.balance"],
  "ct1040.15": ["ct1040.balance"],
  "ct1040.18": ["ct1040.balance"],
  "ct1040.19": ["ct1040.balance"],
  "ct1040.20": ["ct1040.balance"],
};

/**
 * Every line that (transitively) depends on `key`, excluding `key` itself. The
 * walk follows the table through keys that may not be present on a given return;
 * callers intersect the result with the lines that exist. Cycle-safe.
 */
export function downstreamOf(key: LineKey, flow: LineFlow = LINE_FLOW): LineKey[] {
  const seen = new Set<LineKey>();
  const stack: LineKey[] = [...(flow[key] ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || next === key || seen.has(next)) continue;
    seen.add(next);
    for (const further of flow[next] ?? []) stack.push(further);
  }
  return [...seen];
}
