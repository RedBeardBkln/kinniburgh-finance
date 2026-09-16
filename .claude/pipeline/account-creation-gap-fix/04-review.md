# Review: account-creation-gap-fix

## Verdict: APPROVED

## Summary

Read the request, plan, implementation doc (incl. Fix round 2), and test
report (incl. Round 2, PASS) in full, then independently re-verified against
the actual diff rather than trusting the summaries:

- `git diff --stat` against the working tree matches the plan's "Affected
  files/modules" list exactly — no scope creep, no unplanned files touched.
- Reran `pnpm typecheck` (clean, 0 errors) and `pnpm test` (573/573 passed,
  48 files, matching both the Coder's and Tester's reported counts) myself.
- Read every new/changed file in full: `lib/account-types.ts`,
  `lib/plaid-account-type.ts`, `lib/institutions.ts`, `lib/plaid-mapping.ts`,
  `app/api/plaid/pending-accounts/[itemId]/route.ts`, the diffs for
  `actions/accounts.ts`, `app/api/plaid/confirm-mapping/route.ts`,
  `app/api/plaid/exchange/route.ts`, `app/api/plaid/link-token/route.ts`,
  `app/accounts/page.tsx`, `app/accounts/connect/connect-client.tsx`,
  `components/accounts/accounts-page-client.tsx`, and both new test files.
- Confirmed `Account.plaidAccountId` genuinely has no DB-level unique
  constraint (`prisma/schema.prisma:108-138`) — matches the plan's/Tester's
  claim, not just repeated from the write-up.
- Confirmed `auth()` gates `confirm-mapping/route.ts` (line 25) and
  `pending-accounts/[itemId]/route.ts` (lines 18-19); grepped
  `lib/plaid-mapping.ts` for `console.*` — zero calls, so no path there can
  log a token even accidentally. `pending-accounts` logs only `itemId` +
  Plaid's `error_code` string.

## No live browser click-through — explicitly noted, not a gap I'm holding against this review

Neither the Coder nor the Tester had browser tooling or app credentials in
this pipeline (confirmed true here too — I don't have it either). All 9
acceptance criteria are verified by direct code reading/tracing plus the
one live HTTP-level check the Tester ran (the Round-1 empty-500 repro). This
is a known, accepted gap for this pipeline per the task framing — the
orchestrator verifies the actual UI flows against production separately,
post-approval. Noting it here for the record, not as a blocker.

## The one flagged issue: confirm-mapping's blanket catch (my call — not blocking)

Confirmed by direct diff reading: `app/api/plaid/confirm-mapping/route.ts`'s
new `catch (err)` block converts *every* thrown error inside the `try` —
including a raw Plaid/axios error rethrown unchanged by
`syncPlaidTransactions()` (`lib/plaid-sync.ts:177`, e.g. on
`ITEM_LOGIN_REQUIRED`) — into a generic
`NextResponse.json({ error: err.message }, { status: 400 })`. The sibling
`pending-accounts/[itemId]/route.ts` structurally distinguishes this case
(inspects `err.response?.data?.error_code`, returns a dedicated `409` with
`code: "ITEM_LOGIN_REQUIRED"` the client recognizes) — `confirm-mapping`
does not, so a token that expires in the narrow window between the mapping
page loading and the owner clicking "Confirm & sync" surfaces as a
misleading generic 400 instead of triggering the same re-auth banner the
resume path already has.

**My call: acceptable to ship as-is, logged as a follow-up, not blocking.**
Reasoning:
- It's strictly better than the pre-fix state (an empty, crashing 500) —
  this task's actual required defect (Defect #1: duplicate-nickname /
  already-mapped errors never reaching the owner) is genuinely fixed and
  I confirmed it myself by reading the `try`/`catch` boundaries line by line.
- No data corruption or loss: `Account`/Institution writes that succeeded
  before a later `syncPlaidTransactions` failure stay committed and correct;
  the `alreadyMapped` guard makes a retry safe (no double-create).
- The scenario is narrow (token invalidated in a small time window) and
  affects only the *message precision* of an already-rare failure mode, not
  whether the feature works. No acceptance criterion requires
  `confirm-mapping` to structurally distinguish this — AC6 (re-auth
  surfacing) is scoped to the `pending-accounts` GET resume path, which
  already handles it correctly.
- Fixing it properly means mirroring `pending-accounts`'s
  `error_code`/status-code pattern in `confirm-mapping` too, which is a
  small, well-contained, easily-specified follow-up — appropriate for a
  dedicated next task rather than blocking this one, which already fixed
  its one real required defect and is otherwise in good shape.

If the owner hits this in practice (unlikely — requires the token to expire
in that exact narrow window), it's a quick, obvious fix: mirror
`pending-accounts/[itemId]/route.ts`'s catch-block pattern into
`confirm-mapping/route.ts`.

## Correctness against the original request

- **Manual Add Account, new institution.** `actions/accounts.ts`'s
  `createAccountSchema` XOR-refines `institutionId`/`newInstitutionName`
  (`!!v.institutionId !== !!v.newInstitutionName`); `createAccount()` calls
  `resolveOrCreateInstitution()` first when the new-name path is used, then
  proceeds with the unchanged `db.account.create` (`integrationMode:
  "manual_entry"`). Matches AC1/AC2 exactly. The UI toggle in
  `AccountModal` correctly removes the `<select name="institutionId">` from
  the DOM when in "new institution" mode, so `fd.get("institutionId")` can
  never accidentally submit the `"__new__"` sentinel value — verified by
  reading the conditional render, not assumed.
- **Plaid mapping, create-new-account.** `connect-client.tsx`'s
  `CREATE_NEW_SENTINEL` row correctly reveals Entity/Nickname/Type fields,
  defaults Nickname to Plaid's own account name and Account Type via
  `inferAccountTypeFromPlaid(s.type, s.subtype)` (both genuinely editable —
  confirmed these are plain controlled inputs, not disabled/readOnly).
  `confirmMapping()` client-side gates on non-empty `entityId`/`nickname`
  before POSTing (the map step has no native `<form>`, so this replaces
  HTML `required` as the real gate — correctly reasoned in the impl doc).
  Server-side, `entityId: z.string().uuid()` is required unconditionally in
  both `createAccountSchema` and the `confirm-mapping` `newAccounts` array
  schema — ground rule 6 (never default/guess entity) is enforced at both
  layers, not just the client.
- **Sync ordering.** `createAccountsFromPlaidMapping()` runs and commits new
  `Account` rows *before* the trailing `syncPlaidTransactions(itemId)` call
  in `confirm-mapping/route.ts` — confirmed by reading the route top to
  bottom — so `lib/plaid-sync.ts`'s fresh `db.account.findMany({ where:
  { plaidItemId: itemId } })` re-query genuinely picks up the newly created
  accounts in the same initial sync. Matches AC3's explicit requirement.
- **CorePlus resume, no duplicate PlaidItem.** The `resumeItemId` branch in
  `connect-client.tsx` skips Plaid Link's `usePlaidLink`/token-fetch
  entirely and calls `GET /api/plaid/pending-accounts/<itemId>` directly,
  reusing the stored encrypted access token — no new Link session, no new
  `PlaidItem` row, matching AC5's explicit "no duplicate PlaidItem" bar.
  `link-token/route.ts`'s guard loosening (dropping the
  `accounts.length === 0` 404) is exactly the flagged, narrow, justified
  dependency for the re-auth *fallback* only — confirmed it doesn't affect
  any other caller of that route (still fully `auth()`-gated, still requires
  a real `PlaidItem` row to exist).
- **No fabricated data (ground rule 1).** `resolveOrCreateInstitution`
  throws on an empty-after-trim name rather than inventing one;
  `createAccountsFromPlaidMapping` throws if `plaidItem.institutionName` is
  null rather than fabricating a name. No dollar amounts, account numbers,
  or CorePlus-specific values are hardcoded anywhere in the diff — the real
  account creation is correctly left to the owner post-ship.

## Code quality

- Clean extraction of previously-duplicated `ACCOUNT_TYPES` into
  `lib/account-types.ts`, used consistently by both the zod schemas and the
  UI `<select>`s — reduces future drift risk.
- `createAccountsFromPlaidMapping`'s sequential (non-`Promise.all`) loop is
  the right call given the documented race-avoidance reasoning (shared
  `institutionName` across rows) and gives clean per-row error attribution.
- Error messages are genuinely owner-facing and specific (duplicate
  nickname names the actual nickname; already-mapped names the Plaid
  account ID) rather than generic — good instinct for a household-facing
  tool where the "user" hitting these errors is not a developer.
- The `$transaction`-atomicity gap (a 2nd-row failure in a multi-row
  new-account submission leaves the 1st row's `Account` already committed)
  is honestly disclosed rather than silently left out, with a clear,
  reasoned judgment call for why it wasn't fixed this round (no interactive-
  transaction precedent in the repo, would require reshaping
  `resolveOrCreateInstitution`'s signature). Agree with not fixing it here
  — it's a real but low-probability, non-corrupting edge case for a
  single-household app, and deserves its own reviewed change.

## Test quality

Both new test files exercise genuine edge cases, not just happy-path
smoke checks — confirmed by reading them directly (not just trusting the
Tester's line count claims):
- `plaid-account-type.test.ts` includes the meaningful priority-ordering
  case (`type:"credit", subtype:"line of credit"` → `loan`, not
  `credit_card`), which is exactly the kind of test that catches a real
  regression if branch order ever gets reshuffled.
- `institutions.test.ts` covers whitespace-only input, idempotency, and
  internal double-space collapsing — the actual normalization edge cases
  that matter for "does CorePlus Credit Union == coreplus  credit union".

## Documentation

Nothing user-facing/API-facing needs a docs update beyond what's already in
the code comments — this is an internal household tool with no public API
surface or changelog convention to maintain.

## What's good

- The plan's own investigated tradeoff (Plaid-Link-resume vs.
  lightweight-pending-mapping-affordance) was the right call and the
  implementation followed through on it correctly, including the
  re-auth-fallback dependency it required.
- The Coder's Fix Round 2 genuinely fixed the Tester's Round 1 defect — I
  independently reread the `try`/`catch` boundaries and confirm every throw
  site inside is now covered.
- Consistently disclosed tradeoffs and risks rather than silently omitting
  them (transaction atomicity, `plaidAccountId` uniqueness, the
  `institutionName`-null edge case, the link-token guard loosening) — this
  made the review meaningfully faster and more trustworthy.
- No security issues found: token handling stays through `encrypt()`/
  `decrypt()`, no access tokens or full account numbers logged anywhere in
  the diff, every new/changed route is `auth()`-gated.

## Route-back target

N/A — approved, no route-back needed.
