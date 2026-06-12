# Kickoff — How to Build This with Claude Code

## One-time setup

1. Create a new project folder (e.g., `kinniburgh-finance`) and copy the CONTENTS of this package into it, so `CLAUDE.md`, `specs/`, and `data/` sit at the repo root.
2. Initialize git: `git init && git add -A && git commit -m "specs"`.
3. Open a terminal in that folder and run `claude` (Claude Code).
4. Have ready (not required to start, but needed during the build): Plaid developer account (Sandbox keys to start), a Postgres database URL (Neon/Supabase), a Vercel account, and — before Phase 5 — the QuickBooks/CPA chart-of-accounts export.

## Initial prompt to paste into Claude Code

> Read CLAUDE.md and all files in specs/ in numbered order, plus the two CSVs in data/. Then:
> 1. Confirm your understanding by summarizing the four entities, the seven TD/JCSB/QuickBooks bank accounts and their envelope rules, and the items in specs/07-source-data-notes.md — including the owner decisions you must respect and the remaining open items you must ask me about rather than assume.
> 2. Begin Phase 0 of specs/06-build-plan.md. Do not skip the import-validation script: tags 2026.csv must yield 135 tags, and budgets 2026 v2 (with accounts).csv must yield 53 budget lines totaling $16,489/mo with the documented account mapping.
> 3. Never invent a dollar amount, account number, date, or rule that is not in the specs. If you need a value that's missing, stop and ask me.
> 4. After each phase, show me what was built and wait for my approval before continuing.

## Working rhythm

- **One phase per session** is a sensible pace; start each session with "Read CLAUDE.md, then continue from where the build plan left off."
- Before Phase 3 (Plaid), switch Plaid from Sandbox to Production (requires Plaid's approval process — start that application early, it can take days).
- Before Phase 5 (business books/taxes), supply the QuickBooks chart-of-accounts export and confirm the Oct 15, 2026 extended-deadline date with your CPA.
- When the app first runs with real data, it should ask you for: property values (27 Old Barry Rd, 56 Arbor Rd), loan balances if Plaid can't pull them, the Auto Insurance line update (~$217/mo), and approval of the proposed Slush Funds and savings transfers.

## Guardrails to hold Claude Code to

- All money math covered by tests before a phase is "done" (transfer schedules, rollovers, accrual pacing, $250-minimum warnings).
- No secrets in the repo; Plaid tokens encrypted; no account numbers in logs or notifications.
- Tax-related records are never hard-deleted.
- The app provides data-driven observations, not investment/tax advice; tax outputs are drafts for a CPA.
