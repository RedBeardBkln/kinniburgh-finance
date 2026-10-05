# Kinniburgh Financial Platform

Interactive personal + business financial management platform for Eric Kinniburgh and Eva-Laura Ramirez-Wisiackas. Covers envelope budgeting, spend analysis, forecasting, project budgets, retirement planning, business bookkeeping for three LLC/entities, tax document organization and prep, and life insurance policy storage/analysis.

## How to use this repo

Read the specs in order before writing any code:

| File | Contents |
|---|---|
| `KICKOFF.md` | How the owner runs this build (setup, initial prompt, per-phase inputs) |
| `specs/00-overview.md` | Goals, users, organizational buckets, success criteria |
| `specs/01-data-model.md` | Entities, schema, money handling rules |
| `specs/02-personal-finances.md` | Accounts, envelope/transfer rules, budgets, tags |
| `specs/03-business-finances.md` | The three business entities, properties, tax workflows |
| `specs/04-integrations.md` | Bank integrations (Plaid), import fallbacks, security |
| `specs/05-features.md` | Receipts, dashboard, reporting, tagging, proactive guidance, mobile |
| `specs/06-build-plan.md` | Recommended stack and phased implementation plan |
| `specs/07-source-data-notes.md` | **Read this.** Known discrepancies and open questions in the source data — do NOT silently "fix" these |
| `specs/08-clawbox-architecture.md` | Local-only architecture for the Vault + tax/insurance documents on the owner's ClawBox (NVIDIA Jetson) — data split, remote-access trade-offs, and open decisions to resolve before building it (deprioritized — see memory) |
| `specs/09-tax-year-2025-constants.md` | **Read before touching tax computation code.** Primary-sourced federal/CT tax-year-2025 constants (brackets, standard deduction, SE tax, QBI, CT tables A–E). Hardcode tax math against these citations only — never re-derive or approximate a bracket/rate in code. |
| `specs/10-receipt-substantiation-threshold.md` | **Read before touching receipt-required flagging.** The real IRS receipt threshold is $75 (Pub. 463 / Treas. Reg. §1.274-5), not $250 — an existing checklist item has the wrong number, conflating an unrelated charitable-donation rule. |
| `data/tags 2026.csv` | Real personal tag hierarchy (seed data) |
| `data/budgets 2026 v2 (with accounts).csv` | **Authoritative budget seed** — 2026 monthly budgets with account mapping (owner-cleaned, June 2026). Amounts are starting points and may be updated. |
| `data/budgets 2026.csv` | v1 export — historical reference only (contains rollover/actuals figures from the prior tool); do NOT seed budgets from this |
| `data/gl-accounts-ekc-2026.csv` | QuickBooks chart-of-accounts export for Eric Kinniburgh Consulting, LLC (CPA-provided, Sep 2026). GL codes were assigned by the app (QuickBooks export had no account-number column) and are already seeded in the `GlCode` table for that entity. |

## Ground rules (non-negotiable)

1. **Never fabricate financial data.** Every account number, dollar amount, date, and rule in these specs comes from the owner's source documents. If something is missing or ambiguous, check `specs/07-source-data-notes.md`; if still unresolved, ask the user — do not invent a value.
2. **Money is stored as integer cents** (or `NUMERIC(14,2)` in Postgres). Never floats.
3. **Transactions are immutable facts.** Tags, categories, and budget assignments are mutable metadata layered on top. Support audit history.
4. **Two-person household.** Eric and Eva are separate users with shared visibility; notifications can target either or both.
5. **Security first.** This app holds real bank data. Encrypt secrets at rest, never log account numbers or tokens, use OAuth/Plaid tokens (never store bank passwords), enforce auth on every route, support MFA.
6. **Personal vs. business separation is a core invariant.** Every transaction belongs to exactly one bucket (Personal, Sudden Valley Property Management LLC, Eric Kinniburgh Consulting LLC, or Mezzo). Cross-bucket flows (e.g., reimbursements via THE COTTAGE account) are modeled as explicit transfers, not edits.
7. **Tax data retention.** Nothing tax-related is ever hard-deleted; archive only.
8. **Tax output is a computed return prepared by the owner; no investment advice.** Eric Kinniburgh is the self-preparer of record of the TY2025 return and there is no CPA review step (his CPA retired). The tax side SHOULD compute amounts, credits and eligibility conclusions from the owner's answers, the documents and the books — do not water them down to "observations" or add blanket "never decides" restrictions — and produces a complete filing package that the owner reviews, approves and signs himself. The AI Return Reviewer (see "Return review and approval") is advisory: it is software, NOT a CPA, EA or other licensed professional; it can reduce risk but cannot guarantee correctness or acceptance; no output (UI, sheet, cover, PDF, package, spec) may claim professional certification, licensure, or that the return is "CPA approved" or "professionally reviewed"; its PASSED result is a prerequisite for, never a substitute for, the owner's own attestation, which only his account can record. The clean (unstamped) copies and the final package exist only for a return the owner approved at its current fingerprint, say "Prepared by Eric Kinniburgh (self-prepared)", and never mention Claude, AI or this app. Guardrails: (a) every rule, threshold and table used in a computation, and every legal claim in a review finding, must be primary-sourced (irs.gov / Connecticut DRS) and cited in code and `specs/09-*`, or marked "unverified"; a rule that cannot be verified is flagged "needs a professional's input" on that line (internal status `needs_cpa_*`), never guessed or approximated; (b) every computed line carries provenance (which document / answer / books entry, and whether it is verified or an unverified AI read) and every pre-approval output is labelled a draft; (c) overrides are recorded and shown, never applied silently; where the law leaves a real choice (e.g. standard vs actual home-office method), show the computed alternatives side by side — the choice is the owner's. Non-tax guidance (spending, budgets, investing) stays data-driven observation, not investment or financial advice ("you've spent 80% of the Groceries budget").

## Conventions

- TypeScript strict mode everywhere; no `any`.
- All dates stored UTC, displayed in America/New_York.
- Write tests for: transfer/accrual math, budget rollover logic, minimum-balance fee warnings, tag auto-assignment.
- Seed the database from `data/*.csv` exactly as-is (including known quirks listed in spec 07) unless the user approves cleanup.

## Dev Commands

```bash
pnpm dev          # Next.js dev server
pnpm build        # prisma generate && next build
pnpm typecheck    # tsc --noEmit
pnpm lint         # ESLint
pnpm test         # vitest run (all tests)
pnpm test:watch   # vitest watch

# Run a single test file:
pnpm vitest run lib/__tests__/tags.test.ts

# Prisma
pnpm db:generate  # prisma generate (after schema change)
pnpm db:migrate   # prisma migrate dev (local dev migration)
pnpm db:push      # prisma db push (schema push without migration)
pnpm db:studio    # Prisma Studio GUI
pnpm db:seed      # seed from data/*.csv

# TY2025 PDF packet (dev tools; none touch the DB)
pnpm forms:fetch         # download the blank IRS/CT forms listed in data/forms/manifest.json (fails if a sha256 changes)
pnpm forms:catalog       # regenerate data/forms/2025/catalog/*.fields.json from the blank PDFs
pnpm forms:calibrate-ct  # regenerate the CT-1040 overlay geometry (data/forms/2025/geometry/ct1040.json)
pnpm tax2025:pdf-gap     # per form: pending keys still used, printed money lines no map claims (fixture data)
```

## Architecture

**Stack:** Next.js 15 App Router · TypeScript · Prisma/PostgreSQL (Supabase) · NextAuth v5 · Plaid · Tailwind · shadcn/ui · Vitest

**Server actions** (`actions/*.ts`) — all use `"use server"` and call `requireAuth()` as the first line; never skip it. `requireAuth()` throws if no session.

**Auth** — NextAuth v5 credentials provider (email + password + optional TOTP). Session cookie: `authjs.session-token` (HTTP) / `__Secure-authjs.session-token` (HTTPS). Middleware in `middleware.ts` gates all routes except `/login`. **Deliberate exception:** the public `/queue/[token]` review page (Eva's "assign to Eva" magic link) is exempt in middleware, and every export in `actions/review-queue.ts` is token-gated by `requireReviewAccess(token)` (validated against the DB on each call) instead of `requireAuth()`; this is intentional because the caller has no NextAuth session, so it must never be "fixed" to use `requireAuth()` or have the gate removed. Its security boundary is that per-action token check (not the middleware exemption), and a test pins that every export starts with it.

**Entities** — the core multi-tenancy unit. Personal + three LLCs (Sudden Valley, EK Consulting, Mezzo). Entity slug drives the URL (`/business/[slug]/...`). `getNavBuckets()` in `lib/entity.ts` builds the header tabs.

**Money** — `NUMERIC(14,2)` in Postgres; `Decimal.js` at runtime. **Negative = outflow, positive = inflow.** Never use floats for amounts.

**"income" vs "revenue"** — `GlCode.type` (business entities) uses `revenue` (the enum is `asset|liability|equity|revenue|expense`, defined in `actions/gl-codes.ts`'s `GL_TYPES` — never `income`, confirmed against live production data). `"income"` is reserved for personal-finance concepts (e.g. `lib/forecast.ts`'s `ScheduleEventType`, `lib/tax-guidance.ts`'s question categories). This exact mix-up recurred across three separate tasks before being fixed for good in the `gl-code-tag-mapping` change — grep for `"income"` near any `GlCode`/`glCodeId`/`computePL` code before assuming it's correct.

**Encryption** — `lib/encrypt.ts`: AES-256-GCM, format `iv:authTag:ciphertext` (hex). Used for Plaid access tokens, cursors, vault credentials. Key from `ENCRYPTION_KEY` env var (64-char hex → 32 bytes).

**Plaid sync** — `lib/plaid-sync.ts`: use `normalizePlaidTransaction()` for all Plaid tx conversion (flips sign, handles payee priority). Use `normalizePayee()` from `lib/tags.ts` (not `.toLowerCase()`) for `payeeNormalized` field.

**Soft deletes** — `archivedAt: null` guards required on all `findUnique`/`findFirst` queries for Transaction, Account, PlaidItem, VaultOtp. Tax records are never hard-deleted.

**Vault** — separate OTP + session mechanism (`VaultOtp`, `VaultSession`); `lib/vault-session.ts` validates the `vault-session` cookie (4h expiry). OTP has `attempts` column; burns after 5 failures (429).

**Tags** — `lib/tags.ts`: hierarchical (parent/children paths like "Food & Drink / Groceries"); `matchTagRule()` for auto-assignment; always use `normalizePayee()` for `payeeNormalized`.

**Document extraction** — `Document.extractionStatus === "complete"` means only that the AI run finished; "verified" is `extractionConfirmedAt` being set, and owner corrections live in an overlay column `extractionCorrections` (the AI's `extractionData` is never edited). `TAX_EXTRACTION_POLICY` (`lib/tax-extraction-policy.ts`) defaults to `verified_else_ai` (unverified AI reads are used but labelled). Compute/Forms code must read tax extraction data only through `resolveTaxDocForCompute` / `resolveEffectiveExtraction`, never raw `extractionData`.

**TY2025 return engine** — `lib/tax2025/**` is pure (no DB, network or clock): `resolveFacts()` turns rows into `Ty2025Facts` + conflicts + open items, `computeTy2025Return(facts, decisions)` assembles every `LineKey` (`line-catalog.ts`) with an explicit status via rule modules in `rules/`. Every tax number lives ONLY in `constants.ts` (each with irs.gov / ct.gov url + verifiedOn; unverified rules return `needs_cpa_rule_unverified`, never an estimate), and a test fails if a rule file repeats one. A rare line is `not_applicable` 0 only when the owner stated "none" for its group (`facts.statedNone`), otherwise `not_yet_computed`: never a silent 0. `lib/tax2025-build.ts` is the only DB-aware file (read-only; no auth, so callers use `requireAuth()` and pass only `ret` to clients). `lib/tax-compute.ts` keeps the CT tables and v1 helpers.

**TY2025 PDF packet** — `lib/tax2025/pdf/**` turns a computed `Ty2025Return` into a DRAFT zip of filled blank IRS forms (+ the CT-1040 as a flat form with our own overlay fields) and a cover page (the owner's internal workfile; the draft cover is a separate download and is never inside the final zip); it only consumes the engine (the engine never imports it; a test pins this) and never recomputes a number. `adapter.ts` is the only file that reads engine shapes; `maps/*.ts` map every AcroForm field to an engine `LineKey`, an answer, a header name or an explicit `blank` reason (a completeness test requires each field to be claimed exactly once). Invariants: the routes `app/api/tax/forms/[year]/pdf/**` start with `auth()` and return 401 before anything else, nothing is persisted (one `AuditLog` row with ids and counts only), every string written to a PDF or the cover goes through `safeText` (SSN-like text is refused), SSN/EIN/bank/PIN/signature/preparer/address/DOB fields are always blank, and the blank-not-zero policy holds (a line that could not be computed is blank and listed on the cover, never "0"; a form the engine requires but has no map is listed under "Required forms this packet does NOT contain"; a type / description / code box beside a zero amount line is the blank reason `zero_line_entry` with `follows`, and if a followed line ever carries an amount the packet raises an advisory item and L1 raises `L1.B5.entry-by-hand`: no printed text line may be silently `not_modeled`, a ratchet test pins 0 unmapped on every form). Which forms are included follows `Ty2025Return.formsRequired`. Schedule 1-A (every printed money line is an engine line) and Form 8960 (lines 1-17 for an individual) have maps; Form 8829 is intentionally NOT generated (the engine states whether it is required: not under the simplified home-office method, listed on the cover as not generated if the owner chooses the actual method). The per-page stamp reads `DRAFT - not approved for filing - <date> - fp <fp12>` and says nothing about who computed or checked it. Clean copies (`?stamp=0`) and the final package (`?final=1`: `00-package-index.pdf` + `forms/` + `attachments/`, no stamp, neutral document properties) are served only after `auth()` AND only when an owner approval exists for the CURRENT return fingerprint (`lib/tax2025-pdf-approval.ts` `ApprovalLookup`; a failed lookup is 403, never a clean copy); every string we write into the final package is scanned against the banned-wording list in `lib/tax-wording.ts` and a hit fails the build closed. Blank forms are pinned by sha256 in `data/forms/manifest.json` (a re-issued form is a deliberate, reviewed change; `data/forms` is about 3 MB).

**TY2025 owner overrides and CT-1040 lines** — owner overrides (new ones are always recorded with `authority: "owner"`; the DB column default stays `cpa` under the additive-only schema policy and stored `cpa` rows display as "Advisor (recorded earlier)"; a LINE override in force blocks owner approval) live in the append-only `TaxReturnOverride` table (versioned; a change inserts version+1 and archives the old row, clearing only archives; never hard-deleted; reason text is a tax record and never goes into `AuditLog`, which carries ids/counts only). `lib/tax2025/overrides.ts` is pure: an override REPLACES one line's value in the effective view only; every dependent line (edges in `lib/tax2025/line-flow.ts`, kept honest by key-existence, acyclic and spine-drift tests) is flagged "depends on an override" and is NOT recomputed, `headline.complete` is false while a pin is in force, a pin on a blocked line unblocks that line only, and a stale pin (value or status changed) is blocking while an engine-version-only change is advisory. Decisions (`Ty2025Decisions`) still recompute the whole return. The sheet, CSV and PDF packet must all load through `lib/tax2025-overrides-build.ts` (`buildTy2025ReturnWithOverrides`, DB-aware, fail-closed: unreadable rows return an error, never the un-overridden return) and show one note string (`formatOverrideNote`); the actions in `actions/tax-return-overrides.ts` start with `requireAuth()` and refuse SSN-like reasons. When the engine gains or changes a line that feeds another, add its edge to `line-flow.ts` or the drift test fails. CT-1040: lines 3, 7, 8, 12-14, 16, 17, 20a-d, 21, 22, 25, 26, 29, 30 and Schedule 3/4 detail are engine lines (`rules/ct.ts`, `ct-credits.ts`, `ct-settlement.ts`); lines 7, 13 and 20a-d are gated by owner none-statements (unanswered = blocking, never a silent 0), 25 is informational and 23/24/24a are the owner's choice, Schedule 3 is left blank (with a cover note) when the property tax credit is fully phased out, and PDF text that may not fit a cell goes through `pdf/fit-text.ts` (shortened or smaller font, full text kept in an advisory, never a silent clip).

**Return review and approval** (`specs/11-return-review-and-self-preparation.md`) — the owner-approval flow that gates clean copies. A review run and an approval are bound to the return fingerprint v2 (`lib/tax-review/fingerprint.ts`: engine version + view fingerprint + answers + printed header + facts + document set with verification/corrections + questionnaires + overrides + decisions, recomputed on the server for every request; clients never supply it); any change makes the run and any approval non-current. Three layers, each producing structured findings (`lib/tax-review/types.ts`): L1 deterministic invariants (`l1/`: footing per form, PDF read-back vs engine, source-document tie-out, process state, privacy guard), L2 an independent recomputation (`l2/`, shares no rule code with the engine: only `constants.ts`, the fact/line types and the effective-override view), L3 focused LLM passes (`llm/`, Anthropic server-side only; model `TAX_REVIEW_MODEL`, default `claude-opus-5-5`; price vars optional; payer names are sent by default and `TAX_REVIEW_PAYER_NAMES=generic` hides them; household names, addresses, own entity names, SSNs and account numbers are never sent). The gate and the "AI review: PASSED / FLAGGED" verdict are computed by code in `lib/tax-review/gate.ts`, never by a model: an LLM can only ADD findings (a finding that cites a line or value that does not exist is rejected; a law claim without a checkable quote from the pinned `data/tax-sources/2025` pack is `unverified`, capped at medium, and still needs the owner's written acknowledgement) and can never close one. There is NO waiver: L1, L2 and L3 must all have run for the CURRENT fingerprint, a decision still at its default alternative gates, a line override in force gates, and a layer that has not run, failed or is partial keeps the gate red. Only the owner's account (the user named in the EK Consulting entity name; ambiguity means nobody) can accept a finding (written reason) or approve, with the attestation text v2 (`ATTESTATION_V2_TEXT`, hash stored with version id), the typed phrase and his full name; this is recorded as `APPROVED BY OWNER`. An approval stops counting, without being deleted, when the fingerprint changes, when a blocking finding is open again or was decided again after it, or when an AI review was cancelled after it (`currentApproval` / `approvalRevocationReasons`, read by the page and the PDF routes through ONE reader, `lib/tax-review-approval-facts.ts`; any read failure, including a missing table, fails closed: 403). `TaxReviewRun`, `TaxReviewFinding`, `TaxReviewFindingDisposition`, `TaxReturnApproval` and `TaxReviewRunEvent` are append-only (the store modules have no update/delete/upsert path; a source-reading test pins it); findings, reasons and names never contain SSN-like text, and `AuditLog` rows carry ids, counts, fingerprints and hashes only, never values or reasons. Server actions (`actions/tax-review.ts`, `actions/tax-return-approval.ts`) start with `requireAuth()`; spending API credit and recording a decision are owner-only; Anthropic errors log `err.name` only, never prompts or findings. All owner-visible wording passes `lib/tax-wording.ts` (rewrites "the CPA decides" prose at the render boundary; internal ids such as `needs_cpa_*`, `answer_cpa`, `cpaNote` and the `/cpa-summary` URL stay). The reviewer's text must never say it is a CPA, and the honesty panel sits directly above the approval card.

**Testing pattern** — pure function unit tests in `lib/__tests__/`. Use `Decimal` (never floats). Test factory `makeTx(overrides)` for mock Plaid transactions. No integrated DB tests; mock at the function boundary.

**Key env vars:** `DATABASE_URL`, `ENCRYPTION_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `NEXTAUTH_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, VAPID vars.
