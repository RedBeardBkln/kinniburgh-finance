# Request

Tier 4 of the platform roadmap — "mobile PWA polish," part 1 of 3 (offline resilience first, then installability/home-screen experience, then a mobile-responsive layout audit — each is its own separate task, this one is offline resilience only).

## Current state (verified by the orchestrator — don't re-derive)

- `app/manifest.ts` already provides a correct, complete web manifest (name, standalone display, theme color, properly-sized `any`+`maskable` icons at 192/512). Installability basics are fine — not in scope here.
- `public/sw.js` is a hand-rolled service worker (no `next-pwa`/workbox — confirmed no such dependency in `package.json`) that does exactly one thing: handle `push` and `notificationclick` events for web push notifications. **It has no `fetch` event listener at all** — no caching, no offline interception. Registered from `components/notifications/notification-bell.tsx` (unconditionally on mount, and the bell renders in the app shell on every authenticated page) and again explicitly in `components/notifications/push-subscribe-button.tsx`'s enable flow.
- There is no `/offline` page or any offline fallback anywhere in `app/`.
- `next.config.ts` has security headers wired (`X-Robots-Tag`, `X-Frame-Options`, etc.) and Sentry (`@sentry/nextjs`) is integrated — be aware any new client-side network-failure handling shouldn't spam Sentry with expected offline-mode "Failed to fetch" noise (see `components/global-error-safety-net.tsx` for the existing precedent of filtering expected/benign errors, e.g. it already ignores `"Failed to fetch"` in its unhandled-rejection handler — check whether that's sufficient coverage or whether Sentry's own client-side error capture needs a similar allowlist for offline-mode fetch failures).
- This is a Next.js **App Router** app using Server Components and Server Actions extensively (`actions/*.ts`, all `"use server"`) — most pages fetch/act via server round-trips, not client-side REST calls. This fundamentally limits what "offline support" can mean here: you cannot meaningfully run a server action or re-render a Server Component without a network connection.

## Scope (explicit boundary — confirmed with the user)

**In scope:** when the user has no network connection, they should see a friendly, branded "you're offline" experience instead of the browser's default offline error page — for both a fresh navigation attempt while offline, and (if reasonably achievable) an in-app indicator when connectivity drops while already using the app.

**Explicitly out of scope — do not build:** any form of offline data caching, offline transaction entry, background sync, or showing previously-fetched financial figures while offline as if they were current. This is a real household's live bank/tax data — presenting stale cached numbers during an outage without an unmistakable "this is stale/offline data" treatment would violate CLAUDE.md's data-integrity spirit (ground rule 8: no financial-advice/misleading-data claims). If full app-shell asset caching (CSS/JS chunks) turns out to be fragile or high-risk given Next.js's build-hash-based asset URLs (they change every deploy, so a stale service-worker cache could serve mismatched/broken assets after a new deploy), prefer the simpler, safer option: a minimal static `/offline` HTML fallback page served by the service worker's `fetch` handler on navigation failure, without attempting to cache the full dynamic app shell. Flag this tradeoff explicitly in the plan rather than silently picking the more complex approach.

## Ground rules (CLAUDE.md)

TypeScript strict, no fabricated/stale data presented as current, security first (don't weaken any existing header/CSP-adjacent config). No financial-advice claims — not directly relevant here but keep tone observational or plainly a network-status message.

## Your job (Planner)

1. Read `public/sw.js`, `app/manifest.ts`, `app/layout.tsx`, `components/global-error-safety-net.tsx`, and `next.config.ts` in full.
2. Design the offline fallback: a new `/offline` route (static content, no server-side data dependency — it must render even when nothing else can), a `fetch` event listener added to `public/sw.js` that catches failed navigation requests and serves the cached offline page, and precaching just the offline page + its minimal static assets (not the whole app) during the service worker's `install` event.
3. Decide on an in-app "you're offline" indicator (e.g. listening to `window.addEventListener("online"/"offline", ...)` ) for when connectivity drops mid-session — check whether this belongs in `app/layout.tsx` (root, applies everywhere) or a more targeted component, following this repo's existing pattern of small focused client components (e.g. `GlobalErrorSafetyNet`) mounted at the layout level.
4. Address the service-worker versioning/update risk explicitly: since `sw.js` is a static file at a fixed path with no version query param, browsers periodically re-check it for changes — confirm your plan doesn't introduce a stale-cache risk (e.g., cache-busting the offline page's own assets, or keeping the precached set intentionally tiny/inline so there's nothing to go stale).
5. Plan how this gets verified — there's no unit-test-friendly way to test a service worker's `fetch` handler with this repo's Vitest setup (no DOM/service-worker test environment established anywhere in `lib/__tests__/`), so the plan should call for live browser verification (Chrome DevTools' offline throttling, or airplane mode) as the acceptance method for this specific piece, in addition to whatever IS unit-testable (e.g., a pure function computing which paths should bypass the offline fallback, if any such logic ends up being pure/extractable).
6. List every file to be created/modified and precise acceptance criteria for the Tester, including the live-verification steps since a pipeline agent without browser tools can't fully verify a service worker itself — flag clearly what the Tester CAN verify (file contents, correct event-listener wiring, any pure helper logic) versus what requires the orchestrator's own live Chrome verification afterward.

Do not write implementation code. Do not commit or push. Write the plan to `.claude/pipeline/pwa-offline-resilience/01-plan.md`.
