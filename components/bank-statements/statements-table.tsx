"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  confirmBankStatement,
  retryStatementExtraction,
  archiveBankStatement,
  type ConfirmStatementInput,
} from "@/actions/bank-statements";

interface AccountOption {
  id: string;
  nickname: string;
  mask: string | null;
  accountType: string;
}

interface StatementRow {
  id: string;
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
}

interface Props {
  statements: StatementRow[];
  accounts: AccountOption[];
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending:    { label: "Pending", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  processing: { label: "Processing", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  complete:   { label: "Extracted", cls: "bg-green-50 text-green-700 border-green-200" },
  failed:     { label: "Failed", cls: "bg-red-50 text-red-700 border-red-200" },
  skipped:    { label: "Skipped", cls: "bg-muted text-muted-foreground border-border" },
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

const LIABILITY_ACCOUNT_TYPES = new Set(["credit_card", "mortgage", "loan"]);

export function StatementsTable({ statements, accounts }: Props) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);

  if (statements.length === 0) {
    return (
      <Card>
        <CardContent className="px-4 py-8 text-center text-sm text-muted-foreground">
          No statements uploaded yet. Upload one above — balances feed the monthly,
          quarterly, and annual balance sheets.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Uploaded Statements</CardTitle>
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
              const status = STATUS_BADGE[s.extractStatus] ?? STATUS_BADGE.pending;
              const needsReview = !s.confirmedAt;
              return (
                <StatementRowItem
                  key={s.id}
                  statement={s}
                  accounts={accounts}
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
  status,
  needsReview,
  editing,
  onEdit,
  onDone,
  router,
}: {
  statement: StatementRow;
  accounts: AccountOption[];
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
          {needsReview && statement.extractStatus === "complete" && (
            <span className="ml-1 text-xs text-amber-700">unconfirmed</span>
          )}
        </td>
        <td className="px-4 py-2">
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={onEdit}
              className="text-xs text-primary hover:underline"
            >
              {editing ? "Close" : needsReview ? "Review" : "Edit"}
            </button>
            {statement.extractStatus === "failed" && (
              <button
                onClick={handleRetry}
                disabled={isPending}
                className="text-xs text-primary hover:underline disabled:opacity-50"
              >
                Retry
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
                    Credit card, mortgage, or loan balances: enter the amount owed. Positive
                    or negative both work — the balance sheet always treats it as debt owed.
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