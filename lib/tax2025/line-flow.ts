// Static "this line feeds that line" table for the TY2025 return (CPA overrides).
//
// WHY THIS EXISTS: the engine is a set of rule modules, not a line graph, so a
// CPA line override (pin) cannot recompute totals. Instead applyOverrides uses
// this table to FLAG the lines downstream of a pinned line ("depends on an
// override: not recomputed"). It is display-only: it never changes a number.
//
// Where each edge comes from, in priority order:
//   1. the assembler's own A.sum / A.derive / A.copy calls in return.ts (the 1040
//      spine; a test scans that source and fails when an edge is missing here);
//   2. the inputs each rule module reads (lib/tax2025/rules/*.ts), for lines that
//      are computed INSIDE a rule (Schedule C, SE, 8959, QBI, Schedule A, D, 1-A,
//      HSA, IRA, saver's credit, Form 2210, CT);
//   3. the printed 2025 form text ("enter here and on ...") for the rest.
// Over-flagging is the safe failure (a flagged line just asks the CPA to confirm);
// a missing edge means a dependent is not flagged, so prefer extra edges.
//
// Tests (lib/__tests__/tax2025-line-flow.test.ts) pin: every key named here is a
// real LineKey, the graph is acyclic, and every spine edge in return.ts is present
// in the transitive closure.

import type { LineKey } from "@/lib/tax2025/types";

export type LineFlow = Partial<Record<LineKey, readonly LineKey[]>>;

type Keys = LineKey | readonly LineKey[];

/** [sources, destinations]: every source feeds every destination. */
const PAIRS: readonly (readonly [Keys, Keys])[] = [
  // ── Schedule C (Part I-V) ───────────────────────────────────────────────────
  [["schc.1", "schc.2"], "schc.3"],
  ["schc.3", "schc.5"],
  [["schc.35", "schc.36", "schc.37", "schc.38", "schc.39"], "schc.40"],
  [["schc.40", "schc.41"], "schc.42"],
  ["schc.42", "schc.4"],
  ["schc.4", "schc.5"],
  [["schc.5", "schc.6"], "schc.7"],
  ["schc.7", "schc.29"],
  [
    [
      "schc.8", "schc.9", "schc.10", "schc.11", "schc.12", "schc.13", "schc.14", "schc.15", "schc.16a", "schc.16b", "schc.17", "schc.18",
      "schc.19", "schc.20a", "schc.20b", "schc.21", "schc.22", "schc.23", "schc.24a", "schc.24b", "schc.25", "schc.26", "schc.27a", "schc.27b",
    ],
    "schc.28",
  ],
  ["schc.48", "schc.27b"],
  ["schc.28", "schc.29"],
  [["schc.29", "schc.30"], "schc.31"],
  // Net profit: Schedule 1 line 3, Schedule SE (line 2 -> line 3), Form 8995 line 1 and the IRA compensation limit.
  ["schc.31", ["sch1.3", "se.2", "se.3", "f8995.1i", "ira.a.7", "ira.b.7"]],

  // ── Schedule SE ─────────────────────────────────────────────────────────────
  ["se.2", "se.3"],
  ["se.3", "se.4a"],
  ["se.4a", "se.4c"],
  ["se.4c", ["se.6", "se.12"]], // below the floor (line 4c under $400) the SE tax is 0
  ["se.6", ["se.10", "se.11", "f8959.8"]],
  [["se.7", "se.8a"], "se.9"],
  [["se.8a", "se.8b", "se.8c"], "se.8d"],
  ["se.8d", "se.9"],
  ["se.9", "se.10"],
  [["se.10", "se.11"], "se.12"],
  ["se.12", ["se.13", "sch2.4"]], // "enter here and on Schedule 2, line 4"
  ["se.13", "sch1.15"], // "enter here and on Schedule 1, line 15"

  // ── Schedule 1 ──────────────────────────────────────────────────────────────
  ["sch1.3", "sch1.10"],
  [["sch1.1", "sch1.2a", "sch1.4", "sch1.5", "sch1.6", "sch1.7"], "sch1.10"],
  [
    [
      "sch1.8a", "sch1.8b", "sch1.8c", "sch1.8d", "sch1.8e", "sch1.8f", "sch1.8g", "sch1.8h", "sch1.8i", "sch1.8j", "sch1.8k", "sch1.8l",
      "sch1.8m", "sch1.8n", "sch1.8o", "sch1.8p", "sch1.8q", "sch1.8r", "sch1.8s", "sch1.8t", "sch1.8u", "sch1.8v", "sch1.8z",
    ],
    "sch1.9",
  ],
  ["sch1.9", "sch1.10"],
  ["sch1.10", "f1040.8"], // "enter here and on Form 1040 ... line 8"
  [
    ["sch1.24a", "sch1.24b", "sch1.24c", "sch1.24d", "sch1.24e", "sch1.24f", "sch1.24g", "sch1.24h", "sch1.24i", "sch1.24j", "sch1.24k", "sch1.24z"],
    "sch1.25",
  ],
  [
    [
      "sch1.11", "sch1.12", "sch1.13", "sch1.14", "sch1.15", "sch1.16", "sch1.17", "sch1.18", "sch1.19a", "sch1.20", "sch1.21", "sch1.23",
      "sch1.25",
    ],
    "sch1.26",
  ],
  ["sch1.26", "f1040.10"],
  // Retirement-plan / SE adjustments reduce QBI (Form 8995 instructions)
  [["sch1.15", "sch1.16", "sch1.17"], "f8995.1i"],

  // ── HSA (Form 8889, one per spouse) ─────────────────────────────────────────
  [["f8889a.2", "f8889a.3"], "f8889a.8"],
  [["f8889a.8", "f8889a.9"], "f8889a.12"],
  [["f8889a.2", "f8889a.12"], "f8889a.13"],
  [["f8889b.2", "f8889b.3"], "f8889b.8"],
  [["f8889b.8", "f8889b.9"], "f8889b.12"],
  [["f8889b.2", "f8889b.12"], "f8889b.13"],
  [["f8889a.13", "f8889b.13"], "sch1.13"],

  // ── IRA deduction (Pub. 590-A worksheets 1-1 / 1-2) ─────────────────────────
  [
    ["f1040.9", "sch1.11", "sch1.12", "sch1.13", "sch1.14", "sch1.15", "sch1.16", "sch1.17", "sch1.18", "sch1.19a", "sch1.23", "sch1.25"],
    "ira.magi",
  ],
  ["ira.magi", ["ira.a.7", "ira.b.7"]],
  [["ira.a.7", "ira.b.7"], "sch1.20"],

  // ── Schedule 2 ──────────────────────────────────────────────────────────────
  [["sch2.1a", "sch2.1b", "sch2.1c", "sch2.1d", "sch2.1e", "sch2.1f", "sch2.1y"], "sch2.1z"],
  [["sch2.1z", "sch2.2"], "sch2.3"],
  ["sch2.3", "f1040.17"],
  [["sch2.5", "sch2.6"], "sch2.7"],
  [
    [
      "sch2.17a", "sch2.17b", "sch2.17c", "sch2.17d", "sch2.17e", "sch2.17f", "sch2.17g", "sch2.17h", "sch2.17i", "sch2.17j", "sch2.17k",
      "sch2.17l", "sch2.17m", "sch2.17n", "sch2.17o", "sch2.17p", "sch2.17q", "sch2.17z",
    ],
    "sch2.18",
  ],
  [
    ["sch2.4", "sch2.7", "sch2.8", "sch2.9", "sch2.11", "sch2.12", "sch2.13", "sch2.14", "sch2.15", "sch2.16", "sch2.18", "sch2.19"],
    "sch2.21",
  ],
  ["sch2.21", "f1040.23"],

  // ── AMT and NIIT screens ────────────────────────────────────────────────────
  [["f1040.15", "scha.5e", "scha.17", "std.total", "f1040.3a", "qdcg.3"], "f6251.amti"],
  // Form 6251 lines 1a / 1b / 2a: AGI, total deductions, the senior deduction add-back (Schedule 1-A line 37) and the Schedule A taxes (line 7)
  [["f1040.11b", "f1040.14", "sch1a.37", "scha.7"], "f6251.amti"],
  ["f1040.16", "f6251.tmt"],
  ["f6251.amti", "f6251.tmt"],
  ["f6251.tmt", "f6251.amt"],
  ["f6251.amt", "sch2.2"],
  // Form 8960 (every printed line of Parts I-III; rules/form-8960.ts)
  ["f1040.2b", "f8960.1"],
  ["f1040.3b", "f8960.2"],
  ["f1040.5b", "f8960.3"],
  [["sch1.3", "sch1.5", "sch1.6"], ["f8960.4a", "f8960.4b"]],
  [["f8960.4a", "f8960.4b"], "f8960.4c"],
  [["f1040.7a", "sch1.4"], ["f8960.5a", "f8960.5b"]],
  [["f8960.5a", "f8960.5b", "f8960.5c"], "f8960.5d"],
  [["f8960.1", "f8960.2", "f8960.3", "f8960.4c", "f8960.5d", "f8960.6", "f8960.7"], "f8960.8"],
  ["scha.9", "f8960.9a"],
  [["scha.17", "std.total"], "f8960.9a"], // 9a is 0 when the standard deduction wins
  ["sch1.5", ["f8960.5c", "f8960.5d"]],
  [["scha.5a", "scha.5d", "scha.5e", "scha.17", "std.total", "f8960.8", "f1040.11a"], "f8960.9b"],
  [["f8960.9a", "f8960.9b", "f8960.9c"], "f8960.9d"],
  [["f8960.9d", "f8960.10"], "f8960.11"],
  [["f8960.8", "f8960.11"], "f8960.nii"],
  [["f1040.11a", "f1040.2b", "f1040.3b", "f1040.7a"], "f8960.nii"],
  ["f1040.11a", ["f8960.13", "f8960.niit", "f8960.6", "f8960.7", "f8960.10"]], // 6, 7, 10 wait for the MAGI (the owner statement is only asked over the threshold)
  [["f8960.13", "f8960.14"], "f8960.15"],
  [["f8960.nii", "f8960.15"], "f8960.16"],
  ["f8960.16", "f8960.niit"],
  ["f8960.nii", "f8960.niit"],
  ["f8960.niit", "sch2.12"],

  // ── Form 8959 ───────────────────────────────────────────────────────────────
  ["f8959.1", ["f8959.4", "f8959.20"]],
  [["f8959.4", "f8959.5"], "f8959.6"],
  ["f8959.6", "f8959.7"],
  ["f8959.4", "f8959.10"],
  [["f8959.9", "f8959.10"], "f8959.11"],
  [["f8959.8", "f8959.11"], "f8959.12"],
  ["f8959.12", "f8959.13"],
  [["f8959.7", "f8959.13", "f8959.17"], "f8959.18"],
  ["f8959.18", "sch2.11"], // "enter here and on Schedule 2, line 11"
  ["f8959.20", "f8959.21"],
  [["f8959.19", "f8959.21"], "f8959.22"],
  [["f8959.22", "f8959.23"], "f8959.24"],
  ["f8959.24", "f1040.25c"], // "enter here and on Form 1040, line 25c"

  // ── Form 8995 (QBI) ─────────────────────────────────────────────────────────
  ["f8995.1i", "f8995.2"],
  [["f8995.2", "f8995.3"], "f8995.4"],
  ["f8995.4", "f8995.5"],
  [["f8995.6", "f8995.7"], "f8995.8"],
  ["f8995.8", "f8995.9"],
  [["f8995.5", "f8995.9"], "f8995.10"],
  [["f1040.11b", "f1040.12e", "f1040.13b"], "f8995.11"],
  [["f1040.3a", "qdcg.3"], "f8995.12"],
  [["f8995.11", "f8995.12"], "f8995.13"],
  ["f8995.13", "f8995.14"],
  [["f8995.10", "f8995.14"], "f8995.15"],
  ["f8995.15", "f1040.13a"],
  // Lines 16 and 17: the loss carried to 2026 ("Combine lines 2 and 3" / "Combine lines 6 and 7"); they feed nothing in 2025
  [["f8995.2", "f8995.3"], "f8995.16"],
  [["f8995.6", "f8995.7"], "f8995.17"],

  // ── Standard deduction, Schedule A ──────────────────────────────────────────
  ["std.additional", "std.total"],
  ["std.total", "f1040.12e"], // 12e = the larger of itemized and standard
  ["scha.2", "scha.3"],
  ["scha.3", "scha.4"],
  [["scha.5a", "scha.5b", "scha.5c"], "scha.5d"],
  ["scha.5d", "scha.5e"],
  ["f1040.11a", ["scha.5e", "scha.14"]], // AGI drives the SALT phase-down and the charity limits
  [["scha.5e", "scha.6"], "scha.7"],
  [["scha.8a", "scha.8b", "scha.8c"], "scha.8e"],
  [["scha.8e", "scha.9"], "scha.10"],
  [["scha.11", "scha.12", "scha.13"], "scha.14"],
  [["scha.4", "scha.5e", "scha.7", "scha.8a", "scha.8e", "scha.10", "scha.14", "scha.15", "scha.16"], "scha.17"],
  ["scha.17", "f1040.12e"], // "enter on Form 1040, line 12e" when itemizing

  // ── Schedule 1-A (line 38 goes to Form 1040 line 13b) ───────────────────────
  // Every printed money line is an engine key; each part copies line 3, subtracts its threshold and, when the result is zero
  // or less, skips lines 11-12 (19-20, 28-29, 34) and carries the capped amount straight to the deduction line.
  ["f1040.11b", "sch1a.1"],
  ["sch1a.1", "sch1a.3"],
  ["sch1a.3", ["sch1a.8", "sch1a.16", "sch1a.25", "sch1a.31"]],
  [["sch1a.4a", "sch1a.4b"], "sch1a.4c"],
  [["sch1a.4c", "sch1a.5"], "sch1a.6"],
  ["sch1a.6", "sch1a.7"],
  [["sch1a.8", "sch1a.9"], "sch1a.10"],
  ["sch1a.10", ["sch1a.11", "sch1a.13"]],
  ["sch1a.11", "sch1a.12"],
  ["sch1a.12", "sch1a.13"],
  ["sch1a.7", "sch1a.13"],
  [["sch1a.14a", "sch1a.14b"], "sch1a.14c"],
  ["sch1a.14c", "sch1a.15"],
  [["sch1a.16", "sch1a.17"], "sch1a.18"],
  ["sch1a.18", ["sch1a.19", "sch1a.21"]],
  ["sch1a.19", "sch1a.20"],
  ["sch1a.20", "sch1a.21"],
  ["sch1a.15", "sch1a.21"],
  ["sch1a.23", "sch1a.24"],
  [["sch1a.25", "sch1a.26"], "sch1a.27"],
  ["sch1a.27", ["sch1a.28", "sch1a.30"]],
  ["sch1a.28", "sch1a.29"],
  ["sch1a.29", "sch1a.30"],
  ["sch1a.24", "sch1a.30"],
  [["sch1a.31", "sch1a.32"], "sch1a.33"],
  ["sch1a.33", ["sch1a.34", "sch1a.35"]],
  ["sch1a.34", "sch1a.35"],
  ["sch1a.35", ["sch1a.36a", "sch1a.36b"]],
  [["sch1a.36a", "sch1a.36b"], "sch1a.37"],
  [["sch1a.13", "sch1a.21", "sch1a.30", "sch1a.37"], "sch1a.38"],
  ["sch1a.38", "f1040.13b"],

  // ── Schedule D (and the Form 8949 totals that feed it) ──────────────────────
  [["schd.1a.d", "schd.1a.e"], "schd.1a.h"],
  [["schd.1b.d", "schd.1b.e", "schd.1b.g"], "schd.1b.h"],
  [["schd.2.d", "schd.2.e", "schd.2.g"], "schd.2.h"],
  [["schd.3.d", "schd.3.e", "schd.3.g"], "schd.3.h"],
  [["schd.8a.d", "schd.8a.e"], "schd.8a.h"],
  [["schd.8b.d", "schd.8b.e", "schd.8b.g"], "schd.8b.h"],
  [["schd.9.d", "schd.9.e", "schd.9.g"], "schd.9.h"],
  [["schd.10.d", "schd.10.e", "schd.10.g"], "schd.10.h"],
  [["schd.1a.h", "schd.1b.h", "schd.2.h", "schd.3.h", "schd.4", "schd.5", "schd.6"], "schd.7"],
  [["schd.8a.h", "schd.8b.h", "schd.9.h", "schd.10.h", "schd.11", "schd.12", "schd.13", "schd.14"], "schd.15"],
  [["schd.7", "schd.15"], "schd.16"],
  ["schd.16", "schd.21"],
  [["schd.16", "schd.21"], "f1040.7a"],
  [["schd.15", "schd.16"], "qdcg.3"],
  [["schd.7", "schd.15", "schd.21"], "f1040.16"], // the Schedule D Tax Worksheet

  // ── Schedule 3 and the saver's credit (Form 8880) ───────────────────────────
  ["f1040.11a", "f8880.8"],
  ["f8880.8", "f8880.10"],
  ["f8880.7", "f8880.10"],
  [["f1040.18", "sch3.1", "sch3.2", "sch3.3", "sch3.6d", "sch3.6l", "f8880.10"], "f8880.11"],
  [["f8880.10", "f8880.11"], "f8880.12"],
  ["f8880.12", "sch3.4"],
  [["sch3.6a", "sch3.6b", "sch3.6c", "sch3.6d", "sch3.6f", "sch3.6g", "sch3.6h", "sch3.6i", "sch3.6j", "sch3.6k", "sch3.6l", "sch3.6m", "sch3.6z"], "sch3.7"],
  [["sch3.1", "sch3.2", "sch3.3", "sch3.4", "sch3.5a", "sch3.5b", "sch3.7"], "sch3.8"],
  ["sch3.8", "f1040.20"],
  [["sch3.13a", "sch3.13b", "sch3.13c", "sch3.13d", "sch3.13z"], "sch3.14"],
  [["sch3.10", "sch3.11", "sch3.14"], "sch3.15"],
  ["sch3.15", "f1040.31"],

  // ── Schedule B ──────────────────────────────────────────────────────────────
  [["schb.2", "schb.3"], "schb.4"],
  ["schb.4", "f1040.2b"],
  ["schb.6", "f1040.3b"],

  // ── Form 1040 ───────────────────────────────────────────────────────────────
  [["f1040.1a", "f1040.1b", "f1040.1c", "f1040.1d", "f1040.1e", "f1040.1f", "f1040.1g", "f1040.1h"], "f1040.1z"],
  [["f1040.1z", "f1040.2b", "f1040.3b", "f1040.4b", "f1040.5b", "f1040.6b", "f1040.7a", "f1040.8"], "f1040.9"],
  [["f1040.9", "f1040.10"], "f1040.11a"],
  ["f1040.11a", "f1040.11b"],
  ["f1040.11b", ["f1040.15", "scha.2"]],
  [["f1040.12e", "f1040.13a", "f1040.13b"], "f1040.14"],
  ["f1040.14", "f1040.15"],
  [["f1040.15", "f1040.3a", "qdcg.3"], ["f1040.16", "qdcg.25"]],
  ["qdcg.25", "f1040.16"],
  [["f1040.16", "f1040.17"], "f1040.18"],
  [["f1040.19", "f1040.20"], "f1040.21"],
  [["f1040.18", "f1040.21"], "f1040.22"],
  [["f1040.22", "f1040.23"], "f1040.24"],
  [["f1040.24", "f1040.33"], ["f1040.34", "f1040.37"]],
  [["f1040.25a", "f1040.25b", "f1040.25c"], ["f1040.25d", "f1040.33"]],
  ["f1040.25d", "f1040.33"],
  ["f1040.26", "f1040.33"],
  [["f1040.27a", "f1040.28", "f1040.29", "f1040.30", "f1040.31"], "f1040.32"],
  ["f1040.31", "f1040.33"],
  ["f1040.32", "f1040.33"],

  // ── Form 2210 (informational estimate; line 38 on the 1040) ─────────────────
  [
    [
      "f1040.22", "sch2.4", "sch2.8", "sch2.9", "sch2.11", "sch2.12", "sch2.14", "sch2.15", "sch2.16", "sch2.17a", "sch2.17c", "sch2.17d",
      "sch2.17e", "sch2.17f", "sch2.17g", "sch2.17h", "sch2.17i", "sch2.17j", "sch2.17l", "sch2.17z", "sch2.19", "f1040.27a", "f1040.28",
      "f1040.29", "f1040.30", "sch3.9", "sch3.12", "sch3.13b",
    ],
    "f2210.4",
  ],
  ["f2210.4", "f2210.5"],
  [["f1040.25d", "sch3.11"], "f2210.6"],
  [["f2210.4", "f2210.6"], "f2210.7"],
  [["f2210.5", "f2210.8"], "f2210.9"],
  [["f2210.7", "f2210.9"], "f2210.19"],
  ["f2210.19", "f1040.38"],

  // ── Connecticut (rules/ct.ts, ct-schedule1.ts, payments.ts) ─────────────────
  ["f1040.11a", "ct1040.1"],
  ["ct1040.1", "ct1040.ctAgi"],
  [["ct1040.s1.31", "ct1040.s1.32", "ct1040.s1.33", "ct1040.s1.34", "ct1040.s1.35", "ct1040.s1.36", "ct1040.s1.36a", "ct1040.s1.37"], "ct1040.additions"],
  [
    [
      "ct1040.s1.39", "ct1040.s1.40", "ct1040.s1.41", "ct1040.s1.42", "ct1040.s1.43", "ct1040.s1.44", "ct1040.s1.45", "ct1040.s1.46",
      "ct1040.s1.47", "ct1040.s1.48", "ct1040.s1.48a", "ct1040.s1.48b", "ct1040.s1.48c", "ct1040.s1.48d", "ct1040.s1.49",
    ],
    "ct1040.subtractions",
  ],
  // Federal lines the CT Schedule 1 rule reads
  ["sch1.1", "ct1040.s1.42"], // the taxable state refund, repeated
  [["f1040.4b", "f1040.5b", "f1040.6b"], ["ct1040.s1.33", "ct1040.s1.41", "ct1040.s1.43", "ct1040.s1.44", "ct1040.s1.45", "ct1040.s1.48b"]],
  ["sch1.5", ["ct1040.s1.34", "ct1040.s1.46", "ct1040.s1.36", "ct1040.s1.36a"]],
  ["schc.13", ["ct1040.s1.36", "ct1040.s1.36a"]],
  // Line 3 = line 1 + additions; CT AGI = line 3 - subtractions (CT-1040 lines 1-5)
  [["ct1040.1", "ct1040.additions"], "ct1040.3"],
  [["ct1040.3", "ct1040.subtractions"], "ct1040.ctAgi"],
  ["ct1040.ctAgi", "ct1040.6"],
  ["sch2.2", "ct1040.9"],
  [["ct1040.6", "ct1040.7"], "ct1040.8"],
  [["ct1040.8", "ct1040.9"], "ct1040.10"],
  // Property tax credit (Schedule 3 lines 63-68; rules/ct-credits.ts and ct-settlement.ts)
  [["ct1040.ctAgi", "ct1040.10"], ["ct1040.s3.63", "ct1040.s3.65", "ct1040.s3.67", "ct1040.11"]],
  ["ct1040.s3.63", "ct1040.s3.65"],
  ["ct1040.s3.65", "ct1040.s3.67"],
  [["ct1040.s3.65", "ct1040.s3.67"], "ct1040.11"],
  // Tax, payments and settlement spine
  [["ct1040.10", "ct1040.11"], "ct1040.12"],
  [["ct1040.12", "ct1040.13"], "ct1040.14"],
  [["ct1040.14", "ct1040.15"], "ct1040.16"],
  ["ct1040.15", "ct1040.s4.69b"], // both come from the same use-tax input
  ["ct1040.16", "ct1040.17"],
  [["ct1040.18", "ct1040.19", "ct1040.20", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"], "ct1040.21"],
  [["ct1040.17", "ct1040.21"], "ct1040.22"],
  [["ct1040.17", "ct1040.21"], "ct1040.26"],
  [["ct1040.17", "ct1040.21"], "ct1040.balance"],
  // Settlement lines read the withholding, credits, overpayment and tax due
  [["ct1040.14", "ct1040.18", "ct1040.20c", "ct1040.22", "ct1040.26"], ["ct1040.25", "ct1040.27", "ct1040.28", "ct1040.29", "ct1040.30"]],
];

function asList(k: Keys): readonly LineKey[] {
  return typeof k === "string" ? [k] : k;
}

function buildFlow(pairs: readonly (readonly [Keys, Keys])[]): LineFlow {
  const out = new Map<LineKey, Set<LineKey>>();
  for (const [from, to] of pairs) {
    for (const f of asList(from)) {
      const set = out.get(f) ?? new Set<LineKey>();
      for (const t of asList(to)) set.add(t);
      out.set(f, set);
    }
  }
  const flow: LineFlow = {};
  for (const [f, set] of out) flow[f] = [...set];
  return flow;
}

export const LINE_FLOW: LineFlow = buildFlow(PAIRS);

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
