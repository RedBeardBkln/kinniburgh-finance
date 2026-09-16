# Implementation: account-creation-gap-fix

## Summary of changes

Implemented the plan exactly as written — new-institution/new-account creation
for both the manual Add Account form and the Plaid mapping step, plus a
resume-without-Link path for orphaned `PlaidItem`s (specifically CorePlus
Credit Union, live in production with zero `Account` rows).

**New files:**

- `lib/account-types.ts` — `ACCOUNT_TYPE_VALUES` (as-const tuple) and
  `ACCOUNT_TYPE_OPTIONS` (value/label pairs), replacing the two independent
  copies that previously lived in `actions/accounts.ts` and
  `components/accounts/accounts-page-client.tsx`.
- `lib/plaid-account-type.ts` — `inferAccountTypeFromPlaid(type, subtype)`,
  a pure function mapping Plaid's `type`/`subtype` to our `AccountType`,
  case-insensitive on both inputs, defaulting to `"checking"` for anything
  unrecognized. Used only as an editable `defaultValue` — never forces a
  value.
- `lib/institutions.ts` — `normalizeInstitutionName(name)` (pure: trim,
  collapse whitespace, lowercase) and `resolveOrCreateInstitution(rawName,
  plaidFields?)` (DB-aware: case-insensitive find via
  `Prisma.QueryMode.insensitive`, optional backfill of
  `plaidInstitutionId`/`plaidCoverageNotes` on an existing row, or create a
  new `Institution` with the trimmed as-typed name). Throws on an
  empty-after-trim name rather than fabricating one.
- `lib/plaid-mapping.ts` —
  - `getPlaidAccountSuggestions(accessToken)`: the mask-matching suggestion
    logic extracted from `exchange/route.ts`, now also returning Plaid's
    `type` (previously dropped, only `subtype` was threaded).
  - `createAccountsFromPlaidMapping(itemId, newAccounts)`: sequential
    (not `Promise.all`) per-row creation — defensive re-check that the
    `plaidAccountId` isn't already claimed by a non-archived `Account`,
    resolves/creates the `Institution` from the `PlaidItem`'s stored
    `institutionName`/`institutionId`, creates the `Account` wired to
    `plaidItemId`/`plaidAccountId` with `integrationMode: "plaid"`, and
    catches Prisma's `P2002` unique-constraint error (the
    `@@unique([entityId, nickname])` collision) to rethrow a clear,
    owner-facing message instead of a raw Prisma error.
- `app/api/plaid/pending-accounts/[itemId]/route.ts` — new `GET` route,
  `auth()`-gated. Decrypts the stored access token for an existing
  `PlaidItem`, calls `getPlaidAccountSuggestions`, and returns `{ itemId,
  institutionName, suggestions }`. On `ITEM_LOGIN_REQUIRED` from Plaid, marks
  the item `status: "requires_login"` (matching `lib/plaid-sync.ts`'s
  existing pattern) and returns a structured `{ error, code:
  "ITEM_LOGIN_REQUIRED" }` (409) the client uses to offer the Link-based
  re-auth fallback. Logs only `itemId` and Plaid's `error_code` on failure —
  never the decrypted token.
- `lib/__tests__/plaid-account-type.test.ts` — 15 cases covering every
  branch (mortgage, loan/student/line-of-credit, credit/credit-card,
  savings/cd/money-market, investment/brokerage, unenumerated depository
  subtypes, null/empty fallback, case-insensitivity on both inputs).
- `lib/__tests__/institutions.test.ts` — 6 cases for
  `normalizeInstitutionName` (leading/trailing whitespace, internal
  double-spaces, lowercasing, empty string, whitespace-only, idempotency).
  `resolveOrCreateInstitution` intentionally not unit tested, matching this
  repo's DB-boundary-mocking convention.

**Edited files:**

- `components/accounts/accounts-page-client.tsx` — Institution `<select>`
  gains a `"+ Add new institution…"` sentinel (`__new__`) that swaps in a
  required text input (`name="newInstitutionName"`) plus a "‹ choose
  existing instead" toggle back. `createAccount` payload now sends either
  `institutionId` or `newInstitutionName`, never both. Local `ACCOUNT_TYPES`
  replaced with the shared `ACCOUNT_TYPE_OPTIONS` import. New required prop
  `pendingPlaidItems: SerializedPendingPlaidItem[]` renders an amber
  "connected but not finished — Finish setup" banner per zero-account
  `PlaidItem`, linking to `/accounts/connect?resumeItemId=<itemId>`.
- `app/accounts/page.tsx` — added a fourth parallel query,
  `db.plaidItem.findMany({ where: { accounts: { none: { archivedAt: null }
  } } }, orderBy: { createdAt: "asc" } })`, serialized and passed to
  `AccountsPageClient` as `pendingPlaidItems`.
- `actions/accounts.ts` — `createAccountSchema` is now a `.refine()`-based
  schema requiring exactly one of `institutionId` (uuid) /
  `newInstitutionName` (trimmed, 1–200 chars) via `!!a !== !!b` XOR. When
  `newInstitutionName` is present, `createAccount` calls
  `resolveOrCreateInstitution` first, then proceeds with the unchanged
  `db.account.create` (still `integrationMode: "manual_entry"`). Both
  `createAccountSchema` and `updateAccountSchema` now import
  `ACCOUNT_TYPE_VALUES` from `lib/account-types.ts` instead of a local
  `ACCOUNT_TYPES` const.
- `app/api/plaid/exchange/route.ts` — suggestion-building block replaced
  with a call to `getPlaidAccountSuggestions(access_token)` from the new
  `lib/plaid-mapping.ts`. Behavior unchanged for this route; `db` import
  retained (still used for the `PlaidItem` upsert).
- `app/api/plaid/confirm-mapping/route.ts` — zod schema gains
  `newAccounts: z.array({ plaidAccountId, entityId, nickname, accountType,
  mask? }).default([])` (and `mappings` is now `.default([])` too, harmless
  since every caller already sends it). Before the existing
  `mappings.map(db.account.update)` block, calls
  `createAccountsFromPlaidMapping(itemId, newAccounts)` — new accounts are
  wired before the trailing `syncPlaidTransactions(itemId)` call, so they're
  covered by the same initial sync.
- `app/accounts/connect/connect-client.tsx` — substantial rewrite of the
  mapping-step state:
  - `Suggestion` gains `type: string | null` (Plaid's high-level type,
    previously dropped).
  - Per-row state is now `Record<string, RowChoice>` where `RowChoice` is
    `{kind:"skip"} | {kind:"existing", accountId} | {kind:"new", entityId,
    nickname, accountType}`, replacing the old `Record<string, string>`.
  - Each mapping row's `<select>` gained a `"+ Create new account…"`
    sentinel (`__create_new__`); selecting it reveals inline Entity /
    Nickname / Account Type fields directly in that row, defaulting
    Nickname to the Plaid account's own `name` and Account Type to
    `inferAccountTypeFromPlaid(s.type, s.subtype)` (both editable).
  - `entities` is now fetched from the existing `/api/form-data` response
    (previously fetched but discarded) into new state, used to populate the
    new-row Entity `<select>`.
  - `confirmMapping()` builds `mappings` (existing-account picks) and
    `newAccounts` (new-account rows) from `rowChoices`, client-side
    validates that every "new" row has a non-empty `entityId` and
    `nickname` before POSTing (the map step has no native `<form>`, so HTML
    `required` attributes on those inline fields are decorative only — this
    validation is the real gate), and POSTs both arrays to
    `/api/plaid/confirm-mapping`.
  - New `resumeItemId` search-param branch: on mount, if present, fetches
    `GET /api/plaid/pending-accounts/<resumeItemId>` instead of a link
    token, populates `suggestions`/`itemId`/`rowChoices` and jumps straight
    to `step: "map"` — skips Plaid Link initialization entirely. On an
    `ITEM_LOGIN_REQUIRED` response, sets `reauthItemId` and renders a
    "Re-authenticate" card linking to the existing
    `/accounts/connect?itemId=<itemId>` update-mode Link flow instead of the
    mapping step.
  - Minor UX addition beyond the plan's letter: the map step's "Back" button
    is hidden when `resumeItemId` is set (there's no "link" step to go back
    to in the resume flow) — small, self-contained, doesn't change any
    other behavior.
- `app/api/plaid/link-token/route.ts` — dropped the
  `plaidItem.accounts.length === 0` → 404 guard in the `itemId` (update-mode)
  branch; the only remaining check is that the `PlaidItem` row exists. This
  is the one behavior change to an existing route beyond the core ask,
  called out explicitly in the plan (Approach step 7) as the dependency for
  the resumed-item re-auth fallback — an orphaned/zero-account item must
  still be able to open an update-mode Link session.

## Deviations from the plan

None of substance. The one addition (hiding "Back" in the resume flow's map
step) is a self-contained UX nicety not specified in the plan, called out
above rather than silently bundled in.

## Commands run and their results

- `pnpm typecheck` (`tsc --noEmit`) — clean, no errors, first try.
- `pnpm lint` — 0 errors, 47 warnings. All 47 are pre-existing, in files this
  task never touched (verified by name against the diff — none in
  `lib/account-types.ts`, `lib/plaid-account-type.ts`, `lib/institutions.ts`,
  `lib/plaid-mapping.ts`, the new `pending-accounts` route, or any of the
  edited files). Baseline drifted from 46→47 warnings between sessions due
  to concurrent work in this shared repo, consistent with the pattern noted
  in memory — not something this task introduced.
- `pnpm test` (`vitest run`, full suite) — 573/573 passed across 48 files
  (+21 tests, +2 files: `plaid-account-type.test.ts` 15 tests,
  `institutions.test.ts` 6 tests; no existing test file needed edits).
- `npx next build` (skipping `prisma generate` — schema untouched, prior
  session's Prisma client still valid, matching the established workaround
  in memory for this repo's Windows DLL-lock/shared-pool flakiness) —
  succeeded cleanly. Confirmed `/api/plaid/pending-accounts/[itemId]` is
  registered in the route manifest alongside all other unchanged routes; no
  new build errors.
- Manual smoke test: started `pnpm dev` in the background (landed on port
  3001 — 3000 was already in use by a concurrent session's dev server, left
  untouched rather than risk killing someone else's process). `curl`'d
  `/accounts`, `/accounts/connect`, and
  `/api/plaid/pending-accounts/doesnotexist` — all three returned clean 307
  redirects to `/login?callbackUrl=...` (expected: no session cookie), no
  500s, no compile errors in the dev server log. This is the extent of
  verification possible from this role — no browser-control tool and no app
  login credentials are available to the Coder subagent in this repo's
  pipeline (see memory: `no-browser-tool-for-manual-verification`). The
  actual click-through (Add Account new-institution path, Plaid mapping
  create-new-account path for both a fresh Link session and the CorePlus
  resume, pending-mapping banner appear/disappear, re-auth fallback) is an
  explicit open item for the orchestrator per the plan's own "Manual
  verification prep" section (Approach step 9) and Test expectations.
- Grepped the diff for `console.log`/`console.error` calls touching any
  new decrypted-token variable — only one new log call
  (`[plaid/pending-accounts] failed`), and it logs only `itemId` and
  Plaid's `error_code`, never the token. Satisfies acceptance criterion 8.

## Open items

- **Manual click-through verification** (acceptance criteria 1, 3, 5, 6) is
  unverified by this Coder pass — no browser tool or app credentials
  available in this role. The plan's own Test expectations section already
  designates this as the orchestrator's job post-review, not part of this
  task's automated test surface, so this isn't a gap relative to scope —
  just flagging it stays real and unverified until someone with browser
  access runs it.
- **Pre-existing gaps flagged by the plan, not fixed here (by design):**
  - `confirm-mapping/route.ts`'s existing `mappings` (pick-an-existing-
    account) path still doesn't check whether the chosen `ourAccountId` is
    already `plaidItemId`-linked to a *different* item. Out of scope per
    the plan.
  - `Account.plaidAccountId` has no DB-level unique constraint — the
    defensive check in `createAccountsFromPlaidMapping` is a soft,
    race-prone guard (two near-simultaneous submits could both pass the
    check before either writes). Acceptable for this app's single-household
    usage pattern per the plan; a future task could add
    `@@unique([plaidItemId, plaidAccountId])` if it ever becomes a real
    problem.
- No schema migration was needed or made — confirmed `Institution`/
  `Account`/`PlaidItem` already carry every field this task uses.
- The real CorePlus loan account itself was deliberately not created — no
  seed data, placeholder balances, or account numbers were invented,
  per the plan and ground rule 1. The owner will create it himself through
  the shipped UI.

## Memory updates

Added a project-scope note to
`.claude/agent-memory/coder/commands.md` documenting this session's
typecheck/lint/test/build results, and confirmed the `Prisma.QueryMode`
first-of-its-kind usage compiles cleanly against this repo's Prisma 6.19.3.

---

## Fix round 2 (2026-09-16): address 03-test-report.md FAIL verdict

### Summary of changes

- **`app/api/plaid/confirm-mapping/route.ts`** — wrapped the entire POST
  handler body (everything after the auth check) in `try/catch`, mirroring
  the pattern already used correctly in
  `app/api/plaid/pending-accounts/[itemId]/route.ts`. The `catch` block
  converts any thrown error — `schema.parse()`'s `ZodError`, the
  `PlaidItem not found` 404 path was already a normal early return so
  unaffected, and critically `createAccountsFromPlaidMapping()`'s
  deliberately clear owner-facing messages (duplicate-nickname `P2002`
  collision, `alreadyMapped` guard) — into
  `NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })`
  instead of letting it fall through to Next.js 15's empty-body 500 for an
  uncaught Route Handler throw. This was the test report's one required
  (Medium severity) defect, confirmed fixed by re-reading the file: the
  `try`/`catch` now wraps `schema.parse`, the `plaidItem` lookup,
  `createAccountsFromPlaidMapping`, the `mappings` update loop, the
  Institution coverage-notes update, and `syncPlaidTransactions` — i.e. the
  entire previous body, so every throw path in this route is now covered,
  not just the specific reported repro.

### Secondary item: per-row `$transaction` wrapping — judgment call: not done

The test report flagged (as a non-blocking, low-severity note, explicitly
not required for PASS) that `createAccountsFromPlaidMapping`'s per-row new-
account creation loop isn't atomic across rows — a 2nd-row failure leaves
the 1st row's `Account` (and possibly a newly-created `Institution`) already
committed. I looked at wrapping this in a Prisma transaction and decided
against it for this round, for three reasons:

1. **No precedent for interactive transactions in this repo.** Every
   existing `db.$transaction(...)` call site (`actions/gl-codes.ts`,
   `lib/transfer-match-runner.ts`, `lib/dedupe-runner.ts`) uses the
   array-of-promises form — a fixed, known-upfront list of writes. The
   per-row loop here needs conditional logic (read `Institution` via
   `findFirst`, then decide `update` vs `create`, inside
   `resolveOrCreateInstitution`) that the array form can't express; it would
   require the interactive-callback form (`db.$transaction(async (tx) =>
   ...)`), which has zero precedent in this codebase.
2. **Would require reshaping a shared helper's public signature.**
   `resolveOrCreateInstitution` (`lib/institutions.ts`) is also called
   directly by `actions/accounts.ts`'s manual Add Account path outside any
   transaction. Making it transaction-aware means either overloading it to
   accept an optional `Prisma.TransactionClient` parameter (threaded through
   both callers) or forking a transactional variant — either way it's a
   real API change to a shared, already-tested module, not a contained fix.
3. **The existing guard already makes retries safe, matching the tester's
   own assessment.** The `alreadyMapped` check (re-queries by
   `plaidAccountId` before each row's create) means a retried submission
   after a partial failure won't double-create the rows that already
   succeeded — it'll just skip them via the "already mapped" error message
   for that specific plaidAccountId, and the still-pending rows will
   proceed normally. Combined with the fact that this app is single-
   household/low-concurrency (not a high-traffic multi-tenant SaaS), the
   confusion this could cause (owner sees a generic error, doesn't
   immediately know an earlier row already succeeded) is real but small,
   and fixing it properly deserves a dedicated, reviewed change to
   `lib/institutions.ts`'s contract rather than a same-day bolt-on.

Judgment: **left as-is.** This matches the test report's own conclusion
("not required to reach PASS... this Coder judges genuinely low-risk").
If the owner wants this hardened, it should be a small follow-up task
scoped specifically to add transactional support to
`resolveOrCreateInstitution` and `createAccountsFromPlaidMapping` together,
reviewed on its own.

### Commands run and their results

- `pnpm typecheck` — **initially failed** with two `TS2307` errors in
  `.next/types/app/api/cron/testthrow123/route.ts`, referencing a module
  that no longer exists. This is a stale generated Next.js type-checking
  artifact left over from the Tester's temporary throwing route (source
  file was correctly deleted per the test report, but the corresponding
  entry under the gitignored `.next/types/` build-cache directory wasn't
  regenerated). Deleted the stale `.next/types/app/api/cron/testthrow123/`
  directory (build cache, not source — confirmed via `git status` that
  nothing tracked was touched) and reran: clean, no errors, exit 0.
- `pnpm lint` — 0 errors, 47 warnings, identical set/count to the test
  report's baseline; none in `app/api/plaid/confirm-mapping/route.ts` or any
  file this fix round touched.
- `pnpm test` (`vitest run`, full suite) — 573/573 passed across 48 files,
  identical to the pre-fix baseline (no test file was added or changed this
  round — the fix is purely error-handling control flow in an
  already-covered-by-integration-trace route; this repo has no
  `app/api/**/__tests__` precedent per the test report's own note).
- `git status --short` after all changes — only
  `app/api/plaid/confirm-mapping/route.ts` differs from the pre-fix-round
  diff set; no stray files.

### Open items

Unchanged from the original implementation doc's Open items, plus:

- The `$transaction`-atomicity hardening described above remains an
  optional, not-yet-scheduled follow-up — not a defect in what shipped.
- Live browser click-through verification (duplicate-nickname collision
  actually showing the intended message in the UI, not just the route-level
  fix) is still unverified by this role — no browser tool or app
  credentials available to the Coder subagent.
