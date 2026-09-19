"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  confirmBankStatement,
  retryStatementExtraction,
  retryAllPendingStatementExtractions,
  extractAllStatementTransactions,
  archiveBankStatement,
  type ConfirmStatementInput,
} from "@/actions/bank-statements";
import {
  describeStage,
  stageNeedsAttention,
  type StageDisplay,
  type StatementStage,
} from "@/lib/statement-import";
import { LIABILITY_ACCOUNT_TYPES } from "@/lib/statement-review";

interface AccountOption {
  id: string;
  nickname: string;
  mask: string | null;
  accountType: string;
}

interface StatementRow {
  id: string;
  documentId: string | null;
  accountId: string | null;
  accountNickname: string | null;
  periodStart: Date;
  periodEnd: Date;
  institutionName: string | null;
  accountMask: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  extractStatus: string;
  confirmedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  stage: StatementStage;
  importableRows: number;
  rowsInLedger: number;
}

interface Props {
  statements: StatementRow[];
  accounts: AccountOption[];
  entityId: string;
  entitySlug: string;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending:    { label: "Pending", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  processing: { label: "Processing", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  complete:   { label: "Extracted", cls: "bg-green-50 text-green-700 border-green-200" },
  failed:     { label: "Failed", cls: "bg-red-50 text-red-700 border-red-200" },
  skipped:    { label: "Skipped", cls: "bg-muted text-muted-foreground border-border" },
};

// Transaction-stage badge colours (see lib/statement-import.ts). Shown once the
// period/balance read is done; it answers the question the old green
// "Extracted" badge implied but never answered: are the transactions actually
// in the ledger?
const STAGE_TONE_CLASS: Record<StageDisplay["tone"], string> = {
  green: "bg-green-50 text-green-700 border-green-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  red: "bg-red-50 text-red-700 border-red-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  muted: "bg-muted text-muted-foreground border-border",
};

function toCentsInput(dollars: string): number | null {
  const trimmed = dollars.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(/[$,]/g, ""));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function fmtUSD(dollars: string | null): string {
  if (dollars === null) return "—";
  const value = Number(dollars);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(Math.abs(value));
  return value < 0 ? `(${formatted})` : formatted;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}


export function StatementsTable({ statements, accounts, entityId, entitySlug }: Props) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isParsingAll, startParseAll] = useTransition();
  const [parseAllResult, setParseAllResult] = useState<string | null>(null);
  const [isExtractingAll, startExtractAll] = useTransition();
  const [extractAllResult, setExtractAllResult] = useState<string | null>(null);

  const pendingCount = statements.filter((s) => s.extractStatus === "pending").length;
  const hasDocuments = statements.some((s) => s.documentId);

  function handleParseAll() {
    setParseAllResult(null);
    startParseAll(async () => {
      const res = await retryAllPendingStatementExtractions(entityId);
      setParseAllResult(
        `Parsed ${res.succeeded} of ${res.attempted}${res.failed > 0 ? ` — ${res.failed} failed, review manually` : ""}.`
      );
      router.refresh();
    });
  }

  function handleExtractAllTransactions() {
    setExtractAllResult(null);
    startExtractAll(async () => {
      const res = await extractAllStatementTransactions(entityId);
      setExtractAllResult(
        res.attempted === 0
          ? "All statements already have transactions extracted."
          : `Extracted transactions for ${res.succeeded} of ${res.attempted}${res.failed > 0 ? ` — ${res.failed} failed, retry from the statement's review page` : ""}. Review and import each statement's rows below.`
      );
      router.refresh();
    });
  }

  if (statements.length === 0) {
    return (
      <Card>
        <CardContent className="px-4 py-8 text-center text-sm text-muted-foreground">
          No statements uploaded yet. Upload one above.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Uploaded Statements</CardTitle>
        <div className="flex items-center gap-2">
          {extractAllResult && (
            <span className="max-w-xs text-xs text-muted-foreground">{extractAllResult}</span>
          )}
          {parseAllResult && (
            <span className="text-xs text-muted-foreground">{parseAllResult}</span>
          )}
          {hasDocuments && (
            <button
              onClick={handleExtractAllTransactions}
              disabled={isExtractingAll}
              className="inline-flex items-center rounded-md border border-input bg-background px-3 h-8 text-xs font-medium hover:bg-accent disabled:opacity-60"
            >
              {isExtractingAll ? "Extracting…" : "Extract transactions for all statements"}
            </button>
          )}
          {pendingCount > 0 && (
            <button
              onClick={handleParseAll}
              disabled={isParsingAll}
              className="inline-flex items-center rounded-md bg-primary px-3 h-8 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {isParsingAll ? "Parsing…" : `Parse All Pending (${pendingCount})`}
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">Period</th>
              <th className="px-4 py-3 font-medium">Account</th>
              <th className="px-4 py-3 font-medium text-right">Opening</th>
              <th className="px-4 py-3 font-medium text-right">Closing</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {statements.map((s) => {
              // Balances not read yet (pending/processing/failed/skipped): that
              // badge still drives the Parse/Retry buttons. Once read, the badge
              // reports where the TRANSACTIONS stand instead.
              const stageDisplay = describeStage(s.stage, s.importableRows, s.rowsInLedger);
              const status =
                s.extractStatus === "complete"
                  ? { label: stageDisplay.label, cls: STAGE_TONE_CLASS[stageDisplay.tone] }
                  : (STATUS_BADGE[s.extractStatus] ?? STATUS_BADGE.pending);
              const needsReview = !s.confirmedAt || stageNeedsAttention(s.stage);
              return (
                <StatementRowItem
                  key={s.id}
                  statement={s}
                  accounts={accounts}
                  entitySlug={entitySlug}
                  status={status ?? { label: s.extractStatus, cls: "bg-muted text-muted-foreground border-border" }}
                  needsReview={needsReview}
                  editing={editingId === s.id}
                  onEdit={() => setEditingId(editingId === s.id ? null : s.id)}
                  onDone={() => setEditingId(null)}
                  router={router}
                />
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function StatementRowItem({
  statement,
  accounts,
  entitySlug,
  status,
  needsReview,
  editing,
  onEdit,
  onDone,
  router,
}: {
  statement: StatementRow;
  accounts: AccountOption[];
  entitySlug: string;
  status: { label: string; cls: string };
  needsReview: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  router: ReturnType<typeof useRouter>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Editable form state
  const [periodStart, setPeriodStart] = useState(isoDate(statement.periodStart));
  const [periodEnd, setPeriodEnd] = useState(isoDate(statement.periodEnd));
  const [accountId, setAccountId] = useState(statement.accountId ?? "");
  const [institutionName, setInstitutionName] = useState(statement.institutionName ?? "");
  const [accountMask, setAccountMask] = useState(statement.accountMask ?? "");
  const [opening, setOpening] = useState(statement.openingBalance ?? "");
  const [closing, setClosing] = useState(statement.closingBalance ?? "");
  const [notes, setNotes] = useState(statement.notes ?? "");

  const selectedAccountType = accounts.find((a) => a.id === accountId)?.accountType;
  const isLiabilityAccount = selectedAccountType
    ? LIABILITY_ACCOUNT_TYPES.has(selectedAccountType)
    : false;

  function handleConfirm() {
    setError(null);
    const input: ConfirmStatementInput = {
      statementId: statement.id,
      periodStart,
      periodEnd,
      accountId: accountId || undefined,
      institutionName: institutionName || undefined,
      accountMask: accountMask || undefined,
      openingBalanceCents: toCentsInput(opening),
      closingBalanceCents: toCentsInput(closing),
      notes: notes || undefined,
    };
    startTransition(async () => {
      const res = await confirmBankStatement(input);
      if ("error" in res) {
        setError(res.error);
      } else {
        onDone();
        router.refresh();
      }
    });
  }

  function handleRetry() {
    setError(null);
    startTransition(async () => {
      const res = await retryStatementExtraction(statement.id);
      if ("error" in res) setError(res.error);
      router.refresh();
    });
  }

  function handleArchive() {
    startTransition(async () => {
      await archiveBankStatement(statement.id);
      router.refresh();
    });
  }

  return (
    <>
      <tr className={`border-b last:border-0 ${needsReview ? "bg-amber-50/30" : ""}`}>
        <td className="px-4 py-2 whitespace-nowrap tabular-nums">
          {isoDate(statement.periodStart)} → {isoDate(statement.periodEnd)}
        </td>
        <td className="px-4 py-2">
          {statement.accountNickname
            ?? [statement.institutionName, statement.accountMask].filter(Boolean).join(" ···")
            ?? "—"}
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
          {fmtUSD(statement.openingBalance)}
        </td>
        <td className="px-4 py-2 text-right tabular-nums font-medium">
          {fmtUSD(statement.closingBalance)}
        </td>
        <td className="px-4 py-2">
          <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${status.cls}`}>
            {status.label}
          </span>
          {!statement.confirmedAt && statement.extractStatus === "complete" && (
            <span className="ml-1 text-xs text-amber-700">unconfirmed</span>
          )}
        </td>
        <td className="px-4 py-2">
          <div className="flex items-center gap-2 justify-end">
            {statement.documentId && (
              // prefetch={false}: this route's page render can trigger a real,
              // non-idempotent AI extraction call as a side effect (see
              // app/documents/[id]/review/page.tsx). Next.js prefetches a Link
              // by default once it's in the viewport, not just on click — with
              // many rows on this page, that silently fired a burst of
              // concurrent extraction attempts for every visible statement,
              // racing each other and corrupting extractionStatus for several
              // real EK Consulting statements (confirmed live).
              <Link
                href={`/documents/${statement.documentId}/review?bucket=${entitySlug}` as Route}
                prefetch={false}
                className={
                  stageNeedsAttention(statement.stage)
                    ? "text-xs font-semibold text-primary hover:underline"
                    : "text-xs text-primary hover:underline"
                }
              >
                {stageNeedsAttention(statement.stage) ? "Review & import transactions →" : "View transactions →"}
              </Link>
            )}
            <button
              onClick={onEdit}
              className="text-xs text-primary hover:underline"
            >
              {editing ? "Close" : "Edit"}
            </button>
            {(statement.extractStatus === "failed" || statement.extractStatus === "pending") && (
              <button
                onClick={handleRetry}
                disabled={isPending}
                className="text-xs text-primary hover:underline disabled:opacity-50"
              >
                {isPending ? "Parsing…" : statement.extractStatus === "pending" ? "Parse" : "Retry"}
              </button>
            )}
            <button
              onClick={handleArchive}
              disabled={isPending}
              className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
            >
              Archive
            </button>
          </div>
        </td>
      </tr>

      {editing && (
        <tr className="border-b bg-muted/20">
          <td colSpan={6} className="px-4 py-4">
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <div className="space-y-1">
                <label className="text-xs font-medium">Period start</label>
                <Input
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Period end</label>
                <Input
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Account</label>
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs"
                >
                  <option value="">Unlinked</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nickname}{a.mask ? ` (···${a.mask})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Institution</label>
                <Input
                  value={institutionName}
                  onChange={(e) => setInstitutionName(e.target.value)}
                  placeholder="e.g. JCSB"
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Last 4 digits</label>
                <Input
                  value={accountMask}
                  onChange={(e) => setAccountMask(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  placeholder="1234"
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Opening balance ($)</label>
                <Input
                  value={opening}
                  onChange={(e) => setOpening(e.target.value)}
                  placeholder="12500.00"
                  className="h-8 text-xs tabular-nums"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Closing balance ($)</label>
                <Input
                  value={closing}
                  onChange={(e) => setClosing(e.target.value)}
                  placeholder="13100.00"
                  className="h-8 text-xs tabular-nums"
                />
                {isLiabilityAccount && (
                  <p className="text-[10px] text-muted-foreground">
                    Credit card, mortgage, or loan balances: enter the amount owed. It is saved
                    as a positive number, matching how the balance sheet treats it.
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Notes</label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            </div>
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
            <div className="mt-3">
              <button
                onClick={handleConfirm}
                disabled={isPending}
                className="inline-flex items-center rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {isPending ? "Saving…" : "Save & confirm"}
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}