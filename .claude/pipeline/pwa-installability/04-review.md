# Review: PWA installability (maskable icon + custom install prompt)

## Verdict: APPROVED

## What I checked

- Read `00-request.md`, `01-plan.md`, `02-implementation.md`, `03-test-report.md` (PASS) in full.
- Read the actual diff (`git diff -- app/layout.tsx app/manifest.ts package.json`), the three new
  source files (`scripts/generate-maskable-icons.ts`, `lib/pwa-install.ts`,
  `components/pwa-install-prompt.tsx`), the new test file, and `components/offline-indicator.tsx`
  as the style/structure precedent it's meant to match.
- Viewed the original `web-app-manifest-512x512.png` and both new
  `-maskable.png` files directly (visual, not just metadata).
- Independently re-ran `pnpm typecheck`, `pnpm lint`, `pnpm test` from a clean shell — all green,
  463/463 tests, 0 lint errors (44 pre-existing warnings, none in touched files).
- Confirmed `sharp` is a `devDependency` (not `dependencies`) and grepped `app/` for any import of
  the generation script — none found, confirming it's not a runtime code path.
- Confirmed via `git diff --stat` and `git log -1` that `app/settings/branding`, `app/api/logo`,
  `lib/settings.ts`, `public/apple-touch-icon.png`, `public/favicon*`, and `public/sw.js` are all
  genuinely untouched (last commit touching any of them is `7b87b67`, the prior part-1 task, not
  this one).

## Findings

**None blocking.**

- (nit) `scripts/generate-maskable-icons.ts` samples the fill color from a single corner pixel of a
  radial gradient, which is an approximation the plan itself already flagged as a judgment call with
  a visual sanity-check requirement. I did that visual check myself (not just trusting the Coder's/
  Tester's description) — the sampled olive-green blends convincingly with the source art's own
  edge tone, no visible seam or clash. No action needed.
- (nit, already disclosed) The 80%-scale safe zone is looser than Android's official ~66%-diameter
  adaptive-icon safe-circle spec. This was explicitly requested by the request doc's own wording
  ("roughly the inner 80%") and flagged as a known trade-off in the plan's Risks section, appropriate
  for a 2-user personal app, not a Play Store submission. Not a defect — re-flagging only so it's on
  record in case Eric later wants a stricter margin.
- (nit) The custom install banner and `OfflineIndicator` both use `position: fixed` with
  `zIndex: 9999`, one pinned `top: 0` and the other `bottom: 0` — the plan explicitly chose bottom to
  avoid stacking collision, and I confirmed that's what's implemented. No overlap, but if both banners
  were ever visible simultaneously (offline + not-yet-installed), the user would see two amber bars at
  once — visually busy but not broken, and an edge case (an offline user is unlikely to also see a
  fresh `beforeinstallprompt` fire). Not blocking.

## What's good

- The maskable icon fix is real and independently verified by me, not just trusted from the reports:
  viewed all three images side by side, the "BANANA"/"STAND" banner text that touched the edge in the
  original is now clearly inset with a solid margin in both new files, and the fill color doesn't
  clash.
- `app/manifest.ts`'s `any`/`maskable` purpose entries are correctly separated exactly as required —
  `any` entries untouched, pointing at the original full-bleed files; `maskable` entries repointed at
  the new files.
- `lib/pwa-install.ts`'s `shouldShowInstallBanner()` is a clean, single-expression pure function with
  exhaustive test coverage (I hand-verified the 5 tests cover all 8 combinations of the 3 booleans,
  not just the happy path).
- `components/pwa-install-prompt.tsx` correctly mirrors `OfflineIndicator`'s established conventions
  (inline styles, browser-state reads confined to `useEffect`, paired listener cleanup), calls
  `preventDefault()` before stashing the event, checks `display-mode: standalone` before doing
  anything, and returns `null` by default — so Safari/Firefox (and an already-installed shell) get
  zero DOM output, no dead UI. This is the realistic default state for every environment in this
  pipeline, and I confirmed it by code read plus a clean independent `pnpm typecheck`/`lint`/`test`.
  Install-prompt copy is factual ("Install Banana Stand for faster access"), matching CLAUDE.md's
  no-marketing-tone instruction for user-facing text.
  Not verified live in a browser — this was correctly scoped by the plan as aspirational/manual-only
  given this pipeline has no live browser session and no jsdom/RTL infrastructure; nothing here
  should have blocked on that, and it didn't.
- Scope discipline is clean: no iOS custom install UI, no splash-screen generation, branding/`/api/logo`
  feature genuinely untouched (confirmed by diff, not just trusted from the report), `public/sw.js`
  untouched. `sharp` correctly stays a `devDependency`, confirming the generation script is a one-time
  tool and not a runtime cost.
- The Tester's `pnpm build` flakiness investigation (local `.env` still on session-mode Postgres port
  5432 instead of the transaction-mode fix already applied on Vercel) is a real, useful finding but is
  explicitly out of scope for this task per the orchestrator's framing — correctly not held against
  this review.

No route-back needed.
