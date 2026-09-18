"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  createAccount,
  updateAccount,
  archiveAccount,
  dismissPendingPlaidItem,
  countAccountTransactions,
  reassignAccountEntity,
} from "@/actions/accounts";
import { ACCOUNT_TYPE_OPTIONS } from "@/lib/account-types";

const NEW_INSTITUTION_SENTINEL = "__new__";

export interface SerializedAccount {
  id: string;
  nickname: string;
  mask: string | null;
  accountType: string;
  integrationMode: string;
  minimumBalance: string | null;
  minimumBalanceFee: string | null;
  currentBalance: string | null;
  currentBalanceAt: string | null;
  ccDueDate: string | null;
  ccStatementBalance: string | null;
  ccMinimumPayment: string | null;
  ccApr: string | null;
  ccDataAt: string | null;
  entityId: string;
  entityName: string;
  institutionId: string;
  institutionName: string;
  plaidStatus: string | null;
  plaidItemId: string | null;
  plaidLastSyncedAt: string | null;
}

export interface SerializedInstitution {
  id: string;
  name: string;
  plaidCoverageNotes: string | null;
}

export interface SerializedEntity {
  id: string;
  name: string;
}

export interface SerializedPendingPlaidItem {
  itemId: string;
  institutionName: string | null;
  status: string;
  createdAt: string;
}

interface Props {
  accounts: SerializedAccount[];
  institutions: SerializedInstitution[];
  entities: SerializedEntity[];
  pendingPlaidItems: SerializedPendingPlaidItem[];
}

type ModalState =
  | null
  | { mode: "add" }
  | { mode: "edit"; account: SerializedAccount }
  | { mode: "move"; account: SerializedAccount };

function modeBadge(mode: string) {
  const styles: Record<string, string> = {
    plaid: "bg-green-100 text-green-800 border-green-200",
    manual_import: "bg-blue-100 text-blue-800 border-blue-200",
    manual_entry: "bg-gray-100 text-gray-700 border-gray-200",
  };
  const labels: Record<string, string> = {
    plaid: "Plaid",
    manual_import: "CSV Import",
    manual_entry: "Manual",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${styles[mode] ?? styles.manual_entry}`}>
      {labels[mode] ?? mode}
    </span>
  );
}

function DueDateCell({ dueDate }: { dueDate: string }) {
  const d = new Date(dueDate);
  const now = new Date();
  const daysUntil = Math.ceil((d.getTime() - now.getTime()) / 86400000);

  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(d);

  if (daysUntil < 0) {
    return (
      <span className="font-medium text-destructive">
        {formatted} · {Math.abs(daysUntil)}d overdue
      </span>
    );
  }
  if (daysUntil <= 7) {
    return (
      <span className="font-medium text-amber-600">
        {formatted} · {daysUntil === 0 ? "today" : `${daysUntil}d`}
      </span>
    );
  }
  return <span className="text-muted-foreground">{formatted}</span>;
}

function AccountModal({ modal, institutions, entities, onClose }: {
  modal: ModalState & { mode: "add" | "edit" };
  institutions: SerializedInstitution[];
  entities: SerializedEntity[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [addingNewInstitution, setAddingNewInstitution] = useState(false);

  const isEdit = modal.mode === "edit";
  const a = isEdit ? modal.account : null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);

    startTransition(async () => {
      try {
        if (isEdit) {
          await updateAccount({
            id: a!.id,
            nickname: fd.get("nickname") as string,
            accountType: fd.get("accountType") as "checking",
            minimumBalance: (fd.get("minimumBalance") as string) || null,
            minimumBalanceFee: (fd.get("minimumBalanceFee") as string) || null,
          });
        } else {
          const institutionId = fd.get("institutionId") as string;
          await createAccount({
            institutionId: addingNewInstitution ? undefined : institutionId,
            newInstitutionName: addingNewInstitution ? ((fd.get("newInstitutionName") as string) || undefined) : undefined,
            entityId: fd.get("entityId") as string,
            nickname: fd.get("nickname") as string,
            mask: (fd.get("mask") as string) || undefined,
            accountType: fd.get("accountType") as "checking",
            minimumBalance: (fd.get("minimumBalance") as string) || undefined,
            minimumBalanceFee: (fd.get("minimumBalanceFee") as string) || undefined,
          });
        }
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">
          {isEdit ? "Edit Account" : "Add Account"}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Entity — add only */}
          {!isEdit && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Entity</label>
              <select name="entityId" className="w-full rounded border px-3 py-2 text-sm" required>
                <option value="">Select entity…</option>
                {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          )}

          {/* Institution — add only */}
          {!isEdit && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Institution</label>
              {addingNewInstitution ? (
                <>
                  <input
                    name="newInstitutionName"
                    type="text"
                    maxLength={200}
                    placeholder="e.g. CorePlus Credit Union"
                    className="w-full rounded border px-3 py-2 text-sm"
                    autoFocus
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setAddingNewInstitution(false)}
                    className="text-xs text-primary hover:underline"
                  >
                    ‹ choose existing instead
                  </button>
                </>
              ) : (
                <select
                  name="institutionId"
                  className="w-full rounded border px-3 py-2 text-sm"
                  required
                  onChange={(e) => {
                    if (e.target.value === NEW_INSTITUTION_SENTINEL) setAddingNewInstitution(true);
                  }}
                >
                  <option value="">Select institution…</option>
                  {institutions.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  <option value={NEW_INSTITUTION_SENTINEL}>+ Add new institution…</option>
                </select>
              )}
            </div>
          )}

          {/* Account type */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Account Type</label>
            <select name="accountType" className="w-full rounded border px-3 py-2 text-sm" required defaultValue={a?.accountType ?? ""}>
              {!isEdit && <option value="">Select type…</option>}
              {ACCOUNT_TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          {/* Nickname */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Nickname</label>
            <input name="nickname" type="text" defaultValue={a?.nickname ?? ""} maxLength={100} className="w-full rounded border px-3 py-2 text-sm" required />
          </div>

          {/* Last 4 digits — add only */}
          {!isEdit && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Last 4 digits <span className="font-normal text-muted-foreground">(optional)</span></label>
              <input name="mask" type="text" maxLength={10} placeholder="e.g. 1234" className="w-full rounded border px-3 py-2 text-sm" />
            </div>
          )}

          {/* Minimum balance */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Minimum Balance <span className="font-normal text-muted-foreground">(optional — enables envelope solvency)</span></label>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">$</span>
              <input name="minimumBalance" type="number" step="0.01" min="0" defaultValue={a?.minimumBalance ?? ""} placeholder="e.g. 100.00" className="w-full rounded border px-3 py-2 text-sm" />
            </div>
          </div>

          {/* Minimum balance fee */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Minimum Balance Fee <span className="font-normal text-muted-foreground">(default $15)</span></label>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">$</span>
              <input name="minimumBalanceFee" type="number" step="0.01" min="0" defaultValue={a?.minimumBalanceFee ?? ""} placeholder="15.00" className="w-full rounded border px-3 py-2 text-sm" />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={isPending} className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={isPending} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MoveAccountModal({
  account,
  entities,
  onClose,
}: {
  account: SerializedAccount;
  entities: SerializedEntity[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [newEntityId, setNewEntityId] = useState("");
  const [txCount, setTxCount] = useState<number | null>(null);
  const [reassignTx, setReassignTx] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ transactionsReassigned: number } | null>(null);

  useEffect(() => {
    countAccountTransactions(account.id).then(setTxCount);
  }, [account.id]);

  const otherEntities = entities.filter((e) => e.id !== account.entityId);
  const targetEntity = entities.find((e) => e.id === newEntityId);

  function handleConfirm() {
    if (!newEntityId) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await reassignAccountEntity({
          accountId: account.id,
          newEntityId,
          reassignExistingTransactions: reassignTx,
        });
        setResult(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to move account");
      }
    });
  }

  if (result) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-xl space-y-4">
          <h2 className="text-lg font-semibold">Account moved</h2>
          <p className="text-sm text-muted-foreground">
            &ldquo;{account.nickname}&rdquo; now belongs to {targetEntity?.name}.
            {result.transactionsReassigned > 0 &&
              ` ${result.transactionsReassigned} existing transaction${result.transactionsReassigned !== 1 ? "s" : ""} reassigned too.`}
          </p>
          <div className="flex justify-end">
            <button
              onClick={() => {
                router.refresh();
                onClose();
              }}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-xl space-y-4">
        <h2 className="text-lg font-semibold">Move &ldquo;{account.nickname}&rdquo;</h2>
        <p className="text-sm text-muted-foreground">
          Currently under <span className="font-medium">{account.entityName}</span>.
        </p>

        <div className="space-y-1">
          <label className="text-sm font-medium">Move to</label>
          <select
            value={newEntityId}
            onChange={(e) => setNewEntityId(e.target.value)}
            className="w-full rounded border px-3 py-2 text-sm"
          >
            <option value="">Select entity…</option>
            {otherEntities.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>

        <div className="rounded-md border bg-muted/30 p-3 space-y-2">
          <p className="text-sm">
            {txCount === null ? (
              "Checking existing transactions…"
            ) : (
              <>This account has <strong>{txCount}</strong> existing transaction{txCount !== 1 ? "s" : ""} under {account.entityName}.</>
            )}
          </p>
          {txCount !== null && txCount > 0 && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={reassignTx}
                onChange={(e) => setReassignTx(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                Also reassign {txCount === 1 ? "it" : "all of them"} to the new entity.
                {!reassignTx &&
                  ` Leave unchecked to move only the account going forward — existing transactions stay under ${account.entityName}.`}
              </span>
            </label>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={isPending} className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isPending || !newEntityId || txCount === null}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isPending ? "Moving…" : "Move Account"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AccountsPageClient({ accounts, institutions, entities, pendingPlaidItems }: Props) {
  const router = useRouter();
  const [modal, setModal] = useState<ModalState>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [syncingItemId, setSyncingItemId] = useState<string | null>(null);
  const [dismissingItemId, setDismissingItemId] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{
    itemId: string;
    institutionName: string | null;
    added: number;
    cardsUpdated: { accountNickname: string; dueDate: string | null; statementBalance: string | null }[];
    liabilitiesNote: string | null;
  } | null>(null);
  const [, startTransition] = useTransition();

  async function onSync(itemId: string) {
    setSyncingItemId(itemId);
    setSyncResult(null);
    try {
      const resp = await fetch(`/api/plaid/sync/${itemId}`, { method: "POST" });
      if (resp.ok) {
        const data = (await resp.json()) as {
          added: number;
          institutionName: string | null;
          cardsUpdated: { accountNickname: string; dueDate: string | null; statementBalance: string | null }[];
          liabilitiesNote: string | null;
        };
        setSyncResult({ itemId, ...data });
      }
      router.refresh();
    } finally {
      setSyncingItemId(null);
    }
  }

  function onDismissPending(itemId: string, institutionName: string | null) {
    if (!confirm(`Dismiss "${institutionName ?? "this connection"}"? Use this only for a stale/duplicate connection you don't need — it won't delete anything, but the banner won't reappear unless it's re-linked.`)) return;
    setDismissingItemId(itemId);
    setDismissError(null);
    startTransition(async () => {
      try {
        await dismissPendingPlaidItem(itemId);
        router.refresh();
      } catch (e) {
        setDismissError(e instanceof Error ? e.message : "Failed to dismiss");
      } finally {
        setDismissingItemId(null);
      }
    });
  }

  function onArchive(id: string, nickname: string) {
    if (!confirm(`Archive "${nickname}"? It will no longer appear in transactions or forecasts.`)) return;
    setArchivingId(id);
    startTransition(async () => {
      await archiveAccount(id);
      setArchivingId(null);
      router.refresh();
    });
  }

  // Group by entity
  const byEntity = new Map<string, SerializedAccount[]>();
  for (const a of accounts) {
    if (!byEntity.has(a.entityName)) byEntity.set(a.entityName, []);
    byEntity.get(a.entityName)!.push(a);
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Accounts</h1>
            <p className="text-sm text-muted-foreground">Bank connections, integration modes, and live balances</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setModal({ mode: "add" })}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              + Add Account
            </button>
            <Link href="/accounts/connect" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              + Connect Bank
            </Link>
          </div>
        </div>

        {/* Accounts pending mapping — a PlaidItem that connected successfully
            but has zero linked Account rows yet (e.g. no seeded account to
            auto-match to). "Finish setup" resumes the mapping step directly,
            skipping Plaid Link since auth is already done. */}
        {pendingPlaidItems.length > 0 && (
          <div className="space-y-2">
            {dismissError && <p className="text-sm text-destructive">{dismissError}</p>}
            {pendingPlaidItems.map((item) => (
              <div
                key={item.itemId}
                className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm"
              >
                <span className="text-amber-800">
                  <span className="font-medium">{item.institutionName ?? "Unnamed bank"}</span> — connected but not finished
                  {item.status === "requires_login" && " (needs re-authentication)"}.
                </span>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/accounts/connect?resumeItemId=${item.itemId}`}
                    className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
                  >
                    Finish setup
                  </Link>
                  <button
                    type="button"
                    onClick={() => onDismissPending(item.itemId, item.institutionName)}
                    disabled={dismissingItemId === item.itemId}
                    className="rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Sync result feedback */}
        {syncResult && (
          <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm space-y-1">
            <p className="font-medium">
              Synced {syncResult.institutionName ? `${syncResult.institutionName}` : "bank"} — {syncResult.added} new transaction{syncResult.added !== 1 ? "s" : ""}.
              <span className="ml-1 font-normal text-muted-foreground">
                (A sync covers every account under the same bank login.)
              </span>
            </p>
            {syncResult.cardsUpdated.length > 0 && (
              <p className="text-green-600">
                Statement data refreshed for {syncResult.cardsUpdated.length} card{syncResult.cardsUpdated.length !== 1 ? "s" : ""}:{" "}
                {syncResult.cardsUpdated
                  .map((c) => {
                    const due = c.dueDate ? new Date(c.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "no due date";
                    const bal = c.statementBalance ? `$${parseFloat(c.statementBalance).toFixed(2)}` : "no balance";
                    return `${c.accountNickname} (${bal} due ${due})`;
                  })
                  .join("; ")}.
              </p>
            )}
            {syncResult.cardsUpdated.length === 0 && syncResult.liabilitiesNote && (
              <p className="text-amber-600">
                {syncResult.liabilitiesNote}{" "}
                <Link href={`/accounts/connect?itemId=${syncResult.itemId}`} className="underline underline-offset-2">
                  Re-link the bank
                </Link>{" "}
                to grant statement access.
              </p>
            )}
          </div>
        )}

        {[...byEntity.entries()].map(([entityName, entityAccounts]) => (
          <Card key={entityName}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{entityName}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium whitespace-nowrap">Account</th>
                      <th className="px-4 py-2 font-medium whitespace-nowrap">Institution</th>
                      <th className="px-4 py-2 font-medium whitespace-nowrap">Type</th>
                      <th className="px-4 py-2 font-medium whitespace-nowrap">Mode</th>
                      <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Balance</th>
                      <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Statement Due</th>
                      <th className="px-4 py-2 font-medium whitespace-nowrap">Due Date</th>
                      <th className="px-4 py-2 font-medium whitespace-nowrap">Min. Balance</th>
                      <th className="px-4 py-2 font-medium whitespace-nowrap">Last synced</th>
                      <th className="px-4 py-2 font-medium whitespace-nowrap text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entityAccounts.map((acct) => (
                      <tr key={acct.id} className={`border-b last:border-0 hover:bg-muted/30 ${archivingId === acct.id ? "opacity-30" : ""}`}>
                        <td className="px-4 py-2 whitespace-nowrap">
                          <span className="font-medium">{acct.nickname}</span>
                          {acct.mask && <span className="ml-1.5 font-mono text-xs text-muted-foreground">···{acct.mask}</span>}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                          {acct.institutionName}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground capitalize whitespace-nowrap">
                          {acct.accountType.replace("_", " ")}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            {modeBadge(acct.integrationMode)}
                            {acct.plaidStatus === "requires_login" && (
                              <span className="inline-flex items-center rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 whitespace-nowrap">Re-link required</span>
                            )}
                            {acct.plaidStatus === "pending_expiration" && (
                              <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 whitespace-nowrap">Expiring soon</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right font-medium tabular-nums whitespace-nowrap">
                          {acct.currentBalance != null
                            ? `$${parseFloat(acct.currentBalance).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        {acct.accountType === "credit_card" ? (
                          <>
                            <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                              {acct.ccStatementBalance != null ? (
                                <span className="font-medium text-amber-700 dark:text-amber-300">
                                  ${parseFloat(acct.ccStatementBalance).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2 whitespace-nowrap">
                              {acct.ccDueDate ? (
                                <DueDateCell dueDate={acct.ccDueDate} />
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-4 py-2 text-right text-muted-foreground">—</td>
                            <td className="px-4 py-2 text-muted-foreground">—</td>
                          </>
                        )}
                        <td className="px-4 py-2 text-muted-foreground tabular-nums whitespace-nowrap">
                          {acct.minimumBalance
                            ? `$${parseFloat(acct.minimumBalance).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                            : "—"}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                          {acct.plaidLastSyncedAt
                            ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(acct.plaidLastSyncedAt))
                            : acct.currentBalanceAt
                            ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(acct.currentBalanceAt))
                            : "—"}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                            <button onClick={() => setModal({ mode: "edit", account: acct })} className="text-xs text-primary hover:underline">Edit</button>
                            <button onClick={() => setModal({ mode: "move", account: acct })} className="text-xs text-primary hover:underline">Move</button>
                            {acct.integrationMode === "plaid" && acct.plaidItemId ? (
                              acct.plaidStatus === "requires_login" || acct.plaidStatus === "pending_expiration" ? (
                                <Link href={`/accounts/connect?itemId=${acct.plaidItemId}`} className="text-xs font-medium text-red-600 hover:underline">Re-link</Link>
                              ) : (
                                <button
                                  onClick={() => onSync(acct.plaidItemId!)}
                                  disabled={syncingItemId === acct.plaidItemId}
                                  title="Syncs this bank login (all accounts under it share one connection)"
                                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                >
                                  {syncingItemId === acct.plaidItemId ? "Syncing…" : "Sync now"}
                                </button>
                              )
                            ) : acct.accountType === "loan" || acct.accountType === "insurance" ? (
                              <span className="text-xs text-muted-foreground">Manual entry</span>
                            ) : acct.institutionName !== "unsupported" ? (
                              <Link href="/accounts/connect" className="text-xs text-primary hover:underline">Connect to Plaid</Link>
                            ) : (
                              <span className="text-xs text-muted-foreground">Import CSV</span>
                            )}
                            <button
                              onClick={() => onArchive(acct.id, acct.nickname)}
                              disabled={archivingId === acct.id}
                              className="text-xs text-destructive hover:underline disabled:opacity-50"
                            >
                              Archive
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {modal && (modal.mode === "add" || modal.mode === "edit") && (
        <AccountModal modal={modal} institutions={institutions} entities={entities} onClose={() => setModal(null)} />
      )}
      {modal && modal.mode === "move" && (
        <MoveAccountModal account={modal.account} entities={entities} onClose={() => setModal(null)} />
      )}
    </>
  );
}
