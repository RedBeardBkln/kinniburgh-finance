"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTagRule } from "@/actions/tag-rules";
import { TagPicker } from "@/components/tags/tag-picker";
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
  allTags: Tag[];
  defaultPayee: string;
  defaultAmount: string;
  accountId: string;
}

export function CreateRuleForm({ allTags, defaultPayee, defaultAmount, accountId }: Props) {
  const router = useRouter();
  const [payeePattern, setPayeePattern] = useState(defaultPayee);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [useAmountRange, setUseAmountRange] = useState(false);
  const [amountMin, setAmountMin] = useState(defaultAmount);
  const [amountMax, setAmountMax] = useState(defaultAmount);
  const [useAccount, setUseAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!payeePattern.trim()) { setError("Payee pattern required"); return; }
    if (tagIds.length === 0) { setError("Select a tag"); return; }
    setError(null);
    startTransition(async () => {
      try {
        await createTagRule({
          payeePattern,
          tagId: tagIds[0]!,
          ...(useAmountRange && amountMin ? { amountMin } : {}),
          ...(useAmountRange && amountMax ? { amountMax } : {}),
          ...(useAccount ? { accountId } : {}),
        });
        setSuccess(true);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create rule");
      }
    });
  }

  if (success) {
    return (
      <div className="text-sm text-green-700 bg-green-50 rounded-md px-4 py-3">
        Rule created. Future matching transactions will be auto-tagged.{" "}
        <button
          onClick={() => { setSuccess(false); setTagIds([]); }}
          className="underline"
        >
          Create another
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="payeePattern">Payee pattern</Label>
        <Input
          id="payeePattern"
          value={payeePattern}
          onChange={(e) => setPayeePattern(e.target.value)}
          placeholder="e.g. amazon"
        />
        <p className="text-xs text-muted-foreground">
          Partial match — "amazon" tags "amazon.com", "amazon prime", etc.
        </p>
      </div>

      <div className="space-y-1">
        <Label>Tag</Label>
        <TagPicker
          tags={allTags}
          selected={tagIds}
          onChange={setTagIds}
          maxSelected={1}
          placeholder="Pick one tag…"
        />
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
            <Label htmlFor="amountMin">Min ($)</Label>
            <Input
              id="amountMin"
              type="number"
              step="0.01"
              min="0"
              value={amountMin}
              onChange={(e) => setAmountMin(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="amountMax">Max ($)</Label>
            <Input
              id="amountMax"
              type="number"
              step="0.01"
              min="0"
              value={amountMax}
              onChange={(e) => setAmountMax(e.target.value)}
            />
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={useAccount}
          onChange={(e) => setUseAccount(e.target.checked)}
          className="h-4 w-4"
        />
        Match this account only
      </label>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? "Creating…" : "Create rule"}
      </Button>
    </form>
  );
}
