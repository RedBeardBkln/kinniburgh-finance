# 01 — Plan: Gap-driven intake UI + real draft numbers on the personal tax workspace (TY2025)

## Restated goal

Wire the already-approved, currently-zero-importers pure tax engine (`lib/tax-compute.ts`) and its
DB-wiring layer (`lib/tax-compute-build.ts`) into `app/tax/personal/[year]/page.tsx` for the first
time, so Eric actually sees real, unmistakably-labeled draft numbers — and make the 5 known gaps
(3 code-ready, 2 blocked by real-world facts) visible and actionable in that same UI, reusing the
existing readiness-checklist/question UI wherever it can reasonably absorb the new signal instead of
building parallel components.

## Live-code re-verification (read directly, not assumed from the task prompt or prior plans)

- `lib/tax-compute.ts#computePersonalTaxReturn` throws for any `taxYear !== 2025` (TY2025-only
  constants) — confirmed at line 903. Any UI wiring must gate the call on `year === 2025`, matching
  the page's own existing `isExtensionYear = year === 2025` pattern (line 112).
- `lib/tax-compute-build.ts#buildPersonalTaxComputeInput(taxYear)` is fully self-contained (does its
  own `db.document.findMany`/`db.paystub.findMany`/`db.taxWorkspace.findUnique`/`db.mileageEntry
  .findMany`/`computePL` calls) — it does **not** reuse the page's already-fetched `allDocs`/`docs`
  arrays. Confirmed by reading the full function (lines 601–680). This task does not refactor that
  (already-approved, out of scope to touch) — accept the duplicate document/paystub query as a known,
  low-cost tradeoff (2-person household, small tables), not a bug to fix here.
- **`findUnparseableExtractions` is already exported and pure** (`lib/tax-compute-build.ts:142–158`)
  and only needs `{id, docType, taxYear, extractionStatus, extractionData}` — exactly the shape
  `app/tax/personal/[year]/page.tsx`'s existing `allDocs` query already returns (full `Document` rows,
  no `select`). **This means the mistagged-document detector can be called a second time directly in
  the page, against data the page already has, with zero changes to `lib/tax-compute-build.ts`.**
  Avoids touching an already-approved, already-reviewed-three-times module at all.
- `ResolvedPersonalTaxComputeInput` (the wiring layer's return shape) exposes `input` (the exact
  `ComputePersonalTaxReturnInput` for the engine), `buildGaps: string[]`, and `scheduleCDataMissing:
  boolean` — confirmed at `lib/tax-compute-build.ts:449–459`. No document-id-level detail for the
  mistagged-doc case is exposed here (it's folded into a `buildGaps` string only) — reinforces the
  "call `findUnparseableExtractions` separately in the page" design above, since that's the only way
  to get a structured, per-document, deep-linkable signal without changing the wiring layer's shape.
- `app/tax/personal/[year]/page.tsx` already calls `computePL` directly (no server action) for
  `ekcPL`/`svPL` (lines 64–66), inside an async Server Component gated by `if (!session?.user)
  redirect("/login")` at the top (line 26) — this is the live precedent for calling another DB-reading
  function (`buildPersonalTaxComputeInput`) directly in the same page, with the page's own session
  check as the auth gate, no new `actions/*.ts` file.
- `components/tax/personal-tax-client.tsx`'s "2 · Planning questions" section (lines 162–261) renders
  every `TaxQuestion` row passed in via the `questions` prop, filtered to `q.answer === null`
  (`unanswered`, line 131) — it has **zero hardcoded key list**; it renders whatever the page passes.
  Since `actions/tax-planning.ts#ensurePersonalWorkspace` (already shipped in the wiring task) now
  unconditionally backfills any missing `TAX_QUESTION_BANK` key via `createMany({skipDuplicates:
  true})` on every call (confirmed at `actions/tax-planning.ts:53–74`), and `page.tsx` calls
  `ensurePersonalWorkspace(year)` as its very first DB operation (line 32) before re-querying
  `db.taxQuestion.findMany` (line 36) — **the 3 new bank keys (`home_office_sqft`,
  `retirement_contribution_amount`, `estimated_tax_payments_amount`) already appear in the existing
  question UI automatically, with zero code changes, the next time `/tax/personal/2025` loads.**
  Confirmed end-to-end by reading the actual code path, not assumed. See "Design — question
  prominence" below for the one small enhancement this plan still proposes on top of that (ordering,
  not existence).
- `components/tax/tax-document-upload.tsx`'s document table (lines 235–371) is the only document list
  on this page — no separate route/page for documents, so a "point at the specific document" affordance
  has to be an in-page anchor + row highlight, not a new page.
- `lib/utils.ts#formatUSD` formats **cents** (its own doc comment: "Format cents as USD currency
  string"). Every money field this task surfaces (`lib/tax-compute.ts`'s `TaxComputeResult`) is a
  **Decimal DOLLAR amount**, not cents (confirmed via the file's own header comment and every function
  signature). Reusing `formatUSD` would require a `.times(100)` conversion at every call site — a real
  footgun given `lib/notifications.ts` already had to hand-roll its own dollar-native `formatUSD(d:
  Decimal)` (line 48) rather than reuse `lib/utils.ts`'s cents-native one. This task follows that same
  precedent: a new dollar-native formatter, not a reuse of the cents-native one.
- `lib/tax-guidance.ts#TAX_QUESTION_BANK`'s `home_office_sqft`/`retirement_contribution_amount`/
  `estimated_tax_payments_amount` entries (added in the wiring task, confirmed at lines 122–151,
  207–216) already carry good plain-language `context` copy — including `home_office_sqft`'s context
  explicitly noting eligibility is already confirmed. No copy changes needed to the question bank
  itself.

## Scope

**In scope**
- `app/tax/personal/[year]/page.tsx` — call `buildPersonalTaxComputeInput`/`computePersonalTaxReturn`
  (gated to `year === 2025`), call `findUnparseableExtractions` against the page's existing `allDocs`,
  serialize results via the new display module, pass everything as new props to `PersonalTaxClient`.
- New file `lib/tax-compute-display.ts` — pure formatting/labeling helpers (Decimal → formatted
  string, refund-vs-balance-due labeling, a small "promoted question key" predicate). No DB, no
  `"use server"`.
- New file `lib/__tests__/tax-compute-display.test.ts` — unit tests for every export above.
- `components/tax/personal-tax-client.tsx` — accept new props, render the new `TaxDraftNumbers`
  section, promote the 3 structured questions to the top of the unanswered list.
- New file `components/tax/tax-draft-numbers.tsx` — the one new presentational component: draft
  numbers + the two prominent gap alerts (EK Consulting zero-transactions, mistagged document) + the
  general caveats list. Not `"use client"` (no hooks/interactivity of its own).
- `components/tax/tax-document-upload.tsx` — accept an optional `flaggedDocumentIds?: string[]` prop;
  add a per-row `id` anchor and a small amber flag/highlight on matching rows.

**Explicitly NOT in scope (do not build)**
- No new `actions/*.ts` file and no `requireAuth()`-wrapped server action — see "Design — no new
  server action" below for the explicit justification (this directly answers the task's item 1, the
  answer is "the existing page-level auth gate already covers this, matching the `computePL`
  precedent in the same file").
- No changes to `lib/tax-compute.ts` or `lib/tax-compute-build.ts` (both already approved; this task
  reads their existing exports only).
- No re-extraction trigger for the mistagged document (still doesn't exist anywhere in the codebase,
  per the wiring plan's own finding) — the UI instructs the documented manual workaround (relabel +
  re-upload), it does not build the missing feature.
- No credits engine, no PDF generation, no Sudden Valley/Mezzo tax logic (unchanged scope boundary
  from both prior tasks in this trail).
- No client-side numeric validation on the 3 structured question inputs (the wiring layer's strict
  server-side parsing + `buildGaps` messaging already closes the loop — see Risks).
- No change to `ensurePersonalWorkspace`, `TAX_QUESTION_BANK`, or any other already-shipped
  wiring-task file.

## Design — no new server action (answers task item 1)

**Call `buildPersonalTaxComputeInput` and `computePersonalTaxReturn` directly inside
`app/tax/personal/[year]/page.tsx`, not through a new `actions/*.ts` file.**

Justification, not a shortcut:
1. This repo's confirmed RSC read-path convention (multiple prior tasks, e.g. `forecast`/`budgets`
   pages) is that pages performing only *reads* (no mutation) query directly inside the async Server
   Component; `actions/*.ts` is reserved for mutations. `buildPersonalTaxComputeInput` is a pure read
   (no `db.*.create/update/delete` anywhere in it — confirmed by reading the file in full above).
2. **This exact page already does this** for `computePL(ekcEntity.id, ...)`/`computePL(svEntity.id,
   ...)` (lines 64–66) — no action wrapper, just a direct call inside the already-`redirect("/login")`
   -gated Server Component. `buildPersonalTaxComputeInput` is architecturally identical: DB-aware,
   read-only, no `"use server"`.
3. The page's own `if (!session?.user) redirect("/login")` (line 26) is the auth gate — equivalent in
   effect to `requireAuth()`'s job, and it runs before any of this new code executes. There is no
   client-triggered call to `buildPersonalTaxComputeInput` anywhere in this design (it only runs at
   page-load time, server-side) — so the "client-reachable reads need their own auth check even when
   page-load reads don't" caveat (established in this repo for `actions/envelope.ts`) does not apply
   here.
4. Per this repo's own confirmed convention, there is **no existing precedent anywhere in the codebase
   for a server action that only fetches read-only display data** — inventing one here would be a
   first-of-its-kind deviation for no functional benefit, since the page-level gate already provides
   the auth enforcement CLAUDE.md requires.

If a future task ever needs to trigger this computation from a client-side interaction (e.g. a
"recompute now" button), that specific new call site would need its own `requireAuth()`-wrapped
action at that time — flagged here for the record, not built now (no such interaction is requested).

## Design — `computePersonalTaxReturn` result display (answers task item 2)

### New pure module: `lib/tax-compute-display.ts`

```ts
import { Decimal } from "@prisma/client/runtime/library";
import type { TaxComputeResult } from "@/lib/tax-compute";

export const DRAFT_LABEL = "DRAFT — before credits, not a filed number";

/** Dollar-native (NOT cents) formatter — mirrors lib/notifications.ts's own
 *  local dollar-native formatUSD precedent rather than lib/utils.ts's
 *  cents-native one. Always shows 2 decimals; negative Decimals render with
 *  a leading "-". */
export function formatTaxDollars(d: Decimal): string;

export type BalanceLabel = "Refund" | "Balance due" | "Even" | "Not computable";

/** d === null -> "Not computable" / amountFormatted: null (CT Table D/E's
 *  defensive-only unreachable-in-practice case). d.isZero() -> "Even".
 *  d > 0 -> "Refund" (payments/withholding exceeded tax). d < 0 -> "Balance
 *  due". amountFormatted is always the ABSOLUTE value, formatted — the label
 *  carries the sign meaning, never a bare negative number in the UI. */
export function describeBalance(d: Decimal | null): { label: BalanceLabel; amountFormatted: string | null };

export interface SerializedTaxDraft {
  taxYear: number;
  scheduleC: { mileageDeduction: string; homeOfficeDeduction: string; netProfit: string };
  federal: {
    totalIncome: string;
    agiUpperBound: string; // label reinforced in the component, not renamed again here
    deductionMethod: "standard" | "itemized";
    deductionUsed: string;
    taxableIncome: string;
    selfEmploymentTax: string;
    additionalMedicareTax: string;
    qbiDeduction: string;
    totalTaxBeforeCredits: string;
    totalPayments: string;
    balance: { label: BalanceLabel; amountFormatted: string | null };
  };
  connecticut: {
    ctAGI: string;
    ctTaxableIncome: string;
    ctTaxComputed: string | null;
    ctWithholding: string;
    balance: { label: BalanceLabel; amountFormatted: string | null };
  };
  gaps: string[]; // computePersonalTaxReturn's own gaps array, passed through verbatim
}

/** Converts every Decimal in a TaxComputeResult to a formatted display
 *  string — the ONLY place a Decimal instance from lib/tax-compute.ts is
 *  touched; nothing downstream (the page's props, the client component)
 *  ever receives a Decimal or Date instance, matching this repo's confirmed
 *  RSC-to-client serialization convention. */
export function serializeTaxComputeResult(result: TaxComputeResult): SerializedTaxDraft;

/** The 3 code-ready structured questions this task's predecessor added —
 *  used only to SORT them to the top of the existing unanswered-questions
 *  list (never to change which questions render; that's still driven
 *  entirely by real TaxQuestion rows, per the existing component). */
export const PROMOTED_TAX_QUESTION_KEYS = [
  "home_office_sqft",
  "retirement_contribution_amount",
  "estimated_tax_payments_amount",
] as const;

export function isPromotedTaxQuestion(key: string): boolean;
```

**Important scoping note for the Coder:** `scheduleCDataMissing` and `buildGaps` are NOT part of
`TaxComputeResult`/`SerializedTaxDraft` — they come from `ResolvedPersonalTaxComputeInput` (the
wiring layer), a sibling value, not a nested field. The page must pass them to `PersonalTaxClient`/
`TaxDraftNumbers` as separate props alongside the serialized engine result, not try to merge them into
`SerializedTaxDraft`. Keep these two sources visually and structurally distinct in the props (e.g.
`taxDraft: SerializedTaxDraft | null`, `scheduleCDataMissing: boolean`, `buildGaps: string[]`,
`mistaggedDocs: {id, docType, taxYear}[]`) — do not silently fold one into the other.

### Page wiring (`app/tax/personal/[year]/page.tsx`)

```ts
import { buildPersonalTaxComputeInput } from "@/lib/tax-compute-build";
import { computePersonalTaxReturn } from "@/lib/tax-compute";
import { findUnparseableExtractions } from "@/lib/tax-compute-build";
import { serializeTaxComputeResult } from "@/lib/tax-compute-display";

// ... after formPlan/answerMap/baseOps, before the return:

let taxDraft: SerializedTaxDraft | null = null;
let taxComputeError: string | null = null;
let scheduleCDataMissing = false;
let buildGaps: string[] = [];

if (year === 2025) {
  const resolved = await buildPersonalTaxComputeInput(year);
  if ("error" in resolved) {
    taxComputeError = resolved.error;
  } else {
    taxDraft = serializeTaxComputeResult(computePersonalTaxReturn(resolved.input));
    scheduleCDataMissing = resolved.scheduleCDataMissing;
    buildGaps = resolved.buildGaps;
  }
}

const mistaggedDocs = findUnparseableExtractions(
  allDocs.map((d) => ({
    id: d.id,
    docType: d.docType,
    taxYear: d.taxYear,
    extractionStatus: d.extractionStatus,
    extractionData: d.extractionData,
  }))
);
```

`mistaggedDocs` is computed for every year (cheap, pure, scans all documents regardless of tax year —
matches `findUnparseableExtractions`'s own existing all-years scan design), not gated to `year ===
2025`, since a mistagged document is a data-quality issue independent of which year's workspace is
open. `taxDraft`/`scheduleCDataMissing`/`buildGaps` ARE gated to `year === 2025` — for any other year,
`taxDraft` stays `null` and `TaxDraftNumbers` renders a small "computed draft numbers are only
available for tax year 2025 today" note instead of silently showing nothing (never a silent absence
per this trail's own established discipline).

### `TaxDraftNumbers` component — unmistakable draft framing (answers task item 2)

Placed in `personal-tax-client.tsx` as a new, unnumbered card directly after the existing "Strategy —
maximize the refund" objective banner and before "1 · Document intake" — highest-value new content,
first thing below the top banners, without renumbering the existing 1–5 sections (smaller diff, avoids
implying the existing flow changed).

Persistent draft framing, not a tooltip (per the Reviewer's explicit risk on the compute-engine task):
- Card header carries a permanent, non-dismissible badge with `DRAFT_LABEL`'s text — always rendered,
  same visual weight as the card title itself, not a hover-only tooltip.
- Every row label embeds its own caveat in plain text, mirroring the engine's own self-documenting
  field names rather than inventing new copy:
  - "AGI (upper bound — doesn't yet subtract retirement/HSA contributions)"
  - "Federal tax before credits"
  - "CT tax before credits"
  - "Federal balance due / refund before credits"
- A closing line under the whole card, distinct from (and in addition to) `PersonalTaxClient`'s
  existing bottom-of-page CPA disclaimer: "These are draft, pre-credit numbers for your CPA to review
  — not a filed return, not tax advice."

**When `scheduleCDataMissing` is true**, the entire numbers block (Schedule C through CT, since EK
Consulting's Schedule C net profit is a direct input to federal total income, AGI, taxable income, and
therefore CT AGI too — confirmed via `computePersonalTaxReturn`'s own orchestration order) is wrapped
in a red-bordered container with a persistent header: "These numbers are NOT reliable — EK Consulting
has no bank data (see below)." Real computed figures are still shown underneath (never hidden — hiding
a real, if currently-`$0`-derived, number would be less transparent than showing it clearly marked
untrustworthy), but a reader cannot see any of them without first seeing why they shouldn't be trusted.

## Design — the 2 prominent, specific action items (answers task item 4)

Both rendered as dedicated alert blocks at the very TOP of `TaxDraftNumbers` (above the numbers
themselves, so they're visible even if the numbers section is later collapsed/restyled) — not folded
into the generic caveats bullet list, and not new standalone top-level components (kept inside this
one new file, per the "don't build a new gaps-list component" instruction — see next section for why
that applies to the *generic* list, not these two).

**1. EK Consulting zero-transactions (`scheduleCDataMissing`)** — red-bordered block:
> **Schedule C can't be computed yet.**
> EK Consulting LLC has zero bank transactions on record for any period. Every figure below that
> includes Schedule C (net profit, total income, AGI, taxable income, federal tax, CT tax) is computed
> as if the business had $0 income and $0 expenses — which does not reflect real 2025 business
> activity. These numbers won't be trustworthy until EK Consulting's bank activity is connected and
> GL-coded.
> [Connect EK Consulting's accounts →](/accounts?bucket=ek-consulting)

(`/accounts?bucket=ek-consulting` confirmed as a real, valid deep link — `app/accounts/page.tsx`'s
`searchParams: Promise<{ bucket?: string }>` already supports this exact pattern.)

**2. Mistagged document(s) (`mistaggedDocs.length > 0`)** — amber-bordered block, one entry per
flagged doc:
> **A document may be mistagged.**
> "{documentTypeLabel(doc.docType)}" document uploaded {date} didn't extract cleanly under that
> document type — the file's real content likely doesn't match (a known live example: a real 2025
> mortgage-interest statement uploaded as a W-2). If this looks like the wrong type, use "Rename /
> retype" on the document below to relabel it, then **re-upload the same file** — relabeling alone
> does not re-run extraction; there's no automatic re-extract feature yet.
> [Jump to this document ↓](#doc-{id})

Each flagged doc's row in `tax-document-upload.tsx`'s table gets `id={`doc-${doc.id}`}` and a small
amber left-border/background + a "⚠ check type" badge in its Type cell, driven by the new
`flaggedDocumentIds?: string[]` prop (defaults to `[]`, so no behavior change for any existing caller
— confirmed this component has exactly one call site, `personal-tax-client.tsx`).

## Design — absorbing `gaps`/`buildGaps` into existing UI (answers task item 5)

**My call: don't build a new dedicated gaps-list component; render the remaining (non-prominent)
`gaps` + `buildGaps` entries as a plain bullet list inside the new `TaxDraftNumbers` card** (below the
numbers, above the closing disclaimer line) — titled "Other caveats behind this draft."

Reasoning:
- The existing readiness checklist (section "5 · Forms & autofill plan", `lib/tax-form-plan.ts`) answers
  a structurally different question — a per-form-LINE boolean ("do we have source data for this
  field," green/amber dot) — not a prose caveat feed. `gaps`/`buildGaps` are full sentences with
  specific numbers/reasoning (e.g. mismatched mileage rates, unrecognized paystub labels, W2 employer
  names to self-verify) that don't fit a boolean-dot model without losing information. Retrofitting the
  checklist to carry prose would be a bigger, riskier change to an already-shipped component for a
  worse fit than just listing the strings.
- The task's own instruction is "don't build a new gaps-list component if an existing one can
  reasonably absorb this" — the readiness checklist can't reasonably absorb full-sentence caveats, but
  since `TaxDraftNumbers` is *already* a new component this task must build (for the numbers
  themselves), adding one more bullet-list section to that same file is not "a new gaps-list
  component" in the sense the instruction is warning against (a whole separate top-level card/file
  whose only job is displaying gaps) — it's a subsection of a component being built anyway.
- No deduplication logic between "prominently surfaced" items and the general list — the
  `scheduleCDataMissing` message and the mistagged-doc buildGaps entries will appear both as their own
  alert AND as a line in the general list. Accepted as a harmless, minor redundancy (reinforces the
  message) rather than building fragile string-matching to suppress duplicates — flagged in Risks.

## Design — question prominence (answers task item 3)

**Confirmed: no code change is required for the 3 new questions to appear** — `ensurePersonalWorkspace`
already backfills them and `PersonalTaxClient` already renders whatever `TaxQuestion` rows it's given
(see "Live-code re-verification" above).

**One small, justified addition on top of that:** promote the 3 structured keys
(`PROMOTED_TAX_QUESTION_KEYS`) to the top of the `unanswered` list in `personal-tax-client.tsx`,
instead of leaving them to sort by `createdAt` (which places newly-backfilled rows at the END of a
potentially 12-question list). Justification: the whole point of this task is making these
already-code-ready gaps unmissable; sorting them to the bottom of a long list undercuts that goal.
Implementation: partition `unanswered` into `promoted` (matching `isPromotedTaxQuestion(q.key)`,
in `PROMOTED_TAX_QUESTION_KEYS` order) and `rest`, render `promoted` first with a small badge/label
("Unlocks a real computed number below") distinguishing them from the general question list, then
`rest` unchanged below. No change to how questions are answered/saved (`handleAnswer` unchanged), no
schema/action change — purely a client-side array partition using the new pure `isPromotedTaxQuestion`
predicate.

## Affected files/modules

- `app/tax/personal/[year]/page.tsx` — modified (new imports, new computed values, new props passed
  to `PersonalTaxClient`).
- `lib/tax-compute-display.ts` — new (pure).
- `lib/__tests__/tax-compute-display.test.ts` — new.
- `components/tax/personal-tax-client.tsx` — modified (new props, renders `TaxDraftNumbers`, promotes
  3 question keys in the unanswered list).
- `components/tax/tax-draft-numbers.tsx` — new (presentational, not `"use client"`).
- `components/tax/tax-document-upload.tsx` — modified (new optional `flaggedDocumentIds` prop, row
  `id` anchors, flagged-row styling).
- No changes to `lib/tax-compute.ts`, `lib/tax-compute-build.ts`, `lib/tax-guidance.ts`,
  `lib/tax-form-plan.ts`, `actions/tax.ts`, `actions/tax-planning.ts`, `prisma/schema.prisma`.

## Risks/unknowns

1. **Non-2025 years show no computed draft numbers** (the engine throws for any other `taxYear`) —
   this is a hard constraint of the already-approved engine, not something this task can or should work
   around. `TaxDraftNumbers` shows an explicit "only available for 2025 today" note rather than nothing,
   but a future multi-year engine extension is out of scope here.
2. **Duplicate DB queries**: `buildPersonalTaxComputeInput` independently re-fetches
   documents/paystubs/mileage/PL that the page has already fetched (`allDocs`) or could fetch once
   (EKC PL is already computed once for `ekcPL` at line 64, then `buildPersonalTaxComputeInput`
   computes it again internally for the same entity/year). Real, measurable but low-cost (2-person
   household, small tables) inefficiency — flagged, not fixed, since fixing it would mean changing
   `buildPersonalTaxComputeInput`'s signature (to accept pre-fetched data), which is out of scope for
   this task (that file is already approved and this task's job is to consume it, not refactor it).
3. **`scheduleCDataMissing`'s red-wrapper treats the WHOLE federal+CT block as unreliable**, not just
   the Schedule C line — this is a deliberate, more conservative design than the wiring layer's own
   narrower framing (which only explicitly warns about the Schedule C line itself). Justification is in
   the Design section above (cascading dependency, confirmed by reading the orchestration order) — flag
   this as a plan-level interpretation choice in case the owner would rather see federal wage-only
   figures (which ARE trustworthy independent of Schedule C) displayed without the red wrapper. Not
   resolved here; worth a quick confirmation with Eric if this feels too aggressive once built.
4. **No client-side numeric validation on the 3 promoted free-text questions** — a bad answer (e.g.
   "about $12k") is accepted by the existing generic text input, saved, and only surfaced as
   "unparseable" the next time the page reloads and `buildGaps` is recomputed (not instantly). This
   is a real, if minor, UX gap — flagged as a candidate follow-up, not built here (would require either
   inline client validation duplicate of `parseDollarAnswerToCents`'s regex, or a distinct input type
   for these 3 questions — both are small independent follow-ups, not bundled into this task).
5. **No dedup between the prominent alerts and the general caveats list** — see "Design — absorbing
   gaps" above; accepted, not a defect.
6. **The mistagged-document copy references "a known live example: a real 2025 mortgage-interest
   statement uploaded as a W-2" as general context** — this is grounded in a real, confirmed finding
   from the wiring task's live-data investigation (not fabricated), but the copy is written to apply
   generically to any future mistagged document too, not hardcoded to that one document's id — worth
   double-checking the Coder didn't accidentally hardcode a specific document id/name into the alert
   copy itself (it should be driven entirely by `findUnparseableExtractions`'s live output).
7. **`TaxDraftNumbers` is presentational but is imported into an already-`"use client"` file**
   (`personal-tax-client.tsx`) — it gets bundled into client JS regardless of not having its own
   `"use client"` directive (no Server-Component benefit from omitting it, since its parent is already
   fully client-rendered). This matches how `TaxDocumentUpload`/`OtherYearDocuments` are already both
   client components rendered from the same file — not a new pattern, just worth the Coder knowing
   `"use client"` is optional here for a reason (no hooks needed), not an oversight either way.

## Acceptance criteria

- `/tax/personal/2025` (`app/tax/personal/[year]/page.tsx` with `year=2025`) renders real,
  non-placeholder dollar figures from `computePersonalTaxReturn`'s live output for the actual
  household data —
  verified by comparing at least one rendered figure (e.g. total federal withholding) against the real
  live W2 sums documented in the wiring task's plan (Eric Rippling $40,958.31 fed + TriNet $7,318.36
  fed + Eva Fox Farm $118.79 fed + Eva Seacoast $4,202.03 fed = $52,598.51 total federal withholding
  from W2s alone, before any 1099/paystub contribution) — the Coder's completion report should state
  this comparison explicitly, not just "the page renders."
- Every dollar figure surfaced anywhere on this page carries visible "before credits"/"upper bound"/
  "draft" framing in its own row label or immediate vicinity — not solely in a tooltip, tab-away
  banner, or footer disclaimer. Verify by reading the rendered JSX directly (no component test
  infrastructure exists in this repo — see Test expectations).
- When `scheduleCDataMissing` is true (current live state, per the wiring task's finding), the red
  "Schedule C can't be computed yet" alert renders with a working `/accounts?bucket=ek-consulting`
  link, and the wrapped numbers block is visually distinct (red border) from the non-flagged state.
- When `findUnparseableExtractions` returns at least one document (current live state — the real
  mistagged Pennymac-as-W2 document), the amber "A document may be mistagged" alert renders with a
  working `#doc-{id}` anchor link that resolves to a real, highlighted row in the document table below.
- The 3 promoted questions (`home_office_sqft`, `retirement_contribution_amount`,
  `estimated_tax_payments_amount`) render at the top of the unanswered-questions list whenever
  unanswered, each with the "Unlocks a real computed number below" badge.
- `pnpm typecheck`, `pnpm lint`, `pnpm vitest run lib/__tests__/tax-compute-display.test.ts` all pass;
  full `pnpm test` shows no regressions elsewhere.
- No `prisma/schema.prisma` changes; no new `actions/*.ts` file; no changes to `lib/tax-compute.ts` or
  `lib/tax-compute-build.ts` (verify via `git diff` — this must be the Coder's own explicit check, not
  assumed).
- The Coder's completion report restates the disposition of the original 5 gaps (3 code-ready + 2
  blocked-by-real-world-facts) plus the wiring task's gaps 6/7/8/9, exactly matching this plan's and
  the wiring plan's numbering, so the trail stays traceable across all three tasks.

## Test expectations

**Genuinely testable (pure functions in `lib/tax-compute-display.ts`), `lib/__tests__/tax-compute-
display.test.ts`, Vitest, following this repo's `D = (s) => new Decimal(s)` local-helper convention:**

- `formatTaxDollars` — `D("1234.5")` → `"$1,234.50"`; `D("0")` → `"$0.00"`; `D("1000000")` →
  `"$1,000,000.00"` (comma grouping); `D("-500")` → `"-$500.00"` (defensive — most callers pass
  non-negative Decimals per the engine's own `Decimal.max(0, ...)` floors, but the function itself
  must not silently drop a sign if ever called with one).
- `describeBalance` — `D("500")` → `{label: "Refund", amountFormatted: "$500.00"}`; `D("-750")` →
  `{label: "Balance due", amountFormatted: "$750.00"}` (note: absolute value, sign lives in the
  label); `D("0")` → `{label: "Even", amountFormatted: "$0.00"}`; `null` → `{label: "Not computable",
  amountFormatted: null}`.
- `isPromotedTaxQuestion` — each of the 3 real keys → `true`; an existing non-promoted key (e.g.
  `"retirement_contributions"`, `"estimated_taxes_2025"` — the pre-existing narrative questions, NOT
  their structured counterparts) → `false`; an arbitrary unknown key → `false`.
- `serializeTaxComputeResult` — **build the fixture by actually calling the real, already-approved
  `computePersonalTaxReturn` with a small deterministic input** (not a hand-rolled fake
  `TaxComputeResult` object), then assert `serializeTaxComputeResult`'s output against hand-computed
  expected strings. This is deliberate: it guards against type-shape drift between `tax-compute.ts` and
  this new display module, and reuses the already-proven-correct engine rather than re-deriving
  expected numbers independently. Cover at minimum: (a) a golden-path input producing a federal refund
  and a CT refund (both `describeBalance` labels should read "Refund"); (b) an input producing a
  federal balance due (e.g. lower withholding) to prove the negative-balance path renders "Balance due"
  end-to-end, not just in `describeBalance`'s own isolated unit test; (c) confirm `gaps` passes through
  verbatim (same array contents, not re-derived or filtered).

**Explicitly NOT unit-tested, per this repo's established convention (say so plainly rather than force
it):**
- `components/tax/tax-draft-numbers.tsx`, `components/tax/personal-tax-client.tsx`,
  `components/tax/tax-document-upload.tsx` — this repo has zero DOM/component-level test
  infrastructure (`vitest.config.ts` uses `environment: "node"`, no `jsdom`/`happy-dom` dependency, no
  `__tests__` directory under `components/` anywhere) — confirmed as of the most recent memory check on
  this repo. Verification for these three files is `pnpm typecheck` + `pnpm lint` (both must be clean)
  plus a manual click-through of `/tax/personal/2025` by the Coder/Tester, explicitly described in
  their reports (what was clicked, what rendered) rather than asserted without detail.
- `app/tax/personal/[year]/page.tsx`'s new wiring code itself (RSC page, DB-touching) — matches the
  existing "DB-touching wrapper isn't directly unit-tested" convention already established for
  `buildPersonalTaxComputeInput` and every other RSC page in this repo (none have dedicated test
  files). `pnpm typecheck` + manual verification against real live data (the specific W2/withholding
  comparison called out in Acceptance criteria) is this task's actual verification mechanism for this
  file.

## Required findings section (what's now visible/actionable to Eric vs. still not)

**Now visible/actionable after this task, that wasn't before:**
1. Real computed federal + CT draft tax numbers (total income, AGI upper bound, taxable income,
   federal tax before credits, SE tax, Additional Medicare Tax, QBI deduction, federal balance due/
   refund before credits, CT AGI/taxable income/tax/balance) — previously computed nowhere in the live
   app (both `lib/tax-compute.ts` and `lib/tax-compute-build.ts` had zero importers before this task).
2. The EK Consulting zero-transactions gap — previously only visible by reading pipeline planning docs
   or querying the DB directly; now a prominent, specific, linked alert on the actual page Eric uses.
3. The mistagged-document gap — previously invisible to any `docType`-scoped UI query (the wrong-type
   extraction just silently failed); now specifically flagged with a jump-link to the exact document
   row and concrete relabel-then-reupload instructions.
4. The 3 structured, code-ready questions — technically already appearing via the wiring task's
   backfill fix, but now promoted to the top of the question list with explicit "unlocks a real number"
   framing, rather than buried at the bottom of a long list.
5. Every other `gaps`/`buildGaps` caveat (mismatched mileage rates, unrecognized paystub labels,
   included-W2-employer-names-for-self-verification including the "reissued statement" TriNet
   ambiguity, zero-mortgage/property-tax-document notes, unanswered-question notes) — previously only
   in a pure function's return value nothing rendered; now a visible bullet list on the page.

**Still NOT visible/actionable after this task:**
1. **No way to actually fix the EK Consulting zero-transactions gap from this page** — the link goes to
   `/accounts?bucket=ek-consulting`, which is the existing (unrelated-to-this-task) account-linking
   flow; connecting real bank data is Eric's own action outside any code this task builds.
2. **No in-app re-extraction trigger** for the mistagged document — the fix is still fully manual
   (relabel, then re-upload the same file); no "re-run extraction" button exists anywhere in the
   codebase, this task doesn't add one.
3. **No credits engine** — every number shown is explicitly "before credits"; nothing here computes
   CTC, the solar 25D credit, the EV credit, or the Saver's Credit, even though `TAX_QUESTION_BANK`
   already asks about several of them. A household reading this page could reasonably want to see a
   post-credit estimate — that remains a distinct, larger future task.
4. **No multi-year support for computed numbers** — opening `/tax/personal/2024` or any other year
   shows the readiness checklist and questions as before, but no computed draft numbers (the engine is
   TY2025-only by design).
5. **CT Table D/E's `requiresManualLookup` fallback remains theoretically reachable** (though the
   engine's own review found it practically unreachable given the full tables) — if it ever did fire,
   `ctTaxComputed`/the CT balance would show "Not computable" per `describeBalance`'s null handling;
   this task doesn't change that behavior, just makes sure it renders honestly if it ever happens.
6. **Client-side answer validation for the 3 promoted questions remains absent** — a malformed answer
   is only caught on next page load via `buildGaps`, not instantly at save time (see Risks item 4).
