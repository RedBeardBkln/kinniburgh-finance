"use client";

import { useState, useCallback, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Suggestion {
  plaidAccountId: string;
  mask: string | null;
  name: string;
  subtype: string | null;
  ourAccountId: string | null;
  ourAccountNickname: string | null;
}

interface SeededAccount {
  id: string;
  nickname: string;
  mask: string | null;
}

type Step = "link" | "map" | "done";

function ConnectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const updateItemId = searchParams.get("itemId");

  const [step, setStep] = useState<Step>("link");
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [seededAccounts, setSeededAccounts] = useState<SeededAccount[]>([]);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [synced, setSynced] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = updateItemId
      ? `/api/plaid/link-token?itemId=${updateItemId}`
      : "/api/plaid/link-token";
    fetch(url)
      .then((r) => r.json())
      .then((data: { linkToken?: string; error?: string }) => {
        if (data.linkToken) setLinkToken(data.linkToken);
        else setLinkError(data.error ?? "Failed to get link token");
      })
      .catch(() => setLinkError("Network error fetching link token"));
  }, [updateItemId]);

  useEffect(() => {
    fetch("/api/form-data")
      .then((r) => r.json())
      .then((data: { allAccounts?: SeededAccount[] }) => {
        setSeededAccounts(data.allAccounts ?? []);
      })
      .catch(() => {});
  }, []);

  const onSuccess = useCallback(async (publicToken: string) => {
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
      const initial: Record<string, string> = {};
      for (const s of data.suggestions ?? []) initial[s.plaidAccountId] = s.ourAccountId ?? "";
      setMappings(initial);
      setStep("map");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const onExit = useCallback(() => {}, []);

  const { open: openLink, ready: linkReady } = usePlaidLink({ token: linkToken, onSuccess, onExit });

  async function confirmMapping() {
    if (!itemId) return;
    setLoading(true);
    setError(null);
    try {
      const activeMappings = Object.entries(mappings)
        .filter(([, ourId]) => ourId !== "")
        .map(([plaidAccountId, ourAccountId]) => ({ plaidAccountId, ourAccountId }));
      const res = await fetch("/api/plaid/confirm-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, mappings: activeMappings }),
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

      {step === "link" && (
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
              We auto-matched Plaid accounts to your seeded accounts by last 4 digits. Adjust any mismatches, then confirm.
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
                {suggestions.map((s) => (
                  <tr key={s.plaidAccountId} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-medium">{s.name}</td>
                    <td className="py-2 pr-4 font-mono text-muted-foreground">{s.mask ? `···${s.mask}` : "—"}</td>
                    <td className="py-2">
                      <select value={mappings[s.plaidAccountId] ?? ""}
                        onChange={(e) => setMappings((m) => ({ ...m, [s.plaidAccountId]: e.target.value }))}
                        className="w-full rounded border px-2 py-1 text-sm">
                        <option value="">(skip this account)</option>
                        {seededAccounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.nickname}{a.mask ? ` ···${a.mask}` : ""}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex gap-3 pt-2">
              <button onClick={confirmMapping} disabled={loading}
                className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {loading ? "Syncing…" : "Confirm & sync"}
              </button>
              <button onClick={() => setStep("link")} className="rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-accent">Back</button>
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
