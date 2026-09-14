# Plan: PWA Offline Resilience (Tier 4, part 1 of 3)

## Restated goal

When the user has no network connection, replace the browser's default
offline error page with a friendly, branded "you're offline" page — both for
a fresh navigation attempted while offline, and (via an in-app banner) when
connectivity drops mid-session. No offline data caching, no showing
previously-fetched financial figures as if they were current. Installability
(manifest/icons) and the responsive-layout audit are separate later tasks and
untouched here.

## Scope

**In scope:**
- A new static `/offline` fallback page with no server-side data dependency.
- A `fetch` event listener in `public/sw.js` that intercepts failed
  **navigation** requests only and serves the cached `/offline` page.
- Precaching just the `/offline` document (nothing else) during the service
  worker's `install` event, with a versioned cache name and `activate`-time
  cleanup of stale cache versions.
- A small in-app connectivity indicator (banner) that appears when
  `window` fires `offline` and disappears on `online`.
- The one `middleware.ts` change required to make `/offline` reachable
  without an active session (see Approach step 2 — this is infrastructure
  for the fallback page, not a scope expansion).

**Explicitly out of scope — will not build:**
- Any caching of API responses, server actions, RSC payloads, or JS/CSS
  bundle chunks. Only the `/offline` document itself is precached.
- Offline transaction entry, background sync, or any "queue this write for
  later" behavior.
- Showing cached/previously-fetched financial data while offline. The
  offline page and banner both show only a network-status message, never
  a dollar figure or account state.
- General error-page handling (e.g. real 5xx server errors while online).
  The `fetch` handler only reacts to a network failure (the `fetch()`
  promise rejecting), not to a successful response with a non-2xx status.
  Treating server errors as "offline" would mask real app bugs behind a
  misleading "you're offline" message — flagged under Risks below as a
  deliberate scope boundary, not an oversight.
- `next-pwa`/workbox adoption — confirmed absent from `package.json`;
  staying with the existing hand-rolled `public/sw.js` pattern.
- Installability polish and the responsive-layout audit (parts 2 and 3 of
  the Tier 4 effort).

## Affected files/modules

**New:**
- `app/offline/page.tsx` — the offline fallback page (Server Component,
  static, no data fetching).
- `components/offline-indicator.tsx` — `"use client"` banner component for
  the mid-session online/offline indicator.

**Modified:**
- `public/sw.js` — add `install`, `activate`, and `fetch` event listeners.
  Existing `push`/`notificationclick` listeners are untouched.
- `middleware.ts` — add `/offline` to `PUBLIC_PATHS`.
- `app/layout.tsx` — mount `<OfflineIndicator />` alongside the existing
  `<GlobalErrorSafetyNet />`.

**Read, not modified:** `app/manifest.ts` (confirmed already correct, no
changes needed), `components/notifications/notification-bell.tsx` and
`components/notifications/push-subscribe-button.tsx` (confirmed both
register `/sw.js` already — no registration changes needed since the SW's
URL/scope isn't changing, only its event listeners), `components/global-error-safety-net.tsx`
(pattern precedent for the indicator), `next.config.ts` (confirmed no CSP
header exists today, so inline `style` attributes on the offline page are
not blocked by anything — if a CSP is ever added later, this page would need
revisiting).

## Approach

1. **Build the static `/offline` page** (`app/offline/page.tsx`).
   - Server Component, default export, plus a `metadata` export (same
     pattern as `app/privacy/page.tsx`), no `"use client"`, no `db`/
     `requireAuth`/`fetch`/`cookies()`/`headers()` calls of any kind — it
     must be eligible for Next's static prerendering (build-time HTML, no
     dynamic APIs), exactly like `app/privacy/page.tsx` already is.
   - **Style with inline `style` attributes, not Tailwind utility
     classNames.** This is the key decision addressing the asset-versioning
     risk (see Risks below): Tailwind's compiled CSS lives in a
     build-hash-named chunk (e.g. `/_next/static/css/[hash].css`) that
     changes every deploy. If the SW only precaches the `/offline` HTML
     document (which is the plan — see step 3), a Tailwind-styled version of
     this page would render unstyled (or, worse, could error trying to fetch
     a CSS chunk hash from a since-superseded deploy) when served from cache
     during a real outage. Inline styles have zero dependency on any hashed
     build asset, so the page always renders correctly styled from cache
     regardless of how stale the cached HTML is relative to the current
     deploy.
   - Content: short "You're offline" heading, one sentence explaining the
     app needs a connection to load your data (phrase this as a network-
     status fact, not implying any data is being shown), and a plain `<a
     href="/">` (a real anchor tag, not `next/link`'s `Link`) reading
     "Try again". Use a real anchor deliberately — `Link` performs
     client-side RSC navigation, which fails differently than a hard
     reload; a plain anchor forces a full navigation attempt each click,
     which the SW's `fetch` handler will either let through (if back online)
     or re-catch and re-serve the same cached offline page (if still
     offline) — either outcome is correct with zero extra logic.
   - No external image requests (no `<img src="/favicon.svg">` etc.) — if a
     brand mark is wanted, use an inline `<svg>` so the page has exactly one
     network dependency (itself) when precached.
   - Reuse the manifest's `#d97706` theme color inline for brand consistency
     (confirmed value from `app/manifest.ts`/`app/layout.tsx`'s `viewport`).

2. **Make `/offline` reachable without a session.** Add `/offline` to
   `PUBLIC_PATHS` in `middleware.ts` (same list `/login`, `/privacy`, etc.
   already use). Two independent reasons this is required, not optional:
   - The service worker's precache `fetch` during `install` (step 3) sends
     the current session cookie same-origin; if that cookie is ever absent
     or expired at install/update time, an auth-gated `/offline` would cache
     a `/login` redirect page instead of the real offline content.
   - It allows a logged-out user (or the Tester/orchestrator) to load
     `/offline` directly in a browser to visually verify it, matching how
     `/privacy` is reachable today.

3. **Add `install`/`activate`/`fetch` listeners to `public/sw.js`,
   appended after the existing `push`/`notificationclick` listeners:**
   - `install`: open a versioned cache (e.g. `"offline-v1"`) and
     `cache.addAll(["/offline"])` — precache exactly one URL, nothing else.
     Do not call `self.skipWaiting()` (see Risks — flagging, not deciding,
     the update-timing tradeoff).
   - `activate`: enumerate `caches.keys()` and delete any cache name that
     isn't the current version's name, so a future bump to `"offline-v2"`
     (e.g. if the offline page's content changes later) doesn't leave old
     cache entries accumulating indefinitely. This directly addresses the
     request's flagged versioning risk: `sw.js` is unversioned at a fixed
     URL and browsers periodically re-fetch it for byte-level changes, so
     the cache-cleanup-on-activate is what keeps a future SW update from
     leaving a stale precached `/offline` response (from an old deploy)
     sitting alongside a new one.
   - `fetch`: only act when `event.request.mode === "navigate"` (top-level
     page loads). For those, attempt `fetch(event.request)` and, on
     rejection (network unreachable), fall back to `caches.match("/offline")`.
     Every other request type (assets, `fetch()` calls from client
     components, server actions) is left completely untouched — no
     `event.respondWith()` call for those, so they fail with their normal
     browser behavior, which `components/global-error-safety-net.tsx`
     already partially absorbs (its `"Failed to fetch"` filter on
     `unhandledrejection`). No further Sentry work is needed here — see
     step 5.

4. **Build the connectivity indicator** (`components/offline-indicator.tsx`).
   - `"use client"`, following the `GlobalErrorSafetyNet` shape: a small
     component with no props, mounted once at the layout level, returns
     `null` in the common case.
   - `useState` initialized from `navigator.onLine` (guarded — only read
     inside `useEffect`/an initializer function, never at module scope,
     to stay SSR-safe), with `window.addEventListener("online", ...)` and
     `("offline", ...)` toggling it, cleaned up on unmount.
   - When offline, render a small fixed-position banner (e.g. top of
     viewport) with `role="status" aria-live="polite"` so screen readers
     announce the change. Copy should state connectivity status only —
     something like "You're offline. Some actions won't work until your
     connection returns." — never phrase it in a way that implies stale
     data on screen is current, per the explicit scope boundary.
   - Mount `<OfflineIndicator />` in `app/layout.tsx` next to
     `<GlobalErrorSafetyNet />` (root layout, applies everywhere,
     authenticated or not — matches the existing precedent for
     session-independent, always-mounted safety-net components).

5. **No Sentry allowlist change needed.** Read `sentry.client.config.ts` in
   full: client-side Sentry is intentionally fully disabled repo-wide
   (`export {}`, no `Sentry.init()` call) — its own comment explains this is
   because the household's ad blockers caused Sentry's wrapped-fetch
   instrumentation to trigger unhandled rejections that unmounted the React
   tree. `sentry.server.config.ts`/`sentry.edge.config.ts` remain active but
   only see server-side code paths, never a client's offline `fetch()`
   failures. So there is no client-side Sentry error capture to filter for
   offline-mode noise — `GlobalErrorSafetyNet`'s existing `"Failed to
   fetch"` filter (which exists for the unhandled-rejection path, not
   Sentry) is already the only and sufficient safety net here. No new work
   needed for this step; keeping it as a named step so the Tester/Reviewer
   can see this was checked, not skipped.

## Risks / unknowns

- **Service-worker update timing:** the plan deliberately does not add
  `self.skipWaiting()`/`self.clients.claim()`. Without them, a browser tab
  that already has the app open (with the *old* SW, which has no `fetch`
  handler) won't pick up the new offline-fallback behavior until all tabs
  are closed and the app is reopened — standard SW lifecycle. Adding
  `skipWaiting` would make the new behavior active sooner but also changes
  update timing for the *existing* push-notification listeners (an
  in-flight push/notification-click could theoretically be handled by a
  worker mid-transition). This is a real tradeoff, not obviously "worth it"
  for a low-stakes fallback page — flagging for the user/Coder to decide
  rather than picking unilaterally. Default recommendation: leave lifecycle
  as-is (no `skipWaiting`) for this task; can revisit if instant rollout
  matters.
- **`navigator.onLine`/`online`/`offline` events reflect local network
  adapter state, not true internet reachability.** A device connected to
  Wi-Fi with no actual internet route will still report `online`. This is a
  known, accepted limitation of the browser API being used — the indicator
  will not catch every real "can't reach the server" case, only the more
  common "no network adapter connection at all" case. No workaround (e.g.
  periodic ping-based reachability checks) is in scope here, since that
  would add its own network traffic/complexity beyond what was asked.
- **Fetch handler scope is network-failure-only, not HTTP-error-status.**
  A real 500 from the server while online will NOT show the offline page
  (by design — see Scope). If the user actually wants "any failed
  navigation" to show a friendlier page, that's a different, broader
  feature (generic error page) not requested here.
- **No automated test coverage is proposed for `offline-indicator.tsx` or
  `app/offline/page.tsx`.** Confirmed via `vitest.config.ts`
  (`environment: "node"`, no `jsdom`/`happy-dom`) and an empty
  `components/__tests__/` (directory doesn't exist at all) that this repo
  has no component-level/DOM test setup anywhere — inventing one for two
  small, low-logic components is a bigger scope call than this task
  warrants. Flagging this explicitly as a deliberate scope decision per the
  request's own instruction not to invent a first-of-its-kind test pattern
  without calling it out.
- **No pure/extractable business logic exists in the `fetch` handler.** The
  navigation-vs-other-request check is a single-condition branch on
  `event.request.mode`; there's nothing meaningful to pull into a unit-
  testable pure function. Verification for the SW itself is live-browser-
  only (see Test expectations).
- **Assumption:** the offline page's copy/branding wording (exact sentence)
  is left to the Coder's discretion within the constraints above (network-
  status framing only, inline styles, brand color). If the user wants
  specific copy, that should be called out before/during implementation.

## Acceptance criteria

**Statically verifiable (Tester can check without a browser):**
1. `app/offline/page.tsx` exists, has a default export and a `metadata`
   export, contains no `"use client"` directive, and contains no imports of
   `db`, `requireAuth`, `auth`, or any `actions/*` module (grep-confirmable
   — proves no server-side data dependency).
2. `app/offline/page.tsx` uses inline `style={{...}}` attributes for its
   visual styling rather than Tailwind utility `className`s (or, if the
   Coder deviates from this, the deviation must be explicitly justified in
   code comments — the Tester should flag an unexplained deviation as a
   finding, not silently accept it, given the versioning risk this choice
   exists to mitigate).
3. `app/offline/page.tsx`'s retry link is a plain `<a href="/">`, not
   `next/link`'s `<Link>`.
4. `public/sw.js` contains `install`, `activate`, and `fetch` event
   listeners in addition to the pre-existing `push`/`notificationclick`
   ones (which must be unmodified — diff should show only additions).
5. The `install` listener's cache population targets exactly `["/offline"]`
   (or an equally minimal, documented set — no wildcard/glob caching of
   `_next/static/*` or any hashed asset paths).
6. The cache name used is a versioned string (not e.g. just `"cache"`), and
   the `activate` listener deletes any cache key that doesn't match it.
7. The `fetch` listener only calls `event.respondWith(...)` when
   `event.request.mode === "navigate"` — no interception of other request
   types.
8. `middleware.ts`'s `PUBLIC_PATHS` array includes `"/offline"`.
9. `app/layout.tsx` renders `<OfflineIndicator />`.
10. `components/offline-indicator.tsx` is `"use client"`, registers both
    `window.addEventListener("online", ...)` and `("offline", ...)`, and
    removes both listeners in its `useEffect` cleanup function.
11. The offline indicator's rendered copy (grep the JSX text) describes
    connectivity status only — no wording that could be read as presenting
    on-screen data as current/live while offline.
12. `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass with no new
    failures (this task shouldn't need new lib-level tests per the Risks
    note above, so `pnpm test`'s pass count should be unchanged from its
    pre-task baseline — re-run and confirm the actual count rather than
    assuming).

**Requires live browser verification (Chrome DevTools offline throttling or
airplane mode) — flagged explicitly because no pipeline agent has browser
tooling to check this itself; this is the orchestrator's/user's step to run
after the Coder+Tester finish the statically-verifiable items above:**
13. Load the app once online (so the SW installs and precaches `/offline`),
    then use DevTools → Network → "Offline" (or Application → Service
    Workers → "Offline" checkbox) and attempt a fresh navigation (e.g.
    hard-reload a URL, or open a new tab to the app's origin) — the branded
    `/offline` page should appear instead of the browser's default "No
    internet" error page.
14. While already using the app online, toggle DevTools offline mode without
    navigating — the `OfflineIndicator` banner should appear within the
    same session (no reload needed), and disappear when toggled back online.
15. Confirm the offline page renders fully styled (not a flash of unstyled
    HTML) even when only `/offline` was precached — this is the direct test
    of the inline-styles decision in Approach step 1.
16. Confirm normal in-app data (accounts, transactions, budgets, etc.) is
    NOT visible/cached anywhere during the offline test — only the
    connectivity message. This is the direct test of the "no stale data"
    scope boundary.
17. After a subsequent code change to `public/sw.js` (simulating a future
    deploy), confirm via Application → Service Workers that the old cache
    version is removed and only the current version's cache remains after
    activation — direct test of the versioning-risk mitigation.

## Test expectations

- **Unit tests:** none proposed for this task (see Risks — no DOM/SW test
  environment exists in this repo, and there's no pure logic to extract).
  If `pnpm test`'s existing suite has any test that asserts on the full
  contents of `middleware.ts`'s `PUBLIC_PATHS` array or `app/layout.tsx`'s
  rendered tree, that test's expectations will need updating — Tester
  should grep `lib/__tests__/` and any other `__tests__` directories for
  references to either file before assuming none exist.
- **Integration/e2e tests:** none exist in this repo today (no Playwright/
  Cypress config found in `package.json` as read for this plan) — not
  introducing one is consistent with existing repo conventions, not a gap
  specific to this task.
- **Live/manual verification:** the primary verification method for this
  task, per acceptance criteria 13–17 above. This should be explicitly
  logged as done (or not) by whoever runs it — the Tester agent should mark
  these items as "requires live browser check, not verifiable from source"
  rather than silently skipping or falsely marking them passed.
