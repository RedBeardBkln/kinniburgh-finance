# Implementation: mobile-responsive-nav

Implemented exactly per `01-plan.md` (no plan deviations). Summary below.

## Summary of changes

### `components/app-shell-nav.tsx` (new)
Client component (`"use client"`) holding the single `mobileNavOpen` `useState`.
Renders `AppHeader` (passing `onMenuClick={() => setMobileNavOpen(true)}`) and
the `flex flex-1 overflow-hidden` row containing `AppSidebar`
(`mobileOpen={mobileNavOpen}`, `onMobileClose={() => setMobileNavOpen(false)}`)
and `<main>`, exactly matching the plan's specified shape. `children` (the
page's Server Component subtree) is passed through as a prop, which is valid
Next.js App Router composition — it doesn't force the subtree to become
client-rendered.

### `components/app-shell.tsx`
- Replaced the `AppHeader`/`AppSidebar` imports with a single `AppShellNav`
  import.
- Collapsed the two separate `Suspense` boundaries (one around `AppHeader`,
  one around `AppSidebar`) into one around `AppShellNav`, since both children
  now need to share one client component instance for the state to work.
  Confirmed via reading the file that `AppShell` already `await`s all its data
  (`unreadCount`, `navBuckets`, `logoMeta`) before returning JSX, so no
  independent per-child streaming was actually happening before — this merge
  is not a behavior change.
- No other changes; the `redirect("/setup-2fa")` 2FA gate and the
  `Promise.all` data-fetching logic are untouched.

### `components/app-header.tsx`
- Added required `onMenuClick: () => void` to `AppHeaderProps` (single call
  site in `AppShellNav`, so making it required rather than optional avoids a
  silent no-op if ever missed).
- Imported `Menu` from `lucide-react`.
- Added a `md:hidden` hamburger `<button>` as the first child of the header's
  inner flex row (before the logo), styled to match the existing
  `NotificationBell` icon-button convention (`rounded-md p-2
  text-muted-foreground hover:bg-accent`), with `aria-label="Open navigation
  menu"` and `onClick={onMenuClick}`, containing `<Menu className="h-5 w-5" />`.
  It's part of the header's normal SSR'd markup (not conditionally rendered
  post-hydration), so it's visible immediately; only its `onClick` needs
  hydration, same as every other button already in this header.

### `components/app-sidebar.tsx`
- Added `mobileOpen: boolean` and `onMobileClose: () => void` to
  `AppSidebarProps`.
- Extracted all the previously-inline `<nav>`/footer JSX into a new
  non-exported `SidebarNavContent` component (`SidebarNavContentProps`
  includes `pathname`, `activeBucket`, the four bucket-boolean flags,
  `buildHref`, `isActive`, and an optional `onNavigate?: () => void`). Every
  `<Link>` inside it now has `onClick={onNavigate}` added (a no-op when
  `onNavigate` is `undefined`, i.e. the desktop path) — this satisfies
  "close on link click" without duplicating the ~200 lines of
  nav-section/link JSX between desktop and mobile.
- `AppSidebar` itself now: computes the same bucket-derived state as before,
  renders the desktop `<aside className="hidden w-56 shrink-0 flex-col
  border-r bg-background md:flex">` (only class change from `flex` to
  `hidden ... md:flex`, everything else about the desktop path unchanged),
  containing `<SidebarNavContent {...navProps} />` (no `onNavigate`).
- Added a mobile-only drawer block (`fixed inset-0 z-50 md:hidden` wrapper,
  backdrop `div` with `bg-black/40` + `transition-opacity`, and an `<aside>`
  panel `fixed inset-y-0 left-0 z-50 w-64 max-w-[80vw] ... transition-transform`
  with `translate-x-0`/`-translate-x-full` toggling on `mobileOpen`), always
  mounted (not conditionally JSX-mounted) so the CSS transitions actually
  animate, gated purely by Tailwind classes. Contains a "Menu" header row with
  an `X` close button (`aria-label="Close navigation menu"`, matching
  `NotificationBell`'s own close-button precedent) and
  `<SidebarNavContent {...navProps} onNavigate={onMobileClose} />`.
- Added a `useEffect` keyed on `pathname` that calls `onMobileClose()` on every
  pathname change, as the belt-and-suspenders safety net specified in the
  plan (in addition to, not instead of, the per-`Link` `onClick`).

No nav items, hrefs, active-state logic, or bucket-aware section visibility
were changed — only the structural extraction and the added `onClick`/close
wiring.

## Deviations from the plan

None. Implementation matches the plan's file list, component shapes, class
names, and design rationale (prop-drilling via one new client wrapper instead
of React Context) exactly.

## Commands run and their results

- `pnpm typecheck` (`tsc --noEmit`) — **clean, no output, exit 0.**
- `pnpm lint` — **0 errors, 44 warnings**, all pre-existing and in files I did
  not touch (confirmed by reading the full warning list — none reference
  `app-shell.tsx`, `app-shell-nav.tsx`, `app-header.tsx`, or `app-sidebar.tsx`).
  Matches the repo's known ~44-warning baseline per agent memory.
- `pnpm test` (`vitest run`, full suite) — **463/463 passed across 39 files**,
  matching the last-known baseline exactly (no regression, no new tests added
  — consistent with the plan's "Test expectations": this task adds no new
  `lib/` pure logic, so zero new unit tests is correct, not a gap).
- `pnpm build` (`prisma generate && next build`) — **`prisma generate` failed
  3 consecutive times** with `EPERM: operation not permitted, rename ...
  query_engine-windows.dll.node.tmpNNNN -> query_engine-windows.dll.node`.
  Confirmed via `tasklist` that multiple other `node.exe` processes are
  currently running on this machine (other concurrent sessions), matching a
  previously-documented environment issue (Windows DLL lock from concurrent
  sessions, not a code problem — see agent memory
  `build-flaky-shared-db-pool.md`). I did not kill those processes to force
  it through, per standing guidance not to touch other sessions' processes.
  To still get real build-level confidence given this change touches the core
  app shell, I ran `npx next build` directly (bypassing the blocked `prisma
  generate` step, using the already-generated Prisma client already present
  from a prior session) — **this succeeded cleanly: all 63 routes compiled
  and prerendered/generated with zero errors**, and the ESLint pass embedded
  in `next build` reported the same 44 pre-existing warnings and nothing new.
  This confirms there is no RSC/client-boundary violation from passing the
  Server Component `children` through the new `AppShellNav` client wrapper,
  and no build-breaking issue in any of the four touched/new files. I did not
  get a fully clean `prisma generate && next build` run end-to-end in this
  session due to the environment contention described above — flagging this
  explicitly rather than claiming the exact `pnpm build` script passed
  end-to-end.

## What was verified statically vs. what needs live-browser confirmation

**Verified by reading the final code (static, high confidence):**
- Desktop `<aside>` has `hidden md:flex` (not plain `flex`).
- Hamburger button has `md:hidden` and is part of the header's normal SSR
  markup (not conditionally mounted post-hydration).
- The mobile drawer wrapper (backdrop + panel) has `md:hidden` on its outer
  container, so it can never apply at `md` and above regardless of
  `mobileOpen` state.
- The drawer's `z-50` sits above the header's `z-40` (`sticky top-0 z-40`).
- Every `<Link>` in the extracted `SidebarNavContent` receives
  `onClick={onNavigate}` (verified by reading every occurrence in the final
  file — all 4 core-item groups plus the 4 footer links).
- `AppHeader`'s and `AppSidebar`'s prop types correctly reflect the new
  required props (`onMenuClick`, `mobileOpen`, `onMobileClose`) with no `any`
  anywhere — confirmed by `pnpm typecheck` passing clean.
- `AppHeader` and `AppSidebar` each have exactly one import/call site
  (`components/app-shell-nav.tsx` now; previously `app-shell.tsx`) —
  reconfirmed by grep before editing, so widening their prop signatures had
  no other call sites to update.

**NOT verified — requires the orchestrator's live-browser follow-up (per the
plan's own explicit scoping, this repo has no jsdom/DOM test environment):**
- Actual hamburger-tap-opens-drawer behavior at a real narrow viewport.
- Actual backdrop-click-closes-drawer behavior.
- Actual X-button-closes-drawer behavior.
- Actual link-click-navigates-and-closes-drawer behavior.
- Visual correctness of the slide-in/fade transition (no animation library in
  this repo; plain Tailwind `transition-transform`/`transition-opacity` only,
  per the plan).
- The exact 768px breakpoint boundary behavior in a real browser (Tailwind's
  untouched default `md` — confirmed no custom `screens.md` override in
  `tailwind.config.ts`, only `2xl` is customized).

## Open items

- None outside the plan's already-flagged live-browser verification gap
  (see above) — that gap is expected and explicitly scoped as a follow-up
  step in `01-plan.md`, not a defect in this implementation.
- `pnpm build`'s `prisma generate` step is currently blocked by environment
  contention (concurrent sessions holding a DLL lock) unrelated to this
  change — see "Commands run" above. Worth a full clean `pnpm build` re-run
  once other sessions on this machine are idle, though `next build` alone
  already gives strong confidence the change itself is sound.

## Fix round 2 (response to `04-review.md`, verdict CHANGES_REQUESTED)

### Blocking finding fixed: closed mobile drawer was still keyboard-focusable

**Root cause:** the mobile drawer wrapper (`components/app-sidebar.tsx`) is
deliberately always-mounted (not conditionally rendered) so the
slide/fade CSS transitions can animate on open/close. It was hidden only via
`opacity-0` / `-translate-x-full` / `pointer-events-none` — none of which
remove an element from the keyboard tab order. `pointer-events: none` blocks
mouse/touch only. Result: below `md`, tabbing through the header landed on
the entire off-screen nav (every core item, bucket section, footer link)
before reaching page content, on every load, even when the drawer was never
opened. Confirmed by re-reading the actual CSS properties in play, matching
the review's analysis exactly — this was a real bug, not a false positive.

**Fix applied:** added `inert={!mobileOpen}` to the drawer's outer wrapper
`<div>` (the one carrying `fixed inset-0 z-50 md:hidden` and the
`pointer-events-auto`/`pointer-events-none` toggle), in
`components/app-sidebar.tsx`. This is the first suggested fix direction from
the review. Confirmed viable, not just assumed:

- `package.json` has `"react": "^19.3.0"` and `"@types/react": "^19.3.0"` —
  React 19 supports `inert` as a first-class typed JSX boolean prop on DOM
  elements (no `as any`/custom attribute cast needed).
- `inert` is applied to the *wrapper* div (which contains both the backdrop
  and the sliding `<aside>` panel), not just the panel — this also makes the
  backdrop's `onClick={onMobileClose}` non-interactive while closed, which is
  correct (there is nothing to close when the drawer is already closed) and
  matches the existing `pointer-events-none` intent already applied to the
  same wrapper for mouse/touch.
- `inert` removes the entire subtree from both the tab order and the
  accessibility tree while leaving it mounted in the DOM, so the CSS
  `transition-transform`/`transition-opacity` classes are untouched and the
  slide/fade animation is preserved exactly as before — this was the reason
  the plan chose always-mounted over conditional rendering in the first
  place, and the fix doesn't undo that.
- When `mobileOpen` is `true`, `inert={false}` — React omits the `inert`
  attribute entirely in that case (verified by reading React's handling of
  boolean DOM attributes), so the open drawer is fully focusable/interactive
  exactly as before this fix; nothing about the *open* drawer's behavior
  changed.

Diff (in `components/app-sidebar.tsx`):
```tsx
<div
  className={cn(
    "fixed inset-0 z-50 md:hidden",
    mobileOpen ? "pointer-events-auto" : "pointer-events-none"
  )}
  inert={!mobileOpen}
>
```

### Non-blocking note re-checked: merged `Suspense` boundary now wraps `children`

Read `components/app-shell.tsx` and traced how `AppShell` is invoked
(`git diff` + grepping all 51 call sites, e.g. `app/page.tsx`,
`app/transactions/page.tsx`): `AppShell` is only ever called from inside an
async `page.tsx` Server Component that itself fully `await`s all its data
before returning JSX, and `AppShell` itself also `await`s its own data
(`unreadCount`, `navBuckets`, `logoMeta`) before constructing any JSX. By the
time the tree with the merged `Suspense` boundary is built, `children` is
already fully-resolved, already-rendered data being passed through as a
prop — there is no live suspend point inside it anywhere in the current
codebase (no `use()` calls, no independently-streaming child fetches found).
Any real page-load delay is caught by the route's own `loading.tsx` (43 of
them, confirmed via the reviewer's own `find`), which wraps the *entire*
async `page.tsx` function — including its call into `AppShell` — one level
further out than anything inside `AppShell` itself. So the merged boundary's
`h-14` fallback is not reachable in practice today. This matches the
reviewer's own conclusion ("low-risk... nearer boundary will almost always
win first"). No code change made — confirmed concretely, not merely assumed,
per the task's ask to eyeball this rather than skip it.

### Commands re-run after the fix

- `pnpm typecheck` (`tsc --noEmit`) — **clean, no output, exit 0.**
- `pnpm lint` — **0 errors, 44 warnings**, identical warning list to before
  the fix (same pre-existing files, none in `app-sidebar.tsx` or any of the
  other three touched/new files).
- `pnpm test` (`vitest run`, full suite) — **463/463 passed across 39
  files**, unchanged from before the fix (this task still adds no new
  `lib/` logic, so no new test count change is expected).
- `pnpm build` was not re-attempted end-to-end in this round (the
  environment's `prisma generate` DLL-lock contention documented in the first
  round is unrelated to this one-line/one-attribute change and was already
  independently reproduced and worked around by the Reviewer via
  `npx next build`, which succeeded cleanly). The fix here is a single JSX
  attribute addition with no import/dependency change, so it carries no new
  build/RSC-boundary risk beyond what was already verified.

### Open items (updated)

- The blocking finding from `04-review.md` is fixed and verified via
  typecheck/lint/test as above, plus a manual re-read of the resulting
  `inert`/class logic (not just assumed fixed by adding the attribute, per
  the task's instruction).
- Live-browser verification (drawer open/close/backdrop/navigate behavior,
  and now also: confirm via a real screen reader or keyboard-only pass that
  Tab no longer lands on the closed drawer's links) remains the same
  pre-existing follow-up gap noted in round 1 — still outside what this
  repo's no-jsdom/no-RTL test environment can confirm automatically.
- `pnpm build`'s `prisma generate` DLL-lock environment contention (round 1)
  remains unrelated to this task's code and was already independently
  reproduced/worked-around by the Reviewer.
