"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { type BucketSlug } from "@/lib/buckets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TagPicker } from "@/components/tags/tag-picker";
import { createTransaction } from "@/actions/transactions";

interface Account {
  id: string;
  nickname: string;
  mask: string;
  entityId: string;
}

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface Entity {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
}

function NewTransactionInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const bucket = (searchParams.get("bucket") ?? "personal") as BucketSlug;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const [accountId, setAccountId] = useState("");
  const [entityId, setEntityId] = useState("");
  const [postedAt, setPostedAt] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [payeeRaw, setPayeeRaw] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [projectId, setProjectId] = useState("");
  const [isTransfer, setIsTransfer] = useState(false);
  const [transferToAccountId, setTransferToAccountId] = useState("");

  useEffect(() => {
    fetch(`/api/form-data?bucket=${bucket}`)
      .then((r) => r.json())
      .then((d) => {
        setAccounts(d.accounts ?? []);
        setTags(d.tags ?? []);
        setEntities(d.entities ?? []);
        setProjects(d.projects ?? []);
        if (d.accounts?.length > 0) setAccountId(d.accounts[0].id);
        if (d.entities?.length > 0) setEntityId(d.entities[0].id);
      })
      .finally(() => setLoading(false));
  }, [bucket]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await createTransaction({
        accountId,
        entityId,
        postedAt,
        amount,
        payeeRaw,
        description: description || undefined,
        tagIds: selectedTags,
        projectId: projectId || undefined,
        isTransferOut: isTransfer || undefined,
        transferToAccountId: isTransfer ? transferToAccountId : undefined,
      });
      if (result.success) {
        router.push(`/transactions?bucket=${bucket}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save transaction");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">New Transaction</h1>
        <p className="text-sm text-muted-foreground">Add a manual transaction</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Transaction Details</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="postedAt">Date</Label>
                  <Input id="postedAt" type="date" value={postedAt} onChange={(e) => setPostedAt(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="amount">Amount (use - for expenses)</Label>
                  <Input id="amount" type="text" placeholder="-42.50" value={amount} onChange={(e) => setAmount(e.target.value)} required />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="payeeRaw">Payee</Label>
                <Input id="payeeRaw" value={payeeRaw} onChange={(e) => setPayeeRaw(e.target.value)} placeholder="e.g. Stop & Shop" required />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description">Description (optional)</Label>
                <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="accountId">Account</Label>
                  <Select id="accountId" value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.nickname} ···{a.mask}</option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="entityId">Entity</Label>
                  <Select id="entityId" value={entityId} onChange={(e) => setEntityId(e.target.value)} required>
                    {entities.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}</option>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Tags</Label>
                <TagPicker tags={tags} selected={selectedTags} onChange={setSelectedTags} />
              </div>

              {projects.length > 0 && (
                <div className="space-y-1.5">
                  <Label htmlFor="projectId">Project <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
                  <Select id="projectId" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    <option value="">— none —</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </div>
              )}

              <div className="flex items-center gap-2">
                <input id="isTransfer" type="checkbox" checked={isTransfer} onChange={(e) => setIsTransfer(e.target.checked)} className="h-4 w-4" />
                <Label htmlFor="isTransfer" className="cursor-pointer">This is an internal transfer</Label>
              </div>

              {isTransfer && (
                <div className="space-y-1.5">
                  <Label htmlFor="transferTo">Transfer to Account</Label>
                  <Select id="transferTo" value={transferToAccountId} onChange={(e) => setTransferToAccountId(e.target.value)} required={isTransfer}>
                    <option value="">— select —</option>
                    {accounts.filter((a) => a.id !== accountId).map((a) => (
                      <option key={a.id} value={a.id}>{a.nickname} ···{a.mask}</option>
                    ))}
                  </Select>
                </div>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex gap-3 pt-2">
                <Button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Save Transaction"}</Button>
                <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function NewTransactionClient() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground p-4">Loading…</p>}>
      <NewTransactionInner />
    </Suspense>
  );
}
