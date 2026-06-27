"use client";

import { useState, useTransition } from "react";
import { Prisma } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  createGlCode,
  deleteGlCode,
  assignGlCode,
  importGlCodes,
} from "@/actions/gl-codes";

const GL_TYPES = ["revenue", "expense", "asset", "liability", "equity"] as const;
type GlType = (typeof GL_TYPES)[number];

interface GlCode {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface UncodedTx {
  id: string;
  postedAt: string;
  payeeRaw: string | null;
  payeeNormalized: string | null;
  amount: string;
  accountNickname: string;
}

interface Props {
  entityId: string;
  glCodes: GlCode[];
  uncodedTransactions: UncodedTx[];
}

const TYPE_COLORS: Record<string, string> = {
  revenue: "text-green-700 bg-green-50 border-green-200",
  expense: "text-red-700 bg-red-50 border-red-200",
  asset: "text-blue-700 bg-blue-50 border-blue-200",
  liability: "text-orange-700 bg-orange-50 border-orange-200",
  equity: "text-purple-700 bg-purple-50 border-purple-200",
};

export function GlPageClient({ entityId, glCodes: initialCodes, uncodedTransactions: initialUncoded }: Props) {
  const [glCodes, setGlCodes] = useState(initialCodes);
  const [uncoded, setUncoded] = useState(initialUncoded);
  const [showForm, setShowForm] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<GlType>("expense");
  const [formError, setFormError] = useState<string | null>(null);

  const [isCreating, startCreate] = useTransition();
  const [isDeleting, startDelete] = useTransition();
  const [isAssigning, startAssign] = useTransition();
  const [assigningId, setAssigningId] = useState<string | null>(null);

  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState<{ code: string; name: string; type: string }[]>([]);
  const [importResult, setImportResult] = useState<{ imported: number; errors: string[] } | null>(null);
  const [isImporting, startImport] = useTransition();

  function handleCreate() {
    if (!newCode.trim()) { setFormError("Code is required"); return; }
    if (!newName.trim()) { setFormError("Name is required"); return; }
    setFormError(null);

    startCreate(async () => {
      try {
        await createGlCode({ entityId, code: newCode.trim(), name: newName.trim(), type: newType });
        setGlCodes((prev) => [
          ...prev,
          { id: crypto.randomUUID(), code: newCode.trim(), name: newName.trim(), type: newType },
        ].sort((a, b) => a.code.localeCompare(b.code)));
        setNewCode(""); setNewName(""); setNewType("expense"); setShowForm(false);
      } catch (e) {
        setFormError(e instanceof Error ? e.message : "Create failed");
      }
    });
  }

  function handleDelete(id: string) {
    startDelete(async () => {
      try {
        await deleteGlCode(id);
        setGlCodes((prev) => prev.filter((g) => g.id !== id));
      } catch (e) {
        alert(e instanceof Error ? e.message : "Delete failed");
      }
    });
  }

  function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const rows: { code: string; name: string; type: string }[] = [];
      for (const line of lines) {
        const parts = line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
        const [glCode, accountName, type] = parts;
        if (!glCode || glCode.toLowerCase() === "gl code") continue;
        if (glCode && accountName && type) rows.push({ code: glCode, name: accountName, type: type.toLowerCase() });
      }
      setImportRows(rows);
      setImportResult(null);
    };
    reader.readAsText(file);
  }

  function handleImport() {
    startImport(async () => {
      const result = await importGlCodes(
        entityId,
        importRows as { code: string; name: string; type: GlType }[]
      );
      setImportResult(result);
      if (result.imported > 0) setImportRows([]);
    });
  }

  function handleAssign(txId: string, glCodeId: string) {
    setAssigningId(txId);
    startAssign(async () => {
      try {
        await assignGlCode(txId, glCodeId || null);
        setUncoded((prev) => prev.filter((tx) => tx.id !== txId));
      } finally {
        setAssigningId(null);
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* GL Code list */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Chart of Accounts</h2>
          <button
            onClick={() => setShowForm(!showForm)}
            className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-3 h-8 text-xs font-medium hover:bg-primary/90"
          >
            {showForm ? "Cancel" : "+ GL Code"}
          </button>
        </div>

        {showForm && (
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium">Code</label>
                  <Input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="5010" className="h-8 text-sm" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Type</label>
                  <select
                    value={newType}
                    onChange={(e) => setNewType(e.target.value as GlType)}
                    className="block w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm h-8"
                  >
                    {GL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="col-span-2 space-y-1">
                  <label className="text-xs font-medium">Name</label>
                  <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Repairs & Maintenance" className="h-8 text-sm" />
                </div>
              </div>
              {formError && <p className="text-xs text-destructive">{formError}</p>}
              <button
                onClick={handleCreate}
                disabled={isCreating}
                className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-3 h-8 text-xs font-medium hover:bg-primary/90 disabled:opacity-60"
              >
                {isCreating ? "Saving…" : "Create"}
              </button>
            </CardContent>
          </Card>
        )}

        {/* CSV Import */}
        <div className="space-y-2">
          <button
            onClick={() => { setShowImport(!showImport); setImportRows([]); setImportResult(null); }}
            className="text-xs text-primary hover:underline"
          >
            {showImport ? "Hide CSV import" : "Import from CSV"}
          </button>

          {showImport && (
            <Card>
              <CardContent className="pt-4 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Upload a CSV with columns: <code className="font-mono bg-muted px-1 rounded">GL Code, Account Name, Type, Sub Type</code>.
                  Type must be one of: {GL_TYPES.join(", ")}.
                </p>
                <input
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleCsvFile}
                  className="text-xs file:mr-2 file:text-xs file:rounded file:border file:px-2 file:py-0.5"
                />
                {importRows.length > 0 && (
                  <>
                    <p className="text-xs font-medium">
                      {importRows.length} row{importRows.length !== 1 ? "s" : ""} parsed
                      {importRows.length > 10 ? " (showing first 10)" : ""}
                    </p>
                    <table className="w-full text-xs rounded border">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="px-2 py-1">Code</th>
                          <th className="px-2 py-1">Name</th>
                          <th className="px-2 py-1">Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importRows.slice(0, 10).map((r, i) => (
                          <tr key={i} className="border-b last:border-0">
                            <td className="px-2 py-1 font-mono">{r.code}</td>
                            <td className="px-2 py-1">{r.name}</td>
                            <td className="px-2 py-1">{r.type}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button
                      onClick={handleImport}
                      disabled={isImporting}
                      className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-3 h-8 text-xs font-medium hover:bg-primary/90 disabled:opacity-60"
                    >
                      {isImporting ? "Importing…" : `Import ${importRows.length} code${importRows.length !== 1 ? "s" : ""}`}
                    </button>
                  </>
                )}
                {importResult && (
                  <div className="space-y-1">
                    <p className="text-xs text-green-600">
                      Imported {importResult.imported} code{importResult.imported !== 1 ? "s" : ""}.
                    </p>
                    {importResult.errors.map((e, i) => (
                      <p key={i} className="text-xs text-destructive">{e}</p>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium text-xs">Code</th>
                  <th className="px-3 py-2 font-medium text-xs">Name</th>
                  <th className="px-3 py-2 font-medium text-xs">Type</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {glCodes.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground text-sm">
                      No GL codes yet
                    </td>
                  </tr>
                )}
                {glCodes.map((g) => (
                  <tr key={g.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2 font-mono text-xs">{g.code}</td>
                    <td className="px-3 py-2 text-xs">{g.name}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${TYPE_COLORS[g.type] ?? ""}`}>
                        {g.type}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => handleDelete(g.id)}
                        disabled={isDeleting}
                        className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* Coding queue */}
      <div className="space-y-4">
        <h2 className="font-medium">
          Coding Queue
          {uncoded.length > 0 && (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
              {uncoded.length}
            </span>
          )}
        </h2>

        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium text-xs">Date</th>
                    <th className="px-3 py-2 font-medium text-xs">Payee</th>
                    <th className="px-3 py-2 font-medium text-xs text-right">Amount</th>
                    <th className="px-3 py-2 font-medium text-xs">GL Code</th>
                  </tr>
                </thead>
                <tbody>
                  {uncoded.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                        All transactions are coded
                      </td>
                    </tr>
                  )}
                  {uncoded.map((tx) => {
                    const amt = new Prisma.Decimal(tx.amount);
                    const isOut = amt.isNegative();
                    return (
                      <tr
                        key={tx.id}
                        className={`border-b last:border-0 ${assigningId === tx.id ? "opacity-50" : ""}`}
                      >
                        <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(tx.postedAt).toLocaleDateString("en-US", {
                            month: "short", day: "numeric", timeZone: "America/New_York",
                          })}
                        </td>
                        <td className="px-3 py-2 text-xs max-w-[120px] truncate">
                          {tx.payeeRaw ?? tx.payeeNormalized ?? "—"}
                        </td>
                        <td className={`px-3 py-2 text-xs text-right font-mono ${isOut ? "text-destructive" : "text-green-600"}`}>
                          {isOut ? "−" : "+"}
                          {fmtCurrency(amt.abs())}
                        </td>
                        <td className="px-3 py-2">
                          <select
                            defaultValue=""
                            onChange={(e) => { if (e.target.value) handleAssign(tx.id, e.target.value); }}
                            disabled={isAssigning && assigningId === tx.id}
                            className="block w-full rounded border border-input bg-background px-1.5 py-1 text-xs"
                          >
                            <option value="">— assign —</option>
                            {glCodes.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.code} {g.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function fmtCurrency(d: Prisma.Decimal): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(d.toNumber());
}
