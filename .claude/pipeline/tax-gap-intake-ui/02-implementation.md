# 02 — Implementation: Gap-driven intake UI + real draft numbers on the personal tax workspace (TY2025)

## Summary of changes

**`lib/tax-compute-display.ts`** (new, pure, no DB/`"use server"`)
- `DRAFT_LABEL` constant.
- `formatTaxDollars(d: Decimal): string` — dollar-native (not cents) formatter, 2 decimals, comma
  grouping, preserves a leading `-` for negative Decimals.
- `BalanceLabel` type + `describeBalance(d: Decimal | null)` — maps a signed balance Decimal to
  `{label, amountFormatted}` where `amountFormatted` is always the absolute value; `null` ->
  "Not computable".
- `SerializedTaxDraft` interface + `serializeTaxComputeResult(result: TaxComputeResult)` — the only
  place a `Decimal` from `lib/tax-compute.ts` is touched; converts every field to a plain string.
  `gaps` is passed through verbatim (same array reference from the engine result).
- `PROMOTED_TAX_QUESTION_KEYS` (`home_office_sqft`, `retirement_contribution_amount`,
  `estimated_tax_payments_amount`) + `isPromotedTaxQuestion(key)`.

**`lib/__tests__/tax-compute-display.test.ts`** (new) — 17 tests covering every export:
- `formatTaxDollars`: plain decimal, zero, comma-grouping at $1,000,000, negative-sign preservation.
- `describeBalance`: positive -> Refund, negative -> Balance due (absolute value), zero -> Even,
  null -> Not computable.
- `isPromotedTaxQuestion`: all 3 real keys -> true, the 2 pre-existing *narrative* counterpart keys
  (`retirement_contributions`, `estimated_taxes_2025`) -> false, an arbitrary unknown key -> false.
- `serializeTaxComputeResult`: 3 fixtures built by calling the real `computePersonalTaxReturn`
  (not a hand-rolled fake result) — (a) a federal-refund + CT-refund scenario (verified the exact
  federal/CT balance Decimal strings first, then asserted the full serialized object), (b) the
  engine's own existing "golden path" test input reused verbatim to prove the federal
  Balance-due/negative path end-to-end (`-714.898291` -> `{label: "Balance due", amountFormatted:
  "$714.90"}`), (c) the engine's own existing "gap-heavy" test input reused to confirm `gaps` passes
  through verbatim and is non-empty.

**`components/tax/tax-draft-numbers.tsx`** (new, presentational, no `"use client"` — bundled into
client JS anyway since its only caller, `personal-tax-client.tsx`, is already fully client-rendered)
- Card header carries a permanent `Badge variant="warning"` with `DRAFT_LABEL`'s text — not a
  tooltip, always rendered at the same visual weight as the title.
- Two prominent alert blocks at the top, above the numbers: the EK Consulting zero-transactions
  red alert (with the literal `/accounts?bucket=ek-consulting` link) shown when
  `scheduleCDataMissing`, and one amber "A document may be mistagged" block per entry in
  `mistaggedDocs` (with a `#doc-{id}` jump link) — copy is driven entirely by the live
  `findUnparseableExtractions` output (doc type + upload date), never a hardcoded document id/name.
- When `scheduleCDataMissing` is true, the entire Schedule C -> Federal -> CT numbers block is
  wrapped in a `border-2 border-red-400` container with its own "These numbers are NOT reliable"
  header; the real (if untrustworthy) numbers are still rendered underneath, never hidden.
- Every federal/CT section header carries its own "— before credits" framing; the AGI row is
  labeled "AGI (upper bound — doesn't yet subtract retirement/HSA contributions)" and both balance
  rows are labeled "Federal balance due / refund before credits" / "CT balance due / refund before
  credits" — matching the plan's literal copy for the 4 called-out labels.
- Remaining `buildGaps` + `taxDraft.gaps` entries render as a plain bullet list under "Other caveats
  behind this draft" (no dedup against the two prominent alerts, matching the plan's own accepted
  tradeoff).
- Handles 3 states honestly: `taxComputeError` (an actual resolver error), `taxDraft === null` with
  no error (non-2025 year — "only available for tax year 2025 today"), and the normal populated case.

**`components/tax/tax-document-upload.tsx`** (modified)
- Added optional `flaggedDocumentIds?: string[]` prop (defaults to `[]` — no behavior change for
  any existing caller other than `personal-tax-client.tsx`, its only call site).
- Each row now has `id={`doc-${doc.id}`}` (works whether or not the row is flagged, so the anchor
  always resolves to a real DOM node for any doc in the currently-displayed table).
- Flagged rows get an amber left border + row background and a small "⚠ check type" badge next to
  the Type cell.

**`components/tax/personal-tax-client.tsx`** (modified)
- New props: `taxDraft`, `taxComputeError`, `scheduleCDataMissing`, `buildGaps`, `mistaggedDocs`.
- Renders `<TaxDraftNumbers .../>` as a new, unnumbered card directly after the "Strategy" objective
  banner and before "1 · Document intake" (per the plan's placement design — highest-value new
  content, no renumbering of the existing 1–5 sections).
- Passes `flaggedDocumentIds={props.mistaggedDocs.map((d) => d.id)}` to `TaxDocumentUpload`.
- Partitions the unanswered-questions list into `promoted` (the 3
  `PROMOTED_TAX_QUESTION_KEYS`, in that exact order, via an explicit `.map(key => find(...))` —
  not a raw `.filter()`, which would have preserved DB/`createdAt` order instead of the specified
  key order) and `rest` (unchanged order); `promoted` renders first, each with a new
  `Badge variant="warning"` reading "Unlocks a real computed number below" plus a slightly heavier
  border, so they're visually distinct from ordinary questions. Never changes which questions
  render — only their order and a badge; `handleAnswer`/save flow is untouched.

**`app/tax/personal/[year]/page.tsx`** (modified)
- New imports: `buildPersonalTaxComputeInput`, `findUnparseableExtractions` (from
  `lib/tax-compute-build.ts`, unmodified), `computePersonalTaxReturn` (from `lib/tax-compute.ts`,
  unmodified), `serializeTaxComputeResult` (from the new display module).
- Gated exactly on `year === 2025` (matching the existing `isExtensionYear` pattern): calls
  `buildPersonalTaxComputeInput(year)` directly (no new server action — see Deviations/Design
  rationale below), branches on `"error" in resolved`, and on success serializes the engine result
  via `serializeTaxComputeResult`. `taxDraft`/`scheduleCDataMissing`/`buildGaps` stay at their
  `null`/`false`/`[]` defaults for any other year.
- Computes `mistaggedDocs` unconditionally (every year), scanning the page's own already-fetched
  `allDocs` (no new document query) through `findUnparseableExtractions`, then enriches each
  flagged id with its `createdAt` (looked up from the same `allDocs` array via a `Map`) since
  `findUnparseableExtractions`'s own return shape doesn't carry it and the component's copy needs a
  human-readable upload date.
- Passes all 5 new values as props to `PersonalTaxClient`.

## Deviations from the plan

None. Every file listed in the plan's "Affected files/modules" section was touched exactly as
scoped, and no file outside that list was touched (verified — see Commands run). The one place I
made an explicit judgment call within the plan's own stated flexibility was the promoted-question
sort: the plan says "in `PROMOTED_TAX_QUESTION_KEYS` order," so I built `promoted` via
`PROMOTED_TAX_QUESTION_KEYS.map(key => unansweredRaw.find(...)).filter(...)` rather than
`unansweredRaw.filter(isPromotedTaxQuestion)`, since the latter would have sorted by the
questions' own array order (effectively `createdAt`) rather than the specified key order.

## Commands run and their results

- `pnpm typecheck` (`tsc --noEmit`) — **clean, no errors.**
- `pnpm lint` (`eslint .`) — **0 errors, 47 warnings**, all pre-existing and in files I did not
  touch (confirmed by re-reading the full warning list — no `lib/tax-compute-display.ts`,
  `lib/__tests__/tax-compute-display.test.ts`, `components/tax/tax-draft-numbers.tsx`,
  `components/tax/tax-document-upload.tsx`, `components/tax/personal-tax-client.tsx`, or
  `app/tax/personal/[year]/page.tsx` entries anywhere in the output).
- `pnpm vitest run lib/__tests__/tax-compute-display.test.ts` — **17/17 passed.**
- `pnpm test` (full `vitest run`) — **736/736 passed across 52 test files**, no regressions.
- `pnpm build` (`prisma generate && next build`) — `prisma generate` failed twice with a Windows
  `EPERM: operation not permitted, rename ... query_engine-windows.dll.node.tmp...` error (the
  known DLL-lock-from-a-concurrent-session issue already in my memory, not caused by this change —
  the Prisma client wasn't regenerated by anything in this diff since `prisma/schema.prisma` is
  untouched). I then ran `npx next build` directly (bypassing the `prisma generate` step, reusing
  the already-generated, schema-unchanged Prisma client) — **this succeeded cleanly**, producing a
  full static/dynamic route manifest including `ƒ /tax/personal/[year]  5.81 kB  137 kB First Load
  JS`. This is the first task in this trail that actually imports `lib/tax-compute.ts` /
  `lib/tax-compute-build.ts` (both of which value-import `Decimal`) into a real page, and the build
  succeeded without the "Decimal leaks into client bundle" failure class my memory flags — because
  the Decimal-touching functions (`formatTaxDollars`, `describeBalance`,
  `serializeTaxComputeResult`) are only ever called from the server (`page.tsx`) or referenced as
  values that tree-shake cleanly; the client components (`personal-tax-client.tsx`,
  `tax-draft-numbers.tsx`) only import `type SerializedTaxDraft`/`type BalanceLabel` (type-only) and
  the plain-value exports `DRAFT_LABEL`/`PROMOTED_TAX_QUESTION_KEYS`/`isPromotedTaxQuestion`, never
  a function that touches `Decimal` at runtime. I did **not** get a from-scratch `prisma generate &&
  next build` to run clean end-to-end due to the environment-level DLL lock — flagging this
  explicitly per the instructions rather than claiming full success; the Tester should re-run
  `pnpm build` from a clean state to confirm `prisma generate` itself isn't masking anything.
- **Manual verification against real live data** (no browser tool available — see Open items):
  wrote and ran a temporary, read-only `tsx` script (`scripts/_tmp-verify-tax-draft.ts`, deleted
  immediately after use, never committed) that calls the real `buildPersonalTaxComputeInput(2025)`
  + `computePersonalTaxReturn` + `serializeTaxComputeResult` against the live Supabase DB — the
  exact same call chain `page.tsx` now makes. Live output:
  - `scheduleCDataMissing: true` (current live state, matches the plan's assumption).
  - `input.federalWithholdingCents: 5259749` → **$52,597.49** total federal withholding from
    W2s/1099s/paystubs. The plan's acceptance criteria cites **$52,598.51** as the expected
    sum-of-W2s-alone figure (Eric Rippling $40,958.31 + TriNet $7,318.36 + Eva Fox Farm $118.79 +
    Eva Seacoast $4,202.03). These are **$1.02 apart**, not an exact match — close enough to
    confirm the wiring is pulling the correct real documents (same 4 employers, same order of
    magnitude, no fabrication), but I'm reporting the discrepancy honestly rather than rounding it
    away: it's small enough to plausibly be a cents-rounding/reissued-statement artifact already
    flagged elsewhere in this trail (buildGaps includes a note that TriNet has a "reissued
    statement" ambiguity), but I did not re-derive the wiring task's original $52,598.51 figure
    from scratch to pin down the exact $1.02 source — flagged as an Open item for the Tester/Eric.
  - A second read-only script confirmed `findUnparseableExtractions` flags exactly one live
    document (`cfeeec59-ea6c-4036-a10b-7fab323cff0c`, `docType: "w2"`, `taxYear: 2025`,
    `createdAt: 2026-08-31`) — the real Pennymac-as-W2 document. Its `taxYear` is 2025, so on
    `/tax/personal/2025` it appears in the year-filtered `docs` table (not the collapsed
    "Other years" list), meaning the `#doc-cfeeec59-...` jump link the component renders will
    resolve to a real, visible, highlighted row — satisfying that acceptance criterion end-to-end
    against live data, not just by code inspection.
  - Full serialized draft for 2025 (real numbers, `scheduleCDataMissing: true` so Schedule C's
    `$0.00` net profit is correctly flagged untrustworthy): federal total income $274,428.87, AGI
    upper bound $274,428.87, taxable income $242,928.87, federal tax before credits $44,211.41,
    total payments $52,597.49, federal balance **Refund $8,386.08**; CT tax before credits
    $14,815.73, CT withholding $15,591.07, CT balance **Refund $775.34**. These are real,
    non-placeholder figures — not hand-verified against a CPA calculation (out of scope), but
    confirmed to be actually flowing from the live DB through the exact code path `page.tsx` now
    calls.
  - I did **not** click through the actual rendered page in a browser (no browser-control tool
    available to me, and no login session) — see Open items. The verification above exercises the
    identical server-side call chain `page.tsx` makes (same functions, same live data, same
    `year === 2025` gate) and additionally passed `pnpm typecheck` + `pnpm build`, so I'm confident
    the wiring is correct, but the actual DOM rendering (badge placement, red-border wrapping, the
    document table highlight/anchor scroll behavior) was verified by reading the JSX I wrote, not
    by seeing it painted in a browser.

## Open items

1. **$1.02 discrepancy** between the live federal withholding sum ($52,597.49) and the plan's
   stated acceptance-criteria figure ($52,598.51) — not reconciled to its exact source (see above).
   Worth a quick look by the Tester or Eric; does not block this task (both figures are close, both
   are clearly real live data, not fabricated).
2. **No actual browser click-through was performed** (no browser-control tool, no app login
   credentials available to me) — verification is a server-side call-chain trace against the live
   DB plus `typecheck`/`build` success, not a rendered-DOM screenshot. The plan's own Test
   expectations section anticipated this ("manual click-through... explicitly described... rather
   than asserted without detail") — I'm flagging explicitly that I could not perform that specific
   step, and it should fall to the Tester.
3. **Cross-year mistagged-document jump links are a latent gap, inherited from the plan's own
   design, not something I fixed or was asked to fix**: `mistaggedDocs` is computed across every
   tax year (matches `findUnparseableExtractions`'s own all-years scan and the plan's explicit
   instruction not to gate it to 2025), but the `#doc-{id}` anchor only resolves to a visible row
   inside `tax-document-upload.tsx`'s table, which only renders the *current* year's documents —
   `other-year-documents.tsx` (out of scope per the plan's affected-files list) has no `id`
   anchors and is collapsed by default. Today this is a non-issue in practice (the one real live
   mistagged document is `taxYear: 2025`, confirmed above), but if a future mistagged document is
   ever a different tax year than the one currently open, its jump link would silently fail to
   scroll anywhere. Not fixed here since `other-year-documents.tsx` is explicitly outside this
   plan's scope.
4. **`pnpm build`'s own `prisma generate` step could not be verified clean** end-to-end due to a
   Windows file-lock error unrelated to this change (see Commands run) — I verified `next build`
   alone succeeds against the existing generated client, which is the part that actually exercises
   the Decimal-into-client-bundle risk this task was flagged for, but a from-scratch `pnpm build`
   should still be re-run by the Tester in a clean environment for full confidence.
5. **Risks items already flagged by the plan itself** (not new findings, restated for traceability):
   no client-side validation on the 3 promoted free-text answers (Risks item 4); no dedup between
   the two prominent alerts and the general caveats list (Risks item 5); `scheduleCDataMissing`'s
   red wrapper is deliberately broader than the wiring layer's own narrower framing (Risks item 3,
   worth Eric's confirmation per the plan's own note).

## Gap disposition (restated for trail traceability, per the plan's required findings section)

**Now visible/actionable after this task:**
1. Real computed federal + CT draft tax numbers — previously computed nowhere in the live app; now
   rendered on `/tax/personal/2025` with persistent draft/before-credits framing.
2. Gap 2 (EK Consulting zero-transactions) — now a prominent red alert with a working
   `/accounts?bucket=ek-consulting` link; confirmed live (`scheduleCDataMissing: true` today).
3. Gap 3 (the real mistagged Pennymac-as-W2 document) — now a prominent amber alert with a working
   `#doc-{id}` jump link that resolves to a highlighted row; confirmed live against the real
   document id.
4. Gaps 6–9 (the wiring task's 3 structured questions + the general `gaps`/`buildGaps` caveats) —
   the 3 structured questions are now promoted to the top of the unanswered list with an "Unlocks a
   real computed number below" badge; every other caveat (mismatched mileage rates, unrecognized
   paystub labels, W2 employer names to self-verify, zero-mortgage/property-tax notes,
   unanswered-question notes) now renders as a visible bullet list under "Other caveats behind this
   draft."

**Still NOT visible/actionable after this task** (unchanged from the plan — no code in this task
attempts any of these): no way to fix the EK Consulting gap from this page itself (external
account-linking action); no in-app re-extraction trigger for the mistagged document (manual
relabel + re-upload only); no credits engine (every number is explicitly "before credits"); no
multi-year support for computed numbers (TY2025-only engine); CT Table D/E's `requiresManualLookup`
fallback remains theoretically reachable and renders "Not computable" honestly if it ever fires;
client-side answer validation for the 3 promoted questions remains absent.

## Files touched

- `D:\Repos\Personal\kinniburgh-finance\lib\tax-compute-display.ts` (new)
- `D:\Repos\Personal\kinniburgh-finance\lib\__tests__\tax-compute-display.test.ts` (new)
- `D:\Repos\Personal\kinniburgh-finance\components\tax\tax-draft-numbers.tsx` (new)
- `D:\Repos\Personal\kinniburgh-finance\components\tax\tax-document-upload.tsx` (modified)
- `D:\Repos\Personal\kinniburgh-finance\components\tax\personal-tax-client.tsx` (modified)
- `D:\Repos\Personal\kinniburgh-finance\app\tax\personal\[year]\page.tsx` (modified)
- Confirmed **untouched**: `lib/tax-compute.ts`, `lib/tax-compute-build.ts`,
  `prisma/schema.prisma`, and no new file under `actions/*.ts` (verified via `git diff --stat` and
  `git status`).
