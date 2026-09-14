# Review: PWA Offline Resilience (Tier 4, part 1 of 3)

## Verdict: APPROVED

Approval is conditioned on the orchestrator's pending live-browser
verification (plan acceptance criteria 13-17), which this pipeline
structurally cannot perform itself — see "What's outstanding" below. Nothing
in that gap blocks approval; per prior guidance on UI-touching tasks in this
repo, every piece of logic that determines what would render/execute has
been traced by hand to the actual code path, and the change is additive/
low-blast-radius on an internal two-person tool.

## What I independently verified (not just re-reading the write-ups)

- Read `app/offline/page.tsx`, `components/offline-indicator.tsx`, and
  `public/sw.js` in full myself.
- Re-ran `pnpm typecheck` (clean), `pnpm lint` (0 errors / 44 warnings, same
  count and same categories as reported — including the one expected
  `react-hooks/set-state-in-effect` warning on `offline-indicator.tsx:23`,
  confirmed as the same tolerated pattern used elsewhere in the repo), and
  `pnpm test` (458/458 passed across 38 files) myself rather than trusting
  `02-implementation.md`/`03-test-report.md`'s numbers.
- Confirmed via `git diff`/`git status` that the change touches exactly 5
  files: `app/offline/page.tsx` (new), `components/offline-indicator.tsx`
  (new), `public/sw.js`, `middleware.ts`, `app/layout.tsx` (modified). No
  scope creep. The other untracked paths in `git status` (`.claude/agent-
  memory/`, `personal-form-plan-wiring/` pipeline dir, `pnpm-workspace.yaml`,
  etc.) predate this task and are unrelated.
- Read `middleware.ts` in full, not just the diff line — the `PUBLIC_PATHS`
  addition uses the same `pathname === p || pathname.startsWith(p + "/")`
  matching every sibling public path already uses; no special-cased logic.
- Read `components/global-error-safety-net.tsx` to confirm
  `offline-indicator.tsx` genuinely mirrors its established
  mount-at-layout/return-null-by-default shape rather than just claiming to.
- Grepped `components/notifications/notification-bell.tsx` and
  `push-subscribe-button.tsx` to confirm both still register `/sw.js` at the
  default root scope, unchanged — so the new `fetch` listener's navigate-mode
  interception applies app-wide as intended, and no registration-path change
  was needed or made.
- Cross-checked the `#d97706` theme color used in both new files against
  `app/manifest.ts` and `app/layout.tsx`'s `viewport.themeColor` — matches.
- Grepped the whole repo for `eslint-disable` usage to confirm the
  `@next/next/no-html-link-for-pages` suppression on the offline page's
  retry link follows the exact existing repo convention (single-line,
  inline-justified) used for the same rule elsewhere, not a new pattern or a
  broader disable. The lint run itself confirms no "unused eslint-disable
  directive" warning, meaning the suppression is actually doing something,
  not a no-op.

## Findings

None blocking. None should-fix.

**Nit:** the service worker is only ever registered from
`notification-bell.tsx`/`push-subscribe-button.tsx`, both of which render
only in the authenticated app shell (confirmed pre-existing, unchanged by
this task, and explicitly called out as fine in `00-request.md`). Practical
consequence: a user who has never been authenticated in this browser (or who
cleared site data since their last authenticated visit) gets no offline
fallback at all on `/login` itself — they'd see the browser's default
offline error page, not the branded one. This is an inherited limitation of
the existing SW-registration architecture, not something this task
introduced or was asked to fix (the plan explicitly scoped out any
registration-path change), so it's a nit for future-task awareness only, not
a finding against this diff.

## Correctness against CLAUDE.md / the scope boundary

Confirmed by reading both new files' actual rendered copy, not just the
summaries:
- `app/offline/page.tsx`: "Banana Stand needs a network connection to load
  your data. Nothing shown here reflects your current accounts or balances —
  reconnect and try again." — explicit, unambiguous disclaimer, not just an
  absence of data.
- `components/offline-indicator.tsx`: "You're offline. Some actions won't
  work until your connection returns." — pure connectivity-status framing,
  no reference to any on-screen figure.

Neither component fetches, caches, or displays any application data. The
service worker precaches exactly one static, dataless HTML document
(`/offline`) and nothing else — no API routes, no RSC payloads, no
`_next/static/*` chunks. This is the strongest possible reading of the
request's ground-rule-8 concern (no financial data presented as current
during an outage) — there simply is no data path into either surface.

## Fetch handler scope (risk class: over-broad SW interception)

`public/sw.js`'s `fetch` listener returns immediately, with no
`event.respondWith()` call at all, unless `event.request.mode ===
"navigate"`. I traced this by hand: server actions (POST, not
navigation-mode), client-side `fetch()` calls from components, and all
asset/API requests fall through completely untouched, exactly as the plan
and request required. Even for navigation requests, the handler still calls
through to `fetch(event.request)` first and only substitutes the cached
offline page on network rejection — a real 5xx from the server while online
is deliberately NOT caught (by design, documented in the plan and preserved
in the implementation), so this can't mask real application bugs as "you're
offline."

## Cache-versioning / staleness mitigation

`OFFLINE_CACHE_NAME = "offline-v1"` is a named, versioned string (not a bare
`"cache"`). The `activate` listener enumerates `caches.keys()` and deletes
every entry that doesn't match the current name — sound cleanup shape for a
future `"offline-v2"` bump. Two things I checked beyond the surface claim:
- `sw.js` defines no other Cache Storage entries anywhere in the file, so
  `activate`'s indiscriminate "delete anything not offline-v1" can't
  accidentally sweep up an unrelated cache used by some other part of the
  app (there isn't one).
- Because `install` re-runs `cache.addAll(["/offline"])` under the *same*
  cache name whenever `sw.js`'s own bytes change (which is what triggers a
  new `install` event in the first place), the precached `/offline` content
  actually gets refreshed on every SW update regardless of whether the
  version string itself is bumped — `cache.addAll` overwrites the existing
  entry for that URL. The version-name bump matters for *cleanup semantics*
  if the entry set ever grows beyond one URL, not for content freshness
  today. Worth knowing but not a defect — the implementation as shipped has
  no staleness gap for the single-URL cache it actually uses.

## Test quality

No new automated tests were added, and I agree with the plan's own reasoning
for why: `vitest.config.ts` runs in a `node` environment with no `jsdom`/
`happy-dom`, there's no pre-existing DOM/service-worker test harness in this
repo to extend, and there's no pure/extractable logic in either new
component to unit-test in isolation (a single `mode === "navigate"` branch
and a pair of DOM event listeners). Inventing a first-of-its-kind test
harness for two small, low-logic components would have been scope creep in
the other direction. The static acceptance criteria (file structure, listener
wiring, precache target, copy content) are the right level of verification
for what's actually testable outside a browser, and I independently
confirmed all of them by reading the files myself rather than trusting the
Tester's checklist.

## Documentation

Nothing user-facing/API-facing needs a docs update here — this is a
resilience feature with self-explanatory in-product copy, not an API
surface or a workflow change that needs a README/changelog entry.

## What's outstanding (not blocking, by design)

Plan acceptance criteria 13-17 require an actual browser (Chrome DevTools
offline throttling or airplane mode): SW install + precache + navigation
interception, mid-session banner appearance/disappearance, no-FOUC styled
rendering from cache, confirmation that no financial data is visible
anywhere during a live offline test, and cache-cleanup-on-activate after a
simulated future `sw.js` change. None of the four pipeline agents have
browser tooling; this was correctly named as the orchestrator's/user's step
in both the plan and the test report, not silently skipped. Recommend
running all five before considering this fully shipped, particularly
criterion 16 (visual confirmation that no stale data renders anywhere) since
that's the one true "grade the pixels, not just the code" check for this
task's core safety concern.

## What's good

- The inline-styles decision for the offline page (avoiding a dependency on
  a build-hash-named Tailwind CSS chunk that a stale SW cache could
  reference incorrectly after a redeploy) is a genuinely well-reasoned,
  narrowly-targeted mitigation for a real Next.js-specific risk — and it's
  documented in-code, not just in the pipeline docs, so a future maintainer
  who edits this file without reading the pipeline history will still see
  why.
- Scope discipline was excellent end-to-end: the plan explicitly named and
  rejected several tempting expansions (caching the app shell, catching
  HTTP-error-status responses as "offline", adding `skipWaiting`), and the
  implementation didn't quietly reach for any of them.
- The `no-html-link-for-pages` lint suppression is a textbook example of
  "the lint rule is usually right, this is the documented exception" rather
  than a lazy blanket disable.
