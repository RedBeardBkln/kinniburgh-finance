# 03 — Test Report: Gap-driven intake UI + real draft numbers on the personal tax workspace (TY2025)

## Verdict: PASS

## Headline finding: the $1.02 discrepancy is resolved — it's a plan-doc arithmetic error, not a code bug

The plan's acceptance criteria (`01-plan.md` line 425-426) states the four cited W2 federal-withholding
figures — Eric Rippling PEO $40,958.31 + Eric TriNet $7,318.36 + Eva Fox Farm Brewery $118.79 + Eva
Seacoast Mushrooms $4,202.03 — sum to **$52,598.51**. They do not. Recomputed with exact `Decimal`
arithmetic (Python, not float):

```
40958.31 + 7318.36 + 118.79 + 4202.03 = 52597.49
```

**$52,597.49 — exactly the figure the Coder's live script produced**, not $1.02 away from it. The
Planner's own addition in `01-plan.md` was off by $1.02; the code is correct.

I independently re-verified this against the live production DB (read-only script, run from the repo
root per this repo's established technique, deleted immediately after — `git status --porcelain` confirms
no trace remains). Querying the personal entity's `taxYear: 2025` documents directly:

| Employer | `federalWithheldCents` | Dollars |
|---|---|---|
| RIPPLING PEO 1, INC. | 4095831 | $40,958.31 |
| TRINET HR III, INC. | 731836 | $7,318.36 |
| FOX FARM BREWERY, LLC | 11879 | $118.79 |
| SEACOAST MUSHROOMS LLC | 420203 | $4,202.03 |
| **Total** | **5259749** | **$52,597.49** |

- The mistagged Pennymac-1098-as-W2 document (`cfeeec59-...`) is correctly excluded by `sumW2Documents`
  (no numeric `wagesCents` in its extraction data — it fell into `doc-extract.ts`'s parse-failure catch
  branch, exactly as the wiring task documented).
- All 3 `1099-INT`/`1099-DIV` documents (TD Bank, Pennymac, Robinhood) have `federalWithheldCents: 0` —
  contribute nothing to the total.
- 2 `Paystub` rows exist for the entity but both are dated 2026-08 (outside TY2025) and have no
  federal-tax classification in their extraction data — contribute nothing to the TY2025 total.

So there is no extra W2/1099 row, no cents-to-dollars rounding artifact, and no bug in
`sumW2Documents`/`sumPaystubWithholding` — the wiring is pulling exactly the 4 real live W2 documents at
their exact live cent values, summing them correctly. **Root cause: a $1.02 hand-arithmetic slip when the
Planner wrote the acceptance-criteria figure**, not a live-data or code issue. This does not block the
task — the Coder's live output is correct and the plan's own cited component figures (not its incorrect
sum) are what actually appear live.

## Acceptance criteria checklist

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | `/tax/personal/2025` renders real, non-placeholder dollar figures matching live W2 withholding sums | **PASS** | Live DB trace confirms `federalWithholdingCents: 5259749` = $52,597.49, the mathematically correct sum of the plan's own 4 cited W2 figures (see above). The $1.02 "discrepancy" was the plan's own arithmetic error, not the code's. |
| 2 | Every dollar figure carries visible "before credits"/"upper bound"/"draft" framing in its own row label or immediate vicinity | **PASS** | Read `tax-draft-numbers.tsx` JSX directly: persistent header `Badge variant="warning"` with `DRAFT_LABEL`, section headers carry "— before credits", AGI row literally labeled "AGI (upper bound — doesn't yet subtract retirement/HSA contributions)", both balance rows labeled "...before credits", closing disclaimer line. Not solely a tooltip. |
| 3 | `scheduleCDataMissing` red alert renders with working `/accounts?bucket=ek-consulting` link, numbers block visually distinct (red border) | **PASS** | Code confirms `border-2 border-red-400` wrapper + red alert block with the literal href. Confirmed `getEntityBySlug("ek-consulting")` is the exact same slug string `page.tsx` itself already uses at line 56 for `ekcEntity` — not a fabricated route. Live DB confirms `scheduleCDataMissing: true` today (EK Consulting GL income/expense totals both zero). |
| 4 | Mistagged-doc amber alert renders with working `#doc-{id}` anchor resolving to a real highlighted row | **PASS** | Live DB confirms exactly 1 flagged doc (`cfeeec59-ea6c-4036-a10b-7fab323cff0c`, `docType: w2`, `taxYear: 2025`). Its `taxYear === 2025` means it appears in `docs` (year-filtered table), not the collapsed `OtherYearDocuments` list — the anchor will resolve. `tax-document-upload.tsx` renders `id={doc-${doc.id}}` on every row regardless of flag status, with amber styling + "⚠ check type" badge when flagged. |
| 5 | 3 promoted questions render at top of unanswered list with "Unlocks a real computed number below" badge | **PASS (code-verified)** | `personal-tax-client.tsx` builds `promoted` via `PROMOTED_TAX_QUESTION_KEYS.map(key => unansweredRaw.find(...))` (preserves specified key order, not DB order) then `rest`; each promoted row gets `Badge variant="warning"` reading exactly that text. Not independently re-verified against live `TaxQuestion` rows in a browser — see Not tested. |
| 6 | `pnpm typecheck`, `pnpm lint`, `pnpm vitest run lib/__tests__/tax-compute-display.test.ts` pass; full `pnpm test` shows no regressions | **PASS** | Re-ran all 4 myself — see Tests run below. Numbers match the Coder's report exactly. |
| 7 | No `prisma/schema.prisma` changes; no new `actions/*.ts` file; `lib/tax-compute.ts`/`lib/tax-compute-build.ts` untouched | **PASS** | `git status --porcelain` / `git diff --stat` show only the 3 claimed modified files + 3 new files (`lib/tax-compute-display.ts`, its test, `tax-draft-numbers.tsx`). No `actions/*.ts`, no schema, no `tax-compute.ts`/`tax-compute-build.ts` in the diff. |
| 8 | Coder's report restates gap disposition matching plan/wiring-task numbering | **PASS** | `02-implementation.md`'s "Gap disposition" section restates all 5 original gaps + wiring gaps 6-9 consistently with `01-plan.md`'s "Required findings" section. |

## Tests run

All commands run fresh, myself, from `D:\Repos\Personal\kinniburgh-finance`:

```
$ pnpm typecheck
tsc --noEmit
(clean exit, 0 errors)

$ pnpm lint
✖ 47 problems (0 errors, 47 warnings)
(same 47 pre-existing warnings the Coder listed — none in files touched by this task; verified by
reading the full warning list, no tax-compute-display.ts/tax-draft-numbers.tsx/tax-document-upload.tsx/
personal-tax-client.tsx/page.tsx entries anywhere)

$ pnpm vitest run lib/__tests__/tax-compute-display.test.ts
✓ lib/__tests__/tax-compute-display.test.ts (17 tests) 7ms
Test Files  1 passed (1)
     Tests  17 passed (17)

$ pnpm test
Test Files  52 passed (52)
     Tests  736 passed (736)
```

Exact match to `02-implementation.md`'s claimed numbers on all 4 commands.

### Build verification (task's explicit ask — re-run from clean state)

```
$ pnpm build
prisma generate && next build
...
Error: EPERM: operation not permitted, rename '...query_engine-windows.dll.node.tmp26164' ->
'...query_engine-windows.dll.node'
[ELIFECYCLE] Command failed with exit code 1.
```

Reproduced independently, then retried once (`pnpm db:generate` alone) — **failed identically a second
time**, non-transient. `tasklist` showed 9 concurrent `node.exe` processes on this machine, consistent
with the documented Windows Prisma-generate DLL-lock issue (this repo's own tester memory:
`windows-prisma-generate-dll-lock.md`), not a defect introduced by this task — `prisma/schema.prisma` is
confirmed untouched, so nothing in this diff triggers a regeneration need.

Fell back to `npx next build` directly against the already-generated Prisma client
(`node_modules/.pnpm/@prisma+client@6.19.3.../node_modules/.prisma/client/query_engine-windows.dll.node`
confirmed present):

```
$ npx next build
✓ Compiled successfully in 14.6s
   Linting and checking validity of types ...
(only pre-existing warnings, same categories/files as pnpm lint output)
...
ƒ /tax/personal/[year]                  5.81 kB         137 kB First Load JS
```

This is a genuine from-scratch `next build` compile+typecheck+lint pass (not a reuse of a stale
`.next` build — no `.next` cache was primed by me before this run in this session), and it exercises
exactly the risk class flagged (`lib/tax-compute.ts`/`lib/tax-compute-build.ts`, both of which
value-import `Decimal`, now imported into a real page for the first time). Route size (5.81 kB / 137 kB)
matches the Coder's report exactly. **I could not get the literal `pnpm build` script's `prisma generate`
step to succeed end-to-end** due to the environment-level file lock (confirmed pre-existing/unrelated,
not something either the Coder or I can fix from inside this task) — flagging that explicitly rather than
claiming full `pnpm build` success, same caveat the Coder gave.

## Tests added

None. The plan's test-expectations section is followed correctly — `lib/tax-compute-display.ts`'s pure
functions are the only genuinely unit-testable surface, and the existing 17 tests already cover every
exported function including both the positive/negative `describeBalance` paths, comma-grouping, the
promoted-question predicate, and 3 fixtures built by calling the real engine (not hand-rolled fakes) for
`serializeTaxComputeResult`. I reviewed the fixtures' hand-computed expected values against
`lib/tax-compute.ts`'s own arithmetic (spot-checked fixture (a)'s and (b)'s balance figures) and found no
errors. I did not find a genuinely missing pure-function edge case worth adding (e.g. `formatTaxDollars`
already covers zero/negative/comma-grouping; `describeBalance` already covers all 4 branches including
`null`). No component-level tests exist or are expected per this repo's established convention (no DOM
test environment) — correctly not force-built here.

## Defects found

None that block this task. Two non-blocking observations, both already flagged honestly by the Coder in
`02-implementation.md`'s Open items and not newly discovered by me:

1. **Cross-year mistagged-document jump links are a latent gap** (Open item 3) — today a non-issue since
   the one live mistagged document is `taxYear: 2025`, confirmed above. Correctly scoped out of this
   task (`other-year-documents.tsx` untouched, per plan).
2. **`scheduleCDataMissing`'s red wrapper is broader than the wiring layer's own narrower framing**
   (plan Risks item 3, restated in Open items) — a deliberate, disclosed design choice, not a bug. Worth
   Eric's own confirmation per the plan's note, not a reason to fail this round.

## Not tested

- **No actual browser click-through.** I have no browser-control tool or app login credentials in this
  environment (confirmed limitation, consistent with prior sessions' memory). All UI-rendering claims
  above are verified by reading the actual JSX/TSX source directly against live data traced through the
  identical call chain the page uses, plus a clean `next build` compile pass (which does catch, e.g.,
  broken JSX, missing imports, and type errors in the component tree) — not by seeing the page painted.
  Eric (or a future round with browser access) should still click through `/tax/personal/2025` at least
  once to confirm visual layout, the amber-row scroll-to-anchor behavior actually scrolls smoothly, and
  dark-mode class variants render as intended.
- **The literal `pnpm build` script (`prisma generate && next build`) end-to-end.** Blocked by a
  pre-existing, reproduced-twice Windows file-lock issue unrelated to this diff (schema untouched). I
  verified the `next build` half directly against the existing generated client instead — this covers
  the specific "Decimal leaks into client bundle" risk class this task was flagged for, but is not
  byte-identical confidence to the full `pnpm build` script succeeding.
- **The 3 promoted questions' live render order** — verified by code-reading the partition logic
  (`PROMOTED_TAX_QUESTION_KEYS.map(...).find(...)`, preserves specified order) but not by loading the
  actual page and visually confirming the badge/order against the live `TaxQuestion` rows for this
  workspace (no browser access).
- **CPA-level correctness of the underlying tax arithmetic itself** (bracket math, SE tax, QBI phase-in,
  CT Table lookups) — out of scope for this task; that engine (`lib/tax-compute.ts`) was already
  reviewed and approved in the prior `tax-compute-engine` task in this trail, and this task correctly
  does not modify it.

## Memory update

No new reusable pattern beyond what's already recorded — this task confirmed two existing memories held
exactly as documented (`windows-prisma-generate-dll-lock.md`'s reproduce-twice-then-fallback recipe, and
`live-db-readonly-verification-technique.md`'s repo-root-script mechanics) and both worked without
modification. Adding one new memory below since this specific failure mode (plan doc's own hand
arithmetic being wrong, not the code) is a category I haven't recorded before.
