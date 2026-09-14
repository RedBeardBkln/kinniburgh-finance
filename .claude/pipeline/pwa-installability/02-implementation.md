# Implementation: PWA installability (maskable icon + custom install prompt)

## Summary of changes

**Part A — maskable icon generation**

- `scripts/generate-maskable-icons.ts` (new) — one-time `sharp`-based
  generator. For each of the two source sizes (192, 512):
  - Samples the fill color from the source PNG's own top-left corner pixel
    (via `.extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()`,
    read with `Buffer.readUInt8` rather than array indexing — see Deviations)
    instead of hardcoding the manifest's amber theme color, since the source
    art's actual background is a green radial gradient that would clash with
    amber.
  - Resizes the source to 80% of the target canvas (`Math.round(size * 0.8)`).
  - Creates a new opaque 3-channel canvas at the full target size filled with
    the sampled color, composites the resized art centered on it, then
    `.flatten({ background })` + `.removeAlpha()` before encoding to PNG, so
    the output has no alpha channel at all (belt-and-suspenders against any
    transparency).
  - Writes `public/web-app-manifest-{size}x{size}-maskable.png` and logs the
    sampled hex color to stdout.
  - Sampled colors this run: `#4d6030` (192px source), `#4d5f31` (512px
    source) — both a dark olive-green consistent with the source gradient's
    edge tone.
- `package.json` — added `"generate:maskable-icons": "tsx scripts/generate-maskable-icons.ts"`
  to the `scripts` block, matching the existing `import:tags`/`import:budgets`
  convention.
- Ran `pnpm generate:maskable-icons` and committed the two real output files:
  - `public/web-app-manifest-192x192-maskable.png`
  - `public/web-app-manifest-512x512-maskable.png`
- `app/manifest.ts` — the two `purpose: "maskable"` icon entries now point at
  the new `-maskable.png` files; the two `purpose: "any"` entries are
  untouched and still point at the original full-bleed files.

**Part B — custom install prompt**

- `lib/pwa-install.ts` (new) — pure `shouldShowInstallBanner(opts)` function:
  `hasDeferredPrompt && !isStandalone && !dismissed`. Matches this repo's
  existing pure-decision-module pattern (`lib/card-due.ts` et al.).
- `lib/__tests__/pwa-install.test.ts` (new) — covers all the meaningful
  combinations: happy path, no deferred prompt (the common no-event case),
  standalone always wins even with a deferred prompt, dismissed always wins
  regardless of other state. 5 tests.
- `components/pwa-install-prompt.tsx` (new) — `"use client"` component
  structured like `components/offline-indicator.tsx` (inline styles,
  browser-state reads only inside `useEffect`, never in `useState`
  initializers). Locally declares `BeforeInstallPromptEvent` (not in
  `lib.dom.d.ts`). On mount: bails out entirely if
  `window.matchMedia("(display-mode: standalone)").matches`; otherwise reads
  `localStorage.getItem("pwaInstallDismissed")`, attaches
  `beforeinstallprompt` (calls `.preventDefault()`, stashes the event, sets
  visibility via `shouldShowInstallBanner`) and `appinstalled` (clears state,
  hides) listeners, with cleanup on unmount. Install button calls
  `.prompt()` then awaits `.userChoice`, then clears/hides. Dismiss button
  sets `localStorage.pwaInstallDismissed = "1"` and hides (permanent
  dismissal, per the plan's justification). Renders `null` when not visible;
  otherwise a fixed **bottom**-of-viewport banner (deliberately not top,
  where `OfflineIndicator` already renders) with factual copy — "Install
  Banana Stand for faster access." — and "Install"/"Not now" buttons,
  `role="status"`/`aria-live="polite"`.
- `app/layout.tsx` — imports and mounts `<PwaInstallPrompt />` directly after
  `<OfflineIndicator />`, before `{children}`.

## Deviations from the plan

- The plan's sketch of the `sharp` pipeline ended with
  `.flatten({ background: sampledRgb })` alone as the transparency guard. In
  practice, after compositing, `.flatten()` alone still produced a PNG with
  a (fully-opaque, all-255) alpha channel present (`channels: 4`,
  `hasAlpha: true` per `sharp().metadata()`) rather than a true 3-channel
  opaque PNG. This already satisfied acceptance criterion #1 as literally
  worded ("no transparent pixels ... alpha fully opaque, or no alpha channel
  at all") since I verified via `sharp().stats()` that the alpha channel's
  min/max/mean were all 255 at every pixel — but to match the plan's stated
  intent more precisely ("3 channels / no alpha, so the output can never be
  transparent"), I added an explicit `.removeAlpha()` call before `.png()`.
  Re-ran the script; output is now confirmed `channels: 3`, `hasAlpha: false`
  for both files, with identical sampled colors (deterministic, same source
  input). Small implementation-detail deviation, not a scope change.
- Reading the sampled corner-pixel RGB values via `cornerPixel[0]` etc.
  failed `pnpm typecheck` (`TS18048: 'c' is possibly 'undefined'`, from this
  repo's strict/`noUncheckedIndexedAccess` config on `Buffer` index access).
  Switched to `cornerPixel.readUInt8(0/1/2)`, which returns `number` (not
  `number | undefined`). No behavior change, just a stricter-typing fix.

No other deviations — icon generation, manifest wiring, and the install
prompt component all match the plan's design as written.

## Commands run and their results

- `pnpm generate:maskable-icons` — ran twice (once before the `.removeAlpha()`
  fix, once after). Both runs succeeded with no errors; second run's output
  is what's committed.
- Verified output files programmatically (via a throwaway `node -e` script
  using `sharp().metadata()` and `sharp().stats()`, not committed):
  - `public/web-app-manifest-192x192-maskable.png`: `192x192`, PNG,
    `channels: 3`, `hasAlpha: false`.
  - `public/web-app-manifest-512x512-maskable.png`: `512x512`, PNG,
    `channels: 3`, `hasAlpha: false`.
  - Both match their non-maskable counterparts' dimensions exactly
    (verified against the request doc's stated existing dimensions:
    192×192 and 512×512).
- Viewed both generated files directly with the `Read` tool (real visual
  inspection, not just metadata) alongside the original
  `web-app-manifest-512x512.png` for comparison: the maskable variants show
  the "Banana Stand" logo art visibly scaled down and centered, with a
  solid olive-green margin/border around it and no text touching the image
  edge — the "BANANA" and "STAND" banner text that was full-bleed in the
  original is now clearly inside a safe zone. This is real visual
  confirmation, not just a dimension/alpha check.
- `pnpm typecheck` — failed once (`TS18048` in the new script, see
  Deviations), fixed, then passed clean (`tsc --noEmit`, no output/errors).
- `pnpm lint` — 0 errors, 44 warnings, all in pre-existing files unrelated to
  this change (confirmed by reading the full output and checking it contains
  no `pwa-install`, `manifest.ts`, `layout.tsx`, or `generate-maskable-icons`
  entries). Matches this repo's known pre-existing warning baseline per
  agent memory.
- `pnpm test` — full suite, 463/463 tests passed across 39 files, including
  the new `lib/__tests__/pwa-install.test.ts` (5/5 passed). No regressions.
- `pnpm build` (`prisma generate && next build`) — **failed twice on
  environment issues unrelated to this change**, then succeeded once on a
  bare `next build`:
  1. First attempt (`pnpm build`, which runs `prisma generate` first):
     failed with `EPERM: operation not permitted, rename ... query_engine-windows.dll.node`.
     Reproduced identically on a bare `pnpm db:generate` with zero code
     changes involved — a Windows file-lock on the Prisma query engine DLL,
     most likely held by one of several other `node.exe` processes I found
     running concurrently on this machine (`Get-Process node` showed 7
     running node processes). I did not kill any of them, since they may
     belong to other concurrent sessions/dev servers per this repo's known
     pattern of concurrent agent work.
  2. Second attempt (`npx next build`, skipping the `prisma generate` step
     since the client was already generated from a prior session): compiled
     and bundled successfully (webpack/TypeScript/ESLint-in-build all passed
     with only the same pre-existing warnings) but failed during static-page
     prerendering of `/setup-2fa` with
     `FATAL: (EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15`
     — this repo's local dev and production share one Supabase Postgres
     instance with a 15-connection pool (confirmed via this project's own
     agent memory on production operations), and concurrent sessions can
     exhaust it.
  3. Third attempt (`npx next build` again): succeeded completely — full
     route table printed with no errors, all static/dynamic pages built
     including `/setup-2fa` as `○ Static` this time. This confirms the
     failures above were transient DB-pool contention, not anything wrong
     with my changes (`app/manifest.ts`/`app/layout.tsx` compiled and
     bundled cleanly on every attempt, including the two that failed later
     at unrelated DB-dependent prerendering).
  4. I ran the build a fourth time afterward (to `grep` the output for
     "manifest"/"error") and it again hit the same
     `EMAXCONNSESSION` error, this time on `/offline` instead of
     `/setup-2fa` — further confirming this is intermittent pool contention
     tied to whichever DB-touching page happens to prerender while
     connections are scarce, not a fixed bug. I did not retry further to
     avoid adding more connection pressure to a shared instance other
     sessions may be using.

## Open items

- **`pnpm build` is not reliably green in this environment right now** due
  to shared-database connection-pool exhaustion from concurrent sessions —
  this is a known, pre-existing environment characteristic (see this
  project's own production-operations memory), not something introduced or
  fixable by this task. I did get one clean full `next build` pass with all
  63 routes built successfully and zero errors, which is sufficient evidence
  the code compiles/bundles correctly; the orchestrator may want to re-run
  `pnpm build` once when no concurrent sessions are hitting the shared DB, as
  a final gate.
- **`beforeinstallprompt` real-browser behavior is unverified**, exactly as
  flagged in the plan's Risks section — this pipeline has no live browser
  session and Chrome's engagement heuristics make the event unreliable to
  trigger even with one. What I verified instead: the component compiles,
  typechecks, and lints cleanly; it never throws or renders anything when
  the event never fires (confirmed by code read — `visible` starts `false`
  and only flips true inside the `beforeinstallprompt` handler); listener
  attach/cleanup is correctly paired; the `shouldShowInstallBanner` pure
  logic has real, passing unit coverage. Actual on-device confirmation that
  the banner appears, that clicking Install triggers the native prompt, and
  that dismissal survives a real reload needs the orchestrator's own live
  Chromium session across multiple page loads — this is aspirational/manual
  verification the plan already called out as out of this pipeline's reach.
- **No iOS/Safari custom "Add to Home Screen" UI was built**, per the
  request doc's explicit scope exclusion — flagged in the plan as a possible
  future idea only, not built here.
