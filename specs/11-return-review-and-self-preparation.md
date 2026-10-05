# 11. Return review and self-preparation (TY2025)

Status: written 2026-10-04 as step A0 of the `ai-return-reviewer` task. Source plan: `.claude/pipeline/ai-return-reviewer/01-plan.md` (sections 2, 5.7, 5.11, 5.12, 7).

## 1. Situation

Eric's CPA retired. There is no certified professional to review the TY2025 federal + Connecticut return before it is filed (due Oct 15, 2026). Eric is the **self-preparer of record** and owns every number. The app therefore:

1. stops implying that a CPA reviews, prepares or signs anything (wording, section 6);
2. adds an independent, layered **AI Return Reviewer** whose result gates (not replaces) Eric's own attestation;
3. releases a clean, unstamped **final package** only after that attestation, for the current return fingerprint, and the package never says what computed or checked it.

Honesty contract (design constraints, each has a test):

- The reviewer is an AI plus deterministic code. It is **not** a CPA, EA or other licensed professional. It can reduce risk; it cannot guarantee correctness, IRS/CT acceptance or the absence of an audit.
- No output may claim professional certification, licensure, "CPA approved", "professionally reviewed", "audit-proof" or "guaranteed".
- Result wording: `AI review: PASSED for fingerprint <fp12>` / `AI review: FLAGGED (n open blocker/high)`. PASSED is computed by code from the findings state (never by the model) and means "no unresolved blocker/high finding came out of these checks", not "the return is right".
- The approval record is **APPROVED BY OWNER** with timestamp and fingerprint. The AI verdict is a prerequisite, never the approval.
- Every finding about the law cites a primary source the code can check (a constant in `lib/tax2025/constants.ts`, a quote from the pinned source pack, printed-form text) or is marked `unverified` and capped at medium severity for gating.

## 2. Proposed `CLAUDE.md` changes (to be applied by the orchestrator after the Schedule 1-A / Form 8960 branch merges)

`CLAUDE.md` is deliberately not edited by this branch (the other branch touches 2 lines of it). Paste the text below.

### 2.1 Rule 8 (replaces the current rule 8 line)

> 8. **Tax output is a computed return prepared by the owner; no investment advice.** The owner (Eric Kinniburgh) is the preparer of record of the TY2025 return and there is no CPA review step. The tax side computes amounts, credits and eligibility conclusions from the owner's answers, the documents and the books, and produces a complete filing package the owner reviews, approves and signs himself. An AI Return Reviewer (deterministic checks, an independent recomputation and AI review passes) is advisory: it is not a CPA, EA or other licensed professional, it can reduce risk but cannot guarantee correctness, no output may claim professional certification or that the return is "CPA approved", and its PASSED result is a prerequisite for, never a substitute for, the owner's explicit attestation ("I prepared this return and take responsibility"), which is recorded with the return fingerprint. A clean (unstamped) package exists only after that approval and never mentions Claude, AI or this app as preparer. Guardrails: (a) every rule, threshold and table in a computation, and every legal claim in a review finding, must be primary-sourced (irs.gov / Connecticut DRS) and cited in code and `specs/09-*`, or marked "unverified"; a rule that cannot be verified is flagged "needs a professional's input" on that line, never guessed or approximated; (b) every computed line carries provenance (document / answer / books entry, verified or unverified AI read) and every pre-approval output is labelled a draft; (c) overrides are recorded and shown, never applied silently, and where the law leaves a real choice (e.g. standard vs actual home-office method) the computed alternatives are shown side by side and the choice is the owner's. Non-tax guidance (spending, budgets, investing) stays data-driven observation, not investment or financial advice ("you've spent 80% of the Groceries budget").

### 2.2 "TY2025 PDF packet" paragraph (edits)

- "a cover page for the CPA" becomes "a cover page (the owner's internal workfile)".
- Append: "The per-page stamp reads `DRAFT - not approved for filing - <date> - fp <fp12>` and the PDF Subject `DRAFT - not approved for filing`; neither says who computed or checked the packet. Clean copies (`?stamp=0`) and the final package (`?final=1`) are served only when an owner approval exists for the CURRENT return fingerprint (`lib/tax2025-pdf-approval.ts` `ApprovalLookup`; default: nothing is approved, the routes answer 403 after `auth()`/401). The final package (`lib/tax2025/pdf/final-package.ts`) is `00-package-index.pdf` + `forms/` (no stamp, no override/draft tooltip note, Title = form title, no Subject/Keywords/Author) + `attachments/` (real statement PDFs for the Schedule B / Schedule C / CT withholding continuation lists and the Form 8949 summary rows); it says `Prepared by Eric Kinniburgh (self-prepared)`, leaves the paid-preparer/firm/PTIN block blank, and every text we write is scanned against the banned-wording list in section 4 (a hit fails the build closed). The draft cover/workfile is a separate download, never inside the final zip."

### 2.3 "TY2025 CPA overrides and CT-1040 lines" paragraph (edits)

- Retitle to "TY2025 owner overrides and CT-1040 lines" and replace "CPA/owner overrides" with "owner overrides".
- Append: "New overrides are always recorded with `authority: "owner"` (the dialogs have no authority choice and the action default is `owner`); the DB column default stays `cpa` (additive-only schema policy) and stored `cpa` rows still display as `Advisor (recorded earlier)`. A line override in force blocks owner approval of the return (orchestrator decision D1): the engine does not recompute dependent totals under a pin."

### 2.4 New paragraph "Return review and approval" (add after the overrides paragraph)

> **Return review and approval** — an owner-approval flow gates clean copies. A review run is bound to a return fingerprint v2 (engine version + view fingerprint + answers + printed header + facts digest + document set digest + override digest); any change makes the run and any approval non-current. `TaxReviewRun`, `TaxReviewFinding`, `TaxReviewFindingDisposition` and `TaxReturnApproval` are append-only (no update/delete path); findings and reasons never contain SSN-like text and `AuditLog` rows carry ids, counts, fingerprints and hashes only, never values or reasons. The gate and the AI verdict are computed by code (`gate.ts`); an LLM pass can only ADD findings and can never change gate state or close a finding (injection-safe by design); a finding that cites a line or value that does not exist is rejected, and a law claim without a checkable source is `unverified` and capped at medium. Layers: L1 deterministic invariants and tie-outs (footing, PDF-vs-engine read-back, source-document tie-out, process state), L2 an independent recomputation that shares only `constants.ts` with the engine, L3 focused LLM passes. The owner's attestation (typed phrase + name, versioned text, hashes stored) is recorded as `APPROVED BY OWNER` with the fingerprint; only Eric's account may approve. Server actions start with `requireAuth()`; Anthropic calls are server-side only and never log prompts, payloads or findings (log `err.name` only).

### 2.5 `specs/09-tax-year-2025-constants.md` (additive note, not applied here because the other branch edits that file)

> **Not a CPA.** Every constant above is primary-sourced (url + verifiedOn) so the owner can check it himself. The AI Return Reviewer cites only these constants, the pinned source pack and printed-form text, is not a CPA/EA, and a PASSED result does not certify the return. A source pack (`data/tax-sources/2025/`, manifest with sha256) pins the IRS/CT instruction pages the reviewer may quote; a re-issued page is a deliberate change.

## 3. Attestation text v2 (constant `ATTESTATION_V2_TEXT`; hash stored with the approval; v1 is historical)

> This income tax return has been reviewed, prepared and filed by Eric Kinniburgh.
>
> (v1, retired before use, read: "I, Eric Kinniburgh, prepared this 2025 federal and Connecticut income tax return myself ..." The owner chose the shorter v2 sentence himself on 2026-10-04; the Final review page keeps its honesty panel directly above the approval card, and the sentence is never printed in the filing package.)

Typed confirmation: the phrase `I PREPARED THIS RETURN` and his full name. Stored as hashes plus the version id. Who may approve: Eric's account only (orchestrator decision D5); the approving user's name is stored.

## 4. Banned wording

Implemented in `lib/tax-wording.ts` (the plan named `lib/tax-review/wording.ts`; `lib/tax-review/` belongs to the reviewer-core unit, so reconcile the path at merge).

Owner-visible output (sheet, CSV, cover, stamp, PDF properties, tooltips, pages, questionnaires): the standalone word **CPA** (any case, but not inside identifiers such as `needs_cpa_judgment`, `cpaNote`, `cpa-summary`), "certified public accountant", "professionally reviewed", "licensed". The only allowed uses are honesty statements ("not a CPA", "enrolled agent, CPA or tax attorney") and the bookkeeping "Export CPA bundle" button/pages (orchestrator decision D7: left alone, not about the return review).

Final package (everything WE write: index, attachments, document properties; IRS form titles and the owner's data such as payer names are not scanned): `Claude`, `AI` (word), `artificial`, `Banana Stand`, `this app/platform/system/software`, `draft`, `provisional`, `estimate`, `computed by/for/from`, `reviewed by`, `review`, `override`, `engine`, `CPA`, and any `prepared by` other than `Prepared by Eric Kinniburgh (self-prepared)`.

Identifiers that stay (persisted or pinned): `needs_cpa_judgment`, `needs_cpa_rule_unverified`, `needs_cpa_input`, `answer_cpa`, `confirmWithCpa`, `cpaNote`, `who: "cpa"`, the `/tax/forms/[year]/cpa-summary` URL, the `TaxReturnOverride.authority` column default.

## 5. Final-package manifest (`ty2025-final-<fp12>.zip`)

| Path | Content |
|---|---|
| `00-package-index.pdf` | For Eric's use, not for filing. Title `Tax year 2025 - Form 1040 and CT-1040 - married filing jointly`; `Prepared by Eric Kinniburgh (self-prepared)`; `Approved by owner` (+ date when the approval store supplies it); package date; return fingerprint (12 hex); forms and attachments; forms the return needs that this app has no PDF for ("Not included in this package"); "Enter by hand before filing" checklist (SSNs, EINs, dates of birth, bank numbers, PINs, signatures and dates of both spouses, occupations/phones/addresses); the paid-preparer/firm/PTIN boxes stay blank; "Also attach" the broker's 1099-B pages when Form 8949 has summary rows. No findings, no open items. |
| `forms/NN-<form>.pdf`, `forms/ct/ct1040.pdf` | The filled forms in IRS attachment order, same field values as the draft. No page stamp. Field tooltips keep only the IRS's own text. Title = form title; no Subject, Keywords or Author. SSN/EIN/bank/signature/PIN/DOB/address/preparer fields blank. |
| `attachments/NN-<table>.pdf` | Statements for every continuation list (Schedule B interest/dividend payers, Schedule C other expenses, CT withholding) and `form-8949-summary`. Neutral wording. SSN line says "(enter by hand)". |

Refusals (fail closed, 409): a blocking engine item is present; a form could not be built or a fill item is blocking; any text we wrote contains banned wording; a form's document properties are not neutral. 403: no owner approval for the current fingerprint (clean copies and the final package).

## 6. L1 check catalogue ids (for the reviewer-core unit; see plan 5.3)

`L1.F1` footing per form, `L1.F2` cross-form links, `L1.F3` footing coverage drift, `L1.B1` PDF equals engine, `L1.B2` no stray ink (incl. preparer block blank), `L1.B3` printed-line label audit, `L1.B4` checkbox/answer agreement, `L1.B5` unkeyed printed money lines, `L1.B6` metadata and tooltips (final: neutral; draft: marker present), `L1.X1` same figures on every surface, `L1.C1` source documents to return, `L1.C2` double counting, `L1.D1` engine completeness, `L1.D2` unresolved choices, `L1.D3` overrides in force, `L1.D4` privacy guard, `L1.D5` blank-not-zero, `L1.E1` prior-year comparison, `L1.E2` reasonableness ratios, `L1.G1` required forms exist, `L1.G2` filing method.

## 7. What the reviewer cannot do (UI copy, written plainly in Phase B)

It cannot verify that a document is complete or genuine, know income or assets never entered, replace a licensed preparer's judgment on contested positions, guarantee IRS/CT acceptance, see law or guidance changes after the source-pack date, verify its own answers, prepare or file anything, or sign for Eric. Human backstops offered without lecturing: a one-time paid review of only the highest-impact items by an enrolled agent, CPA or tax attorney; IRS free resources; keep copies of the source documents, the final package and the workfile; Form 1040-X exists if an error turns up after filing. Filing logistics (paper vs e-file, Form 8453/8879, attachments, payment/refund, what Eric signs) are shown as an info card labelled "not verified legal advice" and each statement must carry a quoted source or be removed.
