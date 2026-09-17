# Request: DB-wiring layer for the tax computation engine (TY2025)

Build the layer that resolves real Prisma data into the plain-number/`Decimal` inputs
`lib/tax-compute.ts`'s `computePersonalTaxReturn` (and its constituent functions) actually take. That
engine is pure by design (no `db` imports) and currently has **zero importers anywhere in the app** —
this task is what actually makes it useful: wiring it up so a real page/action can call it with real
data and get real numbers.

## Context

`lib/tax-compute.ts` was just built and approved (`.claude/pipeline/tax-compute-engine/`, read that
whole folder — the request, plan, implementation, test report, and review — for full context on what it
computes and its documented scope boundaries/simplifications). It covers the Personal 1040 (Eric + Eva,
MFJ) + Schedule C (Eric Kinniburgh Consulting LLC) + CT-1040 — the only TY2025 filings actually due
Oct 15, 2026 (see `specs/07-source-data-notes.md` — Sudden Valley/Mezzo are out of scope, no 2025 filing
obligation).

The existing readiness tracker (`lib/tax-form-plan.ts`) already knows how to source data from
`Document`, `Paystub`, `MileageEntry`, `TaxQuestion`, and GL-mapped transactions (`computePL` in
`lib/reports.ts`) for the *readiness* question ("does this data exist yet?"). This task reuses those
same data sources but for the *arithmetic* question ("what's the actual dollar value?").

## What to build

A new module (e.g. `lib/tax-compute-build.ts`) with a function that takes an entity/year context, queries
the real Prisma data, and returns the fully-assembled input `computePersonalTaxReturn` needs — or,
where real data is genuinely missing/ambiguous, explicit `null`s that flow through into that function's
own `gaps` array (never a silently-invented number; `tax-compute.ts` already refuses to guess where data
is missing, per its own design — this wiring layer must preserve that discipline, not undermine it by
picking an arbitrary default).

Known **real, currently-blocking** data gaps from the compute-engine task (re-confirm each is still
accurate before building around it, since data may have changed):
1. No 2025 1098/property-tax-bill upload — `mortgage_interest` docType extracts a number but its
   extraction prompt is written for a monthly statement, not an annual 1098 total; `property_tax`
   docType's extraction shape is always `{}` (confirmed in the prior task). Sum what exists; flag if it
   looks like a partial-year figure rather than guessing it's the full year.
2. Home office square footage — not stored anywhere in the schema. This wiring layer should pass `null`
   (not invent a number) unless a schema change to add it is in scope for this task (your call after
   reading — if it's a small, additive, non-breaking migration, it may be worth including; if not,
   leave it for a separate task and just wire `null` through).
3. `MileageEntry` — re-check the actual row count for both entities/years before assuming it's still
   zero; wire through whatever's actually there.
4. Retirement contribution amounts — currently only a free-text `TaxQuestion` answer, not a structured
   number. Same call as #2: small additive schema change in scope, or wire `null` through.
5. Estimated tax payments — same as #4.
6. Federal/CT withholding from `Paystub.taxBreakdown` — that field is a freeform `{ label, amountCents
   }[]` array (confirmed in the prior task), not structured federal/state fields. Build the
   label-matching logic needed to sum "Federal Income Tax"/"CT Income Tax" (or however labels actually
   appear in real extracted data — check live data, don't guess the label text) across all of a tax
   year's paystubs, and treat an unmatched/unexpected label defensively (flag, don't silently drop or
   silently include).

## Ground rules (same as the prior task)

- Never fabricate a number. Every value either comes from real stored data or is explicitly `null`/
  flagged as a gap. Per CLAUDE.md ground rule 1.
- `Decimal` for all money math, never floats.
- If you do add schema fields (only if it's clearly the right call after reading the actual schema and
  weighing effort/value — this is a judgment call for the Planner to make explicitly, not assumed),
  that's a real Prisma migration: flag it clearly in the plan and implementation report, and do **not**
  push it without the owner's explicit confirmation (per this repo's established convention — push
  triggers an immediate Vercel deploy that runs `prisma migrate deploy`). Committing locally is fine;
  pushing a schema-changing commit is not, until the owner is back.
- Do not build UI in this task (no `components/tax/*` changes) unless the Planner judges a minimal
  capture UI for a newly-added schema field is small enough to bundle in — otherwise that's the next
  task ("gap-driven intake UI").
- Do not build a credits engine, PDF generation, or Sudden Valley/Mezzo logic — still out of scope.

## Required findings section

Same as the prior task: explicitly enumerate, in the plan, exactly which of the 6 gaps above got
resolved by this task (because the wiring found real data or a small schema addition was worth it) vs.
which remain genuinely blocked and need the owner directly. Don't let this get lost in implementation
detail — the owner needs a clear, current list of exactly what's still needed from them.
