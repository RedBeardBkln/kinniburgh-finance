# Plan: accrual-draw-dates

## Restated goal

Let Eric enter one or more estimated draw dates + dollar amounts against an accrued
`AccrualEnvelope` (McCarthy Oil, Firewood, etc.), and make the Personal forecast use
those real dates/amounts instead of the current flat monthly `annualBudget/12` spread
for the matching accrued `ScheduledBill` — while leaving every other accrued bill
(no draws entered) exactly as it behaves today.

## Scope

**In scope:**
- New `AccrualDraw` model (date, amount, optional notes) + new nullable
  `AccrualEnvelope.scheduledBillId` FK, via a hand-written Prisma migration.
- A data-fix backfill (in the same migration) linking the 3 existing live
  `AccrualEnvelope` rows to their matching `ScheduledBill` row.
- CRUD server actions for draws (`actions/envelope.ts`), `requireAuth()`-gated.
- UI: a small draws list + add-form on the existing "Accrual Envelopes" card
  (`app/envelope/page.tsx`), via one new small `"use client"` leaf component.
- `lib/forecast.ts#generateBillOccurrences()`: new optional 4th parameter
  (an array of draws) that, when non-empty and `amountType === "accrued"`,
  replaces the flat spread with real draw-date events; unit tests for both
  branches.
- Updating all **three** existing call sites of `generateBillOccurrences` (see
  Risks — one more than the request names) to fetch and pass an envelope's
  draws via the new `scheduledBillId` back-relation.
- `prisma/seed.ts`: set `scheduledBillId` on the three `upsertAccrual(...)`
  calls that already have a matching bill, so a from-scratch seed stays
  consistent with the production backfill.

**Out of scope (explicitly not doing):**
- No seeded/fabricated draw rows for the real McCarthy Oil/Firewood envelopes
  — ships empty, per ground rule 1.
- No change to `lib/notifications.ts#checkAccrualShortfall` or
  `lib/monthly-review-build.ts`'s accrual-pace section — both keep using
  `expectedDrawMonths`/`currentBalance` exactly as today. Draws only affect
  the balance *forecast*, not the pace-tracking/shortfall-warning system.
  (A future task could reconcile these; not requested here.)
- No new `AccrualEnvelope` row for Sudden Valley's "McCarthy Oil (Arbor
  Retreat)" bill (which has no matching envelope today) — flagged, not
  invented.
- No validation/reconciliation that entered draws sum to
  `targetAnnualAmount`/`annualBudget` — draws are independent estimates.
- No change to `AccrualEnvelope`'s existing "Update balance" inline form.
- Running `prisma migrate dev/deploy` or `db push` — Coder hand-writes the
  migration SQL; nothing gets applied to the shared Supabase instance without
  an explicit go-ahead (see Risks).

## Affected files/modules

- `prisma/schema.prisma` — new `AccrualDraw` model; `AccrualEnvelope` gets
  `scheduledBillId String? @unique` + `draws AccrualDraw[]` +
  `scheduledBill ScheduledBill?` relation; `ScheduledBill` gets a back-relation
  `accrualEnvelope AccrualEnvelope?` (same 1:1-optional-FK pattern already
  used for `Document.insurancePolicy`/`Document.bankStatement`).
- `prisma/migrations/<timestamp>_accrual_draws/migration.sql` — new, hand-written.
- `prisma/seed.ts` — capture the 3 relevant `upsertBill(...)` return values
  into variables; pass `scheduledBillId` into the matching `upsertAccrual(...)`
  calls (~lines 342-520).
- `lib/forecast.ts` — `generateBillOccurrences()` signature + logic change
  (new optional `draws` param, `AccrualDrawLike` type).
- `lib/__tests__/forecast.test.ts` — new `describe("generateBillOccurrences")`
  block (currently has zero coverage of this function at all — see Risks).
- `actions/envelope.ts` — new `createAccrualDraw`, `updateAccrualDraw`,
  `deleteAccrualDraw` actions; `getEnvelopeSummary`'s `accruals` query gets
  `include: { draws: { orderBy: { estimatedDate: "asc" } } }`;
  `getEnvelopeForecastData`'s nested `scheduledBills` include gets
  `include: { accrualEnvelope: { include: { draws: true } } }` (see Risks:
  this file's own `generateBillOccurrences` call site, not named in the
  request, needs updating too).
- `app/forecast/page.tsx` — the `db.scheduledBill.findMany(...)` query
  (~line 92) gets the same `accrualEnvelope.draws` include; both
  `generateBillOccurrences` call sites (~367, ~459) pass the resolved draws.
- `app/envelope/page.tsx` — render the new draws-list/add-form client
  component inside each Accrual Envelope card (~lines 394-463).
- New file: `components/envelope/accrual-draws-list.tsx` (`"use client"`).

## Approach

### 1. Confirm live data (already done during planning, restated for the Coder)

Queried live production directly (read-only) and confirmed exactly 3
`AccrualEnvelope` rows and 4 accrued `ScheduledBill` rows exist, matching
`prisma/seed.ts` exactly:

| AccrualEnvelope.name | accountId (nickname) | Matching ScheduledBill.payee | Match confidence |
|---|---|---|---|
| "McCarthy Oil" | Heating & Electric (Personal) | "McCarthy Heating & Oil" | Unambiguous — only accrued bill on that account with "McCarthy" in the name |
| "Firewood" | Heating & Electric (Personal) | "Firewood" | Exact name match |
| "Property taxes — 56 Arbor Rd" | JCSB operating (Sudden Valley) | "Property taxes — 56 Arbor Rd" | Exact name match |

Sudden Valley's "McCarthy Oil (Arbor Retreat)" `ScheduledBill` has **no**
matching `AccrualEnvelope` row today — leave unlinked; do not create one.

Real IDs (for the Coder to re-verify live, not to hardcode into the migration
— the migration matches by `accountId` + name, not by literal UUID, so it's
portable and doesn't risk being wrong if IDs drift):
- AccrualEnvelope "McCarthy Oil" = `9d45453c-a7f3-4d7b-9fcd-ace6217d1d66`
- AccrualEnvelope "Firewood" = `7a14af85-2b6b-4861-9bc7-9caeeeb88ef9`
- AccrualEnvelope "Property taxes — 56 Arbor Rd" = `c7932b29-6f08-4bdf-acb7-4d6bebcb1ce6`
- ScheduledBill "McCarthy Heating & Oil" = `fc74d807-47d0-43e4-b98b-f198ac775e27`
- ScheduledBill "Firewood" = `0b5a1037-03e1-43ad-bfe7-6be922c61ac4`
- ScheduledBill "Property taxes — 56 Arbor Rd" = `6ebb6469-3a78-4822-989c-aeba9d21d84b`
- ScheduledBill "McCarthy Oil (Arbor Retreat)" = `06658b38-ce4a-4f1d-84d5-7db61a8742a8` (no envelope — leave alone)

### 2. Schema + migration

Add to `prisma/schema.prisma`:

```prisma
model AccrualEnvelope {
  id                 String   @id @default(uuid())
  accountId          String
  name               String
  targetAnnualAmount Decimal  @db.Decimal(14, 2)
  fundingTransferId  String?
  currentBalance     Decimal  @db.Decimal(14, 2) @default(0)
  expectedDrawMonths Json
  scheduledBillId    String?  @unique   // NEW — optional link to the bill this envelope funds
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  account       Account        @relation(fields: [accountId], references: [id])
  scheduledBill ScheduledBill? @relation(fields: [scheduledBillId], references: [id])   // NEW
  draws         AccrualDraw[]                                                            // NEW
}

model AccrualDraw {                                                                       // NEW model
  id                String   @id @default(uuid())
  accrualEnvelopeId String
  estimatedDate     DateTime
  estimatedAmount   Decimal  @db.Decimal(14, 2)
  notes             String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  accrualEnvelope AccrualEnvelope @relation(fields: [accrualEnvelopeId], references: [id], onDelete: Cascade)
}

model ScheduledBill {
  // ...existing fields unchanged...
  accrualEnvelope AccrualEnvelope?   // NEW — back-relation only, no column
}
```

`estimatedAmount` is `Decimal(14,2)` (not integer cents) to match this
module's existing convention — `ScheduledBill.expectedAmount`/`annualBudget`
and `AccrualEnvelope.targetAnnualAmount`/`currentBalance` are all `Decimal`,
and `generateBillOccurrences` already works in `Decimal`. Don't use cents here
even though newer unrelated modules (e.g. `ProjectedRevenue.amountCents`) do —
match the immediate neighboring schema, not the repo-wide newest convention.

`onDelete: Cascade` on `AccrualDraw.accrualEnvelopeId` matches the existing
`PolicyCashValue.policyId` precedent (child rows of a manually-tracked parent
that has no delete UI today, but cascade is the safe default if one is ever
added). No extra index on `AccrualDraw.accrualEnvelopeId` or
`AccrualEnvelope.scheduledBillId` beyond what the `@unique`/FK constraints
already create — matches this repo's consistent no-extra-index-on-nullable-FK
convention (`Transaction.glCodeId`/`projectId`/`receiptId`,
`PolicyCashValue.policyId`, `SolarEntry.documentId` all bare FK, no index).

Hand-write `prisma/migrations/<YYYYMMDDHHMMSS>_accrual_draws/migration.sql`
(use today's date, next available timestamp after
`20260915120000_transaction_scheduled_transfer_link`) in the exact style of
existing migrations (no Prisma-generated header, plain SQL):

```sql
-- Estimated draw dates/amounts per AccrualEnvelope (accrual-draw-dates task).
-- Lets an accrued ScheduledBill's forecast use real lump-sum draw dates
-- instead of a flat monthly spread, when the owner has entered any.

CREATE TABLE "AccrualDraw" (
    "id"                TEXT NOT NULL,
    "accrualEnvelopeId" TEXT NOT NULL,
    "estimatedDate"     TIMESTAMP(3) NOT NULL,
    "estimatedAmount"   DECIMAL(14,2) NOT NULL,
    "notes"             TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccrualDraw_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AccrualDraw" ADD CONSTRAINT "AccrualDraw_accrualEnvelopeId_fkey"
  FOREIGN KEY ("accrualEnvelopeId") REFERENCES "AccrualEnvelope"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Optional link from an AccrualEnvelope to the ScheduledBill it funds.
-- Nullable: envelopes without a matching bill aren't forced to have one
-- (e.g. Sudden Valley's "McCarthy Oil (Arbor Retreat)" bill has no envelope
-- today and stays that way).
ALTER TABLE "AccrualEnvelope" ADD COLUMN "scheduledBillId" TEXT;

CREATE UNIQUE INDEX "AccrualEnvelope_scheduledBillId_key" ON "AccrualEnvelope"("scheduledBillId");

ALTER TABLE "AccrualEnvelope" ADD CONSTRAINT "AccrualEnvelope_scheduledBillId_fkey"
  FOREIGN KEY ("scheduledBillId") REFERENCES "ScheduledBill"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: link the 3 existing AccrualEnvelope rows to their matching
-- ScheduledBill, confirmed against live production data 2026-09-16 by
-- reading both tables directly (not guessed/invented). Matched by
-- accountId + real name — see .claude/pipeline/accrual-draw-dates/01-plan.md
-- for the full worked match table, including the one bill (Sudden Valley's
-- "McCarthy Oil (Arbor Retreat)") intentionally left unlinked.
UPDATE "AccrualEnvelope" ae
SET "scheduledBillId" = sb.id
FROM "ScheduledBill" sb
WHERE ae.name = 'McCarthy Oil'
  AND sb.payee = 'McCarthy Heating & Oil'
  AND ae."accountId" = sb."accountId"
  AND ae."scheduledBillId" IS NULL;

UPDATE "AccrualEnvelope" ae
SET "scheduledBillId" = sb.id
FROM "ScheduledBill" sb
WHERE ae.name = 'Firewood'
  AND sb.payee = 'Firewood'
  AND ae."accountId" = sb."accountId"
  AND ae."scheduledBillId" IS NULL;

UPDATE "AccrualEnvelope" ae
SET "scheduledBillId" = sb.id
FROM "ScheduledBill" sb
WHERE ae.name = 'Property taxes — 56 Arbor Rd'
  AND sb.payee = 'Property taxes — 56 Arbor Rd'
  AND ae."accountId" = sb."accountId"
  AND ae."scheduledBillId" IS NULL;
```

Then `pnpm db:generate` only (codegen, safe, no DB connection) — **do not**
run `pnpm db:migrate`/`db:push`/`prisma migrate deploy` locally. The
migration reaches the shared Supabase instance automatically via `prisma
migrate deploy` on Vercel when the commit lands on `main` — **do not push a
commit containing this migration to `main` without the orchestrator's
explicit go-ahead**, per this repo's standing migration-push-gate rule (no
shadow DB; this is the same real database local dev also points at).

Also update `prisma/seed.ts` (~lines 342-520): capture the three relevant
`upsertBill(...)` calls into named consts (`mccarthyOilBill`,
`firewoodBill`, `propertyTaxBill`) and pass `scheduledBillId: <bill>.id` into
the three corresponding `upsertAccrual(...)` calls, so a from-scratch seed of
a future environment produces the same linked state as the migration
backfill produces in production. (Note: because `upsertAccrual` returns early
on an existing row without updating it, re-running seed against the *current*
production DB won't retroactively apply this — that's fine, the migration
already did it; this change is for future fresh-seed parity only.)

### 3. Pure projection logic (`lib/forecast.ts`)

Add near `ScheduledBillLike`:

```ts
export interface AccrualDrawLike {
  estimatedDate: Date | string;
  estimatedAmount: Decimal | string | number;
}
```

Change `generateBillOccurrences` to:

```ts
export function generateBillOccurrences(
  bill: ScheduledBillLike,
  from: Date,
  to: Date,
  draws: AccrualDrawLike[] = []
): ScheduleEvent[] {
  if (bill.amountType === "accrued" && draws.length > 0) {
    const events: ScheduleEvent[] = [];
    for (const draw of draws) {
      const date = startOfDayUTC(new Date(draw.estimatedDate));
      if (date < from || date >= to) continue;
      const amount = new Decimal(String(draw.estimatedAmount));
      if (amount.isZero() || amount.isNegative()) continue;
      events.push({
        date,
        amount: amount.negated(),
        description: bill.payee,
        accountId: bill.accountId,
        type: "bill",
      });
    }
    return events.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  // Fallback: existing flat monthly-spread logic, unchanged, for
  // static/fluctuating bills AND for accrued bills with no draws entered.
  // ...existing body...
}
```

`startOfDayUTC` is already a private helper in this file — reuse it directly.
No new file needed; this stays inside `lib/forecast.ts` next to the function
it modifies, matching how `generateCardStatementPayment` lives alongside it.

### 4. CRUD actions (`actions/envelope.ts`)

Add near `updateAccrualBalance`, same file, same `requireAuth()`-first style.
Use `zod` schemas matching this file's existing money/date conventions
(`z.string().regex(/^\d+(\.\d{1,2})?$/)` for the amount, like
`createTransferSchema`/`incomeSourceSchema`; `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`
for the date, like `actions/projected-revenue.ts#createSchema.expectedDate`):

```ts
const createDrawSchema = z.object({
  accrualEnvelopeId: z.string().uuid(),
  estimatedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  estimatedAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  notes: z.string().max(500).optional(),
});

export async function createAccrualDraw(input: z.infer<typeof createDrawSchema>) { ... }

const updateDrawSchema = z.object({
  id: z.string().uuid(),
  estimatedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  estimatedAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  notes: z.string().max(500).optional(),
});

export async function updateAccrualDraw(input: z.infer<typeof updateDrawSchema>) { ... }

export async function deleteAccrualDraw(id: string) { ... }
```

Each: `requireAuth()` first, `db.accrualDraw.create/update/delete(...)`,
then `revalidatePath("/envelope")` + `revalidatePath("/forecast")` (draws
change what both pages render), matching every other mutation in this file.
Return `{ success: true }` / throw on not-found, matching
`updateAccrualBalance`'s style (not the `{error}`-returning style of
`projected-revenue.ts` — stay consistent with this file's own convention
since these actions live in it). No `AuditLog` entry — `updateAccrualBalance`
in this same file also skips it for `AccrualEnvelope` mutations; match that
existing precedent rather than introducing audit logging newly here.

Update `getEnvelopeSummary`'s `accruals` query to
`include: { account: true, draws: { orderBy: { estimatedDate: "asc" } } }` so
the page can render each envelope's draws.

Update `getEnvelopeForecastData`'s nested `scheduledBills` filter (~line 394)
to also `include: { accrualEnvelope: { include: { draws: true } } }`, and its
`generateBillOccurrences(b, from, to)` call (~line 420) to
`generateBillOccurrences(b, from, to, (b.accrualEnvelope?.draws ?? []).map((d) => ({ estimatedDate: d.estimatedDate, estimatedAmount: d.estimatedAmount })))`.

### 5. Forecast page wiring (`app/forecast/page.tsx`)

The `db.scheduledBill.findMany({ where: { active: true, budgetTagId: { not: null } } })`
query (~line 92) gets `include: { accrualEnvelope: { include: { draws: true } } }`
added. Both call sites (~367, ~459) change from
`generateBillOccurrences(b, forecastStart, forecastEnd90)` /
`...forecastEnd14)` to pass the same draws-mapping shown above.

### 6. UI (`app/envelope/page.tsx` + new client component)

Add `components/envelope/accrual-draws-list.tsx` (`"use client"`), modeled
directly on `components/business/projected-revenue-card.tsx` (a confirmed
close analog already in the repo: rows-as-props, `onSubmit` + `FormData`,
`useState` for saving/error, `router.refresh()` after each mutation) rather
than extending the page's existing inline `"use server"` per-card form
pattern. **Justification (per the request's ask to justify this choice):**
the existing inline form on this card is a single fixed field (one balance
input, one action). A draws list is a variable-length collection needing
per-row delete AND inline edit — generating N inline server-action closures
in server-rendered JSX for an unbounded list is workable but gives no
client-side validation feedback and forces a full page reload-equivalent
(`revalidatePath`) per keystroke-adjacent action; the `ProjectedRevenueCard`
pattern already solves exactly this shape in this repo and is the more
consistent precedent to extend.

Component props: `{ envelopeId: string; draws: { id: string; estimatedDateIso: string; estimatedAmount: string; notes: string | null }[] }`
(plain serialized values, no `Decimal`/`Date` instances passed from the
server component, per this repo's established RSC→client serialization
convention). Renders:
- A small table/list of existing draws (date, amount, notes, inline
  edit-in-place via a "Save"/"Delete" pair per row — mirrors
  `ProjectedRevenueCard`'s per-row action buttons), sorted ascending by date.
- An add-draw mini-form (date, amount, optional notes) below the list, same
  input styling (`rounded border px-2 py-1.5 text-sm`) as the rest of this
  page and `ProjectedRevenueCard`.
- Empty state: "No estimated draws yet — add one below so the forecast can
  use it instead of a flat monthly spread." (mirrors this repo's existing
  empty-state copy style).

Mount it inside each Accrual Envelope `<Card>` in `app/envelope/page.tsx`
(~line 394-463), below the existing "Update balance" form, passing that
envelope's `draws` (now available via the updated `getEnvelopeSummary`
query) serialized to the plain shape above.

### 7. Tests (`lib/__tests__/forecast.test.ts`)

This function currently has **zero** existing test coverage (confirmed —
`describe("generateBillOccurrences")` doesn't exist in the file today,
despite the function having 3 real call sites) — add a full new block, not
just draw-specific cases:

- static/fluctuating bill, `expectedAmount` + `autopayDay` set → one event
  per month on that day (baseline flat-bill behavior, previously untested).
- accrued bill, `annualBudget` set, no `draws` arg (or `[]`) → flat
  `annualBudget/12` spread on `autopayDay` each month — confirms the fallback
  is unchanged (regression guard for every other accrued bill in the system).
- accrued bill with `draws` whose `estimatedDate`s fall inside `[from, to)`
  → emits exactly those dates/amounts as outflow events; **no** flat-spread
  events also appear (the two modes are mutually exclusive per bill).
- accrued bill with draws, some dates outside `[from, to)` → only in-window
  draws are emitted.
- accrued bill with a linked envelope but an empty `draws` array → falls
  back to flat spread (the "envelope has zero draws defined" case named
  explicitly in the request).
- non-accrued (static) bill with a non-empty `draws` arg passed anyway →
  draws are ignored, flat/expected-amount behavior unaffected (defensive;
  draws conceptually only apply when `amountType === "accrued"`).
- a draw with a zero or negative `estimatedAmount` → skipped, not emitted as
  a $0/negative outflow event.

Use this file's existing helpers (`d()`, `dec()`) and add a small
`makeAccrualBill()`/`makeDraw()` local factory, matching `makeTransfer()`/
`makeIncome()`'s existing style.

No test needed for the `actions/envelope.ts` CRUD functions — this repo has
zero `actions/__tests__` coverage anywhere (confirmed prior finding); verify
via `pnpm typecheck` plus the new client component compiling against the
action's inferred return type, consistent with existing precedent.

## Risks/unknowns

- **A third call site exists that the request doesn't name.**
  `actions/envelope.ts#getEnvelopeForecastData` (used by `/envelope`'s own
  30-day solvency forecast, breach-day/suggested-increase calculations) also
  calls `generateBillOccurrences` for the same "Heating & Electric" account
  (a TD account with a real `minimumBalance`, confirmed live) that McCarthy
  Oil/Firewood live on. If only the two `app/forecast/page.tsx` sites are
  updated, `/envelope` and `/forecast` would show inconsistent breach/balance
  projections for the exact account this feature targets — worse, the
  Envelope page (where the draws are *entered*) would be the one page still
  showing the old flat-spread math. This plan includes updating all three
  call sites for consistency; flagging this as scope beyond the literal
  request text, but a fix that's directly implied by not leaving the feature
  half-wired on its own host page.
- **Backfill migration correctness** rests on a live production read done
  during planning (2026-09-16) matching `prisma/seed.ts` exactly, 3-for-3.
  If the Coder re-runs the same read-only check before writing the migration
  and gets a different result (e.g. someone renamed a bill/envelope between
  planning and coding), the match table in this plan is stale — re-verify
  live, don't trust this document blindly, same caution as this repo's other
  migration data-fixes.
- **Migration-push-gate**: per the request's own constraint, the commit
  containing the migration must not reach `main` without the orchestrator's
  explicit go-ahead. Flagging again here so it isn't lost between Planner and
  Coder — the Coder should hand off with the migration file written but
  should not assume permission to push/merge.
- **Edit vs. delete-and-recreate for draws**: the request explicitly asks
  for create/edit/delete. This plan implements a real `updateAccrualDraw`
  action with inline per-row edit UI. An alternative (delete + re-add) would
  be simpler UI but a worse user experience for a household that may adjust
  an oil-delivery estimate by a few dollars multiple times over a season —
  flagging the fuller implementation as the deliberate choice, not a
  from-scratch requirement invention.
- **No reconciliation between entered draws and `annualBudget`/
  `targetAnnualAmount`.** E.g. if the owner enters draws summing to $4,500 for
  an envelope whose `annualBudget` is $4,000, nothing warns him. Out of scope
  per the request (only asked for forecast wiring, not budget reconciliation)
  — flagging as a plausible follow-up, not silently adding it.
- **Accrual-pace notifications untouched.** `checkAccrualShortfall` (pace
  warnings comparing `currentBalance` to `expectedDrawMonths`-implied pace)
  and `monthly-review-build.ts`'s accrual section both continue to ignore
  draws entirely after this task ships — someone could read "on pace" from
  the monthly review while the forecast simultaneously shows a large lump
  sum about to hit. Not fixing this now (not requested), but worth the
  orchestrator's awareness since it's a real, if narrow, inconsistency this
  task introduces between two accrual-related surfaces.

## Acceptance criteria

1. `pnpm db:generate` succeeds after the schema change; `pnpm typecheck` and
   `pnpm lint` pass with zero new errors.
2. New migration file exists at
   `prisma/migrations/<timestamp>_accrual_draws/migration.sql`, hand-written
   (no Prisma CLI run against the live DB), matching the existing migration
   file style (plain SQL, no generated header).
3. `AccrualDraw` model exists with `accrualEnvelopeId`, `estimatedDate`,
   `estimatedAmount`, optional `notes`; `AccrualEnvelope.scheduledBillId` is
   nullable and `@unique`.
4. On the Envelopes page, each of the 3 existing Accrual Envelope cards shows
   a (currently empty) draws list and a working add-draw form; adding a draw
   persists it and it reappears in the list after the action completes;
   editing a draw's date/amount/notes persists the change; deleting a draw
   removes it. All three actions are gated by `requireAuth()`.
5. On the Personal forecast page (both the 90-day and 14-day/schedule views),
   an accrued bill whose linked envelope has at least one draw inside the
   visible window shows that draw's real date + amount as the outflow event,
   with **no** additional flat-monthly-spread event also appearing for that
   same bill in the same window.
6. An accrued bill whose linked envelope has zero draws (or no linked
   envelope at all) continues to show the exact same flat monthly-spread
   behavior as before this change, for every account/bucket in the system —
   confirmed by diffing forecast output for Sudden Valley's two accrued bills
   before/after (should be byte-identical, since neither's envelope — or lack
   thereof — gains any draws in this task).
7. `/envelope`'s own 30-day solvency forecast for the Heating & Electric
   account reflects the same draw-aware logic as `/forecast` (see Risk above)
   — not just the two `app/forecast/page.tsx` call sites.
8. `pnpm test` passes, including the new `generateBillOccurrences` test
   block covering both branches and all edge cases listed above.
9. No `any` types introduced; all new server actions start with
   `requireAuth()`.
10. The 3 live `AccrualEnvelope` rows have their `scheduledBillId` correctly
    backfilled after the migration is (eventually, post-approval) applied,
    verified by a read-only query — not asserted from the migration SQL text
    alone.

## Test expectations

- **Unit (required, `lib/__tests__/forecast.test.ts`):** the full
  `generateBillOccurrences` matrix described in Approach §7 — this is the
  core pure logic and the only new pure-function surface in this task.
- **No integration/DB tests** — this repo has no DB-backed test
  infrastructure (mocks at the function boundary only); the new
  `actions/envelope.ts` CRUD functions and the two page query changes are
  verified via `pnpm typecheck` + the manual click-through the orchestrator
  will do post-review, not new automated tests, consistent with this repo's
  `actions/__tests__`-free precedent.
- **No component/DOM tests** — repo has zero jsdom/RTL infrastructure
  (confirmed in prior planning); the new `accrual-draws-list.tsx` client
  component is verified by `pnpm typecheck` + manual click-through only.
- **Edge cases the unit tests must cover** (restated from Approach §7 for
  clarity as a standalone checklist): flat-spread baseline (previously
  untested), flat-spread fallback for accrued+no-draws, draws-in-window,
  draws-partially-outside-window, empty-draws-array fallback, non-accrued
  bill ignoring a stray `draws` arg, zero/negative-amount draw skipped.
