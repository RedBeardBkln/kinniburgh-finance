"use client";

import { useMemo, useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { createTagRule, deleteTagRule, updateTagRule } from "@/actions/tag-rules";
import { RetroactiveRuleModal } from "./retroactive-rule-modal";
import { RuleConflictWarning } from "./rule-conflict-warning";
import {
  findRuleConflicts,
  ruleMatchesSearch,
  type RuleConflictView,
  type RuleShape,
} from "@/lib/tag-rule-conflicts";

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

  // Edit mode
  const [editingId, setEditingId] = useState<string | null>(null);

  // Search + conflict screening
  const [search, setSearch] = useState("");
  const [approval, setApproval] = useState<{ key: string; conflicts: RuleConflictView[] } | null>(null);

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.nickname ?? "account";
  const tagNameOf = (id: string) => allTags.find((t) => t.id === id)?.shortName ?? "(unknown tag)";

  function rowToShape(r: RuleRow): RuleShape {
    return {
      id: r.id,
      payeePattern: r.payeePattern || null,
      tagId: r.tagId,
      amountMin: r.amountMin !== null ? Number(r.amountMin) : null,
      amountMax: r.amountMax !== null ? Number(r.amountMax) : null,
      accountId: r.accountId,
      accountIds: r.accountIds,
    };
  }

  function withNames(cs: ReturnType<typeof findRuleConflicts>): RuleConflictView[] {
    return cs.map((c) => ({ ...c, tagName: tagNameOf(c.tagId) }));
  }

  // Fingerprint of the form so an approval only applies to the exact values screened
  const formKey = JSON.stringify([
    editingId, newPattern.trim().toLowerCase(), newTagId, newAmountMin, newAmountMax, [...newAccountIds].sort(),
  ]);

  // Live preview of overlapping rules while the form is open
  const liveConflicts = useMemo(() => {
    if (!showForm || !newPattern.trim()) return [];
    const candidate: RuleShape = {
      payeePattern: newPattern.trim().toLowerCase(),
      tagId: newTagId,
      amountMin: newAmountMin ? Number(newAmountMin) : null,
      amountMax: newAmountMax ? Number(newAmountMax) : null,
      accountId: null,
      accountIds: newAccountIds.size > 0 ? [...newAccountIds] : null,
    };
    return withNames(findRuleConflicts(candidate, rules.map(rowToShape), { excludeId: editingId ?? undefined }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm, newPattern, newTagId, newAmountMin, newAmountMax, newAccountIds, rules, editingId]);

  // Which saved rules overlap with another saved rule (badge in the table)
  const conflictCountById = useMemo(() => {
    const shapes = rules.map(rowToShape);
    const counts = new Map<string, number>();
    for (const r of shapes) {
      const n = findRuleConflicts(r, shapes, { excludeId: r.id }).length;
      if (n > 0) counts.set(r.id!, n);
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  const visibleRules = useMemo(
    () =>
      rules.filter((r) =>
        ruleMatchesSearch(search, {
          payeePattern: r.payeePattern,
          tagName: r.tagName,
          accountLabels: [
            ...(r.accountNickname ? [r.accountNickname] : []),
            ...(r.accountIds ?? []).map((id) => accounts.find((a) => a.id === id)?.nickname ?? ""),
          ],
        })
      ),
    [rules, search, accounts]
  );

  // Retroactive application state
  const [retroModal, setRetroModal] = useState<{ ruleId: string; tagName: string } | null>(null);


  function resetForm() {
    setNewPattern("");
    setNewTagId(allTags[0]?.id ?? "");
    setNewAmountMin("");
    setNewAmountMax("");
    setNewAccountIds(new Set());
    setShowForm(false);
    setEditingId(null);
    setApproval(null);
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

  function handleCreate(approveConflicts = false) {
    if (!newPattern.trim()) { setError("Payee pattern is required"); return; }
    if (!newTagId) { setError("Select a tag"); return; }
    setError(null);

    startTransition(async () => {
      try {
        const selectedIds = newAccountIds.size > 0 ? [...newAccountIds] : undefined;
        const result = await createTagRule({
          approveConflicts,
          payeePattern: newPattern.trim(),
          tagId: newTagId,
          amountMin: newAmountMin || undefined,
          amountMax: newAmountMax || undefined,
          accountIds: selectedIds,
        });
        if (result.status === "needs_approval") {
          setApproval({ key: formKey, conflicts: result.conflicts });
          return;
        }
        const ruleId = result.id;
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

  function handleUpdate(approveConflicts = false) {
    if (!editingId) return;
    if (!newPattern.trim()) { setError("Payee pattern is required"); return; }
    if (!newTagId) { setError("Select a tag"); return; }
    setError(null);

    startTransition(async () => {
      try {
        const selectedIds = newAccountIds.size > 0 ? [...newAccountIds] : null;
        const result = await updateTagRule(editingId, {
          approveConflicts,
          payeePattern: newPattern.trim(),
          tagId: newTagId,
          amountMin: newAmountMin || null,
          amountMax: newAmountMax || null,
          accountId: null,
          accountIds: selectedIds,
        });
        if (result.status === "needs_approval") {
          setApproval({ key: formKey, conflicts: result.conflicts });
          return;
        }
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
      <div className="flex items-center justify-between gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search rules by payee, tag, or account…"
          aria-label="Search tag rules"
          className="max-w-sm"
        />
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

            {approval && approval.key === formKey ? (
              <RuleConflictWarning
                conflicts={approval.conflicts}
                accountName={accountName}
                busy={isPending}
                onApprove={() => (editingId ? handleUpdate(true) : handleCreate(true))}
                onCancel={() => setApproval(null)}
              />
            ) : (
              <RuleConflictWarning conflicts={liveConflicts} accountName={accountName} />
            )}

            <button
              onClick={() => (editingId ? handleUpdate() : handleCreate())}
              disabled={isPending || (approval !== null && approval.key === formKey)}
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
              {rules.length > 0 && visibleRules.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No rules match &ldquo;{search}&rdquo;.
                  </td>
                </tr>
              )}
              {rules.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No tag rules yet. Create one above or confirm a receipt to generate rules automatically.
                  </td>
                </tr>
              )}
              {visibleRules.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-mono text-xs">
                    {r.payeePattern}
                    {conflictCountById.has(r.id) && (
                      <button
                        type="button"
                        onClick={() => setSearch(r.payeePattern)}
                        title="This rule overlaps with other rules — click to search for its payee"
                        className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-sans text-[10px] font-medium text-amber-800 hover:bg-amber-200"
                      >
                        ⚠ {conflictCountById.get(r.id)} overlap
                      </button>
                    )}
                  </td>
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
