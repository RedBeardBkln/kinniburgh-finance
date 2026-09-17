# Request: Tax computation engine (TY2025)

Build a pure tax computation engine at `lib/tax-compute.ts`, covering exactly the three things that
need a real 2025 filing by the Oct 15, 2026 deadline: the Personal 1040 (Eric + Eva, MFJ), Schedule C
for Eric Kinniburgh Consulting LLC (single-member disregarded entity), and CT-1040. Sudden Valley PM
LLC and Mezzo are explicitly out of scope — no 2025 filing obligation (see
`specs/07-source-data-notes.md`).

## Context

This repo already has a tax *readiness tracker* (`lib/tax-form-plan.ts`, `lib/tax-guidance.ts`,
`actions/tax.ts`, `components/tax/*`) that tracks whether documents/answers exist per form line, plus
an AI narrative review. What's missing, and what this task builds, is the actual arithmetic: given real
extracted document data / GL-mapped transactions / stored planning-question answers, compute real
dollar figures — wages, Schedule C net profit, SE tax, QBI deduction, standard-vs-itemized comparison,
federal taxable income and tax by bracket, CT AGI/CT taxable income/CT tax via the DRS Tables A-E, and
the federal Additional Medicare Tax check. This is pure, testable math — no PDF generation, no UI in
this task (that's separate follow-on work).

## Critical constraint — ground rule 1 (no fabricated financial data)

Every tax constant (bracket thresholds, standard deduction, SE tax wage base, QBI phase-out, CT Tables
A-E, mileage rate) MUST come from `specs/09-tax-year-2025-constants.md`, written after fetching
primary-source IRS/CT DRS documents directly (not search snippets — several secondary sources had wrong
CT bracket numbers and were discarded). The Planner must read that file as the sole source of truth for
constants and cite it in the plan; the Coder must not introduce any tax rate/threshold not present in
that file. If a computation needs a constant not in that file (e.g., the CT property tax credit
Schedule 3 mechanics, which that file flags as not-yet-verified against the primary form), stub it with
a clearly marked TODO/not-yet-implemented rather than guessing a number, and surface it as an explicit
gap in the plan and implementation report.

## Conventions to follow

- `Decimal` (never floats) for all money math, per `CLAUDE.md`.
- Pure functions, unit-tested in `lib/__tests__/tax-compute.test.ts` following existing test factory
  patterns in that directory.
- Look at `lib/business-quarter-forecast.ts` for the existing (deliberately simplified) tax-reserve
  estimate this supersedes for real-filing purposes, and at `lib/tax-form-plan.ts` for how form-line
  data is currently sourced from the DB so this engine's inputs line up with what's actually available
  (extracted documents, GL-mapped transactions, `TaxQuestionAnswer` rows, `MileageEntry`, paystub
  withholding) rather than assuming data that doesn't exist yet.

## Required findings section (not to build yet)

The Planner must explicitly enumerate every input this engine needs where the real data is currently
missing or incomplete in the live system. Known so far:
- No 2025 1098 / property-tax-bill upload yet for the itemize-vs-standard comparison.
- Home office square footage not stored anywhere.
- `MileageEntry` has zero rows for any entity despite the readiness checklist claiming mileage is
  "compiled."
- Retirement contribution dollar amounts not captured.
- Actual per-quarter estimated tax payments not captured beyond a yes/no answer.

Report these clearly so the owner can be asked directly rather than the engine silently assuming $0 or
guessing.

## Out of scope for this task

PDF form generation/filling, UI/intake screens, Sudden Valley / Mezzo tax logic, e-filing.
