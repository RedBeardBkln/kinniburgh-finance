"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TagPicker } from "@/components/tags/tag-picker";
import { confirmReceipt, deleteReceipt, findMatchingTransactions, type MatchCandidate } from "@/actions/receipts";
import { createProject } from "@/actions/projects";
import { Badge } from "@/components/ui/badge";

const TAX_CATEGORIES = [
  "Meals & Entertainment",
  "Travel",
  "Vehicle / Auto",
  "Office Supplies",
  "Professional Services",
  "Advertising & Marketing",
  "Utilities",
  "Technology & Software",
  "Home Office",
  "Education & Training",
  "Rent",
  "Insurance",
  "Other",
];

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface Account {
  id: string;
  nickname: string;
  mask: string | null;
  entityId: string;
}

interface Project {
  id: string;
  name: string;
}

interface GlCode {
  id: string;
  code: string;
  name: string;
}

interface Props {
  receiptId: string;
  initialVendor: string;
  initialDate: string;
  initialTotal: string;
  initialDescription: string;
  initialGlCode: string;
  initialMemo: string;
  initialAccountId: string | null;
  initialTaxCategory: string | null;
  initialProjectId: string | null;
  ocrStatus: string;
  confirmedAt: string | null;
  matches: MatchCandidate[];
  allTags: Tag[];
  accounts: Account[];
  projects: Project[];
  glCodes: GlCode[];
}

export function ReceiptConfirmForm({
  receiptId,
  initialVendor,
  initialDate,
  initialTotal,
  initialDescription,
  initialGlCode,
  initialMemo,
  initialAccountId,
  initialTaxCategory,
  initialProjectId,
  ocrStatus,
  confirmedAt,
  matches: initialMatches,
  allTags,
  accounts,
  projects: initialProjects,
  glCodes,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isDeleting, startDeleting] = useTransition();
  const [isMatchPending, startMatchTransition] = useTransition();
  const [isCreatingProject, startProjectTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [vendor, setVendor] = useState(initialVendor);
  const [date, setDate] = useState(initialDate);
  const [total, setTotal] = useState(initialTotal);
  const [description, setDescription] = useState(initialDescription);
  const [glCode, setGlCode] = useState(initialGlCode);
  const [memo, setMemo] = useState(initialMemo);
  const [accountId, setAccountId] = useState<string>(initialAccountId ?? "");
  const [taxCategory, setTaxCategory] = useState<string>(initialTaxCategory ?? "");
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? "");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [transactionId, setTransactionId] = useState<string | undefined>();
  const [matches, setMatches] = useState<MatchCandidate[]>(initialMatches);

  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectBudget, setNewProjectBudget] = useState("");

  const isAlreadyConfirmed = confirmedAt != null;

  function handleAccountChange(value: string) {
    setAccountId(value);
    setTransactionId(undefined);
    startMatchTransition(async () => {
      const updated = await findMatchingTransactions(receiptId, value || undefined);
      setMatches(updated);
    });
  }

  function handleCreateProject() {
    if (!newProjectName.trim()) return;
    const budget = parseFloat(newProjectBudget);
    if (isNaN(budget) || budget <= 0) return;
    startProjectTransition(async () => {
      try {
        const proj = await createProject({ name: newProjectName.trim(), budget });
        setProjects((prev) => [...prev, { id: proj.id, name: proj.name }].sort((a, b) => a.name.localeCompare(b.name)));
        setProjectId(proj.id);
        setShowNewProject(false);
        setNewProjectName("");
        setNewProjectBudget("");
      } catch {
        // ignore; user can retry
      }
    });
  }

  function handleConfirm() {
    if (!vendor) { setError("Vendor is required"); return; }
    if (!total || !/^\d+(\.\d{1,2})?$/.test(total)) { setError("Enter a valid total (e.g. 42.50)"); return; }
    setError(null);

    startTransition(async () => {
      try {
        await confirmReceipt({
          receiptId,
          vendor,
          receiptDate: date || new Date().toISOString().split("T")[0]!,
          total,
          description: description || undefined,
          glCode: glCode || undefined,
          memo: memo || undefined,
          accountId: accountId || undefined,
          taxCategory: taxCategory || undefined,
          projectId: projectId || undefined,
          transactionId: transactionId || undefined,
          tagIds: selectedTagIds,
        });
        router.push("/receipts?tab=confirmed");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Confirm failed");
      }
    });
  }

  function handleDelete() {
    if (!confirm("Delete this receipt? This cannot be undone.")) return;
    startDeleting(async () => {
      await deleteReceipt(receiptId);
      router.push("/receipts");
    });
  }

  const selectedAccount = accounts.find((a) => a.id === accountId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>Extracted Data</span>
          {ocrStatus === "failed" && (
            <Badge variant="destructive">Extraction Failed</Badge>
          )}
          {isAlreadyConfirmed && (
            <Badge variant="secondary" className="bg-green-100 text-green-700">
              Confirmed
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <label className="text-sm font-medium">Vendor</label>
          <Input
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="Vendor name"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Total ($)</label>
            <Input
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              placeholder="0.00"
              pattern="\d+(\.\d{1,2})?"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Description</label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What was purchased?"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Memo</label>
          <Input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Internal note (optional)"
          />
        </div>

        {/* Bank account */}
        <div className="space-y-1">
          <label className="text-sm font-medium">Bank Account</label>
          <select
            value={accountId}
            onChange={(e) => handleAccountChange(e.target.value)}
            className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">— Not specified —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname}{a.mask ? ` (${a.mask})` : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Tax category */}
        <div className="space-y-1">
          <label className="text-sm font-medium">Tax Category</label>
          <select
            value={taxCategory}
            onChange={(e) => setTaxCategory(e.target.value)}
            className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">— Not specified —</option>
            {TAX_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>

        {/* Project */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Project</label>
            {!showNewProject && (
              <button
                type="button"
                onClick={() => setShowNewProject(true)}
                className="text-xs text-primary hover:underline"
              >
                + New project
              </button>
            )}
          </div>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">— Not assigned —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {showNewProject && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2 mt-1">
              <p className="text-xs font-medium">New project</p>
              <Input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Project name"
                className="text-sm"
              />
              <Input
                type="number"
                value={newProjectBudget}
                onChange={(e) => setNewProjectBudget(e.target.value)}
                placeholder="Budget (e.g. 5000)"
                min="0"
                step="0.01"
                className="text-sm"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCreateProject}
                  disabled={isCreatingProject || !newProjectName.trim()}
                  className="flex-1 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium hover:bg-primary/90 disabled:opacity-60"
                >
                  {isCreatingProject ? "Creating…" : "Create"}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowNewProject(false); setNewProjectName(""); setNewProjectBudget(""); }}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* GL account */}
        <div className="space-y-1">
          <label className="text-sm font-medium">GL Account / Category</label>
          {glCodes.length > 0 ? (
            <select
              value={glCode}
              onChange={(e) => setGlCode(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">— Not specified —</option>
              {glCodes.map((g) => (
                <option key={g.id} value={`${g.code} — ${g.name}`}>
                  {g.code} — {g.name}
                </option>
              ))}
            </select>
          ) : (
            <Input
              value={glCode}
              onChange={(e) => setGlCode(e.target.value)}
              placeholder="e.g. Office Supplies"
            />
          )}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Tags</label>
          <TagPicker
            tags={allTags}
            selected={selectedTagIds}
            onChange={setSelectedTagIds}
            placeholder="Search tags…"
          />
        </div>

        {/* Transaction match */}
        <div className="space-y-2">
          <label className="text-sm font-medium">
            {selectedAccount
              ? `Match to transaction in ${selectedAccount.nickname}`
              : "Match to transaction"}{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          {isMatchPending ? (
            <p className="text-xs text-muted-foreground px-1">Searching…</p>
          ) : (
            <div className="rounded-md border divide-y text-sm">
              <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/30">
                <input
                  type="radio"
                  name="txMatch"
                  value=""
                  checked={!transactionId}
                  onChange={() => setTransactionId(undefined)}
                />
                <span className="text-muted-foreground italic">Standalone receipt (no transaction match)</span>
              </label>
              {matches.map((m) => {
                const amt = Number(m.amount);
                const sign = amt < 0 ? "-" : "+";
                const display = `${sign}$${Math.abs(amt).toFixed(2)}`;
                return (
                  <label
                    key={m.id}
                    className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/30"
                  >
                    <input
                      type="radio"
                      name="txMatch"
                      value={m.id}
                      checked={transactionId === m.id}
                      onChange={() => setTransactionId(m.id)}
                    />
                    <span>
                      <span className="font-medium">{m.payeeRaw ?? "—"}</span>
                      <span className="ml-2 text-muted-foreground text-xs">
                        {new Date(m.postedAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          timeZone: "UTC",
                        })}{" "}
                        · {m.accountNickname}
                      </span>
                      <span className="ml-2 font-mono">{display}</span>
                    </span>
                  </label>
                );
              })}
              {matches.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  No matching transactions found within ±7 days and ±2% amount.
                </p>
              )}
            </div>
          )}
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isPending || isAlreadyConfirmed}
            className="flex-1 inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground h-10 text-sm font-medium hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isPending ? "Saving…" : isAlreadyConfirmed ? "Already Confirmed" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting}
            className="inline-flex items-center justify-center rounded-md border border-destructive text-destructive px-4 h-10 text-sm font-medium hover:bg-destructive/10 disabled:opacity-60"
          >
            {isDeleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
