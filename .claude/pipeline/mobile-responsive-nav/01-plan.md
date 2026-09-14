> Read together with `00-request.md`, which already contains the confirmed
> defect analysis and constraints. This plan does not re-derive those facts,
> only the concrete implementation design.

## Restated goal

Make the persistent app sidebar (`components/app-sidebar.tsx`, currently a
hardcoded `w-56` column that renders unconditionally at every viewport width)
collapse into a hamburger-triggered off-canvas drawer below the `md` (768px)
breakpoint, while leaving desktop sidebar behavior completely unchanged. This
is the third and final part of the "mobile PWA polish" effort; parts 1
(offline resilience) and 2 (installability) already shipped.

## Scope

**In scope:**
- Introduce shared open/close state for the mobile nav drawer, consumed by
  a hamburger button in `components/app-header.tsx` and a drawer in
  `components/app-sidebar.tsx`.
- Add the hamburger button (mobile-only, `md:hidden`) to the header.
- Add a mobile drawer/backdrop to the sidebar (mobile-only), reusing the
  exact nav content (links, active-state logic, bucket-aware sections) that
  already exists — no new/removed nav items.
- Hide the persistent desktop `<aside>` below `md`; make it visible at `md:`
  and above exactly as it renders today.
- Close-on-backdrop-click and close-on-navigate behavior for the drawer.

**Out of scope (per the request doc, restated for clarity):**
- No redesign of desktop nav/layout — above `md`, `git diff` on the rendered
  desktop DOM/behavior should be effectively zero.
- No new nav items, no removed nav items, no reordering.
- No changes to the shipped offline-indicator / install-prompt components.
- No changes to `app/layout.tsx`'s `viewport` export (already correct).
- No fix to the two `overflow-x-auto`-wrapped wide tables
  (`components/accounts/accounts-page-client.tsx`,
  `components/settings/duplicate-log-client.tsx`) — confirmed not bugs.
- No jsdom/RTL test infrastructure addition (see "Test expectations" below).
- No dashboard chart narrow-width investigation beyond a quick read-through
  (see Risks/unknowns) — not fixed in this task unless something concrete
  turns up.

## Affected files/modules

| File | Change |
|---|---|
| `components/app-shell-nav.tsx` | **New.** Client component holding the shared `mobileNavOpen` state; renders `AppHeader` + the sidebar/main flex row together so both consumers share one state instance. |
| `components/app-shell.tsx` | Modified. Delegates header+sidebar+main rendering to the new `AppShellNav` wrapper; collapses the two existing `Suspense` boundaries into one (see Risks/unknowns for why this is not a behavior change). |
| `components/app-header.tsx` | Modified. Add `onMenuClick: () => void` prop; render a `md:hidden` hamburger (`Menu` icon from `lucide-react`, already a dependency) styled like the existing `NotificationBell` icon-button. |
| `components/app-sidebar.tsx` | Modified. Add `mobileOpen: boolean` and `onMobileClose: () => void` props; hide the existing desktop `<aside>` below `md` (`hidden md:flex`, replacing plain `flex`); add a new mobile drawer (backdrop + slide-in panel) that reuses the existing nav-item JSX via an extracted internal (non-exported) `SidebarNavContent` sub-component to avoid duplicating the ~180 lines of link/section logic. |

No other files are touched. `AppHeader` and `AppSidebar` are confirmed
(via grep) to have exactly one import site each — `components/app-shell.tsx`
— so widening their prop signatures is safe and has no other call sites to
update.

## Design decision: how open/close state is shared

**Chosen approach: lift the toggle state into one new client wrapper
component (`AppShellNav`) that renders both `AppHeader` and `AppSidebar`
directly as props-driven children — not React Context.**

Reasoning:
- `AppHeader` and `AppSidebar` are *already* `"use client"` components today
  (confirmed by reading both files in full) — the only reason they don't
  already share state is that `AppShell` (the async Server Component parent)
  currently mounts each independently inside its own `Suspense` boundary,
  so there's no single client-side ancestor holding both. The fix isn't "we
  need cross-tree state sharing," it's "these two client components need a
  shared client parent" — which is a strictly simpler problem than Context.
- This repo has **zero existing uses of `createContext`/`useContext`**
  anywhere (confirmed by grep). Introducing Context here would be a
  first-of-its-kind pattern for a case that doesn't need it — plain prop
  drilling through one new wrapper is one `useState` and two prop pairs
  (`onMenuClick` / `mobileOpen`+`onMobileClose`), not a deep tree needing
  Context's "avoid prop drilling through many layers" benefit.
- It keeps the diff small and fully typed without a new `Provider`/hook file,
  and is trivially statically verifiable (no runtime Context-consumer-outside-
  Provider failure mode to worry about).
- The repo's own established small-client-component precedent
  (`GlobalErrorSafetyNet`, `OfflineIndicator`, `PwaInstallPrompt` in
  `app/layout.tsx`) is "small, focused, single-purpose client components" —
  a single wrapper holding one `useState` fits that spirit better than adding
  a new context/provider abstraction.

If a second, unrelated piece of cross-component client state shows up in a
future task, Context becomes the better trade-off then — not pre-emptively
here.

### `AppShellNav` shape

```tsx
"use client";
// components/app-shell-nav.tsx
interface AppShellNavProps {
  userName?: string;
  unreadCount: number;
  navBuckets: NavBucket[];
  logoUrl: string | null;
  businessSlugs: string[];
  children: React.ReactNode;
}

export function AppShellNav({ userName, unreadCount, navBuckets, logoUrl, businessSlugs, children }: AppShellNavProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  return (
    <>
      <AppHeader
        userName={userName}
        unreadCount={unreadCount}
        navBuckets={navBuckets}
        logoUrl={logoUrl}
        onMenuClick={() => setMobileNavOpen(true)}
      />
      <div className="flex flex-1 overflow-hidden">
        <AppSidebar
          businessSlugs={businessSlugs}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
        />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
        </main>
      </div>
    </>
  );
}
```

Passing the page's Server Component `children` through this client wrapper
is safe and idiomatic Next.js — a Server Component subtree passed as
`children` to a Client Component does not itself become client-rendered.

`AppShell` (`components/app-shell.tsx`) becomes:

```tsx
return (
  <div className="flex h-screen flex-col overflow-hidden bg-background">
    <Suspense fallback={<div className="h-14 border-b bg-background" />}>
      <AppShellNav
        userName={userName}
        unreadCount={unreadCount}
        navBuckets={navBuckets}
        logoUrl={logoUrl}
        businessSlugs={businessSlugs}
      >
        {children}
      </AppShellNav>
    </Suspense>
  </div>
);
```

Note: this merges the previous two `Suspense` boundaries (one around
`AppHeader`, one around `AppSidebar`) into one around `AppShellNav`, since
both must now be a single component instance to share state. This is *not*
a behavior change: `AppShell` already `await`s its `Promise.all(...)` for
`unreadCount`/`navBuckets`/`logoMeta` **before** returning any JSX (confirmed
by reading the file — there is no `<Suspense>`-driven data fetch happening
inside either child today), so nothing is actually deferred/streamed
independently between the header and sidebar today. The two separate
fallbacks were dead weight for independent streaming, not a live feature
being removed.

## Approach (ordered steps)

1. **Create `components/app-shell-nav.tsx`** per the shape above. Import
   `AppHeader` and `AppSidebar` the same way `app-shell.tsx` currently does.
2. **Modify `components/app-header.tsx`:**
   - Add `onMenuClick: () => void` to `AppHeaderProps` (required — single
     call site, so there's no reason to make it optional and risk a silent
     no-op).
   - Import `Menu` from `lucide-react`.
   - Render a hamburger `<button>` as the first child inside the header's
     inner flex row (before the logo `<Link>`), styled to match
     `NotificationBell`'s icon-button (`rounded-md p-2 text-muted-foreground
     hover:bg-accent`), with `md:hidden` added, `aria-label="Open navigation
     menu"`, `onClick={onMenuClick}`, containing `<Menu className="h-5 w-5" />`.
3. **Modify `components/app-sidebar.tsx`:**
   - Add `mobileOpen: boolean` and `onMobileClose: () => void` to
     `AppSidebarProps`.
   - Extract the existing `<nav>...</nav>` block and the footer
     `<div className="border-t ...">` block (everything currently inside
     `<aside>`) into a non-exported inner component, e.g.
     `SidebarNavContent({ ...same computed values..., onNavigate }: { onNavigate?: () => void })`,
     so the JSX isn't duplicated between the desktop and mobile render paths.
     Every `<Link>` inside it gets `onClick={onNavigate}` added (a no-op
     when `onNavigate` is `undefined`, i.e. the desktop render path).
   - Change the existing `<aside className="flex w-56 shrink-0 ...">` to
     `<aside className="hidden md:flex w-56 shrink-0 ...">` (only class
     change — everything else about the desktop render path is untouched)
     and have it render `<SidebarNavContent .../>` with no `onNavigate`.
   - Add a new mobile-only block, always mounted (not conditionally
     mounted/unmounted) so backdrop/panel can CSS-transition, gated by
     `mobileOpen` via classes rather than by conditional JSX, and by
     `md:hidden` so it never applies above the breakpoint:
     ```tsx
     <div className={cn("fixed inset-0 z-50 md:hidden", mobileOpen ? "pointer-events-auto" : "pointer-events-none")}>
       <div
         className={cn("fixed inset-0 bg-black/40 transition-opacity", mobileOpen ? "opacity-100" : "opacity-0")}
         onClick={onMobileClose}
         aria-hidden="true"
       />
       <aside
         className={cn(
           "fixed inset-y-0 left-0 z-50 flex w-64 max-w-[80vw] flex-col border-r bg-background shadow-xl transition-transform",
           mobileOpen ? "translate-x-0" : "-translate-x-full"
         )}
       >
         <div className="flex items-center justify-between border-b px-3 py-3">
           <span className="text-sm font-semibold">Menu</span>
           <button onClick={onMobileClose} aria-label="Close navigation menu" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent">
             <X className="h-4 w-4" />
           </button>
         </div>
         <SidebarNavContent onNavigate={onMobileClose} />
       </aside>
     </div>
     ```
     (`X` also imported from `lucide-react`, matching `NotificationBell`'s
     own close-button precedent.)
   - Add a `useEffect` keyed on `pathname` that also calls `onMobileClose()`
     on every pathname change, as a safety net for any navigation that
     doesn't go through a plain `<Link onClick>` (e.g. `router.push` calls
     elsewhere, though none currently exist inside the sidebar itself) —
     belt-and-suspenders alongside the per-`Link` `onClick`, not a
     replacement for it.
4. **Modify `components/app-shell.tsx`** to use `AppShellNav` as shown above,
   removing the now-redundant second `Suspense`/fallback and the inline
   sidebar/main flex row (moved into `AppShellNav`).
5. Run `pnpm typecheck` and `pnpm lint` and fix anything they flag.
6. Do not commit or push (per the request doc and standing pipeline rule —
   that's a separate, later step).

## Risks/unknowns

- **Live browser verification gap (flagged per the request doc's item 4):**
  this repo has no jsdom/DOM test environment (`vitest.config.ts` uses
  `environment: "node"`, no `jsdom`/`happy-dom` dependency, no
  `components/__tests__` directory anywhere — confirmed by reading
  `vitest.config.ts` and `package.json`) and the orchestrator's own tooling
  couldn't get a real narrow-viewport browser render this session. That
  means the *actual* open/close/backdrop-click/close-on-navigate drawer
  behavior **cannot be verified by an automated test in this task** and must
  be confirmed by the orchestrator's follow-up live-browser check (or by
  Eric manually testing on a phone) before this is considered fully done.
  What **is** staticaly verifiable and should be the Tester's actual
  checklist:
  - `pnpm typecheck` passes (no `any`, correct prop types on the four
    touched/new files).
  - `pnpm lint` passes.
  - `pnpm build` succeeds (confirms no RSC/client-boundary violation from
    passing `children` through `AppShellNav`).
  - Reading the rendered JSX/classes confirms: the desktop `<aside>` has
    `hidden md:flex` (not just `flex`); the hamburger button has `md:hidden`;
    the mobile drawer wrapper has `md:hidden`; the drawer's `z-50` sits above
    the header's `z-40`; every `<Link>` in `SidebarNavContent` receives
    `onClick={onNavigate}`; `AppHeader`'s and `AppSidebar`'s prop types
    correctly reflect the new required props with no stray `any`.
  - No regression to `pnpm test` (should stay at whatever count it's
    currently at — this task adds no new `lib/` logic, so no new unit tests
    are expected; see Test expectations).
- **Tablet-width ambiguity is an intentional simplification, not a gap:**
  using a single `md` (768px) breakpoint means a tablet in portrait
  orientation (e.g. iPad Mini at 768px exactly, or smaller) gets the mobile
  drawer treatment rather than the desktop sidebar, even though it's not a
  phone. This matches the app's only existing responsive precedent
  (`app-header.tsx`'s `sm:block` username) using the same binary-breakpoint
  approach, and `tailwind.config.ts` has no custom `screens` override for
  `md` (only `2xl` is customized) — so `md` here is the untouched Tailwind
  default (768px). Flagging this as a judgment call rather than silently
  deciding it — if Eric wants a `lg` (1024px) breakpoint instead to keep the
  desktop sidebar on tablets, that's a one-line change but changes the
  "in scope" boundary slightly from what the request doc suggested ("likely
  `md`").
  - **Recommendation (not applied unless approved):** keep `md`, since it's
    the codebase's only existing precedent and the request doc explicitly
    flagged `md` as the likely-correct choice.
- **Dashboard chart at narrow widths:** per the request doc, this is
  lower-priority and may not be practically verifiable without the same
  viewport-testing limitation. This plan does not include a fix for it. If
  the Coder reads the "Spending this month" chart component while in this
  file and finds something concretely broken (e.g. a hardcoded pixel width
  outside a responsive container), flag it back rather than silently fixing
  it — expanding scope here without a confirmed defect would violate "don't
  invent work."
- **No animation library exists in this repo** (confirmed: no
  `framer-motion` in `package.json`) — the drawer's slide/fade uses plain
  Tailwind `transition-transform`/`transition-opacity` classes only, which
  is a reasonable default but won't have easing/spring physics; not worth a
  new dependency for this.
- **`AppShellNav` is a new small always-mounted-while-authenticated client
  component** — it doesn't perfectly match the `app/layout.tsx` precedent
  (`GlobalErrorSafetyNet` etc. use inline `style={}` to dodge hashed-CSS-chunk
  risk on service-worker cache) because those are mounted from the *root*
  layout via the app shell chain, not `layout.tsx` itself, and every existing
  component in this exact file (`AppHeader`/`AppSidebar`) already uses
  Tailwind classes, not inline styles, so following the immediate siblings'
  convention (Tailwind) is more consistent here than the unrelated
  root-layout precedent.

## Acceptance criteria

1. At viewport widths **≥ 768px (`md` and above)**: page renders exactly as
   before this change — persistent sidebar always visible, no hamburger
   button visible, no drawer/backdrop in the DOM's interactive path. No
   visual/behavioral diff from the pre-change desktop experience.
2. At viewport widths **< 768px**: the persistent sidebar is not visible by
   default; a hamburger button is visible in the header at all times
   (doesn't require JS hydration to *appear* — it's part of the header's
   normal SSR'd markup, only its `onClick` requires hydration, same as every
   other button already in this header).
3. Tapping/clicking the hamburger button opens the drawer: backdrop dims the
   screen, nav panel slides in from the left, contains the same nav
   sections/links/active-highlighting as the desktop sidebar for the current
   bucket (no items added or removed).
4. Clicking the backdrop closes the drawer.
5. Clicking the explicit close (X) button in the drawer closes it.
6. Clicking any nav link inside the open drawer navigates AND closes the
   drawer (it does not stay open on the new page).
7. The drawer never renders above `md` width (verified via `md:hidden`
   class, not runtime JS).
8. `pnpm typecheck`, `pnpm lint`, and `pnpm build` all pass with no new
   errors/warnings.
9. `pnpm test` shows no regression from its current passing count (no
   `lib/` logic changed by this task, so no count change is expected either
   way).
10. No changes to nav item labels, hrefs, active-state logic, or
    bucket-aware section visibility (personal/business/tax/projects/footer)
    beyond what's needed to route the exact same content through both the
    desktop and mobile render paths.

## Test expectations

- **No new unit tests are expected in `lib/__tests__/`** — this task adds no
  new pure logic to `lib/`; it's purely component structure/JSX/class
  changes. Consistent with the repo's confirmed pattern (zero
  `components/__tests__` directory, `node`-only Vitest environment, no
  jsdom/RTL) — do not introduce a first-of-its-kind component test harness
  for this task.
- **Static verification only** from the automated pipeline: `pnpm typecheck`
  / `pnpm lint` / `pnpm build` passing, plus a manual read-through of the
  final diff confirming the breakpoint classes and close-handlers described
  above are all present and correctly wired (this is the Tester's real
  checklist given the no-DOM-test-environment constraint).
- **Live-browser verification is required before this is truly "done"** but
  is explicitly a follow-up step outside what an automated Tester can
  confirm in this repo today: open/close via hamburger tap, backdrop-click
  close, link-click close+navigate, and confirming the desktop breakpoint
  boundary at exactly 768px, ideally on an actual phone or a working
  narrow-viewport browser tool (not the `resize_window` tool that was
  confirmed broken in this session's environment). Call this out explicitly
  in the Tester's report rather than silently treating static checks as
  sufficient proof the feature works.
