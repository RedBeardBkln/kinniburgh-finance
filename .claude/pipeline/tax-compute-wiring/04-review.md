# 04 — Review: DB-wiring layer for the tax computation engine (TY2025)

## Verdict: APPROVED

## Scope discipline (independently verified via `git status`/`git diff`, not trusted from write-ups)

```
 M actions/tax-planning.ts
 M lib/tax-guidance.ts
?? lib/tax-compute-build.ts
?? lib/__tests__/tax-compute-build.test.ts
```

Confirmed directly: no `prisma/schema.prisma` diff, no `components/tax/*` changes, no new page/route,
no new `actions/*.ts` file. `lib/tax-guidance.ts`'s diff is exactly 3 new, purely-additive
`TAX_QUESTION_BANK` entries (no existing entry's text touched). `pnpm-workspace.yaml` is untracked in
the working tree but is not part of this task's file list in `02-implementation.md` and isn't touched
by either diff — unrelated debris from a concurrent session, not a scope violation by this task.

## `ensurePersonalWorkspace` change — independently re-verified, not trusted from the Tester's trace

Read `prisma/schema.prisma` lines 581–597 directly: `TaxQuestion` has `@@unique([workspaceId, key])`.
Read the exact `createMany` call in `actions/tax-planning.ts` (lines 53–74): the `data:` mapping sets
only `workspaceId`, `key`, `category`, `question`, `options` — never `answer`, `answeredAt`, or
`skippedReason`. With `skipDuplicates: true`, a `(workspaceId, key)` collision resolves to
`ON CONFLICT DO NOTHING`; there is no update path. So the guard-removal (previously
`if (existing.questions.length === 0)`, now unconditional) can only ever *insert* the 3 new bank keys
into a workspace that doesn't already have them — it cannot touch, overwrite, or reset any of the
already-answered rows in the real, live 2025 workspace (9 real rows, confirmed by the plan's live-data
investigation). This matches the Tester's trace exactly; I reached the same conclusion independently
from the schema and diff rather than crediting the claim. Also confirmed via `grep` that
`ensurePersonalWorkspace` is called live from `app/tax/personal/[year]/page.tsx` — so this is a real
behavior change to already-shipped, already-live code, correctly flagged as such by both the plan and
implementation report, and safe.

## `scheduleCDataMissing` — is it surfaced clearly enough?

The real mechanism is the dedicated top-level boolean field (`ResolvedPersonalTaxComputeInput.scheduleCDataMissing`),
not the `buildGaps` string. It's computed as `ekConsultingGlIncomeTotal.isZero() && ekConsultingGlExpenseTotal.isZero()`
(`lib/tax-compute-build.ts:565`) and is independently correct from the engine's own `computeScheduleCNetProfit`,
which has no way to distinguish "genuinely $0 activity" from "no data at all" — this wiring layer is the
right and only place that distinction can be made, and it's made correctly. Any future caller that gates
Schedule C display on this boolean (rather than just dumping `buildGaps` as an undifferentiated notes list)
gets a hard, unambiguous signal. That said: `buildGaps` itself is a flat, unordered `string[]` with no
severity field, and the high-priority message is appended near the *end* of the array (after mortgage/
property-tax/retirement/estimated-tax/home-office notes), not surfaced with any structural priority within
that array. This is should-fix, not blocking — see Findings below.

## Paystub label-matching defensive handling — real, not just asserted

Read the code directly: `classifyTaxBreakdownLabel`/`classifyAdditionalWithholdingLabel` return
`"unrecognized"` for anything that doesn't match, and `sumPaystubWithholding` (lib/tax-compute-build.ts:86–130)
routes unrecognized entries to a dedicated `unrecognizedLabels` array — excluded from both federal/CT
sums, never silently dropped or summed. `resolvePersonalTaxComputeInput` then surfaces every such entry
into `buildGaps` with paystub ID, label text, and dollar amount. Test coverage (`tax-compute-build.test.ts`
lines 110–123) proves this with a real fixture ("Local Tax" appended to a real-shaped paystub), asserting
both that it's excluded from the sums *and* appears in the diagnostic array. This is real, not asserted.

## Ground-rule-1 scrutiny (fabricated-number check) — one real gap found, should-fix not blocking

Went function-by-function through `lib/tax-compute-build.ts` looking for any path that could produce a
plausible-looking number instead of an explicit null/gap. Everything is disciplined **except one narrow
case**: in `sumW2Documents` and `sum1099InterestIncome`, only the *primary gate field* (`wagesCents` /
`amountCents`) is defended — a document that passes the gate but is missing a *secondary* numeric field
(`federalWithheldCents`, `stateWithheldCents`, `medicareWagesCents` on a W2; `federalWithheldCents` on a
1099-INT) silently contributes `$0` to that sub-total via `if (typeof x === "number") sum += x`, with no
corresponding `buildGaps` note — unlike wages, which are itemized per-document in `buildGaps` for the
owner to self-verify, the federal/CT withholding totals are *not* itemized per document anywhere, so a
partial extraction on a real, included, wages-correct W2 would silently under-count withholding with zero
signal. This doesn't currently fire against live data (the plan's finding 5 confirms all real live W2/1099
docs have complete field sets), so it's not a live defect — it's a latent hole in the "never let a partial
number look complete" discipline this task was specifically asked to apply (request item 5). Route to
**coder**: either flag when a gate-passing doc is missing a withholding sub-field, or itemize each
included doc's federal/CT withholding amounts in `buildGaps` alongside the wages amount already itemized
there, giving parity with how wages ambiguity (gap #9, the "reissued statement" W2) is already handled.

## Test quality

Solid — not superficial. Tests are built from the actual live label text, live dollar figures, and the
actual mistagged-1098-as-w2 JSON shape found during the plan's live-data investigation, not synthetic
placeholders. Edge cases requested in the task brief are all present and correctly pinned: real CT-label
variance across both live paystubs, unrecognized-label exclusion-and-surfacing (both classifiers),
mistagged-extraction detection (flagged case, normal-W2 not-flagged case, and the
`extractionStatus !== "complete"` non-flag edge case), 1099-DIV correctly excluded from interest income,
the real `"skipped"`/`skippedReason` shape correctly distinguished from genuinely-unparseable prose, and
both `scheduleCDataMissing` directions with real dollar figures. I re-hand-traced the end-to-end fixture's
wages/withholding sums myself against the raw numbers in the test file and they're correct.

## Findings

- **should-fix** (`lib/tax-compute-build.ts`, `sumW2Documents`/`sum1099InterestIncome`) — secondary
  numeric fields (federal/CT withholding, Medicare wages) on a gate-passing document are summed with no
  "missing sub-field" flag or per-document itemization in `buildGaps`, unlike wages. Low current risk
  (live data is complete) but a real hole in the ground-rule-1 discipline this task specifically asked to
  scrutinize. Route to **coder** for the next small pass, not blocking this task.
- **should-fix / informational** — `buildGaps: string[]` has no severity/ordering; the
  `scheduleCDataMissing` message's actual safety comes entirely from the dedicated boolean field, not its
  position in the array. Recommend a doc-comment addition (or a structured `{severity, message}` shape in
  a future revision) making explicit that any caller rendering Schedule C output must gate on
  `scheduleCDataMissing` directly, not rely on scanning `buildGaps` text. Not blocking — the boolean field
  itself is correct and tested, and no live caller exists yet to actually mis-render this.
- **nit** — `ensurePersonalWorkspace` now runs a 13-row `createMany` on every workspace-open instead of
  only the first; negligible cost for a 2-person household app, not worth a change.

## What's good

- The plan's schema-decision reasoning (reuse `TaxQuestion.answer`'s existing `Json?` column instead of a
  migration) is sound and correctly executed — verified the `TaxQuestionDef` type already supports
  free-text/no-options entries, so the 3 new bank keys required zero type changes.
- Gap discipline is genuinely thorough: every one of the 9 real gaps the plan enumerated is disposed of
  correctly in code (either a working code path with data still blocked, or explicitly out of scope), and
  the null-vs-$0 convention (null flows through to the already-approved engine's own `$0`-assumed-and-flagged
  pattern, e.g. `estimatedPaymentsCents`) is consistent with the prior, already-approved `tax-compute.ts`
  design rather than inventing a new convention.
- Real live data grounding throughout — label text, dollar figures, and the mistagged-1098 JSON shape in
  tests are all drawn from the plan's actual production-read investigation, not synthetic guesses.
- The `scheduleCDataMissing` flag is exactly the right mechanism for the most consequential open question
  in this whole build (EK Consulting's zero transactions) — a hard boolean a future caller can't
  accidentally ignore, independent of the engine's own $0-vs-missing blindness.
- Clean separation maintained: only `buildPersonalTaxComputeInput` imports `db` (verified: exactly one
  `import { db }`, all 5 `db.*` call sites inside that one function), everything else is pure and tested.

## Recommended next task

Build the **gap-driven intake UI** next, not the PDF-sourcing work. Reasoning: 3 of the 5 originally-listed
gaps (home office sqft, retirement contribution amount, estimated tax payments) are now fully unblocked on
the code side — the only thing standing between "code path ready" and "real number in the engine" is the
owner answering 3 already-seeded, already-structured questions the next time `/tax/personal/2025` loads.
An intake UI that surfaces exactly those open items (plus the mistagged-1098 relabel-and-reupload action,
plus a clear display of the "reissued statement" W2 ambiguity for the owner to confirm) converts three
real, ready-to-resolve gaps into actual filed-return-ready numbers with no further code needed beyond the
UI itself. PDF-sourcing/generation work is comparatively less valuable right now because the underlying
numbers it would render are still incomplete for exactly these reasons.

**One item needs Eric directly, in parallel, not blocking the intake-UI task**: EK Consulting LLC has zero
`Transaction` rows of any kind, ever (plan finding 7) — this is not something any amount of further code
can fix; it requires Eric to actually connect/import EK Consulting's bank activity (Plaid or CSV) before
Schedule C net profit can ever be a real number. Recommend this be raised to Eric as its own explicit
question/task, separate from and not gating the intake-UI work, since the UI can ship and be useful (home
office, retirement, estimated payments) independent of whether/when the EKC bookkeeping gap gets closed.
