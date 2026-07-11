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
import { createTag } from "@/actions/tags";
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
  accountId?: string;
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
  const [localTags, setLocalTags] = useState<Tag[]>(allTags);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropPos, setDropPos] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 });
  const [rulePrompt, setRulePrompt] = useState<RulePrompt | null>(null);
  const [pendingTagSave, setPendingTagSave] = useState<string[] | null>(null);
  const [retroModal, setRetroModal] = useState<RetroState | null>(null);

  // Create tag state
  const [createMode, setCreateMode] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createParentId, setCreateParentId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, startCreateTransition] = useTransition();
  const createNameRef = useRef<HTMLInputElement>(null);
  // Ref so the keydown handler always sees the latest createMode value
  const createModeRef = useRef(false);
  useEffect(() => { createModeRef.current = createMode; }, [createMode]);

  useEffect(() => {
    if (createMode) {
      const t = setTimeout(() => createNameRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [createMode]);

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
        setCreateMode(false);
        setCreateName("");
        setCreateParentId("");
        setCreateError(null);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (createModeRef.current) {
          setCreateMode(false);
          setCreateName("");
          setCreateParentId("");
          setCreateError(null);
        } else {
          setOpen(false);
          setQuery("");
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function handleOpen() {
    if (open) {
      setOpen(false);
      setQuery("");
      setCreateMode(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const DROPDOWN_HEIGHT = 320;
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < DROPDOWN_HEIGHT) {
        setDropPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left });
      } else {
        setDropPos({ top: rect.bottom + 4, left: rect.left });
      }
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
      setOpen(false);
      setQuery("");
      const tag = localTags.find((t) => t.id === tagId);
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

  function enterCreateMode() {
    setCreateName(query.trim());
    setCreateParentId("");
    setCreateError(null);
    setCreateMode(true);
  }

  function handleCreateTag() {
    if (!createName.trim()) { setCreateError("Name is required"); return; }
    setCreateError(null);
    startCreateTransition(async () => {
      try {
        const parent = createParentId ? localTags.find((t) => t.id === createParentId) : null;
        const { id } = await createTag({
          shortName: createName.trim(),
          parentId: createParentId || undefined,
        });
        const fullName = parent
          ? `${parent.name} / ${createName.trim()}`
          : createName.trim();
        const newTag: Tag = { id, name: fullName, shortName: createName.trim(), parentId: createParentId || null };

        setLocalTags((prev) =>
          [...prev, newTag].sort((a, b) => a.name.localeCompare(b.name))
        );
        setCreateMode(false);
        setCreateName("");
        setCreateParentId("");
        setCreateError(null);
        setOpen(false);
        setQuery("");

        // Select the new tag and show rule prompt (bypass toggle — tag is already in localTags now)
        const next = [...tagIds, id];
        setTagIds(next);
        setPendingTagSave(next);
        setRulePrompt({ tagId: id, tagName: newTag.name });
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : "Failed to create tag");
      }
    });
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return localTags;
    return localTags.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.shortName.toLowerCase().includes(q)
    );
  }, [localTags, query]);

  const selectedTags = useMemo(
    () => localTags.filter((t) => tagIds.includes(t.id)),
    [localTags, tagIds]
  );

  const dropdown = open ? (
    <div
      ref={dropdownRef}
      style={{ position: "fixed", top: dropPos.top, bottom: dropPos.bottom, left: dropPos.left, zIndex: 9999 }}
      className="w-80 rounded-md border border-border bg-card shadow-2xl"
    >
      {!createMode ? (
        <>
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
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => enterCreateMode()}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-primary hover:bg-accent"
            >
              <span className="text-sm leading-none font-medium">+</span>
              {query.trim() ? `Create "${query.trim()}"` : "Create new tag"}
            </button>
          </div>
        </>
      ) : (
        /* ── Create mode ── */
        <div className="p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">New tag</span>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setCreateMode(false);
                setCreateName("");
                setCreateParentId("");
                setCreateError(null);
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              ref={createNameRef}
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); handleCreateTag(); }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setCreateMode(false);
                  setCreateName("");
                  setCreateParentId("");
                  setCreateError(null);
                }
              }}
              placeholder="e.g. Groceries"
              className="h-7 text-xs bg-background"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Parent tag <span className="opacity-60">(optional)</span>
            </label>
            <select
              value={createParentId}
              onChange={(e) => setCreateParentId(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              className="w-full h-7 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="">No parent</option>
              {localTags.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          {createError && (
            <p className="text-xs text-destructive">{createError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); handleCreateTag(); }}
              disabled={isCreating}
              className="flex-1 h-7 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
            >
              {isCreating ? "Creating…" : "Create & select"}
            </button>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setCreateMode(false);
                setCreateName("");
                setCreateParentId("");
                setCreateError(null);
              }}
              className="h-7 px-3 rounded-md border text-xs hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
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

        {tagIds.length === 0 && (
          <button
            ref={buttonRef}
            type="button"
            onClick={handleOpen}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            title="Add tag"
          >
            +
          </button>
        )}

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
            setRetroModal({ ruleId, tagName, accountId });
          }}
          onDismiss={closePrompt}
        />
      )}

      {retroModal && (
        <RetroactiveRuleModal
          ruleId={retroModal.ruleId}
          tagName={retroModal.tagName}
          initialAccountId={retroModal.accountId}
          onDone={() => setRetroModal(null)}
        />
      )}
    </>
  );
}
