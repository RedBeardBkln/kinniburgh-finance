# 04 — Review: Gap-driven intake UI + real draft numbers on the personal tax workspace (TY2025)

## Verdict: APPROVED

## Independent verification performed

- **Re-derived the $1.02 discrepancy myself.** `40958.31 + 7318.36 + 118.79 + 4202.03 = 52597.49`
  (checked with a calculator, not just eyeballed). The plan's cited acceptance-criteria sum
  ($52,598.51) is wrong by $1.02; the code/live-data figure ($52,597.49) is the correct sum of its own
  four cited numbers. Tester's root-cause conclusion (plan arithmetic error, not a code bug) is correct.
- **Independently queried the live production DB myself** (temp `tsx` script under `scripts/`, deleted
  after use, confirmed via `git status --porcelain` that nothing remains) rather than trusting the
  Coder's/Tester's scripts. Summed `federalWithheldCents` from each of the 4 real TY2025 `w2` documents
  on the `personal` entity directly from `extractionData.data`:
  - RIPPLING PEO 1, INC. — 4,095,831
  - TRINET HR III, INC. — 731,836
  - FOX FARM BREWERY, LLC — 11,879
  - SEACOAST MUSHROOMS LLC — 420,203
  - **Total: 5,259,749 cents = $52,597.49** — exact match to the Coder's and Tester's figure.
  - Confirmed the mistagged doc (`cfeeec59-ea6c-4036-a10b-7fab323cff0c`) has no `data.wagesCents` and
    is correctly excluded from this sum (matches `sumW2Documents`'s documented gate-field behavior).
  - Confirmed via a second live query that `findUnparseableExtractions` flags exactly the same one
    document, `docType: "w2"`, `taxYear: 2025` — the anchor/jump-link claim is real, not assumed.
- **Sanity-checked the live serialized draft numbers' internal arithmetic** (not just that they render):
  Federal — $44,211.41 tax − $52,597.49 payments = −$8,386.08 → Refund $8,386.08. Connecticut —
  $14,815.73 tax − $15,591.07 withholding = −$775.34 → Refund $775.34. Both match the reported balances
  exactly; the numbers are internally coherent, not just independently plausible.
- **Read the full diff myself** (`git diff` on all 3 modified files, plus the 3 new files in full) —
  not just the Coder's/Tester's summaries.
- **Confirmed scope discipline directly**: `git diff --stat -- lib/tax-compute.ts lib/tax-compute-build.ts
  prisma/schema.prisma` and `git status --porcelain actions/` both returned empty. No new `actions/*.ts`
  file, no schema change, no change to either already-approved engine/wiring module.
- **Traced the Decimal-serialization boundary myself** against `TaxComputeResult`'s real interface
  (`lib/tax-compute.ts:881-891`, plus `FederalTaxResult`/`ConnecticutTaxResult`/`MileageDeductionResult`
  field lists) rather than trusting the Tester's trace: `serializeTaxComputeResult` reads a fixed,
  explicit set of fields off `result` and converts every `Decimal` it touches via `formatTaxDollars`/
  `describeBalance` before returning; every field it does *not* read (e.g. `itemizedDeduction`,
  `qbi.phaseInFraction`, `selfEmploymentTax.oasdiTax`/`.medicareTax`, CT `recapture`/`personalCredit`)
  is simply never copied into `SerializedTaxDraft`, so it never leaves the server at all. Confirmed in
  `app/tax/personal/[year]/page.tsx` that only the *serialized* `taxDraft` (never the raw engine
  `result`, never `resolved.input`) is passed as a prop to `PersonalTaxClient`. No Decimal instance
  crosses the boundary.
- **Read `tax-draft-numbers.tsx`, `tax-document-upload.tsx`, `personal-tax-client.tsx` JSX directly**
  looking for inverted conditionals, key-prop issues, raw Decimal-in-template-literal bugs. Found none.
  `DocumentRowEditable`'s `id={doc-${doc.id}}` is unique per rendered row; `key={doc.id}` likewise.
  `taxComputeError` / `taxDraft === null` / populated states are mutually exclusive and each renders
  something (never a silent blank).
- **Verified the mistagged-doc alert's instructions are literally true against the code**, not just
  plausible-sounding copy: `updateTaxDocument` (`actions/tax-planging.ts:380-404`, pre-existing, not
  touched by this task) updates only `documentName`/`docType` — it does not touch `extractionStatus`/
  `extractionData`. So the alert's claim "relabeling alone does not re-run extraction... re-upload the
  same file" is accurate, not a guess.

## Scrutiny items (from the task prompt), addressed directly

**1. Is the DRAFT framing genuinely unmissable?** Yes. The `DRAFT_LABEL` badge is in the `CardHeader`,
rendered unconditionally across all three render states (error / non-2025-null / populated) — a reader
sees it even before any numbers exist. Every money row/section carries its own "before credits"/"upper
bound" text in the label itself (not a title attribute, not a separate tooltip component), plus a closing
disclaimer line. This matches the plan's design and the Reviewer-flagged risk on the prior task was
addressed as designed.

**2. Does `serializeTaxComputeResult` genuinely prevent any Decimal from crossing the boundary?**
Confirmed independently above — yes, by construction (explicit field-by-field conversion, nothing passed
through by reference) and confirmed by usage (only the serialized object is ever passed to the client
component).

**3. Are the two gap alerts specific/actionable?** Yes. The EK Consulting alert names the actual entity,
explains the mechanism (zero bank transactions → $0 income/expenses assumed → cascades through every
downstream figure), and links to a real, working `/accounts?bucket=ek-consulting` route (same slug the
page's own `getEntityBySlug("ek-consulting")` call already uses at line 56, so not a guessed URL). The
mistagged-document alert names the actual doc type + upload date, explains the failure precisely ("didn't
extract cleanly"), gives a concrete two-step fix (retype via "Rename / retype", then re-upload — verified
accurate against `updateTaxDocument`'s real behavior above), and links to a real, resolving in-page anchor
for the one live flagged document. Neither reads as a generic "something's wrong" warning.

**4. Scope discipline** — confirmed via my own `git diff`/`git status`, not the reports: exactly the 3
modified + 3 new files claimed, nothing else. `lib/tax-compute.ts`, `lib/tax-compute-build.ts`,
`prisma/schema.prisma` untouched; no new `actions/*.ts` file.

**5. Anything that looks likely to break/render wrong from reading alone?** No inverted conditionals, no
key-prop collisions, no raw Decimal in a template literal — checked directly against the source, not
inferred from the reports.

## Findings

**Should-fix (non-blocking) — worth a quick follow-up, not a reason to send this back:**

- The task's framing states Eric "just reported live... there's no way to view/delete/retag an
  already-uploaded tax document, which is why they can't identify or fix it themselves." I checked this
  against the actual code (pre-existing, unmodified by this task): for the *current tax year's* document
  table (`tax-document-upload.tsx`), a "Rename / retype" text-link **does** exist per row, wired to a
  real `updateTaxDocument` server action that changes both `documentName` and `docType` — this is exactly
  the retag capability the new alert instructs the user to use, and it is real and functional (confirmed
  by reading `actions/tax-planning.ts:380-404`). For documents in *other* tax years
  (`other-year-documents.tsx`), the claim holds fully — that component is read-only, "View" only, no
  rename/retype, no delete. And **delete genuinely does not exist anywhere** in either component for tax
  documents — that part of Eric's report is accurate everywhere. Net: the new alert's instructions are
  correct and actionable for the one real live mistagged document (it's in the current year's table), but
  the discrepancy between "user says no retag exists" and "retag exists for current-year docs" is worth
  surfacing to Eric directly — either the affordance is easy to miss (small text link in a table cell,
  no icon) or something about it isn't working as expected for him at runtime, which no pipeline agent
  can verify without browser access. Not something this task needs to fix; flagging for the record.
- Two items the Coder/Tester already disclosed and I independently re-confirmed as accurate, non-blocking
  observations rather than new findings: the cross-year mistagged-document jump-link gap (today a
  non-issue — the one live flagged doc is `taxYear: 2025`, matches the page it'd need to resolve on), and
  `scheduleCDataMissing`'s red wrapper being deliberately broader than the wiring layer's own narrower
  framing (a disclosed design choice, worth Eric's own confirmation per the plan's own note, not a defect).

**Nit:**

- `SerializedTaxDraft`/`TaxDraftNumbers` never surface `itemizedDeduction`'s breakdown (mortgage
  interest / SALT before-and-after-cap / charitable) or `qbi.phaseInFraction` — a household reading
  "Deduction used (itemized): $X" has no way to see what makes up that $X on this page. Not a defect (the
  plan never scoped this level of detail, and the underlying `gaps` bullets partially compensate), just
  worth noting as a natural next increment if Eric wants more transparency into the itemized total.

## Test quality

Genuinely good, not superficial. `serializeTaxComputeResult`'s tests call the real, already-approved
`computePersonalTaxReturn` with deterministic inputs rather than hand-rolling a fake `TaxComputeResult` —
this is the right call, since it guards against exactly the kind of type-shape drift a hand-rolled fixture
would hide. Both the positive (Refund) and negative (Balance due) balance paths are exercised end-to-end
through the real engine, not just in `describeBalance`'s isolated unit test. `formatTaxDollars` covers
comma-grouping and the defensive negative-sign case. `isPromotedTaxQuestion` correctly tests against the
*narrative* counterpart keys (not just arbitrary strings), which is the actually-tricky case to get wrong.
I spot-checked fixture (a)'s hand-computed CT balance myself (ctTaxComputed $6,373.82 − ctWithholding
$7,000.00 = −$626.18 → Refund $626.18, matches) and found no arithmetic errors.

## What's good

- The "no new server action" design decision is well-justified with a real precedent
  (`computePL` called the same way in the same file) rather than asserted by convention alone.
- Honest, specific disclosure culture continues from the prior two tasks in this trail — Open items in
  `02-implementation.md` and `03-test-report.md` name real, verifiable gaps (cross-year jump link,
  `prisma generate` DLL lock, no browser access) rather than glossing over them.
- The Tester's resolution of the $1.02 "discrepancy" is exactly right and I verified it independently
  down to the arithmetic and a fresh live-DB query — this was genuinely diligence, not rubber-stamping.
- Draft/before-credits framing is applied with real discipline: every single dollar figure on the card
  carries its own caveat text, not a single global disclaimer doing all the work.
- Deep links (`/accounts?bucket=ek-consulting`, `#doc-{id}`) are both real, confirmed-resolving targets,
  not aspirational placeholders.

## What's now visible/actionable to the household vs. what still requires their direct action

**Now genuinely visible/actionable on `/tax/personal/2025`:**
- Real, live, internally-consistent computed federal + CT draft numbers, unmistakably marked as
  pre-credit drafts throughout — first time either engine has been shown to a real user.
- The EK Consulting zero-bookkeeping gap, named specifically and linked to the account-connection page.
- The mistagged-1098-as-W2 document, named specifically with a working jump link and a correct,
  functional fix path (the pre-existing "Rename / retype" control + re-upload — confirmed working code,
  not a stub).
- The 3 structured, code-ready questions (home office sqft, retirement contribution amount, estimated
  tax payments), promoted to the top of the question list with an explicit "unlocks a real number" badge.
- Every other computed gap/caveat (mismatched mileage rates, unrecognized paystub labels, W2 employer
  names to self-verify, etc.), as a visible bullet list.

**Still requires the household's own direct action, unchanged by this task (as flagged in the request):**
- EK Consulting's missing bookkeeping — per Eric's live confirmation this session, the QuickBooks
  subscription was recently cancelled; the actual fix is pulling transactions from already-uploaded,
  already-parsed bank statements instead, which is a data-pipeline change this task correctly does not
  attempt (out of scope — this task only surfaces the gap, it doesn't fix the underlying data source).
- The mistagged 1098 — the retag mechanism itself exists and is functional in the code (see Findings
  above), which is a genuinely useful thing for Eric to know given what he reported live, but if it still
  isn't working for him in practice, no pipeline agent can diagnose that further without browser access.

## Memory updates

Writing two new entries: one confirming the "always independently rerun the live-data check, don't just
credit the Tester's numbers" practice paid off concretely on a financial-figure task (extending the
existing pipeline-verification memory with a live example), and one new, more specific finding about the
retag-affordance/user-report mismatch for future tax-document-UI reviews in this repo.
