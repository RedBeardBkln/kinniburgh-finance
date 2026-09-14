# Test Report: PWA Offline Resilience (Tier 4, part 1 of 3)

## Verdict: PASS

All 12 statically-verifiable acceptance criteria from `01-plan.md` pass.
`pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass with no regressions
and no new failures. File scope matches exactly what the plan specified.
Criteria 13–17 require live browser verification and are explicitly NOT
claimed as passed here (see "Not tested" below) — this is expected per the
plan and request, not a gap in this round.

## Acceptance criteria checklist

1. **`app/offline/page.tsx` exists, default export + `metadata` export, no
   `"use client"`, no `db`/`requireAuth`/`auth`/`actions/*` imports — PASS.**
   Read the full file. `export const metadata = {...}` and
   `export default function OfflinePage()`. No `"use client"` directive.
   Grepped for `db|requireAuth|auth(|cookies(|headers(|actions/` — zero
   matches other than the file's own descriptive comment. Structurally
   identical to `app/privacy/page.tsx` (`export const metadata` + `export
   default function ...Page()`).

2. **Inline styles, not Tailwind classNames — PASS.** Every element uses a
   `style={{...}}` object (div, svg, h1, p, a). No `className` appears
   anywhere in the file. No deviation to flag.

3. **Retry link is a plain `<a href="/">`, not `next/link`'s `Link` —
   PASS.** Line 82: `<a href="/" style={{...}}>Try again</a>`. No `Link`
   import anywhere in the file.

4. **`public/sw.js` has `install`/`activate`/`fetch` listeners added,
   pre-existing `push`/`notificationclick` untouched — PASS.** `git diff
   public/sw.js` shows a purely additive diff (46 new lines, zero lines
   removed or changed) appended after the existing listeners. Byte-identical
   confirmed by the diff itself showing no `-` lines.

5. **`install` precaches exactly `["/offline"]` — PASS.**
   `caches.open(OFFLINE_CACHE_NAME).then((cache) => cache.addAll([OFFLINE_URL]))`
   where `OFFLINE_URL = "/offline"`. No wildcard, no `_next/static/*`, no
   additional URLs.

6. **Versioned cache name; `activate` deletes non-matching keys — PASS.**
   `OFFLINE_CACHE_NAME = "offline-v1"`. `activate` handler enumerates
   `caches.keys()`, filters to names `!== OFFLINE_CACHE_NAME`, and deletes
   each. Correct shape for future version bumps.

7. **`fetch` only calls `event.respondWith()` for `mode === "navigate"` —
   PASS.** Handler returns early (`if (event.request.mode !== "navigate")
   return;`) before any `respondWith()` call. All other request types
   (assets, client `fetch()`, server actions) pass through untouched — no
   `respondWith()` is invoked for them at all.

8. **`middleware.ts`'s `PUBLIC_PATHS` includes `"/offline"` — PASS.**
   `const PUBLIC_PATHS = ["/login", "/forgot-password", "/reset-password",
   "/privacy", "/offline", "/api/logo", "/api/favicon", "/api/cron"];` —
   same array, same matching logic (`pathname === p || pathname.startsWith(p
   + "/")`) as every other public path; no special-cased logic introduced.

9. **`app/layout.tsx` renders `<OfflineIndicator />` — PASS.** Imported from
   `@/components/offline-indicator` and mounted directly after
   `<GlobalErrorSafetyNet />` inside `<body>`, before `{children}`. Root
   layout stays a server component (no `"use client"` added to
   `layout.tsx`); it mounts a client component exactly the way it already
   does for `GlobalErrorSafetyNet` (confirmed `global-error-safety-net.tsx`
   itself starts with `"use client"`) — no server/client boundary violation.

10. **`offline-indicator.tsx` is `"use client"`, registers both
    `online`/`offline` listeners, cleans both up — PASS.** File starts with
    `"use client"`. `useEffect` registers `window.addEventListener("online",
    handleOnline)` and `("offline", handleOffline)`, and the cleanup
    function removes both. `useState` for `isOffline` is initialized `false`
    (SSR-safe) and only set from `navigator.onLine` inside the effect, never
    at module or render-body scope.

11. **Indicator copy is connectivity-status-only, no implication of live
    data — PASS.** Rendered text: "You're offline. Some actions won't work
    until your connection returns." Purely a network-status statement, no
    reference to accounts/balances/any on-screen figure. The offline page's
    copy goes further and explicitly disclaims data freshness: "Nothing
    shown here reflects your current accounts or balances."

12. **`pnpm typecheck`, `pnpm lint`, `pnpm test` all pass, test count
    unchanged from baseline — PASS.** See "Tests run" below for full output.
    0 typecheck errors, 0 lint errors (44 pre-existing warnings, one of
    which — `react-hooks/set-state-in-effect` in `offline-indicator.tsx` —
    is the same warning class already tolerated in
    `retroactive-rule-modal.tsx` and `vault-verify-client.tsx`, not a new
    pattern), 458/458 tests passed across 38 files.

## Tests run

```
$ pnpm typecheck
> tsc --noEmit
(clean — no output, exit 0)
```

```
$ pnpm lint
✖ 44 problems (0 errors, 44 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.
```
All 44 warnings are pre-existing categories (unused imports/vars,
`react-hooks/set-state-in-effect`) spread across files this task did not
touch, plus the one expected `set-state-in-effect` warning in the new
`offline-indicator.tsx` (reading `navigator.onLine` synchronously on mount —
same pattern already accepted elsewhere in the repo). No "unused eslint-
disable directive" warning was reported for the `@next/next/no-html-link-
for-pages` suppression in `app/offline/page.tsx`, confirming that
suppression is actually necessary (not a no-op disable masking nothing).

```
$ pnpm test
 Test Files  38 passed (38)
      Tests  458 passed (458)
   Duration  2.20s
```
No new test files, no failures, no skips.

```
$ git diff public/sw.js
```
Confirmed purely additive: 46 new lines appended after the existing `push`
and `notificationclick` listeners, zero lines removed or modified in the
pre-existing code.

```
$ git diff middleware.ts app/layout.tsx
```
`middleware.ts`: one-line change adding `"/offline"` into the existing
`PUBLIC_PATHS` array literal, same shape as sibling entries.
`app/layout.tsx`: one new import line, one new `<OfflineIndicator />` JSX
line — no other changes.

## Tests added

None. Consistent with the plan's "Test expectations" section: this repo's
`vitest.config.ts` uses `environment: "node"` (confirmed no `jsdom`/`happy-
dom`), there is exactly one `__tests__` directory in the whole repo
(`lib/__tests__/`, all pure-function unit tests), and no test anywhere
references `PUBLIC_PATHS`, `middleware.ts`, `app/layout.tsx`'s rendered
tree, or any offline-related file (grepped and confirmed zero matches) — so
no existing test needed updating, and there's no pure/extractable logic in
the new code (the SW's navigation-mode check and the indicator's
online/offline toggling are both trivial, stateful, DOM/SW-dependent
branches with no meaningful pure core to unit test). Inventing a first-of-
its-kind jsdom/service-worker test harness for two small components is a
bigger scope call than this task warrants, matching the plan's own
reasoning — not attempting it.

## Defects found

None. No implementation deviations beyond the one the Coder self-reported
(the `eslint-disable-next-line @next/next/no-html-link-for-pages` on the
plain anchor) — verified that suppression is single-line, has an inline
justification comment restating the plan's own reasoning, and does not
disable the rule more broadly (grepped `eslint.config.*`/`.eslintrc*` — no
repo-wide rule changes). This is a reasonable, narrowly-scoped suppression,
not a broader rule disable.

## Scope check

`git status`/diff matches expectations: modified — `app/layout.tsx`,
`middleware.ts`, `public/sw.js`; new — `app/offline/page.tsx`,
`components/offline-indicator.tsx`, plus this task's pipeline docs under
`.claude/pipeline/pwa-offline-resilience/`. No other tracked file was
touched. (Other untracked paths visible in `git status` — `.claude/agent-
memory/`, `.claude/agents/`, `.claude/commands/`, the
`personal-form-plan-wiring` pipeline directory, `pnpm-workspace.yaml` — were
already present before this task started per the session's initial git
snapshot and are unrelated to this change.)

## Not tested (requires live browser verification — NOT claimed as passed)

These are plan acceptance criteria 13–17, explicitly flagged in the plan
itself as requiring Chrome DevTools offline throttling / airplane mode,
which this toolset does not have access to. Enumerating exactly what the
orchestrator/user needs to check live:

1. **SW install + precache + navigation interception (criterion 13):** load
   the app once online so the SW installs and precaches `/offline`, then go
   offline (DevTools Network → Offline, or Application → Service Workers →
   Offline) and attempt a fresh navigation — confirm the branded `/offline`
   page appears instead of the browser's default offline error page.
2. **Mid-session banner appearance/disappearance (criterion 14):** while
   already using the app online, toggle DevTools offline mode without
   navigating — confirm `OfflineIndicator`'s banner appears within the same
   session (no reload) and disappears when toggled back online.
3. **Offline page renders fully styled from cache, no FOUC (criterion 15):**
   direct test of the inline-styles decision — confirm the page isn't
   unstyled or broken when served purely from the precached response.
4. **No stale financial data visible anywhere during the offline test
   (criterion 16):** confirm no accounts/transactions/budget figures render
   anywhere during the offline navigation — only the connectivity message.
5. **Cache version cleanup on a future SW update (criterion 17):** after a
   subsequent code change to `public/sw.js` (simulating a future deploy),
   confirm via Application → Service Workers that the old cache version is
   removed and only the current version's cache remains post-`activate`.

None of these five were attempted or faked here — they require an actual
browser with a real network adapter, which is outside this toolset's
capability, exactly as the plan anticipated.
