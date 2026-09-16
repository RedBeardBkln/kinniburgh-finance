# Plan: account-creation-gap-fix

## Restated goal

Both ways of adding a bank/loan account today can only *map onto* a pre-seeded
`Institution`/`Account` — neither the manual "Add Account" form nor the Plaid
"Connect Bank" mapping step lets the owner register a genuinely new
institution/account. Fix both gaps, and give the owner a way to finish
mapping the CorePlus Credit Union `PlaidItem` that already exists in
production with zero linked `Account` rows.

## Scope

**In scope:**
1. Manual "Add Account" form (`components/accounts/accounts-page-client.tsx` →
   `actions/accounts.ts#createAccount`) — add an inline "create new
   institution" path.
2. Plaid mapping step (`app/accounts/connect/connect-client.tsx` →
   `app/api/plaid/confirm-mapping/route.ts`) — add a real "Create new account"
   choice per unmatched Plaid account, which creates both the `Account` and
   (if needed) the `Institution` row, wires `plaidItemId`/`plaidAccountId`,
   and triggers an immediate `syncPlaidTransactions`.
3. A way to resume mapping for a `PlaidItem` that already has a valid,
   encrypted access token but zero `Account` rows (CorePlus's exact current
   state) — investigated below, resolved as a new lightweight
   "Accounts pending mapping" affordance on `/accounts`, not a Plaid-Link
   resume.
4. Small shared-constant/helper extractions needed to support the above
   without duplicating logic (`ACCOUNT_TYPE` list, a Plaid
   subtype→`accountType` inference function, an institution
   find-or-create resolver).
5. A narrow, explicitly-flagged loosening of one existing guard in
   `app/api/plaid/link-token/route.ts` (see Approach step 7) so a
   re-link fallback isn't itself blocked for a zero-account item.

**Out of scope (explicitly not touched):**
- Actually creating the real CorePlus loan account with real dollar figures —
  the owner does that himself post-ship, through the UI this task builds. No
  seed data, placeholder balances, or account numbers are invented here.
- Any schema migration — `Institution`/`Account`/`PlaidItem` already carry
  every field needed (confirmed by reading `prisma/schema.prisma`).
- Fixing the pre-existing gap where `confirm-mapping/route.ts`'s *existing*-
  account mapping path (`ourAccountId`) never checks whether that account is
  already claimed by a different `plaidItemId`/`plaidAccountId` — this bug
  predates this task and isn't part of the reported failure; flagged as a
  risk below, not fixed here, to keep this change reviewable.
- `app/api/plaid/webhook/route.ts` and `update-webhooks/route.ts` — unrelated
  to account creation, not read in depth, not touched.
- Any change to `syncPlaidTransactions` itself — reused as-is per the task's
  own instruction.

## Affected files/modules

New files:
- `lib/account-types.ts` — shared `ACCOUNT_TYPE_VALUES` (zod-enum tuple) +
  `ACCOUNT_TYPE_OPTIONS` (value/label pairs for `<select>`s), replacing the
  two independent copies currently living in `actions/accounts.ts` and
  `components/accounts/accounts-page-client.tsx`.
- `lib/plaid-account-type.ts` — pure `inferAccountTypeFromPlaid(type, subtype)`
  returning an `AccountType`, used to default (not force) the account-type
  field when creating a new account from a Plaid mapping row.
- `lib/institutions.ts` — pure `normalizeInstitutionName(name)` (trim/collapse
  whitespace/casefold, for matching) + DB-aware
  `resolveOrCreateInstitution(rawName, plaidFields?)` (case-insensitive
  find-or-create against `Institution.name`).
- `lib/plaid-mapping.ts` — DB+Plaid-aware:
  - `getPlaidAccountSuggestions(accessToken)`: the existing
    match-by-mask-against-seeded-accounts logic currently inlined in
    `exchange/route.ts`, extracted so both `exchange/route.ts` and the new
    pending-mapping route can share it. Returns suggestions including Plaid's
    `type` (currently missing — only `subtype` is threaded today).
  - `createAccountsFromPlaidMapping(itemId, newAccounts)`: resolves/creates
    the `Institution` from the `PlaidItem`'s stored `institutionName`/
    `institutionId`, then `db.account.create()`s each requested new account
    wired to `plaidItemId`/`plaidAccountId`, with a defensive check that no
    existing non-archived `Account` already holds that `plaidAccountId`
    (see Risks).
- `app/api/plaid/pending-accounts/[itemId]/route.ts` — new `GET` route,
  `requireAuth`-gated: given an `itemId` for an existing `PlaidItem`,
  decrypts its stored access token, calls `getPlaidAccountSuggestions`, and
  returns `{ itemId, institutionName, suggestions }` — the "resume mapping
  without going through Plaid Link again" endpoint. On `ITEM_LOGIN_REQUIRED`,
  marks the item `status: "requires_login"` (matching `lib/plaid-sync.ts`'s
  existing error-handling pattern) and returns a structured error the client
  can use to offer the Link-based re-auth fallback instead.
- `lib/__tests__/plaid-account-type.test.ts`, `lib/__tests__/institutions.test.ts`
  — new unit tests for the two pure functions above.

Edited files:
- `components/accounts/accounts-page-client.tsx` — Institution `<select>`
  gains a `"+ Add new institution…"` sentinel option that reveals a text
  input (`newInstitutionName`); submit sends either `institutionId` or
  `newInstitutionName` to `createAccount`. Local `ACCOUNT_TYPES` replaced
  with the shared `ACCOUNT_TYPE_OPTIONS` import. New prop
  `pendingPlaidItems` renders an "Accounts pending mapping" banner above the
  per-entity tables.
- `app/accounts/page.tsx` — fetches `db.plaidItem.findMany({ where: {
  accounts: { none: { archivedAt: null } } } })` alongside the existing three
  queries, serializes, and passes to `AccountsPageClient` as
  `pendingPlaidItems`.
- `actions/accounts.ts` — `createAccountSchema` becomes a discriminated
  union / refined schema accepting `institutionId` (existing uuid path) OR
  `newInstitutionName` (new path); on the new path calls
  `resolveOrCreateInstitution` before creating the `Account`. Local
  `ACCOUNT_TYPES` const replaced with the shared `ACCOUNT_TYPE_VALUES` import.
- `app/api/plaid/exchange/route.ts` — suggestion-building logic (lines ~57-76)
  replaced with a call to `lib/plaid-mapping.ts#getPlaidAccountSuggestions`.
- `app/api/plaid/confirm-mapping/route.ts` — zod schema gains an optional
  `newAccounts: [{ plaidAccountId, entityId, nickname, accountType, mask? }]`
  array; before the existing `mappings.map(db.account.update)` block, calls
  `createAccountsFromPlaidMapping(itemId, newAccounts)`. `syncPlaidTransactions`
  (already called at the end) now also covers the newly created accounts
  since they're wired before that call runs.
- `app/accounts/connect/connect-client.tsx` — per-mapping-row state changes
  from a plain `Record<string, string>` (accountId or "") to a richer
  per-row choice (`existing` / `new` / `skip`, see Approach step 5). Adds a
  `resumeItemId` search-param branch that skips the "link" step entirely and
  calls the new pending-accounts route instead of `/api/plaid/exchange`.
  `Suggestion` interface gains `type` (Plaid's high-level account type,
  currently dropped). Fetches `entities` (already returned by
  `/api/form-data`, currently ignored) alongside `allAccounts`.
- `app/api/plaid/link-token/route.ts` — drops the `plaidItem.accounts.length
  === 0` → 404 guard in the `itemId` (update-mode) branch, keeping only the
  "item must exist" check (see Approach step 7 for why).

## Approach

1. **Extract shared account-type constants** into `lib/account-types.ts`
   (`ACCOUNT_TYPE_VALUES` as-const tuple + `ACCOUNT_TYPE_OPTIONS` label
   pairs, values unchanged: checking/savings/credit_card/mortgage/loan/
   investment/insurance). Update `actions/accounts.ts` and
   `accounts-page-client.tsx` to import from it instead of defining their own
   copies. Pure rename/re-export — no behavior change. Run `pnpm typecheck`
   after this step alone before continuing, to isolate any fallout.

2. **Write `lib/plaid-account-type.ts#inferAccountTypeFromPlaid(type, subtype)`**
   — pure function, case-insensitive on both inputs, returns the shared
   `AccountType`. Suggested mapping (Coder should sanity-check against
   Plaid's documented type/subtype enum, not just this list): `subtype ===
   "mortgage"` → `mortgage`; `type === "loan"` or subtype contains "loan"/
   "student"/"line of credit" → `loan`; `type === "credit"` or `subtype ===
   "credit card"` → `credit_card`; `subtype` in `savings`/`cd`/`money market`
   → `savings`; `type === "investment"` (or `"brokerage"`) → `investment`;
   `type === "depository"` (anything else, e.g. checking/HSA/cash management)
   → `checking`; anything unrecognized → `checking` (a safe default since
   the UI always lets the owner override it before submit — never silently
   final). Write `lib/__tests__/plaid-account-type.test.ts` covering each
   branch plus at least one unrecognized-input case.

3. **Write `lib/institutions.ts`.** `normalizeInstitutionName(name)`: trim,
   collapse internal whitespace, lowercase — pure, tested directly (empty
   string, extra internal spaces, mixed case, leading/trailing whitespace).
   `resolveOrCreateInstitution(rawName, plaidFields?)`: DB-aware (not unit
   tested directly, per this repo's established convention — see memory).
   Trims `rawName`; throws if empty after trimming. Looks up
   `db.institution.findFirst({ where: { name: { equals: trimmed, mode:
   "insensitive" } } })` (Postgres supports `mode: "insensitive"` — confirm
   this compiles against the installed Prisma version during
   `pnpm typecheck`, don't assume). If found, optionally backfills
   `plaidInstitutionId`/`plaidCoverageNotes` when they're currently null and
   `plaidFields` supplies them (harmless for the manual-entry caller, which
   passes no `plaidFields`). If not found, creates a new `Institution` with
   the as-typed (trimmed) name.

4. **Manual Add Account form.** In `accounts-page-client.tsx`'s
   `AccountModal`, add a sentinel `"__new__"` option to the Institution
   `<select>` (e.g. `"+ Add new institution…"` as the last `<option>`). Track
   a small local `useState` for "showing new-institution input" toggled by
   `onChange` on that select; when active, render a text `<input
   name="newInstitutionName" required>` in place of (or alongside, with a
   "‹ choose existing instead" toggle back to the select) the institution
   picker. On submit, build the `createAccount` payload with either
   `institutionId` (existing path, unchanged) or `newInstitutionName` (new
   path) — never both. In `actions/accounts.ts`, change
   `createAccountSchema` to a `z.union` or `.refine()`-based schema requiring
   exactly one of `institutionId` (uuid) / `newInstitutionName` (string,
   1–200 chars, trimmed non-empty). In `createAccount`, when
   `newInstitutionName` is present, call `resolveOrCreateInstitution` first
   to get the `institutionId`, then proceed with the existing
   `db.account.create` call unchanged (still `integrationMode:
   "manual_entry"`).

5. **Plaid mapping step — per-row "create new account" choice.** In
   `connect-client.tsx`, replace `mappings: Record<string, string>` with a
   richer per-row type, e.g.:
   ```ts
   type RowChoice =
     | { kind: "skip" }
     | { kind: "existing"; accountId: string }
     | { kind: "new"; entityId: string; nickname: string; accountType: string };
   ```
   keyed by `plaidAccountId` in a `Record<string, RowChoice>`. Add a
   `"__create_new__"` sentinel to each row's `<select>` (after the seeded
   accounts, before or after "(skip this account)" — Coder's call on
   ordering). When a row is in `"new"` mode, render inline fields directly in
   that table row (or an expanded sub-row): Entity `<select>` (options from
   the newly-fetched `entities` list, required), Nickname `<input>`
   (`defaultValue` = the Plaid account's own `name`, editable, required),
   Account Type `<select>` (options from `ACCOUNT_TYPE_OPTIONS`,
   `defaultValue` from `inferAccountTypeFromPlaid(s.type, s.subtype)`,
   editable). Import `inferAccountTypeFromPlaid` and `ACCOUNT_TYPE_OPTIONS`
   directly into this client component (both are plain `lib/` functions with
   no DB access — confirmed-safe pattern per this repo's existing
   client-importing-pure-lib-helpers precedent). Also thread `entities` out
   of the existing `/api/form-data` fetch (already returns `entities`,
   currently discarded) into a new `entities` state array.

6. **`confirm-mapping/route.ts` — accept and act on new-account rows.**
   Extend the zod schema:
   ```ts
   mappings: z.array(z.object({ plaidAccountId: z.string(), ourAccountId: z.string().uuid() })).default([]),
   newAccounts: z.array(z.object({
     plaidAccountId: z.string(),
     entityId: z.string().uuid(),
     nickname: z.string().min(1).max(100),
     accountType: z.enum(ACCOUNT_TYPE_VALUES),
     mask: z.string().max(10).optional(),
   })).default([]),
   ```
   Before the existing `mappings.map(db.account.update)` block, call
   `createAccountsFromPlaidMapping(itemId, newAccounts)` from the new
   `lib/plaid-mapping.ts`. That function, per new-account entry, in a
   sequential loop (not `Promise.all` — avoids a race on
   first-institution-creation when multiple rows share the same
   `plaidItem.institutionName`, and gives cleaner per-row error attribution):
   - Re-checks (defensively) that no existing non-archived `Account` already
     has this `plaidAccountId` — if one does, throws a clear error rather
     than silently double-mapping (see Risks: this is the exact class of bug
     that orphaned CorePlus, worth guarding even though nothing in today's
     code path should trigger it if the UI is used as designed).
   - Calls `resolveOrCreateInstitution(plaidItem.institutionName, {
     plaidInstitutionId: plaidItem.institutionId, plaidCoverageNotes:
     "supported" })`. If `plaidItem.institutionName` is null/empty, throws a
     clear error instead of fabricating a name (ground rule 1) — flagged as
     a rare edge case in Risks, not expected to fire for CorePlus.
   - `db.account.create({ data: { institutionId, entityId, nickname, mask:
     mask ?? null, accountType, integrationMode: "plaid", plaidAccountId,
     plaidItemId: itemId } })`. If this throws Prisma's unique-constraint
     error (`@@unique([entityId, nickname])` collision), catch and rethrow a
     message like `"An account named "X" already exists for this entity —
     choose a different nickname."` so it surfaces cleanly to the owner
     rather than a raw Prisma error.
   Leave the existing "update Institution coverage notes from the first
   mapped account" block and the trailing `syncPlaidTransactions(itemId)`
   call as-is — both already run after account creation completes, so newly
   created accounts are included in the sync (per the task's explicit
   requirement).

7. **Resume path for the orphaned CorePlus item — investigated, decision
   below.** Two options were considered per the task prompt:
   - **(a) Let Plaid Link's existing update-mode re-link handle it.**
     Rejected as the primary path: `app/api/plaid/link-token/route.ts`
     currently 404s the `itemId` branch whenever `plaidItem.accounts.length
     === 0` — CorePlus's exact state — so update-mode Link can't even be
     opened for it today. More importantly, opening a *fresh* (non-update-mode)
     Link session for "CorePlus Credit Union" again risks Plaid creating a
     **second, separate** `PlaidItem`/access token for the same institution
     rather than reusing the orphaned one (Plaid doesn't dedupe fresh Link
     sessions against existing Items), which would leave the original item
     still orphaned and double the number of live bank connections/API
     usage for no reason. Not the right default entry point.
   - **(b) A lightweight "Accounts pending mapping" affordance that reuses
     the stored access token directly, skipping Link entirely.** Chosen.
     `PlaidItem.accessTokenEncrypted` is already valid for CorePlus (a sync
     already ran once) — there's no reason to re-authenticate through Plaid
     Link just to re-enter the mapping UI. Implemented as: `app/accounts/page.tsx`
     queries `PlaidItem`s with zero (non-archived) linked accounts, and
     `accounts-page-client.tsx` renders them as a dismissable-by-completion
     banner ("CorePlus Credit Union — connected but not finished. [Finish
     setup]"). The link goes to `/accounts/connect?resumeItemId=<itemId>`.
     In `connect-client.tsx`, a `resumeItemId` search param skips the "link"
     step's Plaid Link initialization entirely and instead calls the new
     `GET /api/plaid/pending-accounts/[itemId]` route on mount, populating
     `suggestions`/`itemId` and jumping straight to `step: "map"` — from
     there, everything from step 5/6 above applies identically (the mapping
     step doesn't know or care whether it got here via a fresh Link session
     or a resume).
   - **Necessary small side-effect of (b):** because a resumed item might
     have a genuinely expired/invalidated access token (Plaid access tokens
     aren't guaranteed to live forever, even if CorePlus's is fine today),
     `GET /api/plaid/pending-accounts/[itemId]` must handle
     `ITEM_LOGIN_REQUIRED` from `accountsGet` gracefully: mark the item
     `requires_login` (matching `lib/plaid-sync.ts`'s existing pattern) and
     return a structured error. The client then shows a fallback: "This
     connection needs to be re-authenticated first" with a link to the
     *existing* `/accounts/connect?itemId=<itemId>` update-mode Link flow —
     which is why the `link-token/route.ts` guard from option (a) must still
     be loosened (drop the `accounts.length === 0` check, keep only "item
     must exist") even though (b) is the primary path: it's the fallback's
     dependency. This is the one behavior change to an existing route beyond
     the core ask — flagged here explicitly rather than silently bundled in.

8. **Serialize and wire `pendingPlaidItems` through `app/accounts/page.tsx`**
   → `AccountsPageClient` (new prop: `{ itemId: string; institutionName:
   string | null; status: string; createdAt: string }[]`), rendered as a
   banner/card section above the per-entity account tables (only rendered
   when non-empty).

9. **Manual verification prep (no action needed from Coder beyond making it
   possible):** after this ships, the orchestrator will click through
   `/accounts` → see the CorePlus "Finish setup" banner → "create new
   account" → fill in Personal / a nickname / "loan" type → confirm → see it
   appear in the Personal accounts table with a live balance from the
   triggered sync. Make sure nothing in the flow requires seed data or
   hardcoded test values to reach that point.

10. Run `pnpm typecheck`, `pnpm lint`, and `pnpm test` (full suite) before
    handing off. No `pnpm db:generate`/`db:migrate`/`db:push` needed — no
    schema change.

## Risks/unknowns

- **`Institution.name` uniqueness + case-insensitive matching.** Prisma's
  `mode: "insensitive"` filter requires the `Prisma.QueryMode` import to be
  available/used correctly for this repo's Prisma version — verify it
  compiles cleanly rather than assuming; this repo's Postgres/Prisma
  combination should support it, but hasn't been confirmed by reading a
  prior call site (grepped — no existing `mode: "insensitive"` usage
  anywhere in the repo, so this is a first-of-its-kind query in this
  codebase; not risky to add, but nothing to copy from).
- **`Account.plaidAccountId` has no DB-level unique constraint** (confirmed
  by reading `prisma/schema.prisma`) — the defensive application-level check
  in `createAccountsFromPlaidMapping` (step 6) is a race-prone soft guard,
  not airtight (e.g. two near-simultaneous submits could both pass the
  check before either writes). Acceptable for this app's usage pattern (one
  household, one person submitting a given mapping form at a time) — flagged
  rather than solved with a migration, per the task's explicit
  no-migration constraint. A future task could add
  `@@unique([plaidItemId, plaidAccountId])` if this ever becomes a real
  problem.
- **`plaidItem.institutionName` could theoretically be null** for an item
  where Plaid never resolved an `institution_id` (rare, but `exchange/route.ts`
  already treats both as optional). `createAccountsFromPlaidMapping` throws
  rather than fabricating a name — means new-account creation would be
  blocked (with a clear error) for such an item until that's resolved some
  other way. Not expected to affect CorePlus (its `institutionName` is
  already confirmed populated), but worth the owner knowing this edge case
  exists.
- **Existing gap, not fixed here:** `confirm-mapping/route.ts`'s existing
  `mappings` (pick-an-existing-account) path has never checked whether the
  chosen `ourAccountId` is already `plaidItemId`-linked to a *different*
  item — theoretically lets one Account get remapped out from under an
  active connection. Pre-existing, out of this task's reported scope; flagged
  so it isn't mistaken for something this change was supposed to fix.
- **`link-token/route.ts` guard loosening (step 7)** is a real, if small,
  behavior change to an existing route not explicitly called out in the
  original bug report. Reviewed for safety in Approach step 7 — the route is
  already fully `auth()`-gated and the `itemId` must correspond to a real
  `PlaidItem` row either way, so this doesn't newly expose anything; flagged
  here per the task's own instruction to surface tradeoffs rather than
  silently picking.
- **No component/DOM test infrastructure exists in this repo** (confirmed —
  no jsdom/RTL, no `components/__tests__` anywhere) — the new
  `connect-client.tsx` and `accounts-page-client.tsx` UI logic (the
  create-new-account inline form, the pending-mapping banner) is verified
  only by `pnpm typecheck` plus the orchestrator's manual click-through, not
  by an automated component test. This matches every other client component
  in the app; not a gap specific to this task.
- **CorePlus's current live `PlaidItem.status`** is described as `"active"`
  in the task prompt (not re-queried by this planning pass — no DB read
  access was used here beyond the schema file). If it has since flipped to
  `requires_login` by the time this ships, the resume flow's fallback (step
  7) is exactly what handles that, so no plan change needed either way — but
  worth the Coder/Tester knowing the "happy path" resume (no re-auth needed)
  is the more likely outcome based on what's known now.

## Acceptance criteria

1. From `/accounts`, clicking "+ Add Account", selecting "+ Add new
   institution…", typing a brand-new name, filling the rest of the form, and
   submitting creates both a new `Institution` row (that name) and a new
   `Account` row (`integrationMode: "manual_entry"`) — without needing that
   institution to have been pre-seeded.
2. Submitting the manual form with an institution name that case-insensitively
   matches an existing `Institution` reuses that row rather than creating a
   duplicate.
3. On the Plaid mapping step (`/accounts/connect`, after a fresh Link
   session), each unmatched Plaid account row offers a working "Create new
   account" choice; selecting it and filling in entity/nickname/type and
   confirming creates a new `Account` wired to that `plaidAccountId`/
   `plaidItemId`, creates/reuses the `Institution` from the Plaid item's
   institution name, and the account's balance/transactions are populated
   immediately (via the triggered `syncPlaidTransactions`) rather than
   waiting for the next cron sync.
4. The account-type default shown for a newly-mapped Plaid account is a
   reasonable inference from Plaid's `type`/`subtype` and is editable before
   submit (never silently forced).
5. `/accounts` shows an "Accounts pending mapping" entry for any `PlaidItem`
   with zero currently-linked (non-archived) accounts; for the real CorePlus
   item, clicking through resumes directly into the mapping step (no second
   Plaid Link session, no duplicate `PlaidItem` created) and offers the same
   "Create new account" choice from #3.
6. If a resumed item's access token has actually expired, the flow surfaces
   a clear re-authentication path (via the existing Plaid Link update-mode
   flow) rather than failing silently or throwing an unhandled error.
7. Selecting an entity is required for both new-account paths — no code path
   defaults/guesses an entity for a Plaid-sourced account.
8. No access token, cursor, or full account number is ever logged (grep the
   diff for `console.log`/`console.error` calls touching any new variable
   holding a decrypted token before considering this done).
9. `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass with zero new
   failures.

## Test expectations

Unit tests (Vitest, `lib/__tests__/`, following this repo's pure-function-only
convention — no DB/component test infra to extend):
- `lib/__tests__/plaid-account-type.test.ts` — `inferAccountTypeFromPlaid`:
  one case per branch in step 2's mapping table (mortgage subtype → mortgage;
  loan type / student / line-of-credit subtype → loan; credit type / credit
  card subtype → credit_card; savings/cd/money market subtype → savings;
  investment/brokerage type → investment; depository type with an
  unenumerated subtype (e.g. "checking", "hsa") → checking; both inputs
  null/empty → checking fallback; case-insensitivity on both `type` and
  `subtype` inputs.
- `lib/__tests__/institutions.test.ts` — `normalizeInstitutionName` only
  (the DB-aware `resolveOrCreateInstitution` is intentionally not
  unit-tested, matching this repo's established DB-boundary-mocking
  convention): trims leading/trailing whitespace, collapses internal
  double-spaces to one, lowercases, empty-string input, a name that's
  already normalized (idempotent).

No new tests are expected for `actions/accounts.ts`, `confirm-mapping/route.ts`,
`exchange/route.ts`, or `pending-accounts/route.ts` — this repo has zero
`actions/__tests__` or `app/api/**/__tests__` precedent anywhere (DB-touching
route/action logic is verified by `pnpm typecheck` plus manual click-through
only, consistently across the whole codebase). Don't introduce a
first-of-its-kind test harness for these as part of this task.

Manual/click-through verification (the orchestrator will do this against
production post-review, not part of this task's automated test surface, but
the plan should result in something that supports it cleanly):
- Add-Account form: new-institution path end to end.
- Plaid mapping: create-new-account path for an unmatched account, for both
  a fresh Link session and the CorePlus resume path.
- Pending-mapping banner appears/disappears correctly as items go from
  zero-account to mapped.
- Re-auth fallback path, if CorePlus's token has expired by verification
  time.
