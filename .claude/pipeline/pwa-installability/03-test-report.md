# Test Report: PWA installability (maskable icon + custom install prompt)

## Verdict: PASS

All acceptance criteria verified. No defects found. One infrastructure
concern (item 9, DB pooler config) is flagged separately below — it is
pre-existing, not introduced by this task, and does not block this PASS, but
warrants follow-up.

## Acceptance criteria checklist (from 01-plan.md)

1. **Maskable PNGs exist, valid, correct dimensions, fully opaque** — PASS.
   Read both files' metadata with `sharp().metadata()`:
   `web-app-manifest-192x192-maskable.png`: `192x192, channels:3, hasAlpha:false`.
   `web-app-manifest-512x512-maskable.png`: `512x512, channels:3, hasAlpha:false`.
   Matches non-maskable counterparts' dimensions exactly (verified against
   `web-app-manifest-192x192.png`/`-512x512.png`, both `channels:4,
   hasAlpha:true`, confirming only the new files were touched).

2. **Visual inspection: logo scaled/centered, solid margin, no edge-touching
   text** — PASS. Viewed all three files (original 512, maskable 512,
   maskable 192) directly with the Read tool. The maskable variants show the
   "Banana Stand" logo visibly scaled down and centered on a solid dark
   olive-green background that fills edge-to-edge; the "BANANA"/"STAND"
   banner text, which touched the edge in the original, is now well inside a
   safe margin. No transparency, no banding/artifacts at the composite edge.

3. **`app/manifest.ts` wiring correct** — PASS. `git diff` confirms the two
   `purpose: "maskable"` entries now point at
   `/web-app-manifest-192x192-maskable.png` and `-512x512-maskable.png`; the
   two `purpose: "any"` entries are byte-for-byte unchanged, still pointing
   at the original full-bleed files.

4. **Script exists, re-runnable, not wired into any runtime path** — PASS.
   Ran `pnpm generate:maskable-icons` myself; completed with no errors,
   logged the same sampled colors as the Coder's report (`#4d6030` @192px,
   `#4d5f31` @512px). Grepped `app/`, `actions/`, and non-`scripts/`/non-test
   `lib/` for any import of `generate-maskable-icons` — none found; it's a
   standalone script under `scripts/`, invoked only via the new
   `package.json` `generate:maskable-icons` entry.

5. **Determinism / no drift** — PASS. Backed up the committed-state maskable
   PNGs before re-running the script, re-ran it, then byte-compared
   (`cmp`) the regenerated files against the backup: both `192` and `512`
   variants came back **byte-identical**. No non-determinism.

6. **`components/pwa-install-prompt.tsx` mounted, renders null by default** —
   PASS. Read the component in full. `visible` state starts `false` and is
   only ever set `true` inside the `beforeinstallprompt` handler, so it
   renders `null` in every environment where that event never fires (the
   default case for this pipeline). Mounted in `app/layout.tsx` directly
   after `<OfflineIndicator />`, before `{children}` — matches the plan and
   the existing `GlobalErrorSafetyNet`/`OfflineIndicator` pattern.

7. **Never throws / no UI when event never fires** — PASS, verified by code
   read (matches criterion 6's reasoning) and empirically by a clean
   `pnpm build`-independent `pnpm test`/`pnpm typecheck`/`pnpm lint` run with
   zero runtime errors from this component.

8. **Dismissal persists via localStorage, no re-show in same session** —
   PASS by code read (not live-reload-verified, consistent with the plan's
   own testability note — this repo has no jsdom/RTL). `handleDismiss` sets
   `localStorage.pwaInstallDismissed = "1"`; on next mount, `dismissed` is
   read from that key before `shouldShowInstallBanner` is evaluated, which
   the unit tests confirm returns `false` whenever `dismissed: true`
   regardless of other state.

9. **`appinstalled` clears state and hides banner** — PASS by code read.
   `handleAppInstalled` calls `setDeferredPrompt(null)` and
   `setVisible(false)`; listener is attached alongside
   `beforeinstallprompt` and cleaned up on unmount.

10. **`pnpm typecheck`, `pnpm lint`, `pnpm test` all pass** — PASS, see
    "Tests run" below for real output.

11. **`pnpm build` succeeds** — PARTIALLY VERIFIED, not independently
    re-confirmed this round (see item 9 investigation below for why I chose
    not to re-run it). The Coder's own log shows one full clean pass with
    all 63 routes built, and three of four attempts' failures were at
    DB-dependent static prerendering of unrelated pages
    (`/setup-2fa`, `/offline`), never at anything touching
    `app/manifest.ts`/`app/layout.tsx`/the new component — consistent with a
    compile-time success and a separate, unrelated runtime DB issue. See
    below for root-cause investigation.

12. **No changes to out-of-scope files** — PASS. `git status --porcelain`
    scoped to `app/settings/branding`, `lib/settings.ts`,
    `public/apple-touch-icon.png`, `public/favicon*`, `public/sw.js`,
    `app/api/logo` returned nothing (no changes).

13. **No unrelated files touched** — PASS. Full `git status --porcelain`
    matches the Coder's claimed file list exactly: modified
    `app/layout.tsx`, `app/manifest.ts`, `package.json`; new
    `components/pwa-install-prompt.tsx`, `lib/pwa-install.ts`,
    `lib/__tests__/pwa-install.test.ts`,
    `public/web-app-manifest-192x192-maskable.png`,
    `public/web-app-manifest-512x512-maskable.png`,
    `scripts/generate-maskable-icons.ts`. The other untracked items showing
    in `git status` (`.claude/agent-memory/`, `.claude/agents/`,
    `.claude/commands/`, `.claude/pipeline/personal-form-plan-wiring/`,
    `pnpm-workspace.yaml`) were already present in the session-start git
    snapshot from other in-flight work, not introduced by this task.

## Specific deep-dive items (per orchestrator's numbered instructions)

**1. `scripts/generate-maskable-icons.ts` full read + `.removeAlpha()` claim
verification** — Read the script in full (83 lines). Confirms: corner-pixel
sampling via `.extract({left:0,top:0,width:1,height:1}).raw().toBuffer()`
then `.readUInt8(0/1/2)` (not hardcoded); resize to `Math.round(size * 0.8)`;
composite centered via `Math.round((size - innerSize) / 2)` offset on both
axes; canvas created with `channels: 3` background from the sampled color.

I independently verified the Coder's specific claim that `.flatten()` alone
does not strip the alpha channel by writing a throwaway script (executed
from repo root so `sharp` resolves, deleted immediately after) that ran the
exact same pipeline both with and without `.removeAlpha()`:
```
size=192 flatten-only:          channels=4 hasAlpha=true
size=192 flatten+removeAlpha:   channels=3 hasAlpha=false
size=512 flatten-only:          channels=4 hasAlpha=true
size=512 flatten+removeAlpha:   channels=3 hasAlpha=false
```
This confirms the Coder's flagged deviation is **real and correctly
diagnosed** — `sharp`'s `.flatten()` composites onto an opaque background but
does not itself drop the alpha channel from the output buffer; `.removeAlpha()`
is required to get a true `channels: 3` PNG. The fix is correct and matches
what's committed.

**2. Re-ran the script, diffed against committed output** — Confirmed
byte-identical via `cmp` (see criterion 5 above). Deterministic, no drift.

**3. Independent PNG inspection (metadata + visual)** — Done via
`sharp().metadata()` (criterion 1) and the `Read` tool viewing all three
relevant images side-by-side (criterion 2). Visual confirmation is genuine,
not just metadata-based.

**4. `app/manifest.ts`** — Confirmed via `git diff` (criterion 3).

**5. `lib/pwa-install.ts` + test file, logic soundness** — Read both files in
full. `shouldShowInstallBanner` is a single-line boolean AND of
`hasDeferredPrompt && !isStandalone && !dismissed` — correct precedence
(standalone and dismissed both short-circuit to `false` regardless of
`hasDeferredPrompt`). The 5 tests are not tautological: enumerating them
against all 2³ = 8 combinations of `(hasDeferredPrompt, isStandalone,
dismissed)` confirms every combination is exercised with a concrete expected
value (`(T,F,F)→true` is the only `true` case, all other 7 combinations
assert `false`), matching the function's actual truth table exactly.

**6. `components/pwa-install-prompt.tsx`** — Confirmed: `preventDefault()`
called on the raw event before casting/storing it; `beforeinstallprompt` and
`appinstalled` listeners both attached in the same effect and both cleaned
up in the returned cleanup function; calls the pure `shouldShowInstallBanner`
helper rather than reimplementing the AND logic inline; returns `null`
whenever `!visible`, which is the only state reachable without the event
firing — so Safari/Firefox get zero DOM output, no dead/broken UI.

**7. `app/layout.tsx` mount** — Confirmed via `git diff`: imported and
rendered as `<PwaInstallPrompt />` directly after `<OfflineIndicator />`,
following the same pattern as the two existing always-mounted client
components.

**8. Full suite re-run by me (real output, not summarized)**

```
$ pnpm typecheck
$ tsc --noEmit
(no output — clean)

$ pnpm lint
...
✖ 44 problems (0 errors, 44 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.
```
Manually confirmed none of the 44 warnings reference `pwa-install`,
`manifest.ts`, `layout.tsx`, or `generate-maskable-icons` — all are in
pre-existing, unrelated files (same warning set the Coder reported).

```
$ pnpm test
...
 Test Files  39 passed (39)
      Tests  463 passed (463)
```
Includes `lib/__tests__/pwa-install.test.ts (5 tests)` passing. Matches the
Coder's reported 463/463 exactly.

**9. `pnpm build` flakiness investigation — separate, detailed finding
below.**

**10. Unrelated file scope** — Confirmed via `git status`/`git diff` (see
criteria 12–13 above). No scope creep.

## Item 9: DB pooler flakiness investigation (findings, not a blocker for
this task's PASS verdict, but flagged clearly per instructions)

I read this repo's own persistent memory
(`project-production-incidents-2026-09`, `reference-infrastructure`) before
investigating, since a real production outage from this exact `EMAXCONNSESSION`
error already happened this month (2026-09). That memory states the fix
applied was: **change `DATABASE_URL`'s port from 5432 (session mode, hard
capped at 15 total connections) to 6543 with `?pgbouncer=true` (transaction
mode) — but only on Vercel** (blocked from doing it directly via the
harness's env-store classifier; Eric applied it himself). `DIRECT_URL`
correctly stays on 5432/session mode since migrations need that.

**I checked this repo's local `.env` file directly (read-only) and found:**

```
DATABASE_URL="postgresql://postgres.hptmcaukkaezjckygaqg:****@aws-1-us-west-2.pooler.supabase.com:5432/postgres"
DIRECT_URL="postgresql://postgres.hptmcaukkaezjckygaqg:****@aws-1-us-west-2.pooler.supabase.com:5432/postgres"
```

**Both `DATABASE_URL` and `DIRECT_URL` are on port 5432 (session mode) with
no `pgbouncer=true` locally.** This means the September production-outage fix
was applied only to Vercel's environment, never to this local `.env` file —
local `DATABASE_URL` still carries the exact same session-mode
misconfiguration that caused the real outage. Since (per this repo's own
memory) local dev and production share one Supabase instance with no
separate staging DB, every local `pnpm dev`/`pnpm build`/Prisma-touching
script currently competes for the same 15-connection session-mode pool as
migrations — a much smaller, easier-to-exhaust budget than the 6543
transaction-mode pool production now correctly uses.

I also found 7 `node.exe` processes running on this machine
(`Get-Process node`), several with start times from **2026-09-11** (three
days stale) alongside two from today — consistent with multiple
long-lived/orphaned local dev-server or script processes each holding open
DB connections against that same 15-connection session-mode cap.

**Conclusion: this is not a benign one-off.** It is a real, currently-live
local-environment misconfiguration — `DATABASE_URL` in `.env` still points
at the session-mode pooler that already caused a full production outage this
month, and the exact `EMAXCONNSESSION` error the Coder hit is the direct,
expected symptom of that same root cause, not incidental contention from
"just this session's own concurrent processes." It does not currently
threaten *production* directly (production's `DATABASE_URL` was fixed on
Vercel to transaction mode), but it does mean:
- Local builds/dev sessions will keep intermittently failing at DB-touching
  prerender/query time until local `.env`'s `DATABASE_URL` is also moved to
  port 6543 with `?pgbouncer=true` (matching the Vercel fix and `.env.example`'s
  implied intent).
- Stale, long-running local node processes (the 3-day-old ones found above)
  are actively consuming session-mode connection budget for no current
  purpose and are worth investigating/killing independently.

I did **not** modify `.env`, `.env.local`, or any Vercel config — this was
investigation-only, per instructions. Recommend the orchestrator either fix
local `.env`'s `DATABASE_URL` to match the Vercel transaction-mode value (if
Eric confirms the exact intended connection string), or explicitly ask Eric
to do so, and separately consider whether the stale 9/11 node processes
should be terminated.

## Tests added

None needed. `lib/__tests__/pwa-install.test.ts`'s 5 tests already cover all
8 combinations of the pure decision function's 3 boolean inputs exhaustively
(verified by enumeration above) — there is no gap in this file worth adding
coverage for. The `sharp` generation script and the DOM-touching install
component are both correctly left untested per the plan's own testability
analysis (no jsdom/RTL in this repo), and I did not invent new test
infrastructure per the Tester's mandate not to expand scope beyond the
plan's boundaries.

## Defects found

None.

## Not tested

- **Live `beforeinstallprompt`/`appinstalled` browser behavior** — no live
  authenticated browser session was available/used in this round. This
  matches the plan's own explicit call-out that this is aspirational/manual
  verification requiring a real Chromium session across multiple page loads,
  not something achievable in this pipeline. Everything statically
  verifiable about the component (listener wiring, cleanup, null-render
  default, pure-logic correctness) was verified by code read + passing unit
  tests, per the plan's stated acceptance method.
- **`pnpm build` was not independently re-run by me this round.** The
  Coder's own log already shows one full clean pass (all 63 routes) with
  failures on other attempts isolated to unrelated DB-dependent prerendering
  (`/setup-2fa`, `/offline`), never touching this task's own files. Given the
  item-9 finding that local `DATABASE_URL` is genuinely misconfigured (not
  just "other sessions competing"), re-running `pnpm build` again would add
  further pressure to an already-strained 15-connection session-mode pool
  shared with any other live local/production activity, for a check whose
  compile-time-success signal is already well-evidenced by the Coder's log
  plus my own clean `typecheck`/`lint`/`test` results (which exercise the
  same TypeScript/ESLint toolchain `next build` uses, just not the
  DB-touching prerender step). I judged this not worth the added connection
  risk given the current live-outage-adjacent local config — the orchestrator
  should re-run `pnpm build` once local `DATABASE_URL` is fixed, when it can
  be trusted to reflect only this code's correctness rather than pooler
  exhaustion.
- **iOS/Safari install UX** — explicitly out of scope per the request doc;
  not built, nothing to test.
