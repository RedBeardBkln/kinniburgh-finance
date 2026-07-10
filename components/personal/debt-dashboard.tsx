"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { upsertDebtDetail, deleteDebtDetail } from "@/actions/debt";
import { DebtFreeCalculator } from "@/components/personal/debt-free-calculator";
import { Pencil, Trash2, ChevronDown, ChevronUp, Plus, X } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SerializedDebt {
  id: string;
  accountId: string | null;
  name: string;
  originalBalanceCents: number | null;
  manualBalanceCents: number | null;
  interestRate: string | null;
  monthlyPaymentCents: number | null;
  paymentDay: number | null;
  tagId: string | null;
  tagName: string | null;
  tagShortName: string | null;
  notes: string | null;
  sortOrder: number;
  // from linked account
  accountNickname: string | null;
  accountMask: string | null;
  accountType: string | null;
  accountIntegrationMode: string | null;
  accountBalance: string | null;
  institutionName: string | null;
  entityName: string | null;
}

export interface UnlinkedAccount {
  id: string;
  nickname: string;
  mask: string | null;
  accountType: string;
  currentBalance: string | null;
  institutionName: string;
  entityName: string;
}

export interface TagOption {
  id: string;
  name: string;
  shortName: string;
}

interface Props {
  debts: SerializedDebt[];
  unlinkedAccounts: UnlinkedAccount[];
  tags: TagOption[];
  ccAccounts: { id: string; nickname: string; mask: string | null; currentBalanceStr: string | null }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtUSD(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function fmtBalance(dollars: string | null | undefined) {
  if (!dollars) return null;
  const n = parseFloat(dollars);
  if (isNaN(n)) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function typeBadgeClass(type: string | null) {
  if (type === "credit_card") return "bg-purple-100 text-purple-800";
  if (type === "mortgage") return "bg-blue-100 text-blue-800";
  if (type === "loan") return "bg-amber-100 text-amber-800";
  return "bg-gray-100 text-gray-700";
}

function typeLabel(type: string | null) {
  if (type === "credit_card") return "Credit Card";
  if (type === "mortgage") return "Mortgage";
  if (type === "loan") return "Loan";
  return type ?? "Debt";
}

function effectiveBalance(debt: SerializedDebt): number | null {
  // Plaid-linked: use account balance
  if (debt.accountIntegrationMode === "plaid" && debt.accountBalance != null) {
    const n = parseFloat(debt.accountBalance);
    return isNaN(n) ? null : Math.round(Math.abs(n) * 100);
  }
  // Otherwise: use manual balance
  return debt.manualBalanceCents;
}

// ─── Debt form (shared for add + edit) ────────────────────────────────────────

interface DebtFormProps {
  initial?: Partial<SerializedDebt>;
  unlinkedAccounts: UnlinkedAccount[];
  tags: TagOption[];
  onSave: (data: Parameters<typeof upsertDebtDetail>[0]) => void;
  onCancel: () => void;
  pending: boolean;
  isEdit?: boolean;
}

function DebtForm({ initial, unlinkedAccounts, tags, onSave, onCancel, pending, isEdit }: DebtFormProps) {
  const [mode, setMode] = useState<"account" | "standalone">(
    initial?.accountId ? "account" : (isEdit && !initial?.accountId ? "standalone" : "account")
  );
  const [accountId, setAccountId] = useState(initial?.accountId ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [originalBalance, setOriginalBalance] = useState(
    initial?.originalBalanceCents != null ? (initial.originalBalanceCents / 100).toFixed(2) : ""
  );
  const [manualBalance, setManualBalance] = useState(
    initial?.manualBalanceCents != null ? (initial.manualBalanceCents / 100).toFixed(2) : ""
  );
  const [apr, setApr] = useState(initial?.interestRate ?? "");
  const [payment, setPayment] = useState(
    initial?.monthlyPaymentCents != null ? (initial.monthlyPaymentCents / 100).toFixed(2) : ""
  );
  const [paymentDay, setPaymentDay] = useState(initial?.paymentDay?.toString() ?? "");
  const [tagId, setTagId] = useState(initial?.tagId ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const selectedAccount = mode === "account" && accountId
      ? unlinkedAccounts.find((a) => a.id === accountId)
      : null;

    onSave({
      id: initial?.id,
      accountId: mode === "account" ? (accountId || null) : null,
      name: mode === "account" && selectedAccount ? selectedAccount.nickname : name,
      originalBalanceCents: originalBalance ? Math.round(parseFloat(originalBalance) * 100) : null,
      manualBalanceCents: manualBalance ? Math.round(parseFloat(manualBalance) * 100) : null,
      interestRate: apr ? parseFloat(apr) : null,
      monthlyPaymentCents: payment ? Math.round(parseFloat(payment) * 100) : null,
      paymentDay: paymentDay ? parseInt(paymentDay) : null,
      tagId: tagId || null,
      notes: notes || null,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {!isEdit && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("account")}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${mode === "account" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
          >
            Link to account
          </button>
          <button
            type="button"
            onClick={() => setMode("standalone")}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${mode === "standalone" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
          >
            Standalone debt
          </button>
        </div>
      )}

      {mode === "account" && !isEdit && (
        <div className="space-y-1">
          <Label className="text-xs">Account</Label>
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="h-8 text-sm" required>
            <option value="">Select account…</option>
            {unlinkedAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname}{a.mask ? ` ···${a.mask}` : ""} — {typeLabel(a.accountType)} ({a.entityName})
              </option>
            ))}
          </Select>
        </div>
      )}

      {mode === "standalone" && (
        <div className="space-y-1">
          <Label className="text-xs">Debt name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Toyota Camry Loan"
            className="h-8 text-sm"
            required
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Current balance ($)</Label>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={manualBalance}
            onChange={(e) => setManualBalance(e.target.value)}
            placeholder="18000.00"
            className="h-8 text-sm font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Original balance ($) <span className="font-normal text-muted-foreground">optional</span></Label>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={originalBalance}
            onChange={(e) => setOriginalBalance(e.target.value)}
            placeholder="25000.00"
            className="h-8 text-sm font-mono"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">APR (%)</Label>
          <Input
            type="number"
            step="0.001"
            min="0"
            max="100"
            value={apr}
            onChange={(e) => setApr(e.target.value)}
            placeholder="6.500"
            className="h-8 text-sm font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Monthly payment ($)</Label>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={payment}
            onChange={(e) => setPayment(e.target.value)}
            placeholder="250.00"
            className="h-8 text-sm font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Due day</Label>
          <Input
            type="number"
            min="1"
            max="31"
            value={paymentDay}
            onChange={(e) => setPaymentDay(e.target.value)}
            placeholder="15"
            className="h-8 text-sm font-mono"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Budget tag <span className="font-normal text-muted-foreground">optional — tag your payment transactions to track this in the budget</span></Label>
        <Select value={tagId} onChange={(e) => setTagId(e.target.value)} className="h-8 text-sm">
          <option value="">No tag</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Notes <span className="font-normal text-muted-foreground">optional</span></Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Any relevant notes…"
          className="text-sm"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Debt card ────────────────────────────────────────────────────────────────

function DebtCard({
  debt,
  tags,
  unlinkedAccounts,
  onDeleted,
}: {
  debt: SerializedDebt;
  tags: TagOption[];
  unlinkedAccounts: UnlinkedAccount[];
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const balance = effectiveBalance(debt);
  const progress =
    balance != null && debt.originalBalanceCents != null && debt.originalBalanceCents > 0
      ? Math.max(0, Math.min(100, ((debt.originalBalanceCents - balance) / debt.originalBalanceCents) * 100))
      : null;

  function handleSave(data: Parameters<typeof upsertDebtDetail>[0]) {
    startTransition(async () => {
      await upsertDebtDetail({ ...data, id: debt.id });
      setEditing(false);
      router.refresh();
    });
  }

  function handleDelete() {
    if (!confirm(`Delete "${debt.name}"?`)) return;
    startTransition(async () => {
      await deleteDebtDetail(debt.id);
      onDeleted();
      router.refresh();
    });
  }

  return (
    <Card className={pending ? "opacity-60" : ""}>
      <CardContent className="p-4 space-y-3">
        {!editing ? (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm">{debt.accountNickname ?? debt.name}</span>
                  {debt.accountMask && <span className="font-mono text-xs text-muted-foreground">···{debt.accountMask}</span>}
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${typeBadgeClass(debt.accountType)}`}>
                    {typeLabel(debt.accountType)}
                  </span>
                  {!debt.accountId && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">Standalone</span>
                  )}
                </div>
                {(debt.institutionName || debt.entityName) && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {[debt.institutionName, debt.entityName].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => setEditing(true)} className="text-muted-foreground hover:text-foreground" title="Edit">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={handleDelete} className="text-muted-foreground hover:text-destructive" title="Delete">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Balance</p>
                <p className="font-semibold tabular-nums">
                  {balance != null ? fmtUSD(balance) : <span className="text-muted-foreground">—</span>}
                </p>
                {debt.accountIntegrationMode === "plaid" && (
                  <p className="text-xs text-muted-foreground">Plaid-synced</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground">APR</p>
                <p className="font-medium tabular-nums">
                  {debt.interestRate ? `${parseFloat(debt.interestRate).toFixed(3)}%` : <span className="text-muted-foreground">—</span>}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Monthly payment</p>
                <p className="font-medium tabular-nums">
                  {debt.monthlyPaymentCents != null ? fmtUSD(debt.monthlyPaymentCents) : <span className="text-muted-foreground">—</span>}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Due</p>
                <p className="font-medium">
                  {debt.paymentDay != null ? `Day ${debt.paymentDay}` : <span className="text-muted-foreground">—</span>}
                </p>
              </div>
            </div>

            {progress !== null && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{progress.toFixed(0)}% paid off</span>
                  {debt.originalBalanceCents && <span>Original: {fmtUSD(debt.originalBalanceCents)}</span>}
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div className="h-2 rounded-full bg-green-500 transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            {debt.tagName && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Payments tagged as:</span>
                <span className="text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded font-medium">
                  {debt.tagShortName ?? debt.tagName}
                </span>
              </div>
            )}

            {debt.notes && (
              <p className="text-xs text-muted-foreground border-t pt-2">{debt.notes}</p>
            )}
          </>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium">Edit debt</span>
              <button onClick={() => setEditing(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <DebtForm
              initial={debt}
              unlinkedAccounts={unlinkedAccounts}
              tags={tags}
              onSave={handleSave}
              onCancel={() => setEditing(false)}
              pending={pending}
              isEdit
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Untracked account row ─────────────────────────────────────────────────────

function UntrackedRow({
  account,
  tags,
  onAdded,
}: {
  account: UnlinkedAccount;
  tags: TagOption[];
  onAdded: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleSave(data: Parameters<typeof upsertDebtDetail>[0]) {
    startTransition(async () => {
      await upsertDebtDetail({ ...data, accountId: account.id });
      onAdded();
      router.refresh();
    });
  }

  return (
    <div className={`rounded-lg border border-dashed px-4 py-3 transition-colors ${expanded ? "bg-card" : "hover:bg-muted/30"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{account.nickname}</span>
          {account.mask && <span className="font-mono text-xs text-muted-foreground">···{account.mask}</span>}
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${typeBadgeClass(account.accountType)}`}>
            {typeLabel(account.accountType)}
          </span>
          {account.currentBalance && (
            <span className="text-xs text-muted-foreground">{fmtBalance(account.currentBalance)}</span>
          )}
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-primary hover:underline flex items-center gap-1"
        >
          Track this debt
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </div>

      {expanded && (
        <div className="mt-4 border-t pt-4">
          <DebtForm
            initial={{ name: account.nickname }}
            unlinkedAccounts={[]}
            tags={tags}
            onSave={handleSave}
            onCancel={() => setExpanded(false)}
            pending={pending}
            isEdit
          />
        </div>
      )}
    </div>
  );
}

// ─── Add standalone debt ───────────────────────────────────────────────────────

function AddDebtPanel({
  unlinkedAccounts,
  tags,
  onClose,
}: {
  unlinkedAccounts: UnlinkedAccount[];
  tags: TagOption[];
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleSave(data: Parameters<typeof upsertDebtDetail>[0]) {
    startTransition(async () => {
      await upsertDebtDetail(data);
      onClose();
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Add Debt</CardTitle>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <DebtForm
          unlinkedAccounts={unlinkedAccounts}
          tags={tags}
          onSave={handleSave}
          onCancel={onClose}
          pending={pending}
        />
      </CardContent>
    </Card>
  );
}

// ─── Main dashboard ────────────────────────────────────────────────────────────

export function DebtDashboard({ debts, unlinkedAccounts, tags, ccAccounts }: Props) {
  const [localDebts, setLocalDebts] = useState(debts);
  const [showAdd, setShowAdd] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);

  // Summary totals
  const totalBalanceCents = localDebts.reduce((sum, d) => {
    const b = effectiveBalance(d);
    return sum + (b ?? 0);
  }, 0);
  const totalPaymentCents = localDebts.reduce((sum, d) => sum + (d.monthlyPaymentCents ?? 0), 0);

  function handleDeleted(id: string) {
    setLocalDebts((prev) => prev.filter((d) => d.id !== id));
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Debt Tracker</h1>
          <p className="text-sm text-muted-foreground">Track balances, payments, and payoff progress across all debts.</p>
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)} disabled={showAdd}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add Debt
        </Button>
      </div>

      {/* Summary bar */}
      {localDebts.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Total debt</p>
              <p className="text-xl font-bold tabular-nums mt-0.5">{fmtUSD(totalBalanceCents)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Monthly commitments</p>
              <p className="text-xl font-bold tabular-nums mt-0.5">
                {totalPaymentCents > 0 ? fmtUSD(totalPaymentCents) : <span className="text-muted-foreground text-base">—</span>}
              </p>
            </CardContent>
          </Card>
          <Card className="col-span-2 sm:col-span-1">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Debts tracked</p>
              <p className="text-xl font-bold tabular-nums mt-0.5">{localDebts.length}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Add debt form */}
      {showAdd && (
        <AddDebtPanel
          unlinkedAccounts={unlinkedAccounts}
          tags={tags}
          onClose={() => setShowAdd(false)}
        />
      )}

      {/* Tracked debts */}
      {localDebts.length > 0 && (
        <div className="space-y-3">
          {localDebts.map((debt) => (
            <DebtCard
              key={debt.id}
              debt={debt}
              tags={tags}
              unlinkedAccounts={unlinkedAccounts}
              onDeleted={() => handleDeleted(debt.id)}
            />
          ))}
        </div>
      )}

      {/* Untracked debt accounts */}
      {unlinkedAccounts.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">
            {localDebts.length > 0 ? "Also on your accounts page (not yet tracked):" : "Accounts available to track:"}
          </p>
          <div className="space-y-2">
            {unlinkedAccounts.map((a) => (
              <UntrackedRow
                key={a.id}
                account={a}
                tags={tags}
                onAdded={() => {}}
              />
            ))}
          </div>
        </div>
      )}

      {localDebts.length === 0 && unlinkedAccounts.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <p className="text-sm">No credit card, loan, or mortgage accounts found.</p>
            <p className="text-xs mt-1">Add accounts on the <a href="/accounts" className="text-primary hover:underline">Accounts page</a> or use "Add Debt" above for standalone debts.</p>
          </CardContent>
        </Card>
      )}

      {/* Payoff calculator (collapsible) */}
      {ccAccounts.length > 0 && (
        <div className="border-t pt-6">
          <button
            onClick={() => setShowCalculator((v) => !v)}
            className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {showCalculator ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            Payoff Calculator
          </button>
          {showCalculator && (
            <div className="mt-4">
              <DebtFreeCalculator accounts={ccAccounts} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
