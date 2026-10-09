# Review: recurring-followups (collapse, two-account names, past-due wording, Suspense, tag picker + editable name, pre-confirm Budgets notice)

## Verdict: APPROVED

No blocking findings. The one documentation gap (CLAUDE.md, Tester defect 1) is owned by the coordinator and is listed as should-fix, not a code change. The other three Tester defects are deferred with reasons below. Nothing needs to go back to the Coder or Planner.

## What I did

Read 00-04 of recurring-detection (04-review.md included), 02-implementation.md and 03-test-report.md of this task, CLAUDE.md ground rules, then the real code and diffs: `actions/recurring-suggestions.ts`, `lib/recurring-name.ts`, `lib/recurring-series-marker.ts`, `lib/recurring-add-step.ts`, `lib/recurring-budget-hint.ts`, `lib/recurring-budget-hint-build.ts`, full diffs of `lib/recurring-detect.ts`, `lib/recurring-detect-build.ts`, `lib/upcoming-ledger.ts`, `lib/upcoming-ledger-input.ts`, `lib/upcoming-ledger-view.ts`, `app/page.tsx`, `app/forecast/page.tsx`, `components/upcoming/{suggestion-actions,recurring-suggestions,tag-options,upcoming-parts}.tsx`, `components/forecast/recurring-expenses-section.tsx`, plus `app/budgets/page.tsx` (the override logic the hint must mirror), `lib/advisor/queries/schedule.ts`, `lib/advisor-context.ts`, `actions/recurring-expenses.ts`.

Independently run now: `pnpm typecheck` exit 0, no output. `pnpm vitest run lib/__tests__/recurring lib/__tests__/upcoming`: 28 files, 667 passed, 8 skipped (the `UL_OLD` differential tests, skipped without the HEAD copy; the Tester ran them separately). I did not rerun lint or the full 250 s suite; I relied on the Tester's full-suite pass (12,115 plus their additions) and my targeted run. `git status`: the modified set equals the implementation's list; `lib/forecast.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `prisma/**` unchanged; no `zz-*`/scratch file left; `pnpm-workspace.yaml` and `scripts/setup-eva-account.ts` are untracked and not part of this change. No console.log/debugger/`any` in the new lib files. I edited no source and staged/committed nothing.

## Ground rules

- **Rule 1 (no fabrication): pass.** Amount, frequency, day and next date are built only from the server's re-run of the detector (`found`); the request type carries `{entityId, seriesKey, tagId, name?}` and zod drops everything else. The "~$X a month" figures are sums of real medians via the same `monthlyEquivalentCents` that `/budgets` uses (I read `app/budgets/page.tsx` lines 104-115 and the hint matches: linked monthly equivalents + `additionalAmountCents` replace the stored amount when any recurring expense is linked). The Tester also verified the arithmetic against all 56 live Budget rows (0 mismatches).
- **Rule 5 (security): pass.**
  - `requireAuth()` is the first statement of every export (unchanged, test-pinned). The Suspense sections run only after the page's `auth()`+`redirect` (static pins, 15 mutants killed by the Tester).
  - The client cannot influence money: confirmed by reading the action. `chosenName` only feeds `name`; `tagId` is checked with `db.tag.findUnique` (the schema really has no archived/entity column on Tag; the Coder added a schema-reading test that fails if that changes, which is the right answer to the request's unsatisfiable "archived/entity" wording).
  - Name validation (`validateRecurringName`): NFKC, strips `\p{Cf}`, collapses whitespace, 1..80, rejects `<>` and control chars, rejects SSN/EIN/card/long digit runs via the AI Return Reviewer's `findRedactionIssues`, never echoes the input, runs before any DB or loader call. React escapes on render. Good. Residual: it does not catch an address or a phone number; acceptable for a free-text label the owner types for himself.
  - Marker `[pattern:<entityId>|<accountId>|out|<canonical payee>]`: uuids plus a canonical payee that is stripped to `[a-z0-9 ]`, so no account number, no `%`/`_`/`]` that could act as a LIKE wildcard or break the regex. The trailing `]` makes the `contains` lookup exact (`netflix` cannot match inside `netflix inc`). Length: seriesKey is capped at 300 by zod, notes worst case is about 430 of 500.
- **Rule 6 (personal/business separation): pass.** Group key still entity + account + sign; the series rule, account rule and `matchRows` are all scoped to the same entity; a marker for another entity can never match. Tags are household-wide in this schema (the existing Recurring Expenses form already offers every tag to every entity), so linking an EK Consulting expense to a personal tag is possible exactly as it is today; this is a pre-existing property, disclosed by the Coder, not introduced here.
- **Rule 8 (observational wording, no advice): pass.** Read every new string: "Looks recurring, not counted", "Expected around Oct 6, not posted yet", the amber budget note ("Linking recurring expenses to a category replaces the budget shown on Budgets with their monthly total ... You can change it on Budgets afterwards."), the server notice ("worth a look that they agree" is the softest phrase in the batch and is a heads-up about two records, not a financial recommendation). No should/must/recommend in the changed UI. The learned monthly figure is explicitly labelled "not an amount due" and is absent from the all-entities heading.

## The [pattern:...] marker: where `RecurringExpense.notes` is read or shown

I grepped every `recurringExpense` use under actions/, app/, components/, lib/, scripts/, prisma/ and app/api.

| Reader | Reads notes? | Marker can leak? |
|---|---|---|
| `components/forecast/recurring-expenses-section.tsx` (table) | yes | No: renders `visibleNotes(exp.notes)`, marker stripped. Only place notes are displayed. |
| `lib/upcoming-ledger-input.ts` -> `collectModelledRefs` | yes (`notes: true`, server only) | No: only `seriesKeyFromNotes` consumes it; notes never reach `UpcomingItem` or any Ui type. |
| `app/budgets/page.tsx` | `findMany` without select (loads notes) | Not used or rendered (verified: no `notes` reference in the page or `budget-page-client.tsx`). |
| `lib/advisor/queries/schedule.ts` (tool `list_recurring_and_scheduled`) | no (explicit select, header comment says notes never selected) | No. |
| `lib/advisor-context.ts` (tool `get_financial_overview`) | loads the full row via `include` | No: prints only name, entity, amount, frequency (lines 237-240). Nit: it would be tidier with a select, pre-existing. |
| `actions/recurring-expenses.ts` | `updateRecurringExpense` accepts notes | No UI calls it (grep: only its own file). Latent only: a future edit form that writes notes back from the raw column would drop or expose the marker; use `visibleNotes` + re-append there. |
| `lib/forecast.ts`, `lib/notifications.ts`, exports | do not touch RecurringExpense rows' notes | n/a |

Conclusion: the marker is safe, hidden everywhere a person reads notes, never sent to the advisor, and cannot confuse another consumer. Deleting the row removes the link cleanly (the series returns to the review list), which is the right failure mode.

## Budget-override interaction

Adequately warned BEFORE Confirm. The note appears as soon as a category with a Budget row for that entity is selected or pre-selected (polite `role="status"`, wired to the select's `aria-describedby`), states the current budget, what Budgets will show afterwards and the arithmetic (this one + already linked + additional amount), mentions a tied scheduled bill, and degrades to a generic line when the read fails (Confirm still works). The server then repeats a post-hoc notice. The loader is read-only (exactly three explicit-select `findMany`, source-pinned), uses the same UTC period `/budgets` opens on, and keys by `entityId|tagId` as the page does when scoped to an entity. Confirm is not blocked by the note; given the owner asked for a notice rather than a gate, that is correct. Known limits (all disclosed, none blocking): a Budget row in a different period gets no notice; a parent line that auto-sums children is described only as "no amount of its own"; in the all-entities Budgets view `/budgets` keys recurring expenses by tag alone across entities, so the entity-keyed note can understate that one view.

## Suspense restructure

Correct. `auth()` and `redirect("/login")` stay at the top of both pages before the first `<Suspense>`; `loadUpcomingLedger(` now appears once, inside the section component; the dashboard widget is still gated by `isCurrentPeriod`; the keyed boundary re-shows the skeleton on bucket/horizon/transfers changes; the outer try/catch, the inner `toUiDetection` try/catch (null = pattern checks failed, undefined = ledger failed) and `err.name`-only logging are preserved verbatim. `loadBudgetHints` never rejects, so starting it before the ledger await cannot cause an unhandled rejection even when the ledger throws. Error semantics are slightly different by nature of streaming (a throw during render of a section would now surface at the nearest error boundary after the shell has flushed, rather than 500-ing the whole response), which is acceptable and arguably better. Skeletons carry `id="upcoming"`/`id="looks-recurring"` so anchors resolve. Not verifiable without a browser: streaming order, no layout jump, anchor scroll after streaming, reduced motion, actual latency gain (the Coder never benchmarked it). The Coder's visual checklist still applies.

## Learned items stay outside totals

Confirmed. `collapseLearned` only reads `ledger.learned`; `ledger.learned`, `learnedTotals`, `learnedDropped` are unchanged apart from the optional `learnedCadence` on learned items. The Tester's differential (HEAD vs working tree, fuzzed and live across 10 scope/horizon combinations) found counted fields byte-identical. Heading text says "not counted"/"not in the totals above"; summary strip untouched.

## Line endings

`git ls-files --eol`: index is LF everywhere; working-tree CRLF files are `CLAUDE.md`, `app/page.tsx`, `app/forecast/page.tsx`, `components/forecast/recurring-expenses-section.tsx`, `components/upcoming/upcoming-parts.tsx`, `lib/upcoming-ledger.ts`, which is this repo's established pre-existing state for those files (same as before this task); the other touched files are LF. `git diff --stat` shows per-file hunks of sensible size, no whole-file rewrites. Pass.

## Decisions on the Tester's four low defects

1. **CLAUDE.md stale text: fix in this batch, by you, as a docs-only edit (not a code change).** What must be said, in the "Recurring detection" paragraph (line ~117):
   - Replace "client sends only entity + series key ... linked only at 60%+ share and when no Budget, bill or recurring expense already uses it". The client now sends `{entityId, seriesKey, tagId, name?}`: `tagId` null = "No tag", a uuid = the owner's choice (must exist; Tag has no archived/entity column, a test pins that), omitted = the old server rule (60% share and unused); an explicit tag skips the "in use" probe; `name` is validated (1-80, no `<>`/control chars, refused if SSN/EIN/card/account-like) and defaults to the display name; amount, frequency, day, date and notes are always server-derived.
   - The row's notes end with `[pattern:<series key>]` (`lib/recurring-series-marker.ts`): makes "Already recorded" and suppression survive a rename; hidden by `visibleNotes` in the Recurring Expenses table; the only place notes are displayed; never selected by advisor tools; `updateRecurringExpense` has no caller today and must preserve/hide the marker if one is added.
   - Suppression: new `suppressedBy.kind "series"` (marker names the series); a RecurringExpense no longer suppresses by tag alone (only via name, amount+day or its own marker); bills and Budget lines keep the tag rule; `matchRows` uses a marker row's own series rows first. Consequence worth stating: a hand-typed recurring expense that shares only a tag with a detected series no longer hides it.
   - Pre-confirm Budgets notice: `lib/recurring-budget-hint.ts` (pure) and `lib/recurring-budget-hint-build.ts` (read-only, UTC month, three explicit-select reads), mirrors `/budgets` (linked monthly equivalents + additional amount replace the stored amount); plus the post-hoc server `notice`.
   - Ledger: the existing sentence on duplicate detection should note that two names with different trailing `(...)` qualifiers are never treated as the same obligation (Deviation 1; the follow-ups sentence already says this, keep it).
2. **Qualifier rule counts `Electric (Eversource)` and untagged `Eversource (Heat)` as different obligations: ACCEPT, defer any narrowing.** The case needs two records of one entity that both end in a parenthesis, differ, are untagged-or-differently-tagged and describe the same bill. Live counted ledger is byte-identical to HEAD in every scope, and the rule is what lets `Maintenance Fee (Credit Cards)` and `(Slush Funds)` both be counted (the feature's whole point; the Coder's own mutation test shows the scenario fails without it). The tempting narrowing (treat qualifiers that share a word as the same) would reintroduce the opposite bug for nicknames like `Capital One` vs `Capital One Venture`, and restricting to "known account nicknames" is impossible in the pure ledger without new inputs. The residual risk is a visible extra line the owner can delete, not silent corruption. Documented in CLAUDE.md (see 1). Revisit only if a real pair appears.
3. **"Already recorded" keyed to the default name blocks the other series after a deliberate rename onto its qualified name: DEFER.** It needs the owner to type the other series' exact `Name (Nickname)` into a rename field. The failure is safe (nothing written, a clear "Already recorded", fixed by renaming or deleting that row). The same-name lookup exists for rows created before the marker and for hand-typed rows, so removing it is worse. A cheap follow-up if wanted: ignore a same-name row whose notes carry a marker for a different series key.
4. **Account nickname containing parentheses bypasses the qualifier reader: DEFER.** Unreachable today (all 17 live nicknames have no parentheses, no digit runs, none longer than 20 characters), the failure mode degrades to the old word matching (which at worst lets one same-payee series hide the other until a record is made), and the real fix belongs where nicknames are created (validate on save), outside this batch. Note a nickname containing an account number would be a bigger leak because it flows into display names; worth the same nickname-validation follow-up.

## Should-fix (not blocking)

- CLAUDE.md update as specified in decision 1 (owned by you).
- Pre-selection now defaults to the dominant tag even when that category already has a Budget row; the note makes the consequence visible, so I am not blocking, but if the owner would rather keep the old safe default ("do not pre-select a category a Budget line already uses") it is a one-line change in `suggestedTagId` callers. Live example from the Tester: Google One pre-selects "Google Play" (budget ~$36.00) and the note says the line becomes ~$21.76.

## Nits

- `lib/advisor-context.ts` loads full `RecurringExpense` rows (`include`) although only name/amount/frequency are printed; an explicit select would be tidier and would keep notes out of memory (pre-existing).
- `app/forecast/page.tsx`: pre-existing unused `DAY_NAMES` warning remains.
- Check-then-create in the add action is not atomic (two simultaneous Confirms could create two rows); pre-existing, acknowledged, the next refresh answers "Already recorded".

## What's good

- The client/server boundary is genuinely tight: one `buildAddRequest` is the only request builder, the server re-derives every money field, and both layers are pinned by source-reading and injection tests (hostile extra fields on every add in the fuzz).
- Idempotency without a migration: the marker is a minimal, well-documented solution with an exact-match lookup, hidden from display and the advisor, and the detector's new "series" rule means a renamed row hides exactly its own series.
- The Coder investigated and surfaced the tag-schema mismatch (no archived/entity) instead of inventing a rule, and pinned the assumption with a schema test.
- The pre-confirm notice mirrors the real `/budgets` override logic and was verified against live data (56/56 rows, 720 combinations, 0 mismatches) rather than just unit-tested.
- Suspense restructure kept every earlier guarantee (auth before load, fail-soft layers, `err.name`-only logging) and added static pins for them; `learned` stays quarantined, proven by a differential rather than by assertion.
- Honest disclosure throughout (Deviation 1, marker use of `notes`, no-browser gaps, unbenchmarked latency) and strong testing: 53/53 mutants killed by the Tester, 667 tests green in my targeted run.

## Not verified by me

No browser or DB access: the inline form's focus/Escape/Tab behaviour, the amber note's appearance, skeleton-to-content swap, anchor scrolling after streaming, and the real latency gain were checked only through markup tests, static source pins and reading. The Coder's visual checklist (items 1-6 in both batches) still applies, including the one deliberate click that writes one row. `pnpm build` was not run (prisma generate is off limits here); typecheck covers type safety.
