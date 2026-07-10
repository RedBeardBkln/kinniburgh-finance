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
import { Pencil, Trash2, ChevronDown, ChevronUp, Plus, X, PlusCircle } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DebtDetailShape {
  id: string;
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
}

export interface AccountWithDetail {
  id: string;
  nickname: string;
  mask: string | null;
  accountType: string;
  integrationMode: string;
  currentBalance: string | null;
  institutionName: string;
  entityName: string;
  debtDetail: DebtDetailShape | null;
}

export interface StandaloneDebt {
  id: string;
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
}

export interface TagOption {
  id: string;
  name: string;
  shortName: string;
}

interface Props {
  accounts: AccountWithDetail[];
  standaloneDebts: StandaloneDebt[];
  tags: TagOption[];
  ccAccounts: { id: string; nickname: string; mask: string | null; currentBalanceStr: string | null }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtUSD(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function typeBadgeClass(type: string) {
  if (type === "credit_card") return "bg-purple-100 text-purple-800";
  if (type === "mortgage") return "bg-blue-100 text-blue-800";
  if (type === "loan") return "bg-amber-100 text-amber-800";
  return "bg-gray-100 text-gray-700";
}

function typeLabel(type: string) {
  if (type === "credit_card") return "Credit Card";
  if (type === "mortgage") return "Mortgage";
  if (type === "loan") return "Loan";
  return type;
}

function accountEffectiveBalanceCents(account: AccountWithDetail): number | null {
  if (account.integrationMode === "plaid" && account.currentBalance != null) {
    const n = parseFloat(account.currentBalance);
    return isNaN(n) ? null : Math.round(Math.abs(n) * 100);
  }
  return account.debtDetail?.manualBalanceCents ?? null;
}

// ─── Shared detail form ────────────────────────────────────────────────────────

interface DetailFormProps {
  // account-linked: pass linked account info; standalone: pass null
  linked: { id: string; nickname: string; integrationMode: string } | null;
  existingId?: string;
  initialName?: string;
  initialValues?: Partial<DebtDetailShape>;
  tags: TagOption[];
  onSave: (data: Parameters<typeof upsertDebtDetail>[0]) => void;
  onCancel: () => void;
  pending: boolean;
}

function DetailForm({
  linked,
  existingId,
  initialName = "",
  initialValues,
  tags,
  onSave,
  onCancel,
  pending,
}: DetailFormProps) {
  const isPlaid = linked?.integrationMode === "plaid";
  const [name, setName] = useState(initialName);
  const [originalBalance, setOriginalBalance] = useState(
    initialValues?.originalBalanceCents != null
      ? (initialValues.originalBalanceCents / 100).toFixed(2)
      : ""
  );
  const [manualBalance, setManualBalance] = useState(
    initialValues?.manualBalanceCents != null
      ? (initialValues.manualBalanceCents / 100).toFixed(2)
      : ""
  );
  const [apr, setApr] = useState(initialValues?.interestRate ?? "");
  const [payment, setPayment] = useState(
    initialValues?.monthlyPaymentCents != null
      ? (initialValues.monthlyPaymentCents / 100).toFixed(2)
      : ""
  );
  const [paymentDay, setPaymentDay] = useState(
    initialValues?.paymentDay?.toString() ?? ""
  );
  const [tagId, setTagId] = useState(initialValues?.tagId ?? "");
  const [notes, setNotes] = useState(initialValues?.notes ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      id: existingId,
      accountId: linked ? linked.id : null,
      name: linked ? linked.nickname : name,
      originalBalanceCents: originalBalance
        ? Math.round(parseFloat(originalBalance) * 100)
        : null,
      manualBalanceCents:
        !isPlaid && manualBalance
          ? Math.round(parseFloat(manualBalance) * 100)
          : null,
      interestRate: apr ? parseFloat(apr) : null,
      monthlyPaymentCents: payment
        ? Math.round(parseFloat(payment) * 100)
        : null,
      paymentDay: paymentDay ? parseInt(paymentDay) : null,
      tagId: tagId || null,
      notes: notes || null,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Name — only for standalone debts */}
      {!linked && (
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
        {/* Manual balance — hidden for Plaid accounts (auto-synced) */}
        {!isPlaid && (
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
        )}
        <div className="space-y-1">
          <Label className="text-xs">
            Original balance ($){" "}
            <span className="font-normal text-muted-foreground">optional</span>
          </Label>
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
        <Label className="text-xs">
          Budget tag{" "}
          <span className="font-normal text-muted-foreground">
            optional — tag your payment transactions to track this in the budget
          </span>
        </Label>
        <Select
          value={tagId}
          onChange={(e) => setTagId(e.target.value)}
          className="h-8 text-sm"
        >
          <option value="">No tag</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">
          Notes <span className="font-normal text-muted-foreground">optional</span>
        </Label>
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
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({
  balanceCents,
  originalCents,
}: {
  balanceCents: number;
  originalCents: number;
}) {
  const pct = Math.max(
    0,
    Math.min(100, ((originalCents - balanceCents) / originalCents) * 100)
  );
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{pct.toFixed(0)}% paid off</span>
        <span>Original: {fmtUSD(originalCents)}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted">
        <div
          className="h-2 rounded-full bg-green-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Debt detail display ───────────────────────────────────────────────────────

function DebtStats({
  balanceCents,
  isPlaid,
  detail,
}: {
  balanceCents: number | null;
  isPlaid: boolean;
  detail: DebtDetailShape | null;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
      <div>
        <p className="text-xs text-muted-foreground">Balance</p>
        <p className="font-semibold tabular-nums">
          {balanceCents != null ? (
            fmtUSD(balanceCents)
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </p>
        {isPlaid && (
          <p className="text-xs text-muted-foreground">Plaid-synced</p>
        )}
      </div>
      <div>
        <p className="text-xs text-muted-foreground">APR</p>
        <p className="font-medium tabular-nums">
          {detail?.interestRate ? (
            `${parseFloat(detail.interestRate).toFixed(3)}%`
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Monthly payment</p>
        <p className="font-medium tabular-nums">
          {detail?.monthlyPaymentCents != null ? (
            fmtUSD(detail.monthlyPaymentCents)
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Due</p>
        <p className="font-medium">
          {detail?.paymentDay != null ? (
            `Day ${detail.paymentDay}`
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </p>
      </div>
    </div>
  );
}

// ─── Account card (always shown, detail optional) ─────────────────────────────

function AccountCard({
  account,
  tags,
}: {
  account: AccountWithDetail;
  tags: TagOption[];
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const detail = account.debtDetail;
  const isPlaid = account.integrationMode === "plaid";
  const balanceCents = accountEffectiveBalanceCents(account);

  function handleSave(data: Parameters<typeof upsertDebtDetail>[0]) {
    startTransition(async () => {
      await upsertDebtDetail(data);
      setFormOpen(false);
      router.refresh();
    });
  }

  const showProgress =
    !formOpen &&
    balanceCents != null &&
    detail?.originalBalanceCents != null &&
    detail.originalBalanceCents > 0;

  return (
    <Card className={pending ? "opacity-60" : ""}>
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{account.nickname}</span>
              {account.mask && (
                <span className="font-mono text-xs text-muted-foreground">
                  ···{account.mask}
                </span>
              )}
              <span
                className={`text-xs px-1.5 py-0.5 rounded font-medium ${typeBadgeClass(account.accountType)}`}
              >
                {typeLabel(account.accountType)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {[account.institutionName, account.entityName]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="shrink-0">
            {!formOpen ? (
              detail ? (
                <button
                  onClick={() => setFormOpen(true)}
                  className="text-muted-foreground hover:text-foreground"
                  title="Edit details"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  onClick={() => setFormOpen(true)}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <PlusCircle className="h-3.5 w-3.5" />
                  Add details
                </button>
              )
            ) : (
              <button
                onClick={() => setFormOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Stats (when form closed) */}
        {!formOpen && (
          <DebtStats
            balanceCents={balanceCents}
            isPlaid={isPlaid}
            detail={detail}
          />
        )}

        {/* Progress bar */}
        {showProgress && (
          <ProgressBar
            balanceCents={balanceCents!}
            originalCents={detail!.originalBalanceCents!}
          />
        )}

        {/* Tag badge */}
        {!formOpen && detail?.tagName && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              Payments tagged as:
            </span>
            <span className="text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded font-medium">
              {detail.tagShortName ?? detail.tagName}
            </span>
          </div>
        )}

        {/* Notes */}
        {!formOpen && detail?.notes && (
          <p className="text-xs text-muted-foreground border-t pt-2">
            {detail.notes}
          </p>
        )}

        {/* Inline form */}
        {formOpen && (
          <div className="border-t pt-4">
            <p className="text-sm font-medium mb-3">
              {detail ? "Edit details" : "Add details"}
            </p>
            <DetailForm
              linked={{ id: account.id, nickname: account.nickname, integrationMode: account.integrationMode }}
              existingId={detail?.id}
              initialValues={detail ?? undefined}
              tags={tags}
              onSave={handleSave}
              onCancel={() => setFormOpen(false)}
              pending={pending}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Standalone debt card ──────────────────────────────────────────────────────

function StandaloneDebtCard({
  debt,
  tags,
}: {
  debt: StandaloneDebt;
  tags: TagOption[];
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const balanceCents = debt.manualBalanceCents;

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
      router.refresh();
    });
  }

  const showProgress =
    !editing &&
    balanceCents != null &&
    debt.originalBalanceCents != null &&
    debt.originalBalanceCents > 0;

  return (
    <Card className={pending ? "opacity-60" : ""}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{debt.name}</span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                Standalone
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!editing && (
              <>
                <button
                  onClick={() => setEditing(true)}
                  className="text-muted-foreground hover:text-foreground"
                  title="Edit"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={handleDelete}
                  className="text-muted-foreground hover:text-destructive"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            {editing && (
              <button
                onClick={() => setEditing(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {!editing && (
          <DebtStats balanceCents={balanceCents} isPlaid={false} detail={debt} />
        )}

        {showProgress && (
          <ProgressBar
            balanceCents={balanceCents!}
            originalCents={debt.originalBalanceCents!}
          />
        )}

        {!editing && debt.tagName && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              Payments tagged as:
            </span>
            <span className="text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded font-medium">
              {debt.tagShortName ?? debt.tagName}
            </span>
          </div>
        )}

        {!editing && debt.notes && (
          <p className="text-xs text-muted-foreground border-t pt-2">
            {debt.notes}
          </p>
        )}

        {editing && (
          <div className="border-t pt-4">
            <p className="text-sm font-medium mb-3">Edit debt</p>
            <DetailForm
              linked={null}
              existingId={debt.id}
              initialName={debt.name}
              initialValues={debt}
              tags={tags}
              onSave={handleSave}
              onCancel={() => setEditing(false)}
              pending={pending}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Add standalone debt panel ─────────────────────────────────────────────────

function AddStandalonePanel({
  tags,
  onClose,
}: {
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
          <CardTitle className="text-base">Add Standalone Debt</CardTitle>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <DetailForm
          linked={null}
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

export function DebtDashboard({ accounts, standaloneDebts, tags, ccAccounts }: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);

  const totalBalanceCents =
    accounts.reduce((s, a) => s + (accountEffectiveBalanceCents(a) ?? 0), 0) +
    standaloneDebts.reduce((s, d) => s + (d.manualBalanceCents ?? 0), 0);

  const totalPaymentCents =
    accounts.reduce((s, a) => s + (a.debtDetail?.monthlyPaymentCents ?? 0), 0) +
    standaloneDebts.reduce((s, d) => s + (d.monthlyPaymentCents ?? 0), 0);

  const totalCount = accounts.length + standaloneDebts.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Debt Tracker</h1>
          <p className="text-sm text-muted-foreground">
            Track balances, payments, and payoff progress across all debts.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)} disabled={showAdd}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add Debt
        </Button>
      </div>

      {/* Summary bar */}
      {totalCount > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Total debt</p>
              <p className="text-xl font-bold tabular-nums mt-0.5">
                {fmtUSD(totalBalanceCents)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Monthly commitments</p>
              <p className="text-xl font-bold tabular-nums mt-0.5">
                {totalPaymentCents > 0 ? (
                  fmtUSD(totalPaymentCents)
                ) : (
                  <span className="text-muted-foreground text-base">—</span>
                )}
              </p>
            </CardContent>
          </Card>
          <Card className="col-span-2 sm:col-span-1">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Debts tracked</p>
              <p className="text-xl font-bold tabular-nums mt-0.5">
                {totalCount}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Add standalone debt */}
      {showAdd && (
        <AddStandalonePanel tags={tags} onClose={() => setShowAdd(false)} />
      )}

      {/* All accounts (always shown) */}
      {accounts.length > 0 && (
        <div className="space-y-3">
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} tags={tags} />
          ))}
        </div>
      )}

      {/* Standalone debts */}
      {standaloneDebts.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-muted-foreground">
            Standalone debts
          </p>
          {standaloneDebts.map((d) => (
            <StandaloneDebtCard key={d.id} debt={d} tags={tags} />
          ))}
        </div>
      )}

      {totalCount === 0 && !showAdd && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <p className="text-sm">
              No credit card, loan, or mortgage accounts found.
            </p>
            <p className="text-xs mt-1">
              Add accounts on the{" "}
              <a href="/accounts" className="text-primary hover:underline">
                Accounts page
              </a>{" "}
              or use &ldquo;Add Debt&rdquo; above for standalone debts.
            </p>
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
            {showCalculator ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
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
