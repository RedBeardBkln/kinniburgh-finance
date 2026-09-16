"use client";

import { useState, useCallback, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { inferAccountTypeFromPlaid } from "@/lib/plaid-account-type";
import { ACCOUNT_TYPE_OPTIONS, type AccountType } from "@/lib/account-types";

interface Suggestion {
  plaidAccountId: string;
  mask: string | null;
  name: string;
  /** Plaid's high-level account type (depository/credit/loan/investment/...) */
  type: string | null;
  subtype: string | null;
  ourAccountId: string | null;
  ourAccountNickname: string | null;
}

interface SeededAccount {
  id: string;
  nickname: string;
  mask: string | null;
}

interface FormEntity {
  id: string;
  name: string;
}

type RowChoice =
  | { kind: "skip" }
  | { kind: "existing"; accountId: string }
  | { kind: "new"; entityId: string; nickname: string; accountType: AccountType };

type Step = "link" | "map" | "done";

const LINK_TOKEN_KEY = "plaid_link_token";
const CREATE_NEW_SENTINEL = "__create_new__";

function ConnectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const updateItemId = searchParams.get("itemId");
  const resumeItemId = searchParams.get("resumeItemId");
  const isOAuthReturn = !!searchParams.get("oauth_state_id");

  const [step, setStep] = useState<Step>("link");
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [receivedRedirectUri, setReceivedRedirectUri] = useState<string | undefined>(undefined);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [seededAccounts, setSeededAccounts] = useState<SeededAccount[]>([]);
  const [entities, setEntities] = useState<FormEntity[]>([]);
  const [rowChoices, setRowChoices] = useState<Record<string, RowChoice>>({});
  const [synced, setSynced] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when a resumed item's access token turned out to need re-auth —
  // offers the existing Link update-mode flow as a fallback.
  const [reauthItemId, setReauthItemId] = useState<string | null>(null);

  function initialRowChoices(list: Suggestion[]): Record<string, RowChoice> {
    const initial: Record<string, RowChoice> = {};
    for (const s of list) {
      initial[s.plaidAccountId] = s.ourAccountId
        ? { kind: "existing", accountId: s.ourAccountId }
        : { kind: "skip" };
    }
    return initial;
  }

  // Resume-without-Link: reuse the stored access token for an already-linked,
  // zero-account PlaidItem instead of opening a fresh Link session (which
  // could create a second, separate PlaidItem for the same institution).
  useEffect(() => {
    if (!resumeItemId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/plaid/pending-accounts/${resumeItemId}`)
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as {
          itemId?: string;
          institutionName?: string | null;
          suggestions?: Suggestion[];
          error?: string;
          code?: string;
        };
        if (!r.ok || data.error) {
          if (data.code === "ITEM_LOGIN_REQUIRED") {
            setReauthItemId(resumeItemId);
          }
          setError(data.error ?? "Failed to load pending accounts for this connection");
          return;
        }
        setItemId(data.itemId ?? resumeItemId);
        setSuggestions(data.suggestions ?? []);
        setRowChoices(initialRowChoices(data.suggestions ?? []));
        setStep("map");
      })
      .catch(() => setError("Network error loading pending accounts — check your connection and try again"))
      .finally(() => setLoading(false));
  }, [resumeItemId]);

  useEffect(() => {
    // Resume flow skips Plaid Link entirely — no link token needed.
    if (resumeItemId) return;

    if (isOAuthReturn) {
      // Resuming from an OAuth redirect — reuse the stored link token
      const stored = sessionStorage.getItem(LINK_TOKEN_KEY);
      if (stored) {
        setLinkToken(stored);
        setReceivedRedirectUri(window.location.href);
      } else {
        setLinkError("OAuth session expired. Please start over.");
      }
      return;
    }

    const url = updateItemId
      ? `/api/plaid/link-token?itemId=${updateItemId}`
      : "/api/plaid/link-token";
    fetch(url)
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as {
          linkToken?: string;
          error?: string;
          code?: string;
        };
        if (data.linkToken) {
          sessionStorage.setItem(LINK_TOKEN_KEY, data.linkToken);
          setLinkToken(data.linkToken);
        } else {
          setLinkError(
            data.error
              ? `${data.error}${data.code ? ` (code: ${data.code})` : ""}`
              : `Failed to get link token (HTTP ${r.status})`
          );
        }
      })
      .catch(() => setLinkError("Network error fetching link token — check your connection and try again"));
  }, [updateItemId, isOAuthReturn, resumeItemId]);

  useEffect(() => {
    fetch("/api/form-data")
      .then((r) => r.json())
      .then((data: { allAccounts?: SeededAccount[]; entities?: FormEntity[] }) => {
        setSeededAccounts(data.allAccounts ?? []);
        setEntities(data.entities ?? []);
      })
      .catch(() => {});
  }, []);

  const onSuccess = useCallback(async (publicToken: string, metadata: import("react-plaid-link").PlaidLinkOnSuccessMetadata) => {
    console.log("[plaid-link] onSuccess", { link_session_id: metadata?.link_session_id, institution_id: metadata?.institution?.institution_id });
    sessionStorage.removeItem(LINK_TOKEN_KEY);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plaid/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicToken }),
      });
      const data = (await res.json()) as { itemId?: string; suggestions?: Suggestion[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Exchange failed");
      setItemId(data.itemId!);
      setSuggestions(data.suggestions ?? []);
      setRowChoices(initialRowChoices(data.suggestions ?? []));
      setStep("map");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const onExit = useCallback((err: import("react-plaid-link").PlaidLinkError | null, metadata: import("react-plaid-link").PlaidLinkOnExitMetadata) => {
    if (err) {
      console.error("[plaid-link] onExit error", { error_code: err.error_code, error_message: err.error_message, display_message: err.display_message, link_session_id: metadata?.link_session_id });
      setLinkError(`Plaid error: ${err.display_message ?? err.error_message ?? err.error_code}`);
    }
  }, []);

  const { open: openLink, ready: linkReady } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit,
    ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
  });

  // Auto-open when returning from OAuth redirect
  useEffect(() => {
    if (isOAuthReturn && linkReady) openLink();
  }, [isOAuthReturn, linkReady, openLink]);

  function selectValueFor(choice: RowChoice | undefined): string {
    if (!choice || choice.kind === "skip") return "";
    if (choice.kind === "existing") return choice.accountId;
    return CREATE_NEW_SENTINEL;
  }

  function handleRowSelectChange(s: Suggestion, value: string) {
    setRowChoices((prev) => {
      if (value === "") return { ...prev, [s.plaidAccountId]: { kind: "skip" } };
      if (value === CREATE_NEW_SENTINEL) {
        return {
          ...prev,
          [s.plaidAccountId]: {
            kind: "new",
            entityId: "",
            nickname: s.name,
            accountType: inferAccountTypeFromPlaid(s.type, s.subtype),
          },
        };
      }
      return { ...prev, [s.plaidAccountId]: { kind: "existing", accountId: value } };
    });
  }

  function updateNewRow(plaidAccountId: string, patch: Partial<{ entityId: string; nickname: string; accountType: AccountType }>) {
    setRowChoices((prev) => {
      const current = prev[plaidAccountId];
      if (!current || current.kind !== "new") return prev;
      return { ...prev, [plaidAccountId]: { ...current, ...patch } };
    });
  }

  async function confirmMapping() {
    if (!itemId) return;
    setError(null);

    const mappings: { plaidAccountId: string; ourAccountId: string }[] = [];
    const newAccounts: { plaidAccountId: string; entityId: string; nickname: string; accountType: AccountType; mask?: string }[] = [];

    for (const s of suggestions) {
      const choice = rowChoices[s.plaidAccountId];
      if (!choice || choice.kind === "skip") continue;
      if (choice.kind === "existing") {
        mappings.push({ plaidAccountId: s.plaidAccountId, ourAccountId: choice.accountId });
      } else {
        if (!choice.entityId || !choice.nickname.trim()) {
          setError(`Fill in entity and nickname for "${s.name}" before confirming (or switch it to skip).`);
          return;
        }
        newAccounts.push({
          plaidAccountId: s.plaidAccountId,
          entityId: choice.entityId,
          nickname: choice.nickname.trim(),
          accountType: choice.accountType,
          mask: s.mask ?? undefined,
        });
      }
    }

    setLoading(true);
    try {
      const res = await fetch("/api/plaid/confirm-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, mappings, newAccounts }),
      });
      const data = (await res.json()) as { synced?: number; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Mapping failed");
      setSynced(data.synced ?? 0);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Connect Bank Account</h1>
        <p className="text-sm text-muted-foreground">
          Securely link your bank via Plaid. Your credentials go directly to Plaid — we never see them.
        </p>
      </div>

      <div className="flex items-center gap-4 text-sm">
        {(["link", "map", "done"] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
              step === s ? "bg-primary text-primary-foreground"
              : i < ["link", "map", "done"].indexOf(step) ? "bg-primary/20 text-primary"
              : "bg-muted text-muted-foreground"
            }`}>{i + 1}</span>
            <span className={step === s ? "font-medium" : "text-muted-foreground"}>
              {s === "link" ? "Connect" : s === "map" ? "Map accounts" : "Done"}
            </span>
            {i < 2 && <span className="text-muted-foreground">→</span>}
          </div>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {step === "link" && resumeItemId && reauthItemId && (
        <Card>
          <CardHeader><CardTitle>Re-authentication needed</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This connection needs to be re-authenticated with Plaid before its accounts can be mapped.
            </p>
            <button
              onClick={() => router.push(`/accounts/connect?itemId=${reauthItemId}`)}
              className="rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Re-authenticate
            </button>
          </CardContent>
        </Card>
      )}

      {step === "link" && resumeItemId && !reauthItemId && (
        <Card>
          <CardHeader><CardTitle>Resuming setup…</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {loading ? "Loading this connection's accounts from Plaid…" : "Preparing to resume mapping…"}
            </p>
          </CardContent>
        </Card>
      )}

      {step === "link" && !resumeItemId && (
        <Card>
          <CardHeader><CardTitle>Step 1 — Connect your bank</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Click the button below to open Plaid Link and authenticate with your bank.
              TD Bank and Capital One are fully supported. JCSB, Barclays, and PennyMac will be attempted — coverage may vary.
            </p>
            {linkError && <p className="text-sm text-red-600">{linkError}</p>}
            <button onClick={() => openLink()} disabled={!linkReady || !!linkError || loading}
              className="rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {loading ? "Connecting…" : "Connect your bank"}
            </button>
          </CardContent>
        </Card>
      )}

      {step === "map" && (
        <Card>
          <CardHeader><CardTitle>Step 2 — Map accounts</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              We auto-matched Plaid accounts to your seeded accounts by last 4 digits. Adjust any mismatches, pick
              &quot;+ Create new account&quot; to register one that doesn&apos;t exist yet, then confirm.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Plaid account</th>
                  <th className="py-2 pr-4 font-medium">Mask</th>
                  <th className="py-2 font-medium">Map to (our account)</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => {
                  const choice = rowChoices[s.plaidAccountId];
                  return (
                    <tr key={s.plaidAccountId} className="border-b align-top last:border-0">
                      <td className="py-2 pr-4 font-medium">{s.name}</td>
                      <td className="py-2 pr-4 font-mono text-muted-foreground">{s.mask ? `···${s.mask}` : "—"}</td>
                      <td className="py-2">
                        <select
                          value={selectValueFor(choice)}
                          onChange={(e) => handleRowSelectChange(s, e.target.value)}
                          className="w-full rounded border px-2 py-1 text-sm"
                        >
                          <option value="">(skip this account)</option>
                          {seededAccounts.map((a) => (
                            <option key={a.id} value={a.id}>{a.nickname}{a.mask ? ` ···${a.mask}` : ""}</option>
                          ))}
                          <option value={CREATE_NEW_SENTINEL}>+ Create new account…</option>
                        </select>

                        {choice?.kind === "new" && (
                          <div className="mt-2 space-y-2 rounded border bg-muted/30 p-3">
                            <div className="space-y-1">
                              <label className="text-xs font-medium">Entity</label>
                              <select
                                value={choice.entityId}
                                onChange={(e) => updateNewRow(s.plaidAccountId, { entityId: e.target.value })}
                                className="w-full rounded border px-2 py-1 text-sm"
                                required
                              >
                                <option value="">Select entity…</option>
                                {entities.map((ent) => <option key={ent.id} value={ent.id}>{ent.name}</option>)}
                              </select>
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-medium">Nickname</label>
                              <input
                                type="text"
                                value={choice.nickname}
                                onChange={(e) => updateNewRow(s.plaidAccountId, { nickname: e.target.value })}
                                maxLength={100}
                                className="w-full rounded border px-2 py-1 text-sm"
                                required
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-medium">Account Type</label>
                              <select
                                value={choice.accountType}
                                onChange={(e) => updateNewRow(s.plaidAccountId, { accountType: e.target.value as AccountType })}
                                className="w-full rounded border px-2 py-1 text-sm"
                              >
                                {ACCOUNT_TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                              </select>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex gap-3 pt-2">
              <button onClick={confirmMapping} disabled={loading}
                className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {loading ? "Syncing…" : "Confirm & sync"}
              </button>
              {!resumeItemId && (
                <button onClick={() => setStep("link")} className="rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-accent">Back</button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {step === "done" && (
        <Card className="border-green-200 bg-green-50/50">
          <CardHeader><CardTitle className="text-green-800">Connected successfully</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {synced !== null && synced > 0
                ? `Imported ${synced} transaction${synced === 1 ? "" : "s"} from your initial sync.`
                : "Connection confirmed. Transactions will appear after the next sync."}
            </p>
            <div className="flex gap-3">
              <button onClick={() => router.push("/accounts")}
                className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                Go to Accounts
              </button>
              <button onClick={() => router.push("/transactions")}
                className="rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-accent">
                View Transactions
              </button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function ConnectClient() {
  return (
    <Suspense>
      <ConnectInner />
    </Suspense>
  );
}
