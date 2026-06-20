"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { type BucketSlug } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { parseImportPreview, confirmImport, type ParsedRow } from "@/actions/import";

interface Account {
  id: string;
  nickname: string;
  mask: string;
  entityId: string;
}

interface Entity {
  id: string;
  name: string;
}

type Step = "upload" | "map" | "preview" | "done";

function ImportInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const bucket = (searchParams.get("bucket") ?? "personal") as BucketSlug;

  const [step, setStep] = useState<Step>("upload");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [skippedRows, setSkippedRows] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);

  const [csvContent, setCsvContent] = useState("");
  const [accountId, setAccountId] = useState("");
  const [entityId, setEntityId] = useState("");
  const [colDate, setColDate] = useState("");
  const [colPayee, setColPayee] = useState("");
  const [colAmount, setColAmount] = useState("");
  const [colDescription, setColDescription] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/form-data?bucket=${bucket}`)
      .then((r) => r.json())
      .then((d) => {
        setAccounts(d.accounts ?? []);
        setEntities(d.entities ?? []);
        if (d.accounts?.length > 0) setAccountId(d.accounts[0].id);
        if (d.entities?.length > 0) setEntityId(d.entities[0].id);
      });
  }, [bucket]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setCsvContent(text);
      const firstLine = text.split("\n")[0] ?? "";
      const hs = firstLine.split(",").map((h) => h.replace(/^"|"$/g, "").trim());
      setHeaders(hs);
      const find = (candidates: string[]) =>
        hs.find((h) => candidates.some((c) => h.toLowerCase().includes(c))) ?? "";
      setColDate(find(["date", "posted", "transaction date"]));
      setColPayee(find(["description", "payee", "merchant", "name"]));
      setColAmount(find(["amount", "debit", "credit"]));
      setColDescription(find(["memo", "note", "detail"]));
      setStep("map");
    };
    reader.readAsText(file);
  }

  async function handlePreview() {
    if (!colDate || !colPayee || !colAmount) {
      setError("Date, payee, and amount columns are required");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const { rows: parsed } = await parseImportPreview({
        csvContent,
        mapping: { date: colDate, payee: colPayee, amount: colAmount, description: colDescription || undefined },
        accountId,
      });
      setRows(parsed);
      const dupes = new Set<number>();
      parsed.forEach((r, i) => { if (r.isDuplicate) dupes.add(i); });
      setSkippedRows(dupes);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Parse failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleImport() {
    setLoading(true);
    setError("");
    try {
      const res = await confirmImport({
        accountId,
        entityId,
        rows: rows.map((r, i) => ({
          date: r.date,
          payee: r.payee,
          amount: r.amount,
          description: r.description,
          skipDuplicate: skippedRows.has(i),
        })),
      });
      setResult(res);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  function toggleSkip(i: number) {
    setSkippedRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Import Transactions</h1>
        <p className="text-sm text-muted-foreground">Upload a CSV from your bank</p>
      </div>

      {step === "upload" && (
        <Card>
          <CardHeader><CardTitle>1. Choose a CSV file</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Account</Label>
                <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.nickname} ···{a.mask}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Entity</Label>
                <Select value={entityId} onChange={(e) => setEntityId(e.target.value)}>
                  {entities.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>CSV File</Label>
              <Input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFileChange} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>
      )}

      {step === "map" && (
        <Card>
          <CardHeader><CardTitle>2. Map columns</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Detected {headers.length} columns. Select which columns to use.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                { label: "Date column *", value: colDate, setter: setColDate },
                { label: "Payee / Description column *", value: colPayee, setter: setColPayee },
                { label: "Amount column *", value: colAmount, setter: setColAmount },
                { label: "Notes / Memo column (optional)", value: colDescription, setter: setColDescription },
              ].map(({ label, value, setter }) => (
                <div key={label} className="space-y-1.5">
                  <Label>{label}</Label>
                  <Select value={value} onChange={(e) => setter(e.target.value)}>
                    <option value="">— none —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-3">
              <Button onClick={handlePreview} disabled={loading}>
                {loading ? "Parsing…" : "Preview Import"}
              </Button>
              <Button variant="outline" onClick={() => { setStep("upload"); setCsvContent(""); setHeaders([]); }}>
                Back
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "preview" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              3. Review {rows.length} rows
              <span className="text-sm font-normal text-muted-foreground">
                {skippedRows.size} skipped · {rows.length - skippedRows.size} to import
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-3 py-2">Import</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Payee</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const skip = skippedRows.has(i);
                    const amt = parseFloat(r.amount);
                    return (
                      <tr key={i} className={`border-b last:border-0 ${skip ? "opacity-40" : "hover:bg-muted/30"}`}>
                        <td className="px-3 py-1.5">
                          <input type="checkbox" checked={!skip} onChange={() => toggleSkip(i)} className="h-4 w-4" />
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">{r.date}</td>
                        <td className="px-3 py-1.5 max-w-xs truncate">{r.payee}</td>
                        <td className={`px-3 py-1.5 text-right font-mono ${amt < 0 ? "text-destructive" : "text-green-600"}`}>
                          {amt < 0 ? "-" : "+"}${Math.abs(amt).toFixed(2)}
                        </td>
                        <td className="px-3 py-1.5">
                          {r.isDuplicate && (
                            <Badge variant="outline" className="text-xs text-muted-foreground">duplicate</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex gap-3 p-4">
              <Button onClick={handleImport} disabled={loading || rows.length === skippedRows.size}>
                {loading ? "Importing…" : `Import ${rows.length - skippedRows.size} transactions`}
              </Button>
              <Button variant="outline" onClick={() => setStep("map")}>Back</Button>
            </div>
            {error && <p className="px-4 pb-4 text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>
      )}

      {step === "done" && result && (
        <Card>
          <CardHeader><CardTitle>Import Complete</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-green-600 font-medium">
              {result.imported} transaction{result.imported !== 1 ? "s" : ""} imported
            </p>
            {result.skipped > 0 && (
              <p className="text-muted-foreground text-sm">{result.skipped} skipped (duplicates or invalid dates)</p>
            )}
            <div className="flex gap-3">
              <Button onClick={() => router.push(`/transactions?bucket=${bucket}`)}>View Transactions</Button>
              <Button variant="outline" onClick={() => {
                setStep("upload");
                setCsvContent("");
                setHeaders([]);
                setRows([]);
                setResult(null);
                if (fileRef.current) fileRef.current.value = "";
              }}>
                Import Another
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function ImportClient() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground p-4">Loading…</p>}>
      <ImportInner />
    </Suspense>
  );
}
