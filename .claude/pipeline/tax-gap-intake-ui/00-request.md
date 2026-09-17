# Request: Gap-driven intake UI + real draft numbers on the personal tax workspace (TY2025)

Wire the now-approved pure engine (`lib/tax-compute.ts`) and its DB-wiring layer
(`lib/tax-compute-build.ts`) into the actual personal tax workspace page for the first time — both
modules currently have **zero importers anywhere in the app**. This is the task that turns two backend
modules into something Eric can actually see and use.

## Context

Read the full trail at `.claude/pipeline/tax-compute-engine/` and `.claude/pipeline/tax-compute-wiring/`
(00-request through 04-review in each) before starting — they document exactly what's computed, what's
still a gap, and several hard-won correctness lessons (don't trust a spec excerpt without re-reading the
live file; a "$0" and a "we don't know" must never look the same to a reader).

Current state: `app/tax/personal/[year]/page.tsx` and `components/tax/personal-tax-client.tsx` show the
existing readiness checklist (`lib/tax-form-plan.ts` — yes/no per form line) and the AI opportunity
narrative (`actions/tax.ts`). There is no real computed number shown anywhere in the app today.

## What to build

1. **Wire it in.** Call `buildPersonalTaxComputeInput` (or add a thin server action wrapping it, matching
   this repo's `actions/*.ts` pattern — `requireAuth()` first line, per `CLAUDE.md`) and
   `computePersonalTaxReturn` from the personal tax workspace page/action layer, and surface the result.
   Read `lib/tax-compute-build.ts`'s actual exported types before designing the UI — don't assume a shape.

2. **Show real draft numbers, unmistakably labeled as drafts.** Every figure this surfaces is
   "before credits," some are explicitly an "upper bound" (AGI), and the whole engine is a draft for CPA
   review — not filed, not advice, per `CLAUDE.md` ground rule 8. The Reviewer on the compute-engine task
   specifically flagged the risk of a future UI layer presenting `agiUpperBound`/`totalTaxBeforeCredits`
   as if final — design against that risk explicitly (e.g. persistent "DRAFT — before credits, not a
   filed number" framing near any dollar figure this surfaces, not just in a tooltip).

3. **Surface the 3 code-ready gaps as answerable questions**, prominently — home office square footage,
   retirement contribution amount, estimated tax payments (the 3 new `TAX_QUESTION_BANK` entries from
   the wiring task). These already flow through `ensurePersonalWorkspace`'s seeding; check whether the
   existing question-answering UI (find it — likely in `components/tax/`) already surfaces new bank
   entries automatically or needs to be told about them specifically.

4. **Surface the 2 genuinely-blocked-by-real-world-facts gaps as clear action items, not vague warnings**:
   - EK Consulting LLC has zero `Transaction` rows in production (confirmed live during the wiring task)
     — Schedule C can't compute a real number until this is resolved. This is the single most
     consequential open item in the whole build. Make it unmissable — a household-facing tax page that
     buries "your business has no bookkeeping data" in a small gray note would be a real UX failure here.
   - A real 2025 PennyMac 1098 exists but is mistagged as a W-2 document, so it's unusable as-is (confirmed
     live). Point at the specific document if the existing document-list UI can deep-link to it; otherwise
     describe the fix in plain language (re-upload correctly tagged, or wait for a re-extraction feature
     that doesn't exist yet — don't imply one does).

5. **`scheduleCDataMissing` and every item in `computePersonalTaxReturn`'s `gaps` array must be visible
   in this UI**, not just computed and ignored. Don't build a new gaps-list component if an existing one
   (the readiness checklist) can reasonably absorb this — your call after reading the existing components.

## Ground rules (same as prior two tasks in this trail)

- Never fabricate/imply a number that isn't real or isn't clearly labeled as a gap/estimate. Ground
  rule 1.
- No financial/tax advice framing — data-driven observations and drafts only, CPA reviews before filing.
  Ground rule 8.
- `requireAuth()` first line of any new server action, per `CLAUDE.md`.
- Test what's testable (any new pure formatting/labeling helper functions); this task inherently has a
  real UI component, which per this repo's established convention isn't unit-tested the same way pure
  logic is — say so plainly in the plan rather than force artificial component tests.
- Don't build PDF generation, a credits engine, or Sudden Valley/Mezzo logic in this task.

## Required findings section

Same pattern as the prior two tasks: explicitly enumerate what's now visible/actionable to Eric vs. what
still isn't, so the trail stays honest about real system state rather than implying more is done than is.
