"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createAccount, updateAccount, archiveAccount } from "@/actions/accounts";

const ACCOUNT_TYPES = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit Card" },
  { value: "mortgage", label: "Mortgage" },
  { value: "loan", label: "Loan" },
  { value: "investment", label: "Investment" },
  { value: "insurance", label: "Insurance" },
] as const;

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

interface Props {
  accounts: SerializedAccount[];
  institutions: SerializedInstitution[];
  entities: SerializedEntity[];
}

type ModalState =
  | null
  | { mode: "add" }
  | { mode: "edit"; account: SerializedAccount };

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

function AccountModal({ modal, institutions, entities, onClose }: {
  modal: ModalState & { mode: "add" | "edit" };
  institutions: SerializedInstitution[];
  entities: SerializedEntity[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
            minimumBalance: (fd.get("minimumBalance") as string) || null,
            minimumBalanceFee: (fd.get("minimumBalanceFee") as string) || null,
          });
        } else {
          await createAccount({
            institutionId: fd.get("institutionId") as string,
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
              <select name="institutionId" className="w-full rounded border px-3 py-2 text-sm" required>
                <option value="">Select institution…</option>
                {institutions.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
          )}

          {/* Account type — add only */}
          {!isEdit && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Account Type</label>
              <select name="accountType" className="w-full rounded border px-3 py-2 text-sm" required>
                {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          )}

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

export function AccountsPageClient({ accounts, institutions, entities }: Props) {
  const router = useRouter();
  const [modal, setModal] = useState<ModalState>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

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

        {[...byEntity.entries()].map(([entityName, entityAccounts]) => (
          <Card key={entityName}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{entityName}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Account</th>
                    <th className="px-4 py-2 font-medium">Institution</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Mode</th>
                    <th className="px-4 py-2 font-medium text-right">Balance</th>
                    <th className="px-4 py-2 font-medium">Min. Balance</th>
                    <th className="px-4 py-2 font-medium">Last synced</th>
                    <th className="px-4 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entityAccounts.map((acct) => (
                    <tr key={acct.id} className={`border-b last:border-0 hover:bg-muted/30 ${archivingId === acct.id ? "opacity-30" : ""}`}>
                      <td className="px-4 py-2">
                        <span className="font-medium">{acct.nickname}</span>
                        {acct.mask && <span className="ml-1.5 font-mono text-xs text-muted-foreground">···{acct.mask}</span>}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {acct.institutionName}
                        {acct.plaidStatus === null && acct.integrationMode !== "plaid" ? null : null}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground capitalize">
                        {acct.accountType.replace("_", " ")}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          {modeBadge(acct.integrationMode)}
                          {acct.plaidStatus === "requires_login" && (
                            <span className="inline-flex items-center rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">Re-link required</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right font-medium tabular-nums">
                        {acct.currentBalance != null
                          ? `$${parseFloat(acct.currentBalance).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground tabular-nums">
                        {acct.minimumBalance
                          ? `$${parseFloat(acct.minimumBalance).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                          : "—"}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {acct.plaidLastSyncedAt
                          ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(acct.plaidLastSyncedAt))
                          : acct.currentBalanceAt
                          ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(acct.currentBalanceAt))
                          : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-3">
                          <button onClick={() => setModal({ mode: "edit", account: acct })} className="text-xs text-primary hover:underline">Edit</button>
                          {acct.integrationMode === "plaid" && acct.plaidItemId ? (
                            acct.plaidStatus === "requires_login" ? (
                              <Link href={`/accounts/connect?itemId=${acct.plaidItemId}`} className="text-xs font-medium text-red-600 hover:underline">Re-link</Link>
                            ) : (
                              <form action={`/api/plaid/sync/${acct.plaidItemId}`} method="POST">
                                <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">Sync now</button>
                              </form>
                            )
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
            </CardContent>
          </Card>
        ))}
      </div>

      {modal && (modal.mode === "add" || modal.mode === "edit") && (
        <AccountModal modal={modal} institutions={institutions} entities={entities} onClose={() => setModal(null)} />
      )}
    </>
  );
}
