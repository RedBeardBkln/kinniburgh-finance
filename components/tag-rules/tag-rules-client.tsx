"use client";

import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { createTagRule, deleteTagRule, updateTagRule } from "@/actions/tag-rules";
import { RetroactiveRuleModal } from "./retroactive-rule-modal";

interface RuleRow {
  id: string;
  payeePattern: string;
  tagId: string;
  tagName: string;
  amountMin: string | null;
  amountMax: string | null;
  accountId: string | null;
  accountNickname: string | null;
  accountIds: string[] | null;
  confidence: number;
}

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface Account {
  id: string;
  nickname: string;
  mask?: string | null;
}

interface Props {
  initialRules: RuleRow[];
  allTags: Tag[];
  accounts: Account[];
}

export function TagRulesClient({ initialRules, allTags, accounts }: Props) {
  const [rules, setRules] = useState(initialRules);
  const [showForm, setShowForm] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [isDeleting, startDeleting] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // New rule form state
  const [newPattern, setNewPattern] = useState("");
  const [newTagId, setNewTagId] = useState(allTags[0]?.id ?? "");
  const [newAmountMin, setNewAmountMin] = useState("");
  const [newAmountMax, setNewAmountMax] = useState("");
  const [newAccountIds, setNewAccountIds] = useState<Set<string>>(new Set());

  // Retroactive application state
  const [retroModal, setRetroModal] = useState<{ ruleId: string; tagName: string } | null>(null);

  // Edit mode
  const [editingId, setEditingId] = useState<string | null>(null);

  function resetForm() {
    setNewPattern("");
    setNewTagId(allTags[0]?.id ?? "");
    setNewAmountMin("");
    setNewAmountMax("");
    setNewAccountIds(new Set());
    setShowForm(false);
    setEditingId(null);
  }

  function handleStartEdit(rule: RuleRow) {
    setEditingId(rule.id);
    setNewPattern(rule.payeePattern);
    setNewTagId(rule.tagId);
    setNewAmountMin(rule.amountMin ?? "");
    setNewAmountMax(rule.amountMax ?? "");
    // Populate from accountIds (multi) or legacy accountId (single)
    const ids = rule.accountIds && rule.accountIds.length > 0
      ? rule.accountIds
      : rule.accountId
      ? [rule.accountId]
      : [];
    setNewAccountIds(new Set(ids));
    setShowForm(true);
    setError(null);
  }

  function handleCreate() {
    if (!newPattern.trim()) { setError("Payee pattern is required"); return; }
    if (!newTagId) { setError("Select a tag"); return; }
    setError(null);

    startTransition(async () => {
      try {
        const selectedIds = newAccountIds.size > 0 ? [...newAccountIds] : undefined;
        const { id: ruleId } = await createTagRule({
          payeePattern: newPattern.trim(),
          tagId: newTagId,
          amountMin: newAmountMin || undefined,
          amountMax: newAmountMax || undefined,
          accountIds: selectedIds,
        });
        // Optimistic add
        const tag = allTags.find((t) => t.id === newTagId);
        setRules((prev) => [
          {
            id: ruleId,
            payeePattern: newPattern.trim().toLowerCase(),
            tagId: newTagId,
            tagName: tag?.shortName ?? "",
            amountMin: newAmountMin || null,
            amountMax: newAmountMax || null,
            accountId: null,
            accountNickname: null,
            accountIds: selectedIds ?? null,
            confidence: 1.0,
          },
          ...prev,
        ]);
        // Open retroactive modal; form reset happens when modal closes
        setRetroModal({ ruleId, tagName: tag?.name ?? tag?.shortName ?? "" });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Create failed");
      }
    });
  }

  function handleUpdate() {
    if (!editingId) return;
    if (!newPattern.trim()) { setError("Payee pattern is required"); return; }
    if (!newTagId) { setError("Select a tag"); return; }
    setError(null);

    startTransition(async () => {
      try {
        const selectedIds = newAccountIds.size > 0 ? [...newAccountIds] : null;
        await updateTagRule(editingId, {
          payeePattern: newPattern.trim(),
          tagId: newTagId,
          amountMin: newAmountMin || null,
          amountMax: newAmountMax || null,
          accountId: null,
          accountIds: selectedIds,
        });
        const tag = allTags.find((t) => t.id === newTagId);
        setRules((prev) =>
          prev.map((r) =>
            r.id === editingId
              ? {
                  ...r,
                  payeePattern: newPattern.trim().toLowerCase(),
                  tagId: newTagId,
                  tagName: tag?.shortName ?? "",
                  amountMin: newAmountMin || null,
                  amountMax: newAmountMax || null,
                  accountId: null,
                  accountNickname: null,
                  accountIds: selectedIds,
                }
              : r
          )
        );
        setRetroModal({ ruleId: editingId, tagName: tag?.name ?? tag?.shortName ?? "" });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Update failed");
      }
    });
  }

  function handleDelete(id: string) {
    startDeleting(async () => {
      await deleteTagRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
    });
  }

  return (
    <>
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => showForm ? resetForm() : setShowForm(true)}
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90"
        >
          {showForm ? "Cancel" : "+ New Rule"}
        </button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{editingId ? "Edit Tag Rule" : "New Tag Rule"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">Payee pattern</label>
                <Input
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                  placeholder="e.g. whole foods market"
                />
                <p className="text-xs text-muted-foreground">Type naturally — apostrophes, hyphens, and other symbols are handled automatically</p>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Tag</label>
                <select
                  value={newTagId}
                  onChange={(e) => setNewTagId(e.target.value)}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {allTags.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Amount min ($) <span className="text-muted-foreground font-normal">optional</span></label>
                <Input
                  value={newAmountMin}
                  onChange={(e) => setNewAmountMin(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Amount max ($) <span className="text-muted-foreground font-normal">optional</span></label>
                <Input
                  value={newAmountMax}
                  onChange={(e) => setNewAmountMax(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-sm font-medium">
                  Account{" "}
                  <span className="text-muted-foreground font-normal">optional — leave all unchecked to match any account</span>
                </label>
                <div className="max-h-40 overflow-y-auto rounded-md border p-2 space-y-1">
                  {accounts.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={newAccountIds.has(a.id)}
                        onChange={() => {
                          setNewAccountIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(a.id)) next.delete(a.id);
                            else next.add(a.id);
                            return next;
                          });
                        }}
                        className="accent-primary"
                      />
                      <span className="font-medium">{a.nickname}</span>
                      {a.mask && <span className="text-muted-foreground">···{a.mask}</span>}
                    </label>
                  ))}
                </div>
                {newAccountIds.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setNewAccountIds(new Set())}
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                  >
                    Clear selection
                  </button>
                )}
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <button
              onClick={editingId ? handleUpdate : handleCreate}
              disabled={isPending}
              className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90 disabled:opacity-60"
            >
              {isPending ? "Saving…" : editingId ? "Save Changes" : "Create Rule"}
            </button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">Payee pattern</th>
                <th className="px-4 py-3 font-medium">Tag</th>
                <th className="px-4 py-3 font-medium">Amount range</th>
                <th className="px-4 py-3 font-medium">Account</th>
                <th className="px-4 py-3 font-medium">Confidence</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No tag rules yet. Create one above or confirm a receipt to generate rules automatically.
                  </td>
                </tr>
              )}
              {rules.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-mono text-xs">{r.payeePattern}</td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary">{r.tagName}</Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {r.amountMin || r.amountMax
                      ? `$${r.amountMin ?? "0"} – $${r.amountMax ?? "∞"}`
                      : "Any"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {r.accountIds && r.accountIds.length > 0
                      ? r.accountIds.length === 1
                        ? (accounts.find((a) => a.id === r.accountIds![0])?.nickname ?? "1 account")
                        : `${r.accountIds.length} accounts`
                      : r.accountNickname ?? "Any"}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {Math.round(r.confidence * 100)}%
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-3">
                      <button
                        onClick={() => handleStartEdit(r)}
                        className="text-xs text-muted-foreground hover:text-primary"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(r.id)}
                        disabled={isDeleting}
                        className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>

    {retroModal && (
      <RetroactiveRuleModal
        ruleId={retroModal.ruleId}
        tagName={retroModal.tagName}
        onDone={() => {
          setRetroModal(null);
          resetForm();
        }}
      />
    )}
    </>
  );
}
