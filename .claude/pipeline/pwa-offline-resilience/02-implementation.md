# Implementation: PWA Offline Resilience (Tier 4, part 1 of 3)

## Summary of changes

**New: `app/offline/page.tsx`**
Static Server Component offline fallback page. No `"use client"`, no `db`/`requireAuth`/`fetch`/`cookies()`/`headers()` calls — eligible for build-time static prerendering, matching `app/privacy/page.tsx`'s pattern. Exports `metadata` (title only, no dynamic `generateMetadata`). All visual styling uses inline `style={{...}}` attributes rather than Tailwind classNames, per the plan's asset-versioning rationale (the SW only precaches this page's HTML, not any Tailwind CSS chunk, which is build-hash-named and changes every deploy). Content: an inline `<svg>` icon (no external image request), a "You're offline" heading, one sentence framed strictly as a network-status fact (explicitly states nothing shown reflects current accounts/balances), and a plain `<a href="/">` "Try again" link — not `next/link`'s `Link`, so every click forces a full navigation the service worker can intercept. Uses the manifest's `#d97706` theme color inline.

The plain `<a>` triggered the repo's `@next/next/no-html-link-for-pages` ESLint rule; added a `// eslint-disable-next-line` with an inline comment explaining the deliberate choice (matches the repo's existing convention for justified rule suppressions, e.g. `vault-verify-client.tsx`).

**New: `components/offline-indicator.tsx`**
`"use client"` component mirroring `GlobalErrorSafetyNet`'s shape (no props, mounted once at layout level, returns `null` in the common case). `useState` for `isOffline`, initialized `false` and set from `navigator.onLine` inside `useEffect` (SSR-safe — never read at module scope). Registers `window.addEventListener("online", ...)` and `("offline", ...)`, both removed in the effect's cleanup. Renders a small `role="status" aria-live="polite"` fixed-position banner when offline, with copy limited to connectivity status only ("You're offline. Some actions won't work until your connection returns.") — no wording implying on-screen data is current.

**Modified: `public/sw.js`**
Appended `install`, `activate`, and `fetch` listeners after the existing `push`/`notificationclick` listeners (diff is purely additive — confirmed via `git diff`, no lines removed/changed in the pre-existing code).
- `install`: opens cache `"offline-v1"` and `cache.addAll(["/offline"])` — precaches exactly one URL. No `self.skipWaiting()` (per plan, deliberately deferred — see Risks below).
- `activate`: enumerates `caches.keys()` and deletes any cache name that isn't `"offline-v1"`, so a future cache-name bump won't leave stale versions accumulating.
- `fetch`: returns early (no `event.respondWith()`) unless `event.request.mode === "navigate"`. For navigations, attempts `fetch(event.request)` and falls back to `caches.match("/offline")` only on rejection (network failure) — not on a successful non-2xx response, so real server errors are untouched by design.

**Modified: `middleware.ts`**
Added `"/offline"` to `PUBLIC_PATHS`, alongside `/login`, `/privacy`, etc. — required both so the SW's install-time precache fetch doesn't cache a `/login` redirect if the session cookie is absent/expired, and so the page can be loaded directly (logged out) for visual verification.

**Modified: `app/layout.tsx`**
Imported and mounted `<OfflineIndicator />` in the root layout, immediately after `<GlobalErrorSafetyNet />` — applies on every page, authenticated or not.

## Deviations from the plan

- The plan's acceptance criteria didn't anticipate the `@next/next/no-html-link-for-pages` lint rule firing on the plain `<a href="/">` it explicitly required. Resolved with a scoped `eslint-disable-next-line` plus an inline comment restating the plan's own justification, rather than switching to `Link` (which would have silently reintroduced the exact bug the plan was avoiding) or disabling the rule repo-wide (out of scope, weakens a real check everywhere else). This is a necessary implementation detail to satisfy the plan's explicit design decision, not a deviation from the plan's intent.
- No other deviations. Cache name (`"offline-v1"`), file locations, listener wiring, and page/indicator content all match the plan's Approach section as written.

## Commands run and their results

- `pnpm typecheck` (`tsc --noEmit`) — clean, no errors.
- `pnpm lint` (ESLint) — after adding the disable comment above: **0 errors, 44 warnings**. All 44 warnings are pre-existing, in files I didn't touch, matching known categories from prior sessions (unused imports, `react-hooks/set-state-in-effect` in several components). Grepped the output for my own new/changed files (`app/offline/page.tsx`, `components/offline-indicator.tsx`, `public/sw.js`, `middleware.ts`, `app/layout.tsx`) — `offline-indicator.tsx` does produce one `react-hooks/set-state-in-effect` warning (calling `setIsOffline` synchronously in the effect that reads `navigator.onLine` on mount), which is the same warning class already present and accepted elsewhere in this repo (`insurance-policy-card.tsx`, `category-drilldown-modal.tsx`, `retroactive-rule-modal.tsx`, `vault-verify-client.tsx`) — not a new pattern, not fixed, consistent with existing repo convention of tolerating this specific warning.
- `pnpm test` (`vitest run`, full suite) — **458 passed / 458 total across 38 files**, no failures. No new test files added, consistent with the plan's "Test expectations" section (no DOM/service-worker test environment exists in this repo — `vitest.config.ts` uses `environment: "node"`, confirmed no `jsdom`/`happy-dom`, and there's no pure/extractable logic in the SW's single-condition `fetch` handler to unit test).
- `git diff public/sw.js` — confirmed the diff to that file is purely additive (43 new lines, 1 line changed only because of trailing blank-line context at the end of the pre-existing `notificationclick` listener); the `push` and `notificationclick` listeners are byte-identical to before.

## What was verified vs. what still needs live browser verification

**Verified (static/toolset-checkable):**
- All 12 statically-verifiable acceptance criteria in the plan (items 1–12): `app/offline/page.tsx`'s structure (default export, `metadata` export, no `"use client"`, no `db`/`requireAuth`/`auth`/`actions/*` imports, inline styles, plain `<a>`), `public/sw.js`'s three new listeners with correct scoping (`install` targets exactly `["/offline"]`, versioned cache name `"offline-v1"`, `activate` deletes non-matching cache keys, `fetch` only calls `event.respondWith()` for `mode === "navigate"`), `middleware.ts`'s `PUBLIC_PATHS` inclusion, `app/layout.tsx` rendering `<OfflineIndicator />`, `offline-indicator.tsx`'s listener registration/cleanup, and its copy (connectivity-status-only wording, no implication of live data).
- Typecheck, lint, and full unit-test suite all pass with no regressions.

**NOT verified — requires live browser access (Chrome DevTools offline throttling or airplane mode), which this toolset does not have:**
- Whether the service worker actually installs, precaches `/offline`, and intercepts a failed navigation to serve it (plan acceptance criteria 13, 15, 16).
- Whether the `OfflineIndicator` banner actually appears/disappears in response to real `online`/`offline` browser events during a live session (criterion 14).
- Whether a subsequent `sw.js` change correctly triggers cache cleanup on `activate` in a real browser (criterion 17).
These are explicitly called out in the plan itself as the orchestrator's/user's step to run after this pipeline stage — I have not claimed any of them pass, only that the source code is wired correctly per static inspection.

## Open items

- None outside the plan's own documented risks (SW update-timing tradeoff re: no `skipWaiting()`, `navigator.onLine` reflecting local adapter state rather than true reachability, fetch-failure-only scope excluding real 5xx errors) — all of these were deliberate plan decisions, not implementation gaps.
- The live-browser verification steps above (criteria 13–17) remain outstanding and should be run by the orchestrator/user before considering this task fully done.
