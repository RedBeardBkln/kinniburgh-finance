# 01 — Plan: DB-wiring layer for the tax computation engine (TY2025)

## Restated goal

Build a new module, `lib/tax-compute-build.ts`, that resolves real Prisma data (`Document`,
`Paystub`, `MileageEntry`, `TaxQuestion`, GL-coded transactions via `computePL`) into the exact
plain-number/`Decimal` input shape `lib/tax-compute.ts#computePersonalTaxReturn` requires — making
the already-approved, currently-zero-importers pure tax engine actually usable against real
household data, while preserving its "never fabricate, flag instead of guess" discipline at the
data-resolution layer too.

## Live-data re-verification (ran directly against the real Supabase DB, read-only — not trusted
from the prior task's write-up)

I ran read-only Prisma queries against the actual production database (confirmed `DATABASE_URL`/
`DIRECT_URL` point at the only Supabase instance, per repo convention) via temporary in-repo `tsx`
scripts (deleted after use, per established convention). Findings below supersede the request
doc's "known so far" list where they differ.

1. **`MileageEntry`: zero rows for every entity, confirmed live** (`db.mileageEntry.groupBy` by
   entity returned `[]`). Matches the request doc's assumption — gap #3 is unchanged.
2. **Personal entity's `mortgage_interest`/`property_tax` Documents: zero rows, live** (not "exists
   but extraction is ambiguous" — genuinely **no document of either docType exists at all** for the
   personal entity). Worse than the request doc implied. **But** — see finding 6 below: a real 1098
   *was* uploaded, just filed under the wrong `docType`.
3. **`Paystub.taxBreakdown` real label text, confirmed live (2 real rows exist):**
   - Paystub A: `"Federal Income Tax"`, `"Social Security"`, `"Medicare"`, `"Connecticut State Income
     Tax"`, `"Connecticut Paid Family"`; `additionalWithholding`: `"Federal Tax (Additional)"`,
     `"State Tax (Additional)"`.
   - Paystub B: `"Social Security"`, `"Medicare"`, `"Federal Income Tax"`, `"CT Income Tax"`, `"CT
     PFML"`; `additionalWithholding`: `[]`.
   - **The CT withholding label itself varies between the two real paystubs** (`"Connecticut State
     Income Tax"` vs `"CT Income Tax"`), confirming the request's fragility concern is real, not
     theoretical, and grounding the exact regex design below (section "Paystub label-matching
     approach").
   - **Critical correction to the request doc's framing: both real paystubs are dated `2026-08-31`
     and `2026-08-28` — i.e. tax year 2026, not 2025.** For the TY2025 filing this engine covers,
     `Paystub`-sourced withholding contributes **$0** today (no row falls in range) — W2/1099
     structured fields are the real TY2025 withholding source (see finding 5). The label-matching
     logic is still worth building now (real, tested against real label text, and it will matter for
     next year's TY2026 filing), but **it does not resolve any TY2025 number by itself.** This must
     be stated plainly wherever gap #6 is discussed so nobody thinks TY2025 withholding is
     paystub-derived.
4. **`TaxQuestion` live answers for the personal workspace (`taxYear: 2025`), 9 rows exist:**
   - `retirement_contributions`: `answer: "skipped"`, `skippedReason: "Skipped for now"` — genuinely
     unanswered, not a usable free-text dollar figure. Gap #4 unchanged/confirmed.
   - `estimated_taxes_2025`: `answer: "Yes"` (free text) — confirms gap #5: no structured number, and
     "Yes" is explicitly unparseable as a dollar figure (must not be guessed at).
   - `home_office_ekc`: `answer: "yes_exclusive"` — **the household has already confirmed
     eligibility** for the home office deduction; only the square-footage number is missing. This
     materially raises the value of resolving gap #2 (a real, ready-to-claim ~$1,500 deduction is
     currently unclaimed for lack of one integer).
   - `itemized_vs_standard`: `answer: "standard"` — the household's own stated intent. Consistent
     with finding 2 (zero SALT/mortgage documents mean `computeItemizedDeduction`'s `itemizedTotal`
     will always be $0 today, so `selectDeductionMethod` will independently arrive at `"standard"`
     too — no contradiction, just confirms there's currently no real itemized data to lose by taking
     the standard deduction).
5. **W2/1099 documents for the personal entity, TY2025: real, complete, structured data exists** — 5
   W2 documents (Eric: Rippling PEO $186,160.26 wages / $40,958.31 fed / $11,123.90 CT withheld;
   Eric: TriNet HR III $34,627.20 wages / $7,318.36 fed / $2,189.12 CT withheld, whose own extraction
   summary self-describes as **"a reissued statement"** — ambiguous whether this is a legitimate
   second employer or a correction/duplicate of another W2 already counted, see finding 7; Eva: Fox
   Farm Brewery $9,194.37 wages / $118.79 fed; Eva: Seacoast Mushrooms $43,309.00 wages / $4,202.03
   fed / $1,945.13 CT — **this exact document is duplicated as a second `Document` row mistakenly
   tagged `taxYear: 2026`**, which correctly self-excludes from any `taxYear === 2025` filter, so it
   doesn't break the sum, but is worth flagging as a live data-quality item). 3 `1099-INT`/`1099-DIV`
   documents (TD Bank $1,124.32 interest, Pennymac $13.72 interest, Robinhood $3.58 qualified
   dividends — the Robinhood one is `1099-DIV`, out of this engine's scope, must be excluded from
   `interestIncome` and flagged, not silently summed in). **This means real federal/CT withholding
   for TY2025 is fully resolvable today from W2 + 1099 structured fields — the paystub-fragility
   concern (gap #6) is real but doesn't block TY2025 at all.**
6. **NEW finding, not in the request doc's list: one of the 5 "W2" documents is actually a real 2025
   Pennymac 1098 Mortgage Interest Statement, uploaded under the wrong `docType` (`"w2"`).** Its
   extraction (run under the w2 prompt, since `docType` at upload time drives which prompt runs) came
   back as prose Claude correctly refused to force into the W2 shape ("This document is a Form 1098
   ... It cannot be extracted into the requested W-2 JSON schema..."), which failed strict `JSON.parse`
   and fell into `doc-extract.ts#parseExtractionResponse`'s catch branch — `extractionData` is exactly
   `{ docType: "other", summary: "Could not parse extraction response.", data: { raw: "<the full
   refusal text>" } }`. **The real 1098 the whole gap-#1 discussion assumed didn't exist actually does
   exist in the system today — it's just unreadable to any docType-scoped query because it's
   mistagged.** `actions/tax-planning.ts#updateTaxDocument` already lets the owner correct `docType`
   post-upload, but does **not** re-trigger extraction — so relabeling alone won't fix the stale
   garbage `extractionData`. Concrete, owner-actionable next step (not built in this task, see Risks):
   relabel this document to `mortgage_interest`, then re-upload the same file (no "re-extract existing
   document" action exists anywhere in the codebase today) to get a real, usable `interestCents`
   figure into the system.
7. **NEW finding: EK Consulting LLC has ZERO `Transaction` rows of any kind — not just zero
   GL-coded ones — for its entire history, confirmed via `db.transaction.count({entityId: ekc.id})`
   returning 0 (not scoped to 2025; genuinely 0 forever).** `computePL(ekConsultingEntityId, ...)`
   for any 2025 date range therefore returns `{ incomeLines: [], expenseLines: [], totalIncome: 0,
   totalExpenses: 0 }`. **This is the single most consequential gap this investigation found and it
   is NOT one of the request doc's original 6** — `computeScheduleCNetProfit`'s arithmetic
   (`glIncomeTotal - glExpenseTotal - mileage - homeOffice`) would compute a small **negative**
   number today (since there's no income to net against even the modest home-office/mileage
   deductions), which would be actively misleading for a business that plainly had real 2025
   consulting revenue (that revenue is the entire reason a Schedule C filing is required). This is a
   bookkeeping/Plaid-sync gap, not something this wiring task can fix — flagged as the top blocker
   for the owner, and this plan's `buildPersonalTaxComputeInput` design includes an explicit
   `scheduleCDataMissing: boolean` output flag specifically so this can never look like a
   confirmed/final number (see design below).

## Scope

**In scope**
- New file `lib/tax-compute-build.ts` — a mix of pure resolver/classifier/parser functions (no `db`
  import, unit-tested) plus one DB-aware orchestrator function (`buildPersonalTaxComputeInput`,
  imports `db`, not unit-tested — matches this repo's established "pure matcher + DB-aware runner"
  pattern, e.g. `lib/dedupe.ts`/`lib/dedupe-runner.ts`, `lib/budget-pace.ts` + its
  `lib/notifications.ts` caller).
- New file `lib/__tests__/tax-compute-build.test.ts` — unit tests for every pure function only.
- **Two small, non-Prisma-migration additions to unblock gaps #2/#4/#5** (see "Schema decision"
  below): 3 new entries in `lib/tax-guidance.ts#TAX_QUESTION_BANK`, and a small fix to
  `actions/tax-planning.ts#ensurePersonalWorkspace`'s question-seeding guard so newly-added bank
  questions get backfilled into the *already-existing* 2025 workspace (currently only seeds when a
  workspace has literally zero questions — confirmed live: the 2025 workspace already has 9, so a
  new bank entry would silently never appear without this fix).
- No other files change.

**Explicitly NOT in scope (do not build)**
- **No Prisma schema/migration changes anywhere in this task** — see "Schema decision" below for the
  full reasoning; this is a deliberate, justified call, not an oversight.
- No `components/tax/*` changes, no new page, **no new `actions/tax*.ts` server action** — the
  request's own framing ("so a real page/action can call it") is the *motivation* for building this
  layer, not a mandate to also build that page/action in this task. `lib/tax-compute-build.ts`
  remains, like `lib/tax-compute.ts` before it, unwired from any live call site — that's the natural
  next task (flagged in Risks), not this one.
- No re-extraction trigger for the mistagged Pennymac document (finding 6) — flagged as a concrete
  owner-actionable item and a candidate small follow-up task, not built here.
- No attempt to computationally resolve the "reissued W2" ambiguity (finding 7) or the
  zero-EKC-transactions gap (finding 7... wait, renumber: see "Real gaps" section below for the
  final numbered list) — both are surfaced as flags for the owner, never guessed at.
- No changes to `lib/tax-compute.ts` itself (already approved, out of scope to touch).
- No credits engine, no PDF generation, no Sudden Valley/Mezzo logic (unchanged from the prior task).

## Schema decision — no Prisma migration in this task (explicit, justified call)

The request asks the Planner to explicitly weigh adding schema fields for (a) home office sqft, (b)
structured retirement-contribution amount, (c) structured estimated-tax-payment amounts, against
leaving them `null`.

**My call: none of the three need a Prisma migration at all**, because `TaxQuestion.answer` is
already a flexible `Json?` column intentionally designed to hold exactly this kind of
household-answered data point, and `lib/tax-guidance.ts#TAX_QUESTION_BANK` is a plain in-memory
array — adding a new question is a data-only change, not a schema change. Concretely:

- Add 3 new `TAX_QUESTION_BANK` entries: `home_office_sqft`, `retirement_contribution_amount`,
  `estimated_tax_payments_amount` — each free-text (`options: undefined`, matching the existing
  `retirement_contributions`/`estimated_taxes_2025` free-text pattern), with a placeholder that asks
  for a **plain whole-dollar (or whole-sqft) number, no prose** (e.g. `"e.g. 12000 (whole dollars,
  no $ sign needed)"`), specifically so the number is mechanically parseable rather than needing NLP
  over free English text like the existing `estimated_taxes_2025` question's own placeholder ("Paid
  Q1-Q4 estimates totaling $X; or 'none'") — that existing question's prose format is exactly why its
  real answer ("Yes") isn't usable; the new questions are deliberately narrower so their answers are.
  These are **new keys, not replacements** — the existing `retirement_contributions`/
  `estimated_taxes_2025` narrative questions stay as-is (they carry real context/legal-risk framing
  the new structured questions don't need to duplicate).
- Fix `ensurePersonalWorkspace`'s `if (existing.questions.length === 0)` guard to always attempt
  `db.taxQuestion.createMany({ data: TAX_QUESTION_BANK.map(...), skipDuplicates: true })` regardless
  of current question count (the existing `skipDuplicates: true` already makes this idempotent and
  answer-preserving — it can only ever *add* missing keys, never touch/overwrite an already-answered
  row, since the unique constraint is `@@unique([workspaceId, key])`). This is the one real code
  change needed to make the new questions actually appear the next time the owner opens `/tax`.
- The wiring layer (`lib/tax-compute-build.ts`) reads these 3 new keys' `answer` values, parses them
  strictly (reject anything that isn't a clean whole number — never guess at prose), and passes
  `null` through whenever unanswered/unparseable, exactly preserving the engine's existing gap
  discipline.

**Why not a real Prisma column instead:** a dedicated `Int`/`Decimal` column would be marginally more
type-safe, but (a) it requires a real migration the owner must explicitly confirm before it reaches
`main` (per this repo's push-gate convention), (b) it requires *some* UI change to actually write to
it (the existing free-text answer flow can't target a typed column), and (c) `TaxQuestion` was
already built specifically to avoid needing a new column per tax fact — reusing it is the
lower-risk, faster-to-unblock path, and the "small additive migration" tradeoff the request asked me
to weigh resolves cleanly in favor of "don't migrate" once this alternative is available. If a future
task wants stronger typing (e.g. because free-text parsing proves too fragile in practice), that's a
legitimate follow-up, not a blocker for this one.

**No Prisma migration means no push-gate concern for this task** — nothing here needs the owner's
explicit "OK to push" confirmation from CLAUDE.md's schema-change convention, since `schema.prisma`
is untouched.

## Affected files/modules

- `lib/tax-compute-build.ts` — new.
- `lib/__tests__/tax-compute-build.test.ts` — new.
- `lib/tax-guidance.ts` — add 3 `TAX_QUESTION_BANK` entries (data only, no type changes needed since
  `TaxQuestionDef` already supports free-text questions with no `options`).
- `actions/tax-planning.ts` — one small fix to `ensurePersonalWorkspace`'s seeding guard.
- No changes to `lib/tax-compute.ts`, `lib/tax-form-plan.ts`, `lib/reports.ts`, `prisma/schema.prisma`,
  any `components/tax/*` file, or any page/route.

## Design — `lib/tax-compute-build.ts`

### Paystub label-matching approach (grounded in the real label text from finding 3)

Two separate small classifiers, because `taxBreakdown` and `additionalWithholding` have different
real vocabularies (confirmed live):

```ts
export function classifyTaxBreakdownLabel(
  label: string
): "federal_income_tax" | "ct_income_tax" | "fica_or_other_excluded" | "unrecognized" {
  if (/federal/i.test(label) && /income tax/i.test(label)) return "federal_income_tax";
  if (/\b(connecticut|ct)\b/i.test(label) && /income tax/i.test(label)) return "ct_income_tax";
  if (/social security|medicare|paid family|pfml/i.test(label)) return "fica_or_other_excluded";
  return "unrecognized";
}

export function classifyAdditionalWithholdingLabel(
  label: string
): "federal" | "state_ct" | "unrecognized" {
  if (/federal/i.test(label)) return "federal";
  // additionalWithholding's own schema comment scopes this array to exactly
  // "extra federal/state tax money elected on the W-4" — no third category —
  // so any non-federal label here is treated as this household's one resident
  // state (CT). Documented assumption, not a guess: re-check if this
  // household ever has a second state's withholding on a paystub.
  if (/state|connecticut|\bct\b/i.test(label)) return "state_ct";
  return "unrecognized";
}
```

Verified against real label text: `"Federal Income Tax"` → federal_income_tax; `"Connecticut State
Income Tax"` and `"CT Income Tax"` → ct_income_tax (both real variants, confirmed live); `"Connecticut
Paid Family"` / `"CT PFML"` → fica_or_other_excluded (correctly excluded — CT PFML is a separate
payroll tax, not CT income tax withholding, and must never be summed into `ctWithholdingCents`);
`"Social Security"`/`"Medicare"` → fica_or_other_excluded; `"Federal Tax (Additional)"` → federal;
`"State Tax (Additional)"` → state_ct. Any label matching none of these (e.g. a hypothetical `"Local
Tax"` or `"NY State Tax"`) → `"unrecognized"` — excluded from both sums and pushed into a diagnostic
list, never silently included or silently dropped, per the request's explicit instruction.

```ts
export interface PaystubWithholdingInput {
  id: string;
  payDate: Date | null;
  extractStatus: string;
  taxBreakdown: unknown; // Paystub.taxBreakdown Json — { label, amountCents }[] shape expected
  additionalWithholding: unknown;
}

export interface PaystubWithholdingResult {
  federalWithholdingCents: number;
  ctWithholdingCents: number;
  paystubsIncluded: number;
  unrecognizedLabels: { paystubId: string; label: string; amountCents: number }[];
}

export function sumPaystubWithholding(
  paystubs: PaystubWithholdingInput[],
  taxYear: number
): PaystubWithholdingResult
```

Filters internally to `extractStatus === "complete" && payDate !== null && payDate.getUTCFullYear()
=== taxYear` (mirrors `computeMileageDeduction`'s own "caller passes everything, function filters by
year" convention from the approved engine) — for TY2025 today this returns `paystubsIncluded: 0`,
`federalWithholdingCents: 0`, `ctWithholdingCents: 0` (both real paystubs are 2026-dated, per finding
3), which is correct, not a bug.

### Unparseable-extraction detector (grounded in finding 6)

```ts
export function findUnparseableExtractions(
  documents: { id: string; docType: string; taxYear: number | null; extractionStatus: string | null; extractionData: unknown }[]
): { id: string; docType: string; taxYear: number | null }[]
```

Flags any document where `extractionStatus === "complete" && (extractionData as
{summary?:unknown})?.summary === "Could not parse extraction response."` — the exact literal string
`lib/doc-extract.ts#parseExtractionResponse`'s catch branch produces. This is a general, non-magic
-string-guessing check (not "does this doc mention 1098") that happens to catch finding 6's real
mistagged document precisely, and will catch any future doc/docType mismatch the same way.

### W2 / 1099 / itemized-document resolvers

```ts
export interface W2DocInput {
  id: string; docType: string; taxYear: number | null;
  extractionStatus: string | null; extractionData: unknown;
}
export interface W2SumResult {
  wagesCents: number; medicareWagesCents: number; federalWithheldCents: number; ctWithheldCents: number;
  includedDocs: { id: string; employerName: string | null; wagesCents: number }[];
  unusableDocs: { id: string; reason: string }[];
}
export function sumW2Documents(documents: W2DocInput[], taxYear: number): W2SumResult
```
Filters `docType === "w2" && taxYear === input taxYear && extractionStatus === "complete"`; requires
`typeof data.wagesCents === "number"` to include a doc (the mistagged-1098 case from finding 6 has
no `data.wagesCents` at all — correctly excluded and separately caught by
`findUnparseableExtractions`). `stateWithheldCents` is summed into `ctWithheldCents` — **documented
assumption inherited from `lib/tax-form-plan.ts`'s own pre-existing `hasW2StateWithholding` check**:
the W2 extraction shape has no state-code field, so every W2's state withholding is assumed CT. Not
new to this task, but restated because this wiring layer is the first place that assumption produces
a real dollar figure instead of just a boolean.

```ts
export interface Doc1099Input {
  id: string; docType: string; taxYear: number | null;
  extractionStatus: string | null; extractionData: unknown;
}
export interface Interest1099Result {
  interestIncomeCents: number; federalWithheldCents: number;
  includedDocs: { id: string; payerName: string | null; amountCents: number }[];
  excludedNonInterestDocs: { id: string; formVariant: string | null; amountCents: number }[];
}
export function sum1099InterestIncome(documents: Doc1099Input[], taxYear: number): Interest1099Result
```
Only `formVariant === "1099-INT"` counts toward `interestIncomeCents` (matches
`lib/tax-form-plan.ts#has1099Interest`'s own existing variant check). Any other variant found (e.g.
the real live Robinhood `1099-DIV`) is excluded and reported separately, never silently summed in as
"interest."

```ts
export interface ItemizedDocInput {
  id: string; docType: string; taxYear: number | null;
  extractionStatus: string | null; extractionData: unknown;
}
export interface ItemizedDocSumResult {
  mortgageInterestCents: number; mortgageInterestDocCount: number;
  propertyTaxCents: number; propertyTaxDocCount: number;
  notes: string[];
}
export function sumItemizedDocInputs(documents: ItemizedDocInput[], taxYear: number): ItemizedDocSumResult
```
`mortgage_interest`: sums `interestCents` across complete docs; **always** pushes a note when
`mortgageInterestDocCount > 0` (plan Risks item 7 from the engine task — monthly-statement-vs-annual
-1098 ambiguity is structural, not resolved by having more documents) and a different note when the
count is 0. `property_tax`: `propertyTaxCents` is always 0 (the shape is always `{}`, confirmed by
reading `doc-extract.ts` directly) — always pushes a note distinguishing "0 docs uploaded" from "docs
uploaded but this docType never yields a number."

### Free-text numeric answer parsers (grounded in finding 4 — the real "skipped" shape)

```ts
export function parseDollarAnswerToCents(
  answer: unknown, skippedReason: string | null
): { cents: number | null; unparseable: boolean }

export function parseSqftAnswer(
  answer: unknown, skippedReason: string | null
): { sqft: number | null; unparseable: boolean }
```
Both: if `skippedReason` is non-null, OR `answer` is `null`/`undefined`/empty string, return `{
value: null, unparseable: false }` — genuinely "not answered," not malformed (grounded in the real
live shape: `retirement_contributions`'s answer is literally the string `"skipped"` with
`skippedReason: "Skipped for now"` — a case a naive parser could mistake for "the user typed the word
skipped as a dollar figure" if it didn't check `skippedReason`). Otherwise, strict regex
(`/^\$?\s*[\d,]+(\.\d{1,2})?\s*$/` for dollars, `/^\d{1,5}\s*(sq\s?\.?\s?ft\.?)?$/i` for sqft) — a
match converts to cents (dollars) or a plain integer (sqft); no match returns `{ value: null,
unparseable: true }`. Never attempts to extract a number out of prose (e.g. the real live "Yes" or
"Paid Q1-Q4 estimates totaling $X" answers are correctly `unparseable: true`, not silently
interpreted).

```ts
export function resolveHomeOfficeSqft(
  eligibilityAnswer: unknown, // home_office_ekc TaxQuestion.answer
  sqftAnswer: unknown,        // home_office_sqft TaxQuestion.answer (new key)
  sqftSkippedReason: string | null
): { sqft: number | null; note: string | null }
```
Only returns non-null `sqft` when `eligibilityAnswer === "yes_exclusive"` AND
`parseSqftAnswer(sqftAnswer, sqftSkippedReason)` succeeds — a stray sqft number left over after the
user answers `"no"`/`"yes_shared"` to eligibility is deliberately ignored (with a note explaining
why), never used to compute a deduction the household isn't entitled to.

### Top-level pure resolver + DB-aware orchestrator

```ts
export interface RawPersonalTaxComputeInput {
  taxYear: number;
  personalDocuments: (W2DocInput & Doc1099Input & ItemizedDocInput)[]; // all Document rows,
  // any taxYear, archivedAt: null, for the personal entity — sub-resolvers filter by taxYear
  // internally; the full set (not pre-filtered) is needed so findUnparseableExtractions can scan
  // broadly.
  paystubs: PaystubWithholdingInput[]; // all Paystub rows for the personal entity
  taxQuestions: { key: string; answer: unknown; skippedReason: string | null }[]; // this year's
  // TaxWorkspace's questions ([] if no workspace exists yet for this year)
  mileageEntries: MileageEntryInput[]; // already date-filtered to [yearStart, yearEnd] by the caller,
  // matching the existing app/tax/personal/[year]/page.tsx query pattern
  ekConsultingGlIncomeTotal: Decimal; // computePL(ekConsultingEntityId, yearStart, yearEnd).totalIncome
  ekConsultingGlExpenseTotal: Decimal; // ...totalExpenses
}

export interface ResolvedPersonalTaxComputeInput {
  input: ComputePersonalTaxReturnInput; // exact shape tax-compute.ts needs
  buildGaps: string[]; // wiring-layer-specific caveats, distinct from (and meant to be merged
  // with, by a future caller) computePersonalTaxReturn's own `gaps` array
  scheduleCDataMissing: boolean; // true whenever both GL totals are zero — a hard signal a future
  // UI/caller must never render scheduleC.netProfit as a trustworthy number when this is true
}

export function resolvePersonalTaxComputeInput(
  raw: RawPersonalTaxComputeInput
): ResolvedPersonalTaxComputeInput
```

Pure — wires every resolver above together, assembles the exact `ComputePersonalTaxReturnInput`
(throwing nothing; `computePersonalTaxReturn`'s own `taxYear !== 2025` guard is the single source of
truth for year validation, this function doesn't duplicate it), and builds `buildGaps` by actually
inspecting what each sub-resolver returned (never a static list) — including, always, a
**high-priority entry when `scheduleCDataMissing` is true**: `"EK Consulting LLC has zero GL-coded
transactions for tax year {taxYear} — Schedule C net profit is computed as $0 income minus
deductions, which does NOT reflect real business activity. This number must not be trusted until
transactions are synced/imported and GL-coded for this entity."`

```ts
export async function buildPersonalTaxComputeInput(
  taxYear: number
): Promise<ResolvedPersonalTaxComputeInput | { error: string }>
```

DB-aware (imports `db`), not unit-tested (matches the `checkCardPaymentsDue`-style
"DB-touching wrapper around a tested pure function" precedent). Fetches, mirroring
`app/tax/personal/[year]/page.tsx`'s existing query shapes exactly:
- `getEntityBySlug("personal")` / `getEntityBySlug("ek-consulting")` — `{ error: ... }` if personal
  entity lookup fails (shouldn't happen; defensive).
- `db.document.findMany({ entityId: personal.id, archivedAt: null })` — all years/types.
- `db.paystub.findMany({ entityId: personal.id, archivedAt: null })` — all rows.
- `db.taxWorkspace.findUnique({ where: { entityId_taxYear: { entityId: personal.id, taxYear } } })`
  then `db.taxQuestion.findMany({ where: { workspaceId } })` if found, else `[]` (with a `buildGaps`
  note if no workspace exists yet for this year).
- `db.mileageEntry.findMany({ entityId: ekConsulting.id, archivedAt: null, date: { gte: yearStart,
  lte: yearEnd } })` (only if the ek-consulting entity lookup succeeded; `[]` + a note otherwise).
- `computePL(ekConsulting.id, yearStart, lte: yearEnd)` for the GL totals (same date-math pattern as
  `actions/reports.ts#exportCpaBundle`, per established convention).
- Calls `resolvePersonalTaxComputeInput` with everything assembled and returns its result directly.

## Real gaps — final enumeration (required section)

**Original 6, re-verified against live data:**
1. **1098/property-tax extraction ambiguity** — code path fully implemented
   (`sumItemizedDocInputs`), but live data reveals the real blocker isn't "ambiguous extraction," it's
   "the real 1098 is mistagged as a W2 and its extraction is garbage" (see new finding below). Data
   itself remains blocked until the owner relabels + re-uploads.
2. **Home office sqft** — code path fully implemented (`resolveHomeOfficeSqft` + new
   `home_office_sqft` question, no Prisma migration). Data blocked until the owner answers one new
   free-text question (household has already confirmed eligibility, so this is a one-field unblock).
3. **`MileageEntry` zero rows** — re-confirmed live for every entity/year. Code path already correct
   in the approved engine; nothing new to build here.
4. **Retirement contribution amount** — code path fully implemented (`parseDollarAnswerToCents` +
   new `retirement_contribution_amount` question, no migration). Data blocked until answered.
5. **Estimated tax payments** — same as #4, new `estimated_tax_payments_amount` question. Data
   blocked until answered.
6. **`Paystub.taxBreakdown` label matching** — code path fully implemented and unit-tested against
   real, live label text (including the confirmed CT-label variance across the 2 real paystubs).
   **Contributes $0 to the actual TY2025 filing today** because both real paystubs are TY2026-dated —
   this is a real, tested, reusable capability that will matter starting with next year's filing, not
   a TY2025 unblock.

**New, found during this investigation, not in the request doc's original list:**
7. **EK Consulting LLC has zero `Transaction` rows of any kind, ever** — the most consequential
   finding in this investigation. Not fixable by this wiring task (it's a bookkeeping/Plaid-sync gap).
   Surfaced via a dedicated `scheduleCDataMissing: boolean` flag plus a high-priority `buildGaps`
   entry, specifically so a negative-looking Schedule C net profit can never be mistaken for a real
   number by a future caller.
8. **A real 2025 Pennymac 1098 exists in the system today, mistagged `docType: "w2"`, extraction
   garbled as a result** — concrete, owner-actionable: relabel via the existing
   `updateTaxDocument` action, then re-upload the file (no re-extraction-trigger action exists yet —
   flagged as a small candidate follow-up task, not built here). `findUnparseableExtractions` will
   surface this document automatically once wired into a real caller.
9. **The "TriNet HR III, Inc." W2's own extraction summary self-describes as "a reissued statement"**
   — ambiguous whether it's a distinct second job or a correction/duplicate of another already-summed
   W2. The wiring layer sums it at face value (ground rule: sum what exists, never guess) but always
   surfaces every included W2's employer name + amount in `buildGaps` so the owner can self-verify
   before trusting total wages.

## Risks/unknowns

- **No live server action/page calls this module after this task** — by design (explicit scope
  boundary), but worth restating so nobody assumes `/tax/personal/2025` renders real numbers yet. The
  natural next task: a thin `actions/tax.ts` (or similar) addition plus a UI surface for
  `computePersonalTaxReturn`'s output, which should also pick up gap 8's re-extraction-trigger need.
- **The `stateWithheldCents`-means-CT assumption** (inherited from `tax-form-plan.ts`, restated here
  because this task is the first to turn it into a dollar figure) has no way to detect a real
  non-CT-state W2 if one ever appears — low risk given this household's confirmed CT residency, but
  worth a code comment flagging it as unverified-if-ever-violated.
- **`classifyAdditionalWithholdingLabel`'s `/state/i` fallback** assumes every non-federal
  `additionalWithholding` entry is CT, based on that array's schema-documented scope ("extra
  federal/state ... elected on the W-4") rather than an explicit state-code field — same class of
  assumption as above, flagged in the function's own doc comment.
- **`TAX_QUESTION_BANK`'s existing `estimated_taxes_2025` key is itself year-suffixed** (a
  pre-existing minor inconsistency/latent bug — the array is shared across all tax years via
  `ensurePersonalWorkspace(taxYear)`, so a literally-2025-named key will look stale in future years).
  Not this task's to fix; the 2 new keys added here are deliberately NOT year-suffixed to avoid
  repeating that pattern.
- **`ensurePersonalWorkspace`'s guard fix is a genuine behavior change** (previously: only ever seeds
  questions for a workspace with zero existing questions; after: always attempts an idempotent
  `skipDuplicates` backfill) — low risk (can only add missing keys, never touch answered ones,
  confirmed by the `@@unique([workspaceId, key])` constraint), but should be called out explicitly in
  the Coder's completion report as a real, if small, action-layer behavior change, not purely additive
  code.

## Acceptance criteria

- `lib/tax-compute-build.ts` exists; every function in the "Design" section above matches its stated
  signature; strict TypeScript, no `any`, no Prisma schema import beyond `Decimal`/`Prisma` types
  needed for typing.
- Only `buildPersonalTaxComputeInput` imports `db` — every other export is a pure function (verify by
  grepping the file for `import { db }` and confirming it appears exactly once, at the top, scoped
  only to that function's usage).
- No `prisma/schema.prisma` changes; no new migration file.
- `lib/tax-guidance.ts#TAX_QUESTION_BANK` has exactly 3 new entries (`home_office_sqft`,
  `retirement_contribution_amount`, `estimated_tax_payments_amount`), each free-text
  (`options: undefined`), no changes to any existing entry.
- `actions/tax-planning.ts#ensurePersonalWorkspace`'s seeding logic backfills missing bank keys for
  an already-existing workspace (verify by reading the diff: the `if (existing.questions.length ===
  0)` guard around the `createMany` call is removed or widened, `skipDuplicates: true` preserved).
- No `components/tax/*` file changes; no new route/page; no new `actions/*.ts` file.
- `resolvePersonalTaxComputeInput` never coerces a missing/unparseable value to a fabricated non-null
  number — every gap flows through as `null` (or, for engine-level `$0`-is-correct cases like zero
  mileage entries, `$0` paired with an explicit flag) plus a `buildGaps` entry.
- `scheduleCDataMissing` is `true` whenever both GL totals are zero, and the corresponding high
  -priority `buildGaps` message is present whenever that's true.
- `pnpm typecheck`, `pnpm lint`, `pnpm vitest run lib/__tests__/tax-compute-build.test.ts` all pass
  with zero new errors; full `pnpm test` shows no regressions elsewhere.
- The Coder's completion report explicitly restates the disposition of all 9 numbered gaps above
  (resolved-code-path-data-still-blocked vs. genuinely-out-of-scope vs. code-path-and-data-both-fine)
  exactly as enumerated in this plan, so the owner sees a current, accurate list without re-reading
  this whole document.

## Test expectations

Unit tests only, `lib/__tests__/tax-compute-build.test.ts`, Vitest, no DB (pure functions only — the
DB-aware `buildPersonalTaxComputeInput` is not unit-tested, matching this repo's established
"DB-touching wrapper isn't directly tested" convention).

**`classifyTaxBreakdownLabel`** — all 5 real label strings from live data (`"Federal Income Tax"`,
`"Connecticut State Income Tax"`, `"CT Income Tax"`, `"Connecticut Paid Family"`, `"CT PFML"`) plus
`"Social Security"`, `"Medicare"`, and one made-up unrecognized label (`"Local Tax"`) — assert each
lands in the correct bucket.

**`classifyAdditionalWithholdingLabel`** — real labels `"Federal Tax (Additional)"`, `"State Tax
(Additional)"`, plus an unrecognized made-up label.

**`sumPaystubWithholding`** — two fixtures shaped exactly like the two real live paystubs (literal
label text, literal amounts) summed correctly by category; a paystub dated outside `taxYear`
excluded; `extractStatus !== "complete"` excluded; an unrecognized label present in one fixture is
excluded from both sums and appears in `unrecognizedLabels`.

**`findUnparseableExtractions`** — a document shaped exactly like the real mistagged Pennymac-as-w2
case (`extractionStatus: "complete"`, `extractionData: { docType: "other", summary: "Could not parse
extraction response.", data: { raw: "..." } }`) → flagged; a normal complete W2 extraction → not
flagged; a `summary` match with `extractionStatus !== "complete"` → not flagged (pin this edge case).

**`sumW2Documents`** — multiple valid W2s (using real-shaped fixtures mirroring the live wage/
withholding figures) summed correctly; a doc with a different `taxYear` excluded; an incomplete
-status doc excluded; a doc whose `extractionData.data` has no numeric `wagesCents` (the mistagged
-1098 shape) pushed to `unusableDocs`, never counted as `$0`.

**`sum1099InterestIncome`** — a `1099-INT` doc summed into `interestIncomeCents`; a `1099-DIV` doc
excluded and pushed to `excludedNonInterestDocs`; wrong-`taxYear` doc excluded.

**`sumItemizedDocInputs`** — 0 `mortgage_interest` docs → `$0` + the "0 docs" note; 1+ docs → summed +
the standing monthly-vs-annual ambiguity note; `property_tax` docs (any count, including 0) → always
`$0` + the "this docType never yields a number" note.

**`parseDollarAnswerToCents`** — `"12000"` → 1,200,000 cents; `"$12,000"` → 1,200,000; `"12,000.50"`
→ 1,200,050; `null` answer → `{cents: null, unparseable: false}`; the real live shape (`answer:
"skipped"`, `skippedReason: "Skipped for now"`) → `{cents: null, unparseable: false}` (not flagged as
garbage); `"Yes"` with no `skippedReason` → `{cents: null, unparseable: true}`.

**`parseSqftAnswer`** — `"180"` → 180; `"180 sq ft"` → 180; `"large"` → unparseable; `null` → not
-answered.

**`resolveHomeOfficeSqft`** — `"yes_exclusive"` + valid sqft → sqft returned, no note;
`"yes_exclusive"` + no sqft answer → `null` + "eligible but not yet answered" note; `"no"` + a stray
valid sqft answer → `null` + "not eligible, sqft ignored" note; unanswered eligibility → `null` +
note.

**`resolvePersonalTaxComputeInput`** (end-to-end, pure) —
- One realistic fixture built from the *actual* live data shapes found in this investigation
  (2 W2s, 1 W2 with unparseable data mirroring the mistagged-1098 case, 1 `1099-INT`, 1 `1099-DIV`,
  zero mileage entries, zero mortgage/property-tax docs, `retirement_contributions: "skipped"`,
  `estimated_taxes_2025: "Yes"`, `home_office_ekc: "yes_exclusive"` with no `home_office_sqft`
  answer yet, EKC GL totals both zero) — assert the exact resulting `ComputePersonalTaxReturnInput`
  fields and that `buildGaps` contains: the unusable-W2 note, the excluded-1099-DIV note, the
  zero-mortgage-docs note, the zero-property-tax note, the unanswered-retirement note, the
  unparseable-estimated-taxes note, the eligible-but-no-sqft note, and the high-priority
  `scheduleCDataMissing` message — and `scheduleCDataMissing === true`.
- A second fixture with `home_office_sqft` answered `"180"` and EKC GL totals nonzero → sqft is used,
  `scheduleCDataMissing === false`, and its `buildGaps` message is absent.

## Findings for the owner (surfaced verbatim from this plan, for convenience)

1. EK Consulting LLC has never had a single bank transaction imported/synced (Plaid or otherwise) —
   this blocks a trustworthy Schedule C net profit entirely, independent of anything this task can
   fix. This is the most urgent real gap found.
2. A real 2025 Pennymac 1098 mortgage-interest statement is already uploaded, but tagged as a W2 at
   upload time, so its extraction is unusable. Relabel it to "Mortgage/Interest Statement" via the
   existing edit-document-type UI, then re-upload the same file so it re-extracts correctly (there's
   currently no "re-run extraction on an existing document" button — a small, worthwhile follow-up).
3. The home office deduction is already confirmed eligible (you answered "yes, exclusive use") but
   has never had a square-footage number — after this task ships, a new one-field question will ask
   for it directly.
4. Two new short numeric questions will appear for retirement contributions and estimated tax
   payments — the existing narrative questions for both remain, these are just structured follow-ups
   so the platform can compute exact dollar figures instead of just noting "yes, something happened."
5. One of your two 2025 W2s (TriNet HR III) is itself labeled "a reissued statement" by its own
   extraction — worth confirming with your CPA whether this is a distinct job or a correction/
   duplicate of another W2, since this wiring layer will sum both at face value unless told otherwise.
