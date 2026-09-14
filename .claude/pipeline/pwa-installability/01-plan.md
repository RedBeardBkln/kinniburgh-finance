# Plan: PWA installability (maskable icon + custom install prompt)

## Restated goal

Fix the PWA's maskable home-screen icon so Android's adaptive-icon masking
doesn't clip the "BANANA"/"STAND" banner text, and add a small Chromium-only
custom "Install app" UI driven by `beforeinstallprompt`/`appinstalled`, since
today installability relies entirely on each browser's native default UI.

## Scope

**In scope:**
1. A one-time `sharp`-based script that generates safe-zone-padded maskable
   variants of the 192×192 and 512×512 icons, checked into `public/` as new
   static files; `app/manifest.ts`'s `maskable` purpose entries repointed at
   them (the `any` purpose entries keep pointing at the original full-bleed
   files).
2. A small always-mounted client component that listens for
   `beforeinstallprompt`/`appinstalled` and shows a dismissible "Install
   Banana Stand for faster access" banner with Install/Dismiss actions on
   Chromium browsers only, doing nothing everywhere else.

**Explicitly out of scope (per the request doc, don't touch):**
- No iOS/Safari custom "Add to Home Screen" instruction UI.
- No `apple-touch-startup-image` splash-screen generation.
- No changes to the branding/custom-logo feature (`app/settings/branding/`,
  `/api/logo`, `lib/settings.ts`'s `getLogoMeta`/`getFaviconMeta`) — the PWA
  manifest icons stay hardcoded to the static `web-app-manifest-*.png`
  files, not wired to `/api/logo`. Leave that separation exactly as-is.
- No changes to `public/apple-touch-icon.png` or `public/favicon*` — already
  correctly sized.
- No changes to `public/sw.js` — confirmed by reading it in full: it only
  precaches `/offline` and intercepts navigation requests, nothing icon- or
  asset-related. New PNG files need no service-worker changes.

## Affected files/modules

**New files:**
- `scripts/generate-maskable-icons.ts` — one-time generation script (run
  once by the Coder, output committed to the repo; not a runtime code path).
- `public/web-app-manifest-192x192-maskable.png` — generated output.
- `public/web-app-manifest-512x512-maskable.png` — generated output.
- `components/pwa-install-prompt.tsx` — the install-prompt client component.
- `lib/pwa-install.ts` — pure decision-logic helper extracted from the
  component (see Approach step 5 for why).
- `lib/__tests__/pwa-install.test.ts` — unit tests for the above.

**Modified files:**
- `app/manifest.ts` — repoint the two `purpose: "maskable"` icon entries at
  the new files.
- `app/layout.tsx` — mount `<PwaInstallPrompt />` alongside
  `<GlobalErrorSafetyNet />` and `<OfflineIndicator />`.
- `package.json` — add a `generate:maskable-icons` script entry (see
  Approach step 2) for discoverability/future regeneration, matching the
  existing `import:tags`/`import:budgets` pattern.

**Not modified (confirmed by reading):** `public/sw.js`,
`app/settings/branding/page.tsx`, `/api/logo`, `lib/settings.ts`,
`public/apple-touch-icon.png`, `public/favicon*`.

## Approach

### Part A — maskable icon generation

1. **Confirm the safe-zone problem is real.** Viewed
   `public/web-app-manifest-512x512.png` directly: full-bleed "Banana Stand"
   logo — a green ribbon/banner reading "BANANA" across the top and "STAND"
   across the bottom, both close to the image edge, on a radial-gradient
   green background (lighter yellow-green center fading to darker olive-green
   at the corners — **not a flat/solid color**). Confirms the orchestrator's
   description: this will clip under Android's circular/squircle adaptive-icon
   mask if reused as-is for `purpose: "maskable"`.

2. **Write `scripts/generate-maskable-icons.ts`.** No existing `sharp` usage
   pattern exists anywhere in this repo to follow — despite the request
   doc's note that it's "used elsewhere for image processing," a repo-wide
   grep found zero `import sharp` call sites (the one text match outside
   `package.json`/lockfiles was the unrelated word "sharper" in
   `components/tax/personal-tax-client.tsx`'s UI copy). `sharp` is a real
   `devDependency` (`^0.35.4`, not a runtime `dependency`), consistent with
   it only ever being used in one-off build-time scripts like this one, run
   via `tsx` the same way `scripts/import-tags.ts` and
   `scripts/import-budgets.ts` already are. Script logic, for each of the
   two source sizes (192, 512):
   - Read the source file (`public/web-app-manifest-{size}x{size}.png`) with
     `sharp()`.
   - **Sample a fill color from the source itself, don't hardcode one.**
     Extract the 1×1 pixel at the source's top-left corner
     (`.extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()`)
     and read its RGB — this is the darkest edge tone of the existing radial
     gradient, and is what the manifest's `#d97706` amber theme color would
     visibly clash against (the source art is green, not amber). Use the
     sampled RGB as the canvas fill. This is a deliberate deviation from
     "use the manifest's background_color" — flagged under Risks below.
   - Resize the source to 80% of the target canvas size
     (`Math.round(size * 0.8)`), preserving the existing 1:1 aspect ratio.
   - Create a new opaque canvas at the full target size
     (`sharp({ create: { width: size, height: size, channels: 3,
     background: sampledRgb } })`) — 3 channels / no alpha, so the output can
     never be transparent.
   - Composite the resized image centered on the canvas
     (`left`/`top` = `Math.round((size - innerSize) / 2)`).
   - `.flatten({ background: sampledRgb })` before encoding, as a second
     guard against any residual alpha, then `.png().toFile(...)`.
   - Write to `public/web-app-manifest-{size}x{size}-maskable.png`.
   - Log the sampled RGB/hex to stdout so the Coder/Tester can eyeball
     whether it looks reasonable without needing to open an image viewer.

3. **Invocation:** add to `package.json`'s `scripts` block:
   `"generate:maskable-icons": "tsx scripts/generate-maskable-icons.ts"`.
   Coder runs `pnpm generate:maskable-icons` once, locally, and commits the
   two resulting PNGs — this is a static-output script, never called at
   request time or during `pnpm build`.

4. **Update `app/manifest.ts`:** change the two `purpose: "maskable"` entries'
   `src` to the new `-maskable.png` filenames. Leave the two `purpose: "any"`
   entries pointing at the original files unchanged.

### Part B — custom install prompt

5. **Extract pure decision logic into `lib/pwa-install.ts`, per this repo's
   established "pure-decision-module" pattern** (see `lib/card-due.ts`,
   `lib/cc-funding.ts`, `lib/budget-pace.ts` precedent): since
   `vitest.config.ts` runs with `environment: "node"` and there is no
   jsdom/RTL setup anywhere in the repo (confirmed: no `components/__tests__`
   directory exists), the component's DOM/event-wiring itself can't be unit
   tested — but its one piece of real decision logic (when to show the
   banner) can be pulled out as a pure, testable function:
   ```ts
   // lib/pwa-install.ts
   export function shouldShowInstallBanner(opts: {
     hasDeferredPrompt: boolean;
     isStandalone: boolean;
     dismissed: boolean;
   }): boolean {
     return opts.hasDeferredPrompt && !opts.isStandalone && !opts.dismissed;
   }
   ```
   `lib/__tests__/pwa-install.test.ts` covers all 2^3 combinations. This
   gives the Tester one real `pnpm test`-verifiable piece of this feature
   instead of everything being browser-only.

6. **`components/pwa-install-prompt.tsx`** — `"use client"`, structured like
   `components/offline-indicator.tsx` (the most recent precedent for a small
   always-mounted client component): local `interface BeforeInstallPromptEvent
   extends Event` (this event isn't in `lib.dom.d.ts`) with `platforms:
   string[]`, `userChoice: Promise<{ outcome: "accepted" | "dismissed";
   platform: string }>`, `prompt(): Promise<void>`.
   - State: `deferredPrompt: BeforeInstallPromptEvent | null`, `visible: boolean`.
   - On mount (`useEffect`, matching `OfflineIndicator`'s pattern of reading
     browser state only inside the effect, never in the `useState`
     initializer, to avoid SSR/hydration mismatches):
     - If `window.matchMedia("(display-mode: standalone)").matches`, do
       nothing further (already installed).
     - Read `localStorage.getItem("pwaInstallDismissed")` for prior dismissal.
     - Attach a `beforeinstallprompt` listener: `event.preventDefault()`,
       store the event, then set `visible` via
       `shouldShowInstallBanner({ hasDeferredPrompt: true, isStandalone,
       dismissed })`.
     - Attach an `appinstalled` listener: clear `deferredPrompt`, `setVisible(false)`.
     - Clean up both listeners on unmount.
   - Install button: `await deferredPrompt.prompt()`, then
     `await deferredPrompt.userChoice` (result not branched on beyond
     clearing state — Chrome only allows the prompt once regardless of
     outcome), then clear `deferredPrompt` and hide.
   - Dismiss button: `localStorage.setItem("pwaInstallDismissed", "1")`,
     hide. **Decision: dismissal is permanent (no time-based re-prompt).**
     Justified because (a) this is a 2-person household app with two known,
     returning users — re-nagging every session once someone has actively
     said no is worse than just leaving Chrome's native install icon
     available in the address bar as the fallback path; (b) no existing
     precedent in this repo for a time-boxed "snooze" pattern to reuse, and
     inventing one adds complexity the request doesn't call for. Flagged
     as a judgment call under Risks below in case the user disagrees.
   - Rendering: inline styles (no Tailwind classes), matching
     `OfflineIndicator`'s exact convention. Fixed at the **bottom** of the
     viewport (not top, where `OfflineIndicator` already renders, to avoid
     the two banners ever visually stacking/colliding), amber/theme-colored,
     factual copy per CLAUDE.md's "no marketing tone" instruction: "Install
     Banana Stand for faster access" plus "Install" / "Not now" buttons.
     `role="status"`/`aria-live="polite"` matching `OfflineIndicator`.
   - Return `null` when `!visible` (mirrors `OfflineIndicator`).

7. **Mount in `app/layout.tsx`**, directly after `<OfflineIndicator />`.

## Risks/unknowns

- **The request doc's claim that `sharp` is "already used elsewhere for
  image processing" does not hold up** — verified by grepping the whole repo
  for `sharp` and reading `lib/supabase-storage.ts` in full: the logo/favicon
  upload path (`uploadLogoFile`/`downloadFile`) stores raw uploaded bytes
  with no image processing at all. This will be the **first real `sharp`
  usage** in the codebase. Not a blocker (the package is already an
  installed `devDependency`), but there's no existing call-site convention
  to match — the Coder is establishing one. Flagging so nobody assumes an
  existing pattern was "followed."
- **80% safe-zone scale vs. stricter official Android guidance.** The
  request doc specifies "roughly the inner 80%," which this plan follows
  literally. Google's official adaptive-icon spec technically defines the
  guaranteed-visible safe zone as a centered circle of only ~66% diameter
  (108dp canvas / 66dp safe circle) — some aggressive launcher masks could
  still clip content right at the 80% square's corners-adjacent extremities.
  Given this is a personal 2-user app (not a Play Store submission subject
  to strict review), 80% matches the request doc's explicit instruction and
  is a reasonable middle ground; not going stricter unless asked.
- **Background fill color is sampled from the source image's corner pixel
  at generation time, not hardcoded to the manifest's `#d97706` theme
  color.** The request doc explicitly allows this ("unless the source art
  has its own dominant background color that would look more correct — use
  judgment"). The source's actual background is amber-clashing green, so
  using `#d97706` would look visibly wrong (a hard amber square behind a
  green-bordered circular logo). This is a judgment call the Coder should
  sanity-check visually (view the generated file) before considering the
  task done, since the source has a *gradient*, not a flat color, and corner
  sampling is an approximation, not a guaranteed "best" pick.
- **`beforeinstallprompt` is not reliably testable in this pipeline.**
  Chrome only fires it after internal engagement heuristics are satisfied
  (prior visits, time-on-site, etc.) that don't reliably trigger in a fresh
  automated session, and this repo has zero DOM/browser test infrastructure
  (`vitest.config.ts` is `environment: "node"`, no jsdom, no RTL, confirmed
  by reading the config and finding no `components/__tests__` directory).
  What the Tester **can** verify: `pnpm typecheck`/`pnpm lint`/`pnpm build`
  succeed; the component compiles and mounts without throwing when the event
  never fires (the realistic case in any headless/CI-style check); the
  `shouldShowInstallBanner` unit tests pass; a manual code read confirms
  `preventDefault()` is called, listeners are attached/detached correctly,
  and no UI renders when `beforeinstallprompt` never fires. What the Tester
  **cannot** verify here: that the banner actually appears in a real Chrome
  session, that clicking Install actually triggers the native OS install
  flow, or that dismissal persistence survives a real reload. That requires
  a live, authenticated browser session (the orchestrator's own browser
  access, if any, across multiple real page loads) — call this out
  explicitly as aspirational/manual-only verification, not something to
  block the pipeline on.
- **Permanent (non-expiring) dismissal is a judgment call**, not something
  the request doc mandated either way — flagged above in step 6, and again
  here in case the user wants a time-boxed re-prompt instead (e.g., re-show
  after 30 days). Easy to change later; not building it speculatively now.
- **Possible future idea, explicitly NOT being built now** (per the request
  doc's own instruction to flag rather than build): a custom "Add to Home
  Screen" instructional overlay for iOS/Safari users, since `beforeinstallprompt`
  doesn't exist there and Safari's manual share-sheet flow is easy to miss.
  Noting this as a possible Tier 5+ idea only.

## Acceptance criteria

1. `public/web-app-manifest-192x192-maskable.png` and
   `public/web-app-manifest-512x512-maskable.png` exist, are valid PNGs,
   have exactly the same pixel dimensions as their non-maskable counterparts
   (192×192 and 512×512 respectively), and contain no transparent pixels
   (alpha fully opaque, or no alpha channel at all).
2. Viewing the generated maskable files shows the logo artwork visibly
   smaller and centered, with a solid-color border/margin around it (no
   banner text touching the image edge) — i.e., the "BANANA"/"STAND" text is
   now inside a safe margin, not full-bleed.
3. `app/manifest.ts`'s two `purpose: "maskable"` entries point at the new
   `-maskable.png` files; the two `purpose: "any"` entries are unchanged and
   still point at the original full-bleed files.
4. `scripts/generate-maskable-icons.ts` exists, is re-runnable
   (`pnpm generate:maskable-icons`) without errors, and is not imported or
   invoked from any runtime request path (`app/`, `actions/`, `lib/` used at
   request time).
5. `components/pwa-install-prompt.tsx` is mounted in `app/layout.tsx` and
   renders nothing (`null`) unless a `beforeinstallprompt` event has fired
   and not been dismissed/already-installed.
6. The component never throws and shows no UI on browsers/environments that
   never fire `beforeinstallprompt` (the default state for every automated
   check in this pipeline).
7. Dismissing the banner persists via `localStorage` and the banner does not
   reappear on a subsequent mount within the same browser storage (verified
   via code read, not a live reload, per the testability note above).
8. `appinstalled` firing clears the prompt state and hides the banner.
9. `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass, including the new
   `lib/__tests__/pwa-install.test.ts`.
10. `pnpm build` succeeds (confirms `app/manifest.ts` and
    `app/layout.tsx` changes compile cleanly).
11. No changes anywhere to `app/settings/branding/*`, `/api/logo`,
    `lib/settings.ts`, `public/apple-touch-icon.png`, `public/favicon*`, or
    `public/sw.js`.

## Test expectations

- **Unit tests (real, `pnpm test`-verified):** `lib/__tests__/pwa-install.test.ts`
  covering `shouldShowInstallBanner()` across all combinations of
  `hasDeferredPrompt`/`isStandalone`/`dismissed` — this is the one piece of
  this feature with genuine automated regression coverage, per the repo's
  pure-decision-module pattern.
- **No unit test for the `sharp` generation script** — it's one-off I/O
  (reads/writes files), not a pure function, consistent with this repo's
  existing convention of not unit-testing DB/IO-touching wrapper code (see
  `lib/notifications.ts`'s `checkXxx` wrappers, similarly untested directly).
  Verify it instead by actually running it and inspecting the output files
  (dimensions, non-transparency) — either via the `Read` tool (view the
  images) or a tiny throwaway Node/`sharp` `.metadata()` check, not a
  permanent test file.
- **No jsdom/RTL test for `components/pwa-install-prompt.tsx`** — this repo
  has zero DOM/component test infrastructure and this task should not be the
  one to invent it for a single small component (flagging, not building,
  per Risks above). Verification is: typecheck/lint/build passing, a careful
  code read against the acceptance criteria above, and — if the orchestrator
  has live authenticated browser access at Tester/Reviewer time — best-effort
  manual verification in a real Chromium session, explicitly labeled
  aspirational/non-blocking if it can't be triggered.
- **Edge cases that matter for the pure logic:** `dismissed=true` always
  wins regardless of `hasDeferredPrompt`; `isStandalone=true` always wins
  (never show an install prompt inside an already-installed PWA shell, even
  if a stray event somehow fired); `hasDeferredPrompt=false` alone is
  sufficient to hide it (the common no-event case).
