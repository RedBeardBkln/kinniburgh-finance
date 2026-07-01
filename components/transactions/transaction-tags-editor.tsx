"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TagPicker } from "@/components/tags/tag-picker";
import { updateTransactionTags } from "@/actions/transactions";
import { createTagRule } from "@/actions/tag-rules";
import { RetroactiveRuleModal } from "@/components/tag-rules/retroactive-rule-modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface Props {
  transactionId: string;
  allTags: Tag[];
  initialTagIds: string[];
  payeeNormalized?: string;
  defaultAmount?: string;
  accountId?: string;
  accountNickname?: string;
  accountMask?: string | null;
}

interface RulePrompt {
  tagId: string;
  tagName: string;
}

interface RetroState {
  ruleId: string;
  tagName: string;
}

function InlineRulePanel({
  prompt,
  payeeNormalized,
  defaultAmount,
  accountId,
  accountNickname,
  accountMask,
  onCreated,
  onDismiss,
}: {
  prompt: RulePrompt;
  payeeNormalized?: string;
  defaultAmount?: string;
  accountId?: string;
  accountNickname?: string;
  accountMask?: string | null;
  onCreated: (ruleId: string, tagName: string) => void;
  onDismiss: () => void;
}) {
  const [payeePattern, setPayeePattern] = useState(payeeNormalized ?? "");
  const [useAmountRange, setUseAmountRange] = useState(false);
  const [amountMin, setAmountMin] = useState(defaultAmount ?? "");
  const [amountMax, setAmountMax] = useState(defaultAmount ?? "");
  const [useAccount, setUseAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    if (!payeePattern.trim()) {
      setError("Payee pattern is required");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const { id: ruleId } = await createTagRule({
          payeePattern: payeePattern.trim(),
          tagId: prompt.tagId,
          ...(useAmountRange && amountMin ? { amountMin } : {}),
          ...(useAmountRange && amountMax ? { amountMax } : {}),
          ...(useAccount && accountId ? { accountId } : {}),
        });
        onCreated(ruleId, prompt.tagName);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create rule");
      }
    });
  }

  const accountLabel = accountNickname
    ? `${accountNickname}${accountMask ? ` ···${accountMask}` : ""}`
    : "this account";

  return (
    <div className="mt-4 rounded-md border border-dashed p-4 space-y-3 bg-muted/30">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">
          Save as tag rule for{" "}
          <span className="font-semibold">{prompt.tagName}</span>?
        </p>
        <button
          onClick={onDismiss}
          className="text-xs text-muted-foreground hover:text-foreground shrink-0"
        >
          Dismiss
        </button>
      </div>

      <div className="space-y-1">
        <Label htmlFor="rulePayeePattern" className="text-xs">Payee pattern</Label>
        <Input
          id="rulePayeePattern"
          value={payeePattern}
          onChange={(e) => setPayeePattern(e.target.value)}
          placeholder="e.g. amazon"
          className="h-8 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Partial match — future transactions whose payee contains this will be auto-tagged.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={useAmountRange}
          onChange={(e) => setUseAmountRange(e.target.checked)}
          className="h-4 w-4"
        />
        Restrict to amount range
      </label>

      {useAmountRange && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="ruleAmountMin" className="text-xs">Min ($)</Label>
            <Input
              id="ruleAmountMin"
              type="number"
              step="0.01"
              min="0"
              value={amountMin}
              onChange={(e) => setAmountMin(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ruleAmountMax" className="text-xs">Max ($)</Label>
            <Input
              id="ruleAmountMax"
              type="number"
              step="0.01"
              min="0"
              value={amountMax}
              onChange={(e) => setAmountMax(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
        </div>
      )}

      {accountId && (
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={useAccount}
            onChange={(e) => setUseAccount(e.target.checked)}
            className="h-4 w-4"
          />
          Match {accountLabel} only
        </label>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-2 pt-1">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending ? "Saving…" : "Save rule"}
        </Button>
        <Button size="sm" variant="outline" onClick={onDismiss} disabled={isPending}>
          No thanks
        </Button>
      </div>
    </div>
  );
}

export function TransactionTagsEditor({
  transactionId,
  allTags,
  initialTagIds,
  payeeNormalized,
  defaultAmount,
  accountId,
  accountNickname,
  accountMask,
}: Props) {
  const router = useRouter();
  const [tagIds, setTagIds] = useState(initialTagIds);
  const [isPending, startTransition] = useTransition();
  const [rulePrompt, setRulePrompt] = useState<RulePrompt | null>(null);
  const [retroModal, setRetroModal] = useState<RetroState | null>(null);

  function handleChange(newIds: string[]) {
    // Detect a newly added tag to offer the save-as-rule prompt
    if (payeeNormalized) {
      const prevSet = new Set(tagIds);
      const addedId = newIds.find((id) => !prevSet.has(id));
      if (addedId) {
        const tag = allTags.find((t) => t.id === addedId);
        if (tag) setRulePrompt({ tagId: addedId, tagName: tag.name });
      }
    }

    // Auto-dismiss prompt if its tag was removed
    if (rulePrompt && !newIds.includes(rulePrompt.tagId)) {
      setRulePrompt(null);
    }

    setTagIds(newIds);
    startTransition(async () => {
      await updateTransactionTags(transactionId, newIds);
      router.refresh();
    });
  }

  return (
    <>
      <div className={isPending ? "opacity-50 pointer-events-none" : ""}>
        <TagPicker tags={allTags} selected={tagIds} onChange={handleChange} />
        {isPending && (
          <p className="mt-2 text-xs text-muted-foreground">Saving…</p>
        )}

        {rulePrompt && (
          <InlineRulePanel
            prompt={rulePrompt}
            payeeNormalized={payeeNormalized}
            defaultAmount={defaultAmount}
            accountId={accountId}
            accountNickname={accountNickname}
            accountMask={accountMask}
            onCreated={(ruleId, tagName) => {
              setRulePrompt(null);
              setRetroModal({ ruleId, tagName });
            }}
            onDismiss={() => setRulePrompt(null)}
          />
        )}
      </div>

      {retroModal && (
        <RetroactiveRuleModal
          ruleId={retroModal.ruleId}
          tagName={retroModal.tagName}
          onDone={() => setRetroModal(null)}
        />
      )}
    </>
  );
}
