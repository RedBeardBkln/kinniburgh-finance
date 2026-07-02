"use client";

import { useState, useEffect, useRef, useTransition, useMemo } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { updateTransactionTags } from "@/actions/transactions";
import { createTagRule } from "@/actions/tag-rules";
import { RetroactiveRuleModal } from "@/components/tag-rules/retroactive-rule-modal";
import { cn } from "@/lib/utils";

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

function RuleDialog({
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

  const accountLabel = accountNickname
    ? `${accountNickname}${accountMask ? ` ···${accountMask}` : ""}`
    : "this account";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-lg border bg-card shadow-xl p-6 space-y-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium">
            Save as tag rule for{" "}
            <span className="font-semibold">{prompt.tagName}</span>?
          </p>
          <button
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground shrink-0 text-xl leading-none"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>

        <div className="space-y-1">
          <Label htmlFor="rulePayeePatternDialog" className="text-xs">
            Payee pattern
          </Label>
          <Input
            id="rulePayeePatternDialog"
            autoFocus
            value={payeePattern}
            onChange={(e) => setPayeePattern(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
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
              <Label htmlFor="ruleAmountMinDialog" className="text-xs">
                Min ($)
              </Label>
              <Input
                id="ruleAmountMinDialog"
                type="number"
                step="0.01"
                min="0"
                value={amountMin}
                onChange={(e) => setAmountMin(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ruleAmountMaxDialog" className="text-xs">
                Max ($)
              </Label>
              <Input
                id="ruleAmountMaxDialog"
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
          <Button
            size="sm"
            variant="outline"
            onClick={onDismiss}
            disabled={isPending}
          >
            No thanks
          </Button>
        </div>
      </div>
    </div>
  );
}

export function InlineTagCell({
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });
  // Deferred save: hold tag IDs until user decides on the rule prompt.
  // updateTransactionTags calls revalidatePath which triggers an automatic RSC
  // re-render — calling it while the dialog is open would wipe dialog state.
  const [rulePrompt, setRulePrompt] = useState<RulePrompt | null>(null);
  const [pendingTagSave, setPendingTagSave] = useState<string[] | null>(null);
  const [retroModal, setRetroModal] = useState<RetroState | null>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !containerRef.current?.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function handleOpen() {
    if (open) {
      setOpen(false);
      setQuery("");
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setDropPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen(true);
  }

  function commitTags(ids: string[]) {
    startTransition(async () => {
      await updateTransactionTags(transactionId, ids);
      router.refresh();
    });
  }

  function toggle(tagId: string) {
    const isAdding = !tagIds.includes(tagId);
    const next = isAdding
      ? [...tagIds, tagId]
      : tagIds.filter((id) => id !== tagId);

    setTagIds(next);

    if (isAdding) {
      // Close the picker and show the rule dialog before saving
      setOpen(false);
      setQuery("");
      const tag = allTags.find((t) => t.id === tagId);
      if (tag) {
        setPendingTagSave(next);
        setRulePrompt({ tagId, tagName: tag.name });
        return;
      }
    }

    commitTags(next);
  }

  function removeTag(tagId: string, e: React.MouseEvent) {
    e.stopPropagation();
    const next = tagIds.filter((id) => id !== tagId);
    setTagIds(next);
    commitTags(next);
  }

  function closePrompt() {
    const ids = pendingTagSave;
    setRulePrompt(null);
    setPendingTagSave(null);
    if (ids) commitTags(ids);
    else router.refresh();
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return allTags;
    return allTags.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.shortName.toLowerCase().includes(q)
    );
  }, [allTags, query]);

  const selectedTags = useMemo(
    () => allTags.filter((t) => tagIds.includes(t.id)),
    [allTags, tagIds]
  );

  const dropdown = open ? (
    <div
      ref={dropdownRef}
      style={{ position: "fixed", top: dropPos.top, left: dropPos.left, zIndex: 9999 }}
      className="w-80 rounded-md border border-border bg-card shadow-2xl"
    >
      <div className="p-2 border-b border-border">
        <Input
          autoFocus
          placeholder="Search tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 text-xs bg-background"
        />
      </div>
      <ul className="max-h-56 overflow-y-auto py-1">
        {filtered.map((tag) => {
          const isSelected = tagIds.includes(tag.id);
          return (
            <li key={tag.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  toggle(tag.id);
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-accent gap-2",
                  isSelected && "font-medium text-primary"
                )}
              >
                <span className="leading-snug">{tag.name}</span>
                {isSelected && (
                  <span className="text-primary shrink-0">✓</span>
                )}
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="px-3 py-2 text-xs text-muted-foreground">
            No tags found
          </li>
        )}
      </ul>
    </div>
  ) : null;

  return (
    <>
      <div
        ref={containerRef}
        className={cn(
          "relative inline-flex flex-wrap items-center gap-1",
          isPending && "opacity-50 pointer-events-none"
        )}
      >
        {selectedTags.map((t) => (
          <Badge key={t.id} variant="secondary" className="text-xs pr-1 gap-0.5">
            {t.shortName}
            <button
              type="button"
              onClick={(e) => removeTag(t.id, e)}
              className="ml-0.5 text-muted-foreground hover:text-destructive leading-none"
            >
              ×
            </button>
          </Badge>
        ))}

        <button
          ref={buttonRef}
          type="button"
          onClick={handleOpen}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          title="Add tag"
        >
          +
        </button>

        {typeof document !== "undefined" && dropdown
          ? createPortal(dropdown, document.body)
          : null}
      </div>

      {rulePrompt && (
        <RuleDialog
          prompt={rulePrompt}
          payeeNormalized={payeeNormalized}
          defaultAmount={defaultAmount}
          accountId={accountId}
          accountNickname={accountNickname}
          accountMask={accountMask}
          onCreated={(ruleId, tagName) => {
            const ids = pendingTagSave;
            setRulePrompt(null);
            setPendingTagSave(null);
            if (ids) commitTags(ids);
            else router.refresh();
            setRetroModal({ ruleId, tagName });
          }}
          onDismiss={closePrompt}
        />
      )}

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
