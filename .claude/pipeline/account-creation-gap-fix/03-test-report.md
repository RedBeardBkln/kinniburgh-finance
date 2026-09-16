# Test Report: account-creation-gap-fix

## Verdict: FAIL

One concrete, verified defect: `app/api/plaid/confirm-mapping/route.ts` has no
`try/catch` around `createAccountsFromPlaidMapping()`, so the "clear,
owner-facing error message" this task's plan explicitly designed (Approach
step 6) for duplicate-nickname and already-mapped-account collisions never
actually reaches the browser. Confirmed empirically (see Defects below):
Next.js 15 App Router returns an **empty-body HTTP 500** for an uncaught
throw in a Route Handler, which breaks `res.json()` client-side and surfaces
a garbled JSON-parse error instead of the intended message. All 9 acceptance
criteria and both new test files otherwise check out — see checklist.

## Acceptance criteria checklist

1. **Manual Add Account: new-institution path creates Institution + Account
   without pre-seeding.** PASS (code review). `actions/accounts.ts`'s
   `createAccountSchema` XOR-refines `institutionId`/`newInstitutionName`;
   `createAccount()` calls `resolveOrCreateInstitution(newInstitutionName)`
   then `db.account.create(..., integrationMode: "manual_entry")`. Not
   click-through verified (no browser/credentials available to this role —
   see Not tested).

2. **Case-insensitive institution-name reuse.** PASS.
   `lib/institutions.ts#resolveOrCreateInstitution` uses
   `db.institution.findFirst({ where: { name: { equals: trimmed, mode:
   Prisma.QueryMode.insensitive } } })` before creating — confirmed compiles
   (`pnpm typecheck` clean) and reads correctly. Only unit-tested indirectly
   via `normalizeInstitutionName`; the DB-aware resolver itself isn't unit
   tested (matches this repo's documented DB-boundary-mocking convention,
   and the plan explicitly scoped it out).

3. **Plaid mapping: "Create new account" choice creates Account + resolves
   Institution + triggers immediate sync.** PASS on the happy path (code
   review + trace): `connect-client.tsx`'s `CREATE_NEW_SENTINEL` row reveals
   Entity/Nickname/Type fields; `confirmMapping()` builds a `newAccounts`
   array and POSTs to `confirm-mapping/route.ts`, which calls
   `createAccountsFromPlaidMapping(itemId, newAccounts)` **before** the
   trailing `syncPlaidTransactions(itemId)` call — confirmed
   `syncPlaidTransactions` re-queries `db.account.findMany({ where: {
   plaidItemId: itemId } })` fresh at call time (`lib/plaid-sync.ts:152-155`),
   so newly created accounts are genuinely included in the same sync. FAILS
   on the error path — see Defects (the clear message this step was designed
   to produce doesn't reach the client).

4. **Account-type default is a reasonable, editable inference.** PASS.
   `inferAccountTypeFromPlaid` is a pure defaulting function only used as
   `defaultValue`; the row's Account Type `<select>` remains a normal
   controlled input the user can change before submit. 15 unit tests cover
   every branch including priority ordering (e.g. `type:"credit",
   subtype:"line of credit"` correctly resolves to `loan`, not
   `credit_card`, confirming the loan-branch-before-credit-branch ordering
   is real, not accidental).

5. **`/accounts` pending-mapping banner + CorePlus resume, no duplicate
   PlaidItem.** PASS (code review). `app/accounts/page.tsx` queries
   `db.plaidItem.findMany({ where: { accounts: { none: { archivedAt: null }
   } } } })` and passes to the client, which renders a "Finish setup" link
   to `/accounts/connect?resumeItemId=<itemId>`. `connect-client.tsx`'s
   `resumeItemId` branch skips Plaid Link entirely, calling `GET
   /api/plaid/pending-accounts/<itemId>` (reuses the stored access token, no
   new Link session, no new PlaidItem row created) and jumps straight to
   `step:"map"`. Not click-through verified against the live CorePlus item.

6. **Expired-token resume surfaces a clear re-auth path.** PASS (code
   review). `pending-accounts/[itemId]/route.ts` catches
   `ITEM_LOGIN_REQUIRED` from Plaid, marks the item `requires_login`
   (matching `lib/plaid-sync.ts`'s existing pattern), and returns a
   structured `{error, code: "ITEM_LOGIN_REQUIRED"}` (409) — this route DOES
   have a proper try/catch (unlike confirm-mapping, see Defects), so this
   message reaches the client correctly. `connect-client.tsx` reads
   `data.code === "ITEM_LOGIN_REQUIRED"`, sets `reauthItemId`, and renders a
   "Re-authenticate" card linking to `/accounts/connect?itemId=<itemId>`
   (the existing update-mode Link flow). Also verified the dependency this
   relies on: `link-token/route.ts`'s dropped zero-account guard (see
   criterion 7 reasoning below) — without that change this fallback would
   404 for CorePlus's exact state.

7. **Entity selection required, never defaulted, for both new-account
   paths.** PASS, verified server-side not just client-side.
   `actions/accounts.ts`: `entityId: z.string().uuid()` required
   unconditionally in `createAccountSchema` (not optional, not defaulted).
   `confirm-mapping/route.ts`: `newAccounts` array schema requires
   `entityId: z.string().uuid()` per row — an empty string from the client
   fails uuid validation and the whole POST 400s via `schema.parse()` inside
   `zod`'s own throw (note: this particular throw path is *before*
   `createAccountsFromPlaidMapping`, and Zod's `.parse()` throwing is also
   uncaught in this route — same missing-try/catch defect class, see
   Defects, though this specific case is redundant with the working
   client-side guard in `confirmMapping()` that already blocks empty
   `entityId`/`nickname` before the fetch fires). Client-side:
   `connect-client.tsx`'s `confirmMapping()` explicitly checks `if
   (!choice.entityId || !choice.nickname.trim())` and blocks submission with
   an inline message rather than defaulting anything.

8. **No access token/cursor/full account number ever logged.** PASS,
   verified directly by reading every new/changed log call, not just
   trusting the Coder's claim:
   - `lib/plaid-mapping.ts` — no `console.*` calls at all.
   - `app/api/plaid/pending-accounts/[itemId]/route.ts:55` —
     `console.error("[plaid/pending-accounts] failed", { itemId, code:
     plaidError?.error_code ?? null })` — only itemId + Plaid's error_code
     string, never `accessToken`.
   - `app/api/plaid/exchange/route.ts:22` — pre-existing, unchanged by this
     diff: `console.log("[plaid-exchange] token exchanged", { item_id,
     request_id })` — logs Plaid's own opaque `item_id`/`request_id`, never
     `access_token`.
   - `app/api/plaid/link-token/route.ts` — pre-existing `console.error`/
     `console.warn` calls log `{status, code, message}` from
     `plaidErrorMessage()`, never the decrypted `accessToken` variable
     introduced on the `itemId` branch this task touched.
   Confirmed: no defect here.

9. **`pnpm typecheck`, `pnpm lint`, `pnpm test` all pass with zero new
   failures.** PASS — reran independently, see Tests run below. Matches the
   Coder's reported results exactly.

## Tests run

All commands run fresh in this session (not reusing the Coder's report):

```
$ pnpm typecheck
$ tsc --noEmit
(clean, no output, exit 0)
```

```
$ pnpm lint
...
✖ 47 problems (0 errors, 47 warnings)
```
Manually cross-checked every warning's file path against `git status` — none
are in `lib/account-types.ts`, `lib/plaid-account-type.ts`,
`lib/institutions.ts`, `lib/plaid-mapping.ts`, `app/api/plaid/pending-accounts/`,
or any of the 7 edited files. All 47 are pre-existing, in untouched files
(`components/offline-indicator.tsx`, `components/vault/*`,
`prisma/seed.ts`, etc.) — confirms the Coder's claim.

```
$ pnpm test
 Test Files  48 passed (48)
      Tests  573 passed (573)
```
Includes the two new files: `lib/__tests__/plaid-account-type.test.ts` (15
tests) and `lib/__tests__/institutions.test.ts` (6 tests).

Live empirical verification of the Route Handler error-handling defect (see
Defects below) — ran `pnpm dev` locally, added a temporary throwing route
handler under the public `/api/cron/` prefix (middleware-exempt, so
reachable without a session cookie), confirmed the actual HTTP response
shape for an uncaught throw, then deleted the temp file and killed the dev
server before finishing (confirmed via `git status --short` that no test
artifacts remain — output matches the pre-session snapshot exactly).

```
$ curl -s -i http://localhost:3002/api/cron/testthrow123
HTTP/1.1 500 Internal Server Error
(no Content-Type, empty body — confirmed via `curl -s ... | wc -c` = 0)
```

`npx next build` was not independently rerun in this session (the Coder's
reported successful build plus a clean `pnpm typecheck`/`pnpm lint` pass
across the exact same source tree gives high confidence it's unaffected;
rerunning it risked colliding with this repo's known Windows
Prisma-generate DLL-lock issue for marginal additional signal — see memory).

## Tests added

None. Coverage for the two new pure functions
(`inferAccountTypeFromPlaid`, `normalizeInstitutionName`) was already
comprehensive per the plan's own Test expectations section — verified by
reading both test files line-by-line against the plan's specified case list
(every branch, case-insensitivity, empty/null fallback, idempotency,
whitespace-only input) and confirming each listed case is actually present,
not just counted. No gap found worth extending with a DB-touching route
test, since this repo has zero `app/api/**/__tests__` precedent and the
plan explicitly scoped that out.

## Defects found

### 1. `confirm-mapping/route.ts` swallows its own designed-in clear error messages (Medium)

**Repro steps:**
1. In the Plaid mapping step, mark a row "+ Create new account…" and submit
   a `nickname` that already exists for the chosen `entityId` (collides with
   `@@unique([entityId, nickname])`), OR submit the same `plaidAccountId`
   twice in one session (triggers the `alreadyMapped` guard in
   `lib/plaid-mapping.ts`).
2. `createAccountsFromPlaidMapping()` throws a plain `Error` with a deliberately
   clear message (e.g. `An account named "X" already exists for this entity —
   choose a different nickname.`), per `lib/plaid-mapping.ts:107-127` and the
   plan's Approach step 6 / implementation doc's explicit claim that this
   "surfaces cleanly to the owner rather than a raw Prisma error."
3. `app/api/plaid/confirm-mapping/route.ts` has **no `try/catch`** anywhere
   in the file (confirmed by `grep -n "try\|catch"` returning nothing) — the
   thrown error is never converted into a `NextResponse.json({error: ...})`.
4. Verified empirically (not just by reading Next.js docs) what actually
   happens: an uncaught throw in a Next.js 15 App Router Route Handler
   returns `HTTP/1.1 500 Internal Server Error` with a **completely empty
   body** (`curl -s ... | wc -c` → `0`), not JSON, not the thrown message.
5. Client-side, `connect-client.tsx#confirmMapping()` does:
   ```ts
   const res = await fetch("/api/plaid/confirm-mapping", ...);
   const data = (await res.json()) as { synced?: number; error?: string };
   ```
   `res.json()` on an empty body throws a `SyntaxError` ("Unexpected end of
   JSON input"), which is caught by the surrounding `catch (err)` and shown
   to the owner via `setError(err.message)` — producing a generic JSON-parse
   error message instead of the intended
   `An account named "X" already exists for this entity — choose a different
   nickname.` text.

**Expected:** the owner sees the specific, actionable message the Coder
wrote for exactly this situation.
**Actual:** the owner sees a garbled/generic JSON-parsing error with no
indication of what went wrong or how to fix it.

**Severity:** Medium. Doesn't block the happy path (AC3/AC5 pass as
designed), and the underlying operation still correctly refuses to
double-create anything — but it directly undermines the specific, deliberate
design goal of plan Approach step 6 ("surfaces cleanly ... rather than a raw
Prisma error"), for realistic scenarios (duplicate nickname, accidental
double-submit) in a feature whose whole purpose is unblocking a real,
production, owner-facing account-creation flow. A secondary, related
consequence: because `createAccountsFromPlaidMapping`'s per-row loop isn't
wrapped in a `db.$transaction` and isn't atomic across multiple new-account
rows in one submission, a 2nd-row failure leaves the 1st row's `Account`
already created in the DB while the client shows a generic failure with no
indication anything succeeded — not data-corrupting (the `alreadyMapped`
guard prevents a literal duplicate on retry), but confusing enough that the
owner could reasonably believe the whole submission failed and needs
attention. This is a real gap in the exact code path this task added, not a
pre-existing issue — worth a small, well-scoped fix (wrap the route body in
try/catch, mirroring the pattern `pending-accounts/[itemId]/route.ts`
already uses correctly).

### Note (not a blocking defect): same class of gap pre-exists elsewhere, untouched by this task
`app/api/plaid/exchange/route.ts` (pre-existing, only its suggestion-building
block was touched by this task) also has no top-level try/catch around its
Plaid API calls — any Plaid failure there (e.g. `itemPublicTokenExchange`
throwing) hits the same empty-500 failure mode. Flagged for awareness only;
out of this task's scope since it wasn't part of the diff's new logic and
isn't part of the reported bug.

## Not tested

- **Live browser click-through** for all 4 manual-verification items the
  plan explicitly deferred to the orchestrator (new-institution manual add,
  Plaid mapping create-new-account for both fresh-Link and CorePlus-resume,
  pending-mapping banner appear/disappear, re-auth fallback against a truly
  expired token) — no browser tool or app login credentials available in
  this role, consistent with the plan's own scoping and prior Coder's
  identical limitation. Everything in this report from those flows is
  code-review + static trace + the one live HTTP-level check described
  above (the error-handling defect), not an actual UI click-through.
- **`resolveOrCreateInstitution`'s live DB race condition** described in the
  plan's own Risks section (two near-simultaneous submits of a new,
  differently-cased institution name could both pass the case-insensitive
  `findFirst` check and create two `Institution` rows with different
  casing, since `Institution.name`'s DB-level `@unique` constraint is
  case-sensitive) — theoretical, not reproduced; the plan already flagged
  this as an accepted risk for this app's single-household usage pattern,
  not something to block on.
- **`npx next build`** was not independently rerun this session (see Tests
  run — judgment call given typecheck/lint were both clean against the
  identical source and rerunning risked the known Windows Prisma-DLL-lock
  flakiness for no new signal).
- **Production-mode Server Action error-message redaction** — Next.js
  redacts thrown-error messages sent to the client from Server Actions by
  default in production builds (different mechanism than Route Handlers,
  not verified live this session). If this repo's Server Actions rely on
  `err.message` reaching the client in production the same way it does in
  dev, `actions/accounts.ts#createAccount`'s new
  XOR-validation/resolveOrCreateInstitution error messages could have the
  same "message doesn't reach the owner" problem as Defect #1 above — but
  this would be a pre-existing, repo-wide pattern (71 `throw new Error(...)`
  call sites across 38 files in `actions/`, not something this task
  introduced), so not flagged as a blocking defect specific to this task.
  Worth a dedicated investigation outside this pipeline if it isn't already
  understood.

---

## Round 2 (2026-09-16): re-verify fix for Defect #1

### Verdict: PASS

The one required (Medium) defect from Round 1 — `confirm-mapping/route.ts`
swallowing its designed-in clear error messages behind an empty-body 500 — is
confirmed fixed by direct code reading, not just by trusting the Coder's
implementation-doc claim. `pnpm typecheck`/`pnpm lint`/`pnpm test` all rerun
fresh and match baseline exactly. One new, non-blocking observation found
during re-verification (see below) — does not reach the FAIL bar.

### 1. try/catch coverage — confirmed complete

Read `app/api/plaid/confirm-mapping/route.ts` in full (reproduced below for
the record). The `try` block now opens right after the auth check (line 30)
and closes with a `catch` (line 81) that runs for every throw site inside it:

```
30  try {
31    const body = schema.parse(await req.json());              // zod ParseError
...
34    const plaidItem = await db.plaidItem.findUnique(...)       // (early return, not a throw)
42    await createAccountsFromPlaidMapping(itemId, newAccounts); // alreadyMapped / no-institution-name / P2002-duplicate-nickname throws
45    await Promise.all(mappings.map(... db.account.update ...)) // Prisma throws (bad ourAccountId, etc.)
60-75 db.institution.update(...)                                 // Institution coverage-notes update
78    const {...} = await syncPlaidTransactions(itemId);          // Plaid API throws (ITEM_LOGIN_REQUIRED, etc.)
80    return NextResponse.json({...})
81  } catch (err) {
87    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
91  }
```

Every throw site I identified in the Round 1 report is inside the `try`.
Confirmed the specific Round 1 repro is fixed: `createAccountsFromPlaidMapping`'s
`new Error("An account named \"X\" already exists...")` and
`new Error("An account is already mapped to Plaid account...")` are both
plain `Error` instances, so `err instanceof Error` is true and `err.message`
gives back the exact clear, owner-facing text the plan designed — it now
reaches the client as JSON (`res.json()` in `connect-client.tsx#confirmMapping()`
will parse successfully instead of throwing "Unexpected end of JSON input" on
an empty body). This is a genuine, verified fix, not just a plausible-looking
diff.

### 2. `pnpm typecheck` / `pnpm lint` / `pnpm test` — rerun fresh, match baseline

```
$ pnpm typecheck
$ tsc --noEmit
(clean, no output, exit 0)
```

```
$ pnpm lint
...
✖ 47 problems (0 errors, 47 warnings)
```
Same 47 warnings, same files (`lib/__tests__/forecast.test.ts`,
`lib/encrypt.ts`, `lib/plaid-sync.ts`, `lib/transfer-match-runner.ts`,
`prisma/seed.ts`) — none in any file this round touched.

```
$ pnpm test
 Test Files  48 passed (48)
      Tests  573 passed (573)
```
Identical counts to the Round 1 baseline (no test files added/changed this
round — expected, since the fix is pure control-flow in an already-covered
route with no repo precedent for route-level tests).

I did not rebuild the temporary-throwing-route empirical HTTP check from
Round 1 — the mechanism that broke last time (an *uncaught* throw producing
an empty-body 500) is fundamentally different from a `try/catch` correctly
converting a caught error into `NextResponse.json(...)`, which is ordinary,
well-understood Next.js Route Handler behavior with no framework-specific
gotcha to re-verify empirically. Code reading is sufficient evidence here.

### 3. `git status --short` — only expected file changed

```
 M actions/accounts.ts
 M app/accounts/connect/connect-client.tsx
 M app/accounts/page.tsx
 M app/api/plaid/confirm-mapping/route.ts
 M app/api/plaid/exchange/route.ts
 M app/api/plaid/link-token/route.ts
 M components/accounts/accounts-page-client.tsx
?? app/api/plaid/pending-accounts/
?? lib/__tests__/institutions.test.ts
?? lib/__tests__/plaid-account-type.test.ts
?? lib/account-types.ts
?? lib/institutions.ts
?? lib/plaid-account-type.ts
?? lib/plaid-mapping.ts
```
(plus unrelated pre-existing `.claude/`/other-task noise already present at
session start — not this task's). Identical to the Round 1 file set;
`confirm-mapping/route.ts` was already modified in Round 1's diff (it's where
the `newAccounts` schema/call-site lives) and is exactly the file the Round 2
fix touched further — no stray new files, no unexpected file left modified.

### 4. New observation (non-blocking): the blanket catch conflates genuine third-party/server failures with client-correctable ones

While specifically checking "could a genuine unexpected server error now get
miscategorized as a 400?" (per this round's explicit instruction), I traced
every throw path inside the new `try` block and found one real, if lower-severity, gap:

**The last statement inside `try` is `await syncPlaidTransactions(itemId)`**
(`app/api/plaid/confirm-mapping/route.ts:78`), which internally calls Plaid's
`transactionsSync` (`lib/plaid-sync.ts:165-178`). On any Plaid API failure —
including `ITEM_LOGIN_REQUIRED` (token expired between the mapping page load
and this submit) — `plaid-sync.ts` correctly updates the `PlaidItem.status`
(`requires_login` or `error`) but then **rethrows the raw Plaid/axios error
unchanged** (`lib/plaid-sync.ts:177`, `throw err`). That raw error now
propagates up into `confirm-mapping/route.ts`'s new catch-all, which treats
it identically to a client-input validation error: `err instanceof Error`
is true for an axios error too, so it becomes
`NextResponse.json({ error: err.message }, { status: 400 })` — where
`err.message` is a generic axios string like `"Request failed with status
code 400"`, not the specific, actionable `ITEM_LOGIN_REQUIRED` message the
sibling `app/api/plaid/pending-accounts/[itemId]/route.ts` deliberately
extracts and returns as `{ error, code: "ITEM_LOGIN_REQUIRED" }` with status
`409` (confirmed by direct comparison of the two files' catch blocks — see
`pending-accounts/[itemId]/route.ts:39-59`).

**Concrete consequence:** if a mapping submission's account-creation and
`mappings`/Institution updates all succeed, but the trailing sync fails
because the item needs re-authentication, the owner sees a *misleading*
generic-looking "error" with a 400 status (implying "you did something
wrong, fix your input") even though (a) their new account(s) were actually
created successfully in the DB, and (b) the real issue is a re-auth need,
not fixable by resubmitting the mapping form — `connect-client.tsx` has no
code path that recognizes this response shape as an `ITEM_LOGIN_REQUIRED`
case (it only checks for that `code` in the separate
`pending-accounts` GET response, not in `confirmMapping()`'s POST response
handling), so no re-auth banner is offered here the way it is on the resume
path.

**Severity: Low, non-blocking.** Reasoning:
- It does not regress or reopen the Round 1 defect — the specific repro
  (duplicate nickname / already-mapped) is fixed and verified above.
- It's strictly better than the pre-fix state (a real JSON body and status
  code now return, vs. an empty crashing 500 before).
- It's a narrower edge case (Plaid token expiring in the specific window
  between the mapping-step page load and form submit) than the originally
  reported, always-reproducible defect.
- No acceptance criterion explicitly requires `confirm-mapping` (as opposed
  to the `pending-accounts` resume GET, which AC6 does explicitly cover and
  which already handles this correctly) to distinguish sync-time
  re-auth-needed failures with a structured code.
- Underlying data integrity is unaffected — no double-creation, no silent
  data loss; only the error message/status-code precision and the missing
  re-auth-banner trigger on this specific path are imprecise.

Flagging this as a **follow-up recommendation, not a blocking defect**:
`confirm-mapping/route.ts`'s catch block could mirror
`pending-accounts/[itemId]/route.ts`'s pattern (inspect
`err.response?.data?.error_code` for `ITEM_LOGIN_REQUIRED` and return 409
with `code`, falling back to 500 — not 400 — for any other non-Zod,
non-`Error`-with-a-deliberately-thrown-message case) if the owner wants this
tightened. Given this task's own framing ("treat leaving [the optional
hardening item] undone as acceptable unless you find a concrete reason it
isn't"), I judge this concrete-but-narrow gap as informative rather than
blocking — it doesn't undermine the specific defect this round was scoped to
fix.

### Round 2 final verdict: PASS

All Round 1 acceptance-criteria findings stand (8/9 were already PASS; the
one FAIL — criterion 3's error path — is now fixed and verified). Typecheck/
lint/test all pass fresh, matching baseline exactly. `git status` shows only
the expected file changed. The one new observation (blanket 400 for
sync-time Plaid failures) is real but low-severity, narrow-scope, and
non-data-corrupting — logged as a follow-up recommendation, not a blocker.
Proceeding to Reviewer.
