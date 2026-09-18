# Plan: Auto-flag transactions needing a receipt into Receipts > Needs Review

## Restated goal

Any imported business-entity transaction that's an outflow of $75 or more and has no receipt attached
should automatically appear on `/receipts?tab=review` ("Needs Review"), shown alongside — but visually
distinct from — the existing uploaded-but-unconfirmed `Receipt` rows already surfaced there. From that
page, an "Attach receipt" action lets the user upload a file for a flagged transaction and, on save, ties
it to that transaction and runs the existing tag→GL-code assignment exactly as the current receipt-first
flow already does. A "Not needed" dismissal keeps the queue from permanently clogging with expenses (like
a card payment or bank fee) that will never get a receipt.

## Required findings (stated plainly, per the request's mandate)

**1. The exact "needs receipt" query.** Scope: business entities only (`Entity.type === "business"`,
enforced unconditionally — see the fail-closed note in Approach step 1, this is the one thing that must
never regress). Threshold: **$75**, cited from `specs/10-receipt-substantiation-threshold.md` (IRS Pub.
463 / Treas. Reg. §1.274-5(c)(2)(iii)) via one exported constant, never re-derived. **Correction to the
request's own phrasing:** the request says "`Math.abs(amount) >= 7500` cents" — but per this repo's own
confirmed convention (`Transaction.amount` is `Decimal(14,2)` **dollars**, not integer cents — see
`repo_conventions` memory, "dollars with cents precision... despite cents-suffixed field names elsewhere"),
the real comparison against the live column is `amount <= -75` (dollars), not a cents integer. Using 7500
literally against this column would be wrong by 100x. **Also a correction to a naive `abs(amount) >= 75`
reading**, found by running a live read-only query against production data (see below): that would flag
*income* rows too (Airbnb rent deposits, etc.), which is wrong — the IRS receipt-substantiation rule is
about substantiating an **expense**, not income received. The real query is **outflow-only**:
```ts
{
  archivedAt: null,
  receiptId: null,
  transferPairId: null,
  amount: { lte: -RECEIPT_THRESHOLD_DOLLARS }, // -75, i.e. outflow >= $75
  entity: { type: "business" },       // always present, unconditionally
  ...(entityId ? { entityId } : {}),  // optional additional narrowing, never a substitute for the type check
}
```
Exclusions: `archivedAt: null` (soft-deleted), `receiptId: null` (already has one), `transferPairId: null`
(internal transfers, not real expenses — matches the established `transferPairId: null` filter used
elsewhere in this repo for real-spend queries), plus a dismissal exclusion (finding 2) applied after the
DB query. `glCodeId` is deliberately **not** filtered either way — GL-coding status is independent of
whether a receipt is required.

**Real production numbers (live read-only query, run while planning this task, 2026-09-18):**
Sudden Valley: **55** flagged outflow transactions, EK Consulting: **20**, Mezzo: **0** (zero transactions
of any kind). A naive `abs(amount) >= 75` (no outflow filter) would have additionally, wrongly, flagged
**33** Sudden Valley and **5** EK Consulting *income* rows (Airbnb deposits, etc.) — concrete confirmation
the outflow-only filter is load-bearing, not a theoretical edge case. Also confirmed: Sudden Valley already
has **2** real uploaded-but-unconfirmed `Receipt` rows today (two duplicate "Lowe's Home Centers, LLC"
$28.93 receipts dated 2026-06-17) that will render alongside the 55 flagged transactions once this ships —
a concrete example of the two-item-type merge this task must render distinctly. EK Consulting has zero
existing Receipt rows. Real EK Consulting sample flagged rows include `CAPITAL ONE-CRCARDPMT` (-$352.30,
-$1,416.39) and `AMEX EPAYMENT-RETRY PYMT` (-$862.50) — real payments *to* a card issuer, not purchases;
these are the concrete, real version of "an expense that will never get a receipt," and are exactly what
finding 2's dismissal mechanism is for (no code can reliably auto-detect these — `Transaction` carries no
`lineType`/purchase-vs-payment signal the way the new `credit_card_statement` extraction does for
statement line items; that classification only exists at import time for that one feature, not on the
`Transaction` row itself afterward).

**2. Dismissal/override mechanism: yes, built, no migration.** Uses the existing `AppSetting` key/value
table (`lib/settings.ts`'s established mechanism, previously only used for per-entity-suffixed keys —
extended here to a per-transaction-suffixed key: `receipt_not_required:{transactionId}`, value = a JSON
string `{dismissedById, dismissedAt, reason}`). **Why no-migration is the right call here, not just the
default preference:** (a) this repo's own ground rule requires explicit confirmation before any Prisma
migration is pushed — a hand-written migration for a *new* nullable `Transaction` column would still need
that sign-off before the column exists in the live (only) Supabase database, meaning the feature would be
non-functional until a separate approval+deploy step happened, unlike every other part of this task; (b)
`AppSetting` is explicitly the repo's designated low-friction extensibility valve for exactly this shape of
additive flag, with real precedent for per-scope-suffixed keys; (c) real volume is low — today's total
`AppSetting` row count is 4, and even with all 75 currently-flagged transactions dismissed over time, that
table would only reach double digits, not a scale concern for a two-person household app. **Tradeoff,
flagged honestly:** this is a two-step query (fetch candidate transaction ids, then a second
`appSetting.findMany({ key: { in: [...] } })` to filter), not a single-query `WHERE` clause the way a real
column would allow, and there's no DB-level referential integrity tying the key to a live transaction (in
practice harmless, since transactions are archive-only, never hard-deleted, per ground rule 7). A real
`Transaction.receiptWaivedAt`/`receiptWaivedById` column pair (mirroring the existing
`Receipt.confirmedAt`/`confirmedById` pattern) would be the cleaner long-term answer if this ever needs to
be joined/reported on at scale — **recommended as a future follow-up, not built now**, consistent with not
expanding scope beyond what's needed. Every dismiss also writes a paired `AuditLog` row
(`changeType: "receipt_flag_dismissed"`, `transactionId` set, real `changedBy`) for a proper audit trail,
matching how every other transaction-metadata mutation in this repo (tag changes, GL auto-assignment) is
already logged — `AuditLog.changeType` is a plain string column, no migration needed for a new value
(matches the existing `Notification.type`-is-a-plain-string precedent). **No "undo" UI is built** — matches
this repo's existing one-way-archive convention (no restore/unarchive UI exists anywhere yet, per
`repo_conventions` memory); technically reversible by deleting the `AppSetting` row directly, not exposed
in the UI. Flagged as a real, accepted limitation, not silently resolved.

**3. Confirmed: the GL-code tie-in genuinely reuses `confirmReceipt`, not reimplemented.** Traced the full
call chain by reading the actual code, not assuming: `confirmReceipt` (`actions/receipts.ts`) → when
`transactionId` + `tagIds` are present → `updateTransactionTags(transactionId, tagIds)`
(`actions/transactions.ts`, line ~178) → which itself calls `autoAssignGlCodes([{transactionId, entityId,
tagIds}], user.id)` (`lib/gl-code-resolver.ts`) at the end of its own body. This is the **same,
already-shipped** call chain regardless of whether the receipt originated receipt-first (today) or
transaction-first (this task). **This task's "Attach receipt" flow does not call `autoAssignGlCodes` or
`updateTransactionTags` directly anywhere** — it only pre-populates the existing `ReceiptConfirmForm`'s
`transactionId` React state (currently always initialized to `undefined`, requiring a manual radio-button
match) so that when the user clicks the form's existing "Confirm" button, it calls the exact same
`confirmReceipt` action with the exact same shape it already uses today. Zero new tag/GL-code logic is
written anywhere in this plan.

## Scope

**In scope:**
- A new pure module (`lib/receipt-flagging.ts`) defining the $75 threshold (cited), the "needs receipt"
  Prisma where-clause builder, the dismissal-key helpers, and a merge/sort helper for the two Needs-Review
  item types.
- `actions/receipts.ts`: two new exports, `listFlaggedTransactions` and `dismissReceiptRequirement`.
- `/receipts?tab=review` (`app/receipts/page.tsx`): renders flagged transactions alongside existing
  Receipt rows, visually distinct, with a combined tab-badge count.
- A small new client component for the inline "Not needed" dismiss action.
- Extending `/api/receipts/upload` and the upload page/client with an optional `transactionId` so an
  "Attach receipt" flow can pre-fill vendor/date/total from the transaction itself and pre-select it as the
  match on the confirm page — reusing, not duplicating, `confirmReceipt`.
- `app/receipts/[id]/page.tsx` + `ReceiptConfirmForm`: accept an optional pre-selected `transactionId` so
  the attach-flow lands with the correct transaction already chosen, no manual match-picking required.
- Applies uniformly to transactions from both the bank-statement import path and the credit-card-statement
  import path (and Plaid-synced transactions) — the query is transaction-shape-agnostic; it doesn't care
  how a `Transaction` row was created, only its `entity.type`, `amount`, `receiptId`, `transferPairId`, and
  `archivedAt`.
- Business-entity scoping only (ground rule 5) — enforced unconditionally in the shared where-clause
  builder, not left to individual call sites to remember.
- User-facing copy framed as "flagged for review," with an explicit scope caveat sentence, per ground rule
  8 (see Approach step 6).

**Out of scope (explicitly not doing):**
- No Prisma migration (finding 2).
- No "undo dismissal" UI (finding 2).
- No pagination for the flagged-transaction list — real current volume (55 + 20 = 75 across two business
  entities) is small enough for one page; flagged as a risk if the planned 2025 Capital One PDF backfill
  (recommended, not yet built, per `.claude/pipeline/credit-card-statement-import/04-review.md`) later
  produces a much larger one-time queue.
- No mismatch validation between a manually-edited "Total" on the confirm form and the actual pinned
  transaction's amount — this is pre-existing behavior (the receipt-first flow already lets a user type any
  total independent of a selected match), not something this task introduces or is asked to fix.
- No changes to `confirmReceipt`, `updateTransactionTags`, or `autoAssignGlCodes` themselves — reused
  as-is (finding 3).
- No changes to `lib/doc-extract.ts` or the bank-statement/credit-card-statement import actions themselves
  — this task only reads their *output* (`Transaction` rows), it doesn't touch how they're created.
- Not building a dismissal *reason* input UI — the `reason` field exists in the stored JSON shape for
  future use, but the "Not needed" button in this plan sends no reason text (`undefined`). A future task
  could add a small reason prompt without any schema change.

## Affected files/modules

New:
- `lib/receipt-flagging.ts` — pure, no DB, no `"use server"`.
- `lib/__tests__/receipt-flagging.test.ts`.
- `components/receipts/dismiss-receipt-flag-button.tsx` — small `"use client"` leaf.

Modified:
- `actions/receipts.ts` — add `listFlaggedTransactions`, `dismissReceiptRequirement`.
- `app/receipts/page.tsx` — fetch + merge flagged transactions into the `tab === "review"` render path;
  combined badge count.
- `app/receipts/upload/page.tsx` — read optional `transactionId` search param, fetch that transaction,
  pass a `transactionContext` prop down.
- `app/receipts/upload/upload-client.tsx` — accept and use `transactionContext`; include `transactionId`
  in the upload `FormData`; skip the `/api/entity-id` lookup when attaching to a known transaction.
- `app/api/receipts/upload/route.ts` — accept optional `transactionId`; when present, derive `entityId`
  server-side from the transaction (never trust a client-supplied one in this mode), pre-fill
  vendor/receiptDate/total from the transaction, set `Receipt.accountId` from the transaction's account,
  and force `ocrStatus: "complete"` even if the OCR call itself fails (the essential fields are already
  known).
- `app/receipts/[id]/page.tsx` — accept optional `searchParams.transactionId`; fetch that one transaction;
  pass `initialTransactionId`/adjusted `initialAccountId` into `ReceiptConfirmForm`.
- `components/receipts/receipt-confirm-form.tsx` — accept new optional prop `initialTransactionId`; seed
  the existing `transactionId` state from it instead of always `undefined`; merge the pinned transaction
  into the displayed match list if `findMatchingTransactions`'s fuzzy search didn't already surface it.

Not modified (confirmed unaffected): `lib/doc-extract.ts`, `actions/documents.ts`, `actions/bank-statements.ts`,
`lib/gl-code-resolver.ts`, `actions/transactions.ts`, `prisma/schema.prisma` (no migration).

## Approach

1. **`lib/receipt-flagging.ts`** — the shared, single source of truth for the query and dismissal
   plumbing:
   ```ts
   import { Prisma } from "@prisma/client";

   // $75: specs/10-receipt-substantiation-threshold.md (IRS Pub. 463 / Treas. Reg. §1.274-5(c)(2)(iii)).
   // Cite that file for any future tax-year/rule change — never hardcode 75 anywhere else.
   export const RECEIPT_THRESHOLD_DOLLARS = 75;

   // `entity: { type: "business" }` is unconditional — appended regardless of whether entityId is also
   // supplied, so a caller can never accidentally flag a Personal transaction by passing Personal's own
   // real entity id (Personal is a real Entity row, not a null bucket — getEntityBySlug("personal")
   // returns one). This was caught explicitly while planning this task; do not "simplify" it away.
   export function needsReceiptWhere(entityId?: string): Prisma.TransactionWhereInput {
     return {
       archivedAt: null,
       receiptId: null,
       transferPairId: null,
       amount: { lte: -RECEIPT_THRESHOLD_DOLLARS },
       entity: { type: "business" },
       ...(entityId ? { entityId } : {}),
     };
   }

   export function receiptDismissalKey(transactionId: string): string {
     return `receipt_not_required:${transactionId}`;
   }

   export interface ReceiptDismissal {
     dismissedById: string;
     dismissedAt: string; // ISO datetime
     reason: string | null;
   }

   export function serializeReceiptDismissal(d: {
     dismissedById: string;
     dismissedAt: string;
     reason?: string | null;
   }): string {
     return JSON.stringify({ dismissedById: d.dismissedById, dismissedAt: d.dismissedAt, reason: d.reason ?? null });
   }

   export function parseReceiptDismissal(raw: string | null | undefined): ReceiptDismissal | null {
     if (!raw) return null;
     try {
       const parsed = JSON.parse(raw) as Partial<ReceiptDismissal>;
       if (typeof parsed.dismissedById !== "string" || typeof parsed.dismissedAt !== "string") return null;
       return { dismissedById: parsed.dismissedById, dismissedAt: parsed.dismissedAt, reason: parsed.reason ?? null };
     } catch {
       return null;
     }
   }

   // ─── Merge/sort for the two Needs-Review item shapes ──────────────────────

   export interface ReviewReceiptItem {
     kind: "receipt";
     id: string;
     vendor: string | null;
     amountDollars: number | null;
     itemDate: string | null; // ISO date, or null if unextracted
     sortAt: string;          // ISO datetime driving merged order (createdAt)
   }

   export interface ReviewFlaggedTransactionItem {
     kind: "flagged_transaction";
     id: string; // transactionId
     payeeRaw: string | null;
     amountDollars: number; // always positive (abs of the outflow)
     itemDate: string;      // ISO date (postedAt)
     entityName: string;
     entitySlug: string | null;
     sortAt: string;
   }

   export type ReviewItem = ReviewReceiptItem | ReviewFlaggedTransactionItem;

   // Single merged list, most-recent-activity-first. Simpler than two separate
   // sub-lists/sections, and matches this page's existing single-table layout.
   export function mergeReviewItems(
     receipts: ReviewReceiptItem[],
     flagged: ReviewFlaggedTransactionItem[]
   ): ReviewItem[] {
     // sortAt is always a plain ISO 8601 datetime string, so a lexicographic
     // compare is also a correct chronological compare (same convention as
     // lib/statement-review.ts#isWithinPlaidCoverage's own ISO-string comparison).
     return [...receipts, ...flagged].sort((a, b) => b.sortAt.localeCompare(a.sortAt));
   }
   ```

2. **`actions/receipts.ts` — two new exports**, reusing the file's existing local `requireAuth()` helper
   (this file does not import a shared one; every `actions/*.ts` file in this repo defines its own local
   wrapper — confirmed by reading this file in full):
   ```ts
   export interface FlaggedTransactionRow {
     id: string;
     payeeRaw: string | null;
     amount: string;       // Decimal-as-string, negative
     postedAt: Date;
     entityId: string;
     entityName: string;
     entitySlug: string | null;
   }

   export async function listFlaggedTransactions(entityId?: string): Promise<FlaggedTransactionRow[]> {
     await requireAuth();
     const rows = await db.transaction.findMany({
       where: needsReceiptWhere(entityId),
       select: {
         id: true, payeeRaw: true, amount: true, postedAt: true,
         entity: { select: { id: true, name: true, navLabel: true, slug: true } },
       },
       orderBy: { postedAt: "desc" },
     });
     if (rows.length === 0) return [];
     const keys = rows.map((r) => receiptDismissalKey(r.id));
     const dismissed = await db.appSetting.findMany({ where: { key: { in: keys } }, select: { key: true } });
     const dismissedKeys = new Set(dismissed.map((d) => d.key));
     return rows
       .filter((r) => !dismissedKeys.has(receiptDismissalKey(r.id)))
       .map((r) => ({
         id: r.id,
         payeeRaw: r.payeeRaw,
         amount: r.amount.toString(),
         postedAt: r.postedAt,
         entityId: r.entity.id,
         entityName: r.entity.navLabel ?? r.entity.name,
         entitySlug: r.entity.slug,
       }));
   }

   export async function dismissReceiptRequirement(transactionId: string, reason?: string): Promise<void> {
     const user = await requireAuth();
     const tx = await db.transaction.findUnique({
       where: { id: transactionId, archivedAt: null },
       include: { entity: true },
     });
     if (!tx) throw new Error("Transaction not found");
     if (tx.entity.type !== "business") {
       // Defense in depth — the UI never renders this control outside a flagged
       // (already business-scoped) row, but the server must not trust the client.
       throw new Error("Receipt flagging only applies to business transactions");
     }

     const value = serializeReceiptDismissal({
       dismissedById: user.id!,
       dismissedAt: new Date().toISOString(),
       reason: reason ?? null,
     });

     await db.appSetting.upsert({
       where: { key: receiptDismissalKey(transactionId) },
       update: { value },
       create: { key: receiptDismissalKey(transactionId), value },
     });

     await db.auditLog.create({
       data: {
         transactionId,
         changedBy: user.id!,
         changeType: "receipt_flag_dismissed",
         before: {},
         after: JSON.parse(value),
       },
     });

     revalidatePath("/receipts");
   }
   ```

3. **`app/receipts/page.tsx` — render the merge, `tab === "review"` only.** Other tabs (`confirmed`,
   `all`) are unchanged (Receipt rows only, existing 25-per-page pagination untouched) — flagged
   transactions conceptually can't appear there (they have no `Receipt` row, so "confirmed" doesn't apply,
   and "all" is specifically a list of uploaded receipts). For `review`:
   ```ts
   const [{ receipts, total, pageSize }, flaggedTransactions, reviewReceiptCount] = await Promise.all([
     listReceipts({ entityId: entity?.id, tab: tab === "all" ? "all" : tab === "confirmed" ? "confirmed" : "review", page }),
     listFlaggedTransactions(entity?.id),
     db.receipt.count({ where: { entityId: entity?.id, archivedAt: null, ocrStatus: "complete", confirmedAt: null } }),
   ]);
   const reviewCount = reviewReceiptCount + flaggedTransactions.length;
   ```
   When `tab === "review"`: build `ReviewReceiptItem[]` from `receipts` (map `createdAt`→`sortAt`,
   `receiptDate`→`itemDate`, `total`→`amountDollars`) and `ReviewFlaggedTransactionItem[]` from
   `flaggedTransactions` (map `postedAt`→both `itemDate` and `sortAt`, `Math.abs(Number(amount))`→
   `amountDollars`), call `mergeReviewItems`, and render one combined `<tbody>`. **No pagination applied
   to the review tab's merged list** (see Scope) — `receipts`' own `total`/`pageSize`/pagination controls
   only apply to the `confirmed`/`all` tabs.
   - Row rendering per `item.kind`:
     - `"receipt"`: unchanged from today — Vendor / Date / Amount / `OcrStatusBadge` / `Review →` link to
       `/receipts/{id}`.
     - `"flagged_transaction"`: Vendor = `payeeRaw ?? "Unknown"`, Date = `itemDate`, Amount =
       `formatUSD(amountDollars)` (this file's existing `formatUSD` call convention — pass the dollar
       number directly, no `/100`/`*100` conversion, matching this exact page's own current
       `formatUSD(decimalToNumber(r.total))` call), Status = a new distinctly-colored badge reading
       **"Flagged for review — no receipt on file"** (not "Receipt Required" — ground rule 8 framing), two
       actions: `Attach receipt →` linking to
       `` `/receipts/upload?bucket=${item.entitySlug ?? "personal"}&transactionId=${item.id}` as Route ``,
       and the new `<DismissReceiptFlagButton transactionId={item.id} />` client component.
   - Add one short caption line above the table, visible only on the `review` tab, satisfying ground rule
     8's framing requirement explicitly:
     *"Transactions over $75 are flagged here using a commonly-applied receipt-substantiation guideline —
     not a certainty that every flagged item legally requires a receipt for your specific expense category.
     Dismiss any item that doesn't need one."*

4. **`components/receipts/dismiss-receipt-flag-button.tsx`** (new, `"use client"`, matches this repo's
   established `window.confirm` + `useTransition` + `router.refresh()` pattern):
   ```tsx
   "use client";
   import { useTransition } from "react";
   import { useRouter } from "next/navigation";
   import { dismissReceiptRequirement } from "@/actions/receipts";

   export function DismissReceiptFlagButton({ transactionId }: { transactionId: string }) {
     const router = useRouter();
     const [isPending, startTransition] = useTransition();
     function handleClick() {
       if (!confirm("Mark this transaction as not needing a receipt? It will no longer show up in this queue.")) return;
       startTransition(async () => {
         await dismissReceiptRequirement(transactionId);
         router.refresh();
       });
     }
     return (
       <button type="button" onClick={handleClick} disabled={isPending}
         className="text-xs text-muted-foreground hover:text-destructive hover:underline disabled:opacity-60">
         {isPending ? "Dismissing…" : "Not needed"}
       </button>
     );
   }
   ```

5. **The "Attach receipt" flow — extend upload, don't fork it.**
   - `app/receipts/upload/page.tsx`: add `transactionId?: string` to `searchParams`. When present, fetch
     `db.transaction.findUnique({ where: { id: transactionId, archivedAt: null }, include: { entity: true, account: true } })`
     and pass a `transactionContext` prop (`{ id, payeeRaw, postedAt: isoDate, amount: dollarString,
     entityLabel, accountId }`) to `UploadClient` **instead of** deriving `entityLabel` from `?bucket=` —
     the transaction's own entity is authoritative in this mode (no possibility of a `bucket`/transaction
     mismatch).
   - `upload-client.tsx`: accept optional `transactionContext`. When present:
     - Skip the `/api/entity-id?bucket=` fetch in `handleSubmit` entirely — `formData.set("transactionId",
       transactionContext.id)` instead of `formData.set("entityId", ...)`.
     - Replace the read-only "Entity" field with a small summary card: *"Attaching a receipt to:
       **{payeeRaw}** — {formatted date} — {formatted amount} ({entityLabel})"*.
     - Default the existing "Capture date" input's `defaultValue` to `transactionContext.postedAt` instead
       of today's date (closer to the truth — the receipt was presumably captured near the purchase date).
     - After a successful upload, `router.push(`/receipts/${receiptId}?transactionId=${transactionContext.id}`)`
       instead of the current plain `/receipts/${receiptId}`.
   - `app/api/receipts/upload/route.ts`: accept optional `transactionId` from `formData`. Validation order:
     ```ts
     const transactionIdRaw = formData.get("transactionId");
     const transactionId = typeof transactionIdRaw === "string" && transactionIdRaw ? transactionIdRaw : null;
     let tx = null;
     if (transactionId) {
       tx = await db.transaction.findUnique({ where: { id: transactionId, archivedAt: null }, include: { entity: true } });
       if (!tx) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
       if (tx.entity.type !== "business") {
         return NextResponse.json({ error: "Receipt flagging only applies to business transactions" }, { status: 400 });
       }
     }
     // entityId is required UNLESS a valid transactionId was supplied (server derives entityId from tx.entityId then)
     if (!tx && typeof entityId !== "string") {
       return NextResponse.json({ error: "entityId required" }, { status: 400 });
     }
     ```
     Then, at `db.receipt.create`: `entityId: tx ? tx.entityId : entityId`, `accountId: tx?.accountId ?? null`,
     and (new) pre-fill `vendor: tx?.payeeRaw ?? null`, `receiptDate: tx ? tx.postedAt : null`,
     `total: tx ? new Prisma.Decimal(tx.amount).abs() : null` **at create time**, before OCR runs. After
     `extractReceiptData` completes (success or failure), the update branch must **not** let OCR overwrite
     an already-known vendor/date/total when `tx` is set — only `description`/`glCode`/`ocrRaw` come from
     OCR in that case, and `ocrStatus` is forced to `"complete"` (not `"failed"`) whenever `tx` is set,
     since the essential fields are already known from the transaction regardless of whether the Claude
     call itself succeeded. Response JSON becomes `{ receiptId, transactionId }` (echoing back
     `transactionId` so the client's redirect can include it).

6. **`app/receipts/[id]/page.tsx` + `ReceiptConfirmForm` — pre-select the pinned transaction.**
   - Page: add `searchParams: Promise<{ transactionId?: string }>`. When present, fetch that one
     transaction (`select: { id, payeeRaw, amount, postedAt, accountId, account: { select: { nickname: true } } }`)
     and build one extra `MatchCandidate`-shaped object from it. Pass `initialTransactionId={transactionId}`
     and prepend the pinned transaction into the `matches` array passed to `ReceiptConfirmForm` **only if
     it isn't already present** (dedupe by id — `findMatchingTransactions`'s ±7-day/±2% fuzzy window may or
     may not have already surfaced the exact same row).
   - `ReceiptConfirmForm`: add prop `initialTransactionId?: string`; change
     `useState<string | undefined>()` to `useState<string | undefined>(initialTransactionId)` for the
     `transactionId` state. No other change — `handleConfirm`'s existing call to `confirmReceipt` already
     passes `transactionId` and `tagIds` exactly as today; this is the entire mechanism by which the
     attach-flow reuses (never reimplements) the tag→GL-code tie-in (finding 3).

7. **Tests.**
   - `lib/__tests__/receipt-flagging.test.ts` (new): `needsReceiptWhere` (asserts `entity: {type:
     "business"}` is present both with and without an `entityId` argument — the regression this task must
     never reintroduce; asserts the exact `-75` threshold value), `receiptDismissalKey` (stable, prefixed),
     `serializeReceiptDismissal`/`parseReceiptDismissal` (round-trip; malformed JSON → `null`; missing
     required field → `null`), `mergeReviewItems` (interleaves both kinds correctly by `sortAt` descending;
     stable behavior on equal `sortAt`; empty-array edge cases on either side).
   - Not unit-tested (matches this repo's established convention — no `actions/__tests__` directory
     anywhere, no DOM/component test infra): `actions/receipts.ts`'s two new exports, the
     `app/api/receipts/upload/route.ts` changes, and all `.tsx` changes — verified via `pnpm typecheck` +
     `pnpm lint` plus the manual smoke test below.

## Risks/unknowns

- **AppSetting-based dismissal is a deliberate no-migration tradeoff**, not the cleanest possible design —
  see finding 2 for the full reasoning and the recommended (not built) future column-based alternative.
- **No queue-size cap/pagination for the flagged-transaction list.** Fine at today's real volume (75 across
  two entities) but will grow substantially if the recommended-but-not-yet-built 2025 Capital One PDF
  backfill (from `.claude/pipeline/credit-card-statement-import/04-review.md`) happens — revisit
  pagination if that backfill lands and the list becomes unwieldy.
- **No reliable automatic way to distinguish "a real expense that just never got a receipt" from "a
  transaction that will never plausibly have one" (e.g. `CAPITAL ONE-CRCARDPMT`, a payment to the card
  issuer, not a purchase).** `Transaction` carries no `lineType`/purchase-vs-payment signal (that
  classification only exists transiently during credit-card-statement extraction, per the
  `credit-card-statement-import` task, and isn't persisted onto the resulting `Transaction` row). This is
  exactly why the dismissal mechanism exists — it's a human judgment call per row, not something this task
  attempts to auto-detect. A future task *could* extend the flagging query to auto-exclude known
  payment-shaped payees (`payeeNormalized` pattern matching, similar to `TagRule`'s existing pattern
  matching) — not built here since it wasn't asked for and risks silently hiding a row that should have
  been reviewed.
- **Total/date/vendor pre-filled from the transaction at upload time are not re-validated against
  whatever the user later types into the confirm form.** If a user attaches a receipt via the flagged-
  transaction flow but then manually edits the total to a wildly different number before confirming,
  nothing stops it — matches pre-existing behavior of the receipt-first flow (see Scope), not a new gap.
- **`Mezzo` entity currently has zero transactions of any kind** (confirmed live) — this feature will show
  nothing for Mezzo today; not a bug, just worth knowing so an empty flagged-transaction list for that
  bucket isn't mistaken for a query error during manual testing.
- **The merged review-tab list intentionally drops the existing tab's pagination** for the `review` case
  only (see Scope/Approach step 3) — a deliberate simplification given today's real volume, flagged in case
  a future reviewer expects pagination to behave identically across all three tabs.

## Acceptance criteria

1. Visiting `/receipts?bucket=ek-consulting&tab=review` shows the entity's flagged outflow transactions
   ($75+ outflow, no `receiptId`, not a transfer, not archived) — verified against real data: 20 rows for
   EK Consulting, 55 for Sudden Valley, 0 for Mezzo and for Personal.
2. Visiting `/receipts?bucket=personal&tab=review` never shows any flagged-transaction rows, only the
   existing uploaded-but-unconfirmed `Receipt` rows (unchanged behavior) — verified against real data
   (Personal currently has 1 real "complete"/unconfirmed Receipt row).
3. A flagged-transaction row and an uploaded-unconfirmed `Receipt` row render with visually distinct status
   badges and different action links/labels on the same page (verified against Sudden Valley's real mix of
   2 Receipt rows + 55 flagged transactions).
4. Clicking "Not needed" on a flagged-transaction row, after confirming the `window.confirm` prompt, removes
   it from the queue on reload and creates one `AppSetting` row (`receipt_not_required:{id}`) and one
   `AuditLog` row (`changeType: "receipt_flag_dismissed"`) — verified by a direct DB read after the action.
5. Clicking "Attach receipt" on a flagged-transaction row, uploading a real file, and confirming: creates a
   `Receipt` row whose `vendor`/`receiptDate`/`total` match the transaction's own `payeeRaw`/`postedAt`/
   `abs(amount)` (not necessarily whatever OCR alone would have guessed), sets `Transaction.receiptId` to
   the new receipt's id, applies the selected tag(s) via `TransactionTag`, and — if the selected tag(s)
   resolve to exactly one GL code via `TagGlCodeMapping` for that entity — sets `Transaction.glCodeId`
   accordingly, all via the unmodified `confirmReceipt` → `updateTransactionTags` → `autoAssignGlCodes`
   chain (verified by direct DB read of the resulting rows, not just UI observation).
6. After step 5, the same transaction no longer appears in `listFlaggedTransactions`'s output (its
   `receiptId` is now non-null).
7. `dismissReceiptRequirement` and the upload route's `transactionId` branch both throw/error when pointed
   at a transaction belonging to a non-business entity (fail-closed, matching this repo's established
   pattern from `credit-card-statement-import`'s `businessExpenseIndices` guard).
8. `needsReceiptWhere(entityId)` always includes `entity: { type: "business" }` in its returned where-input
   regardless of whether `entityId` is supplied — including when `entityId` is Personal's own real entity
   id (Personal is a real `Entity` row, not a null bucket) — verified by a unit test, not just inspection.
9. `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass with no new failures.
10. `git diff prisma/schema.prisma` is empty — no migration added or needed.

## Test expectations

- **Unit (Vitest, `lib/__tests__/receipt-flagging.test.ts`, new):** `needsReceiptWhere` (business-type
  filter always present; threshold value; entityId-narrowing branch), `receiptDismissalKey`,
  `serializeReceiptDismissal`/`parseReceiptDismissal` (valid round-trip, malformed JSON, missing field),
  `mergeReviewItems` (interleaving/ordering, empty-array edge cases on either input).
- **Not unit-tested** (matches established repo convention — confirmed by checking for an
  `actions/__tests__` directory, which doesn't exist anywhere in this repo, and confirming
  `vitest.config.ts` has no DOM/component test infra): `actions/receipts.ts`'s two new exports,
  `app/api/receipts/upload/route.ts`'s new branch, and every `.tsx` change — verified via `pnpm typecheck`
  + `pnpm lint` plus the manual smoke test below.
- **Manual smoke test (required given real financial/tax data, matching this repo's established
  discipline for this class of feature):**
  1. Visit `/receipts?bucket=ek-consulting&tab=review` — confirm ~20 flagged transactions render, visually
     distinct from any existing Receipt rows (EK Consulting currently has none, so this bucket exercises
     the "flagged-only" case).
  2. Visit `/receipts?bucket=sudden-valley&tab=review` — confirm the mix of 2 real existing Receipt rows
     ("Lowe's Home Centers, LLC," $28.93 each) plus ~55 flagged transactions all render on one page,
     correctly distinguished.
  3. Click "Not needed" on the real `CAPITAL ONE-CRCARDPMT` (-$352.30) EK Consulting row — confirm it
     disappears on reload; directly query `AppSetting`/`AuditLog` to confirm the two new rows.
  4. Click "Attach receipt" on a different real flagged row — confirm the upload page shows the
     transaction's own payee/date/amount as context (not a blank generic form), upload a real or test
     file, select a tag on the resulting confirm page, confirm the transaction is pre-selected as the
     match (not "Standalone receipt"), click Confirm — directly query the resulting `Transaction` row to
     confirm `receiptId`, `TransactionTag` rows, and (if the tag has a GL mapping) `glCodeId` are all set
     correctly.
  5. Reload `/receipts?bucket=ek-consulting&tab=review` — confirm the just-attached transaction no longer
     appears in the flagged list.
  6. Confirm `/receipts?bucket=personal&tab=review` shows zero flagged-transaction rows at every point
     above (ground rule 5).

## Edge cases worth explicit attention

- A flagged transaction whose `payeeRaw` is `null` — row must render `"Unknown"` (matches the existing
  Receipt-row fallback already in this page), not crash or show a blank cell.
- A transaction that's exactly `$75.00` (the boundary) — must be included (`lte: -75`, inclusive), not
  excluded; a unit test should assert this boundary explicitly rather than only testing values clearly
  above/below it.
- A transaction dismissed once, then later re-imported/re-synced with a new duplicate id by some future
  process — the dismissal key is per-transaction-id, so a genuinely new row would show up again undismissed;
  this is correct behavior (a new transaction is a new fact), not a bug, but worth noting so it isn't
  mistaken for the dismissal "not working."
- The upload route's `transactionId` branch when the uploaded file's OCR extraction genuinely fails (bad
  scan, network error) — `ocrStatus` must still end up `"complete"` (not `"failed"`) because vendor/date/
  total are already known from the transaction; only `description`/`glCode` are missing in that case, which
  is an acceptable, non-blocking gap (the user can still type a description manually on the confirm page).
