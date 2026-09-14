# Request

Tier 4 "mobile PWA polish," part 3 of 3 (part 1, offline resilience, shipped `7b87b67`; part 2, installability, shipped `1232fc0`). This part: mobile-responsive layout audit.

## Important tooling constraint (why this task is scoped the way it is)

The orchestrator could not get a genuine narrow-viewport (phone-width) live browser render in this session — `resize_window` on the available Chrome automation tab reports success but `window.innerWidth` stays at desktop width (1920px) regardless, a real environment limitation, not something to work around by guessing. So this task is grounded in **static code reading**, not live visual confirmation — the orchestrator identified one clear, high-confidence, high-impact defect this way (see below) and did a broader grep pass that came back otherwise clean. Treat the one confirmed defect as the priority; treat anything else in "possible secondary items" below as lower-confidence and worth a second look by you, not an assumed bug.

## Confirmed defect (read directly by the orchestrator, don't re-derive)

**The app shell's sidebar never collapses on any screen size.** `components/app-shell.tsx` renders `<AppSidebar />` unconditionally inside a `flex` row next to `<main>`, with no responsive wrapper (no `hidden md:block`, no breakpoint logic anywhere in the file). `components/app-sidebar.tsx` itself is `<aside className="flex w-56 shrink-0 flex-col border-r bg-background">` — a hardcoded 224px-wide column with 6-9 nav items in the "core" section alone, plus bucket-specific sections (personal/business/tax/projects) and a footer section (Vault/Tags/Tag Rules/Settings). On an actual phone viewport (~390px wide, the modern baseline), this sidebar alone would consume well over half the screen, leaving roughly 166px for `<main>`'s actual content — unusable. This is the single highest-impact mobile defect in the app; everything else found is secondary.

`components/app-header.tsz` already has ONE responsive pattern to follow as precedent: `<span className="hidden text-sm text-muted-foreground sm:block">{userName}</span>` — hides the username below the `sm` breakpoint. This repo's existing overlay/modal convention (see `components/business/gl-backfill-modal.tsx`) is `<div className="fixed inset-0 z-50 ... bg-black/40 px-4">` for a full-screen backdrop.

## Scope

**In scope — the sidebar fix:**
1. Below a reasonable breakpoint (likely `md:` = 768px, matching this codebase's only other responsive reference point — confirm this is sound rather than assuming), hide the persistent sidebar and add a hamburger/menu button (in `components/app-header.tsx`, which already has the icon-button pattern via `NotificationBell`/sign-out — follow that button style) that opens the nav as an off-canvas drawer (slide-in panel + backdrop overlay, following the `fixed inset-0 z-50 bg-black/40` convention already used for modals in this repo) or a full-screen sheet — your call on exactly which, but it must: close on backdrop click, close on navigating to a new page (so it doesn't stay open after tapping a link), and not require JS to already be interactive before the header/hamburger button itself is visible (avoid a flash of a broken/unclickable header).
2. Above the breakpoint, current always-visible desktop sidebar behavior must be completely unchanged — this is a mobile-only addition, not a redesign of desktop nav.
3. `AppSidebar` currently has no open/close state at all (it's rendered by the parent `AppShell`, a Server Component, with no props for visibility) — you'll need to introduce that state somewhere client-side. Decide the cleanest approach given `AppShell` is an async Server Component (can't hold `useState` itself) — likely a new small client wrapper component holding the open/closed state, with `AppHeader`'s hamburger button and `AppSidebar`'s drawer both consuming it (e.g. via React context, or by lifting the toggle+drawer into one client component that wraps both). Look at how `app/layout.tsx`'s existing small always-mounted client components (`GlobalErrorSafetyNet`, `OfflineIndicator`, `PwaInstallPrompt`) are structured for this repo's conventions, though none of those needs cross-component shared state — this is the first case that does, so use your judgment on the cleanest idiomatic approach (React Context is probably right here) and explain the choice.

**Possible secondary items — investigate, but only fix if you find a real, concrete issue (don't invent work):**
- Any other page/component with a hardcoded pixel width that isn't inside an `overflow-x-auto` wrapper (the orchestrator's own grep for `w-\[Npx\]`/`min-w-\[Npx\]` patterns found the two wide `<table>` instances that exist already correctly wrapped in `overflow-x-auto` — `components/accounts/accounts-page-client.tsx` and `components/settings/duplicate-log-client.tsx` — so those are NOT bugs, don't touch them; the grep otherwise came back clean, but re-check since static grep can miss dynamically-composed classNames).
- `app/layout.tsx`'s `viewport` export already sets `width: "device-width", initialScale: 1` correctly — don't touch.
- Any obviously-broken chart/graph rendering at narrow widths (e.g. the dashboard's "Spending this month" bar chart) — flag if you find something concrete by reading the component, but this is lower priority than the sidebar and may not be practically fixable without the same viewport-testing constraint that blocked the orchestrator; don't over-invest here.

**Explicitly out of scope:**
- No redesign of desktop nav/layout.
- No new nav items, no removal of existing nav items.
- No touching the already-shipped offline/install-prompt components from parts 1-2.

## Ground rules (CLAUDE.md)

TypeScript strict. This is the core navigation shell used on every authenticated page — be careful, this has the largest blast radius of any UI change in this session (if broken, it breaks navigation for the whole app, not just one page).

## Your job (Planner)

1. Read `components/app-shell.tsx`, `components/app-sidebar.tsx`, `components/app-header.tsx`, and `app/layout.tsx` in full.
2. Design the exact component structure for introducing shared open/close state across the header (button) and sidebar (drawer) given `AppShell` is a Server Component — decide between React Context, lifting state into one new client wrapper, or another approach, and justify it.
3. Specify the exact breakpoint, drawer/sheet visual treatment (width, slide direction, z-index relative to the existing `sticky top-0 z-40` header and the `z-50` modal convention — the drawer must appear above the header but the ordering relative to any open modal doesn't matter since a user can't meaningfully have both open), and close-on-navigate/close-on-backdrop-click behavior.
4. Given this repo has no jsdom/DOM test environment (confirmed by prior PWA-polish tasks' Planners), plan for live browser verification as the acceptance method for the actual drawer open/close/navigate behavior — note this explicitly, and specify what IS staticaly verifiable (correct conditional rendering logic, correct breakpoint classes, no TypeScript/lint errors) vs. what needs the orchestrator's follow-up.
5. List every file to be created/modified and precise acceptance criteria for the Tester.

Do not write implementation code. Do not commit or push. Write the plan to `.claude/pipeline/mobile-responsive-nav/01-plan.md`.
