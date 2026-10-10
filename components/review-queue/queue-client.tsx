"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Prisma } from "@prisma/client";
import {
  createTagForQueue,
  markOpened,
  returnToEric,
  saveQueue,
  type CreateTagForQueueResult,
  type QueueTag,
} from "@/actions/review-queue";
import { findSimilarItems, isUsableRulePattern, type QueueItemSaveResult } from "@/lib/review-queue";
import { normalizePayee, suggestPayeePattern } from "@/lib/tags";
import type { QueueItem } from "@/lib/review-queue-server";
import { TagPickerSheet } from "./tag-picker-sheet";

// Eva's mobile-first queue. Single column of cards, one tap on a card's tag
// button opens the bottom-sheet picker, a sticky Save bar at the bottom.
// Everything the server needs is derived from the token (never from this
// component); the token is passed to each action and validated on every call.

interface Props {
  token: string;
  items: QueueItem[];
  tags: QueueTag[];
  assigneeName: string;
  senderName: string;
}

interface Choice {
  tagId: string;
  ruleOn: boolean;
  pattern: string;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC", // calendar day stored at UTC midnight
  }).format(new Date(iso));
}

function formatAmount(amountStr: string): { text: string; isOutflow: boolean } {
  const d = new Prisma.Decimal(amountStr);
  const text = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(d.abs().toNumber());
  return { text, isOutflow: d.isNegative() };
}

function defaultPattern(item: QueueItem): string {
  return suggestPayeePattern(normalizePayee(item.payee));
}

export function QueueClient({ token, items: initialItems, tags: initialTags, assigneeName, senderName }: Props) {
  const [items, setItems] = useState<QueueItem[]>(initialItems);
  const [tags, setTags] = useState<QueueTag[]>(initialTags);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [recentTagIds, setRecentTagIds] = useState<string[]>([]);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [confirmReturn, setConfirmReturn] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<string[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [finished, setFinished] = useState(initialItems.length === 0);
  const [totals, setTotals] = useState({ saved: 0, sentBack: 0 });
  const [isSaving, startSave] = useTransition();
  const [isReturning, startReturn] = useTransition();

  // Open tracking: from the client only, so link-preview bots (which don't run
  // JS) never count as "opened". Failure is irrelevant to Eva.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    markOpened(token).catch(() => {});
  }, [token]);

  const closeSheet = useCallback(() => setSheetFor(null), []);

  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const readyCount = items.filter((i) => choices[i.transactionId]).length;

  const similarityItems = useMemo(
    () =>
      items.map((i) => ({
        id: i.transactionId,
        payee: i.payee,
        amount: new Prisma.Decimal(i.amount).abs().toNumber(),
        accountId: i.accountId,
      })),
    [items]
  );

  const chooseTag = useCallback((item: QueueItem, tagId: string) => {
    setChoices((prev) => {
      const existing = prev[item.transactionId];
      return {
        ...prev,
        [item.transactionId]: {
          tagId,
          ruleOn: existing?.ruleOn ?? false,
          pattern: existing?.pattern ?? defaultPattern(item),
        },
      };
    });
    setRecentTagIds((prev) => [tagId, ...prev.filter((id) => id !== tagId)].slice(0, 8));
    setItemErrors((prev) => {
      if (!(item.transactionId in prev)) return prev;
      const next = { ...prev };
      delete next[item.transactionId];
      return next;
    });
    setSheetFor(null);
  }, []);

  function updateChoice(txId: string, patch: Partial<Choice>) {
    setChoices((prev) => {
      const existing = prev[txId];
      if (!existing) return prev;
      return { ...prev, [txId]: { ...existing, ...patch } };
    });
  }

  function clearChoice(txId: string) {
    setChoices((prev) => {
      const next = { ...prev };
      delete next[txId];
      return next;
    });
  }

  function applyToSimilar(item: QueueItem) {
    const choice = choices[item.transactionId];
    if (!choice) return;
    const ids = findSimilarItems(choice.pattern, similarityItems, item.transactionId).filter(
      (id) => !choices[id]
    );
    if (ids.length === 0) return;
    setChoices((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        const target = items.find((i) => i.transactionId === id);
        if (!target || next[id]) continue;
        next[id] = { tagId: choice.tagId, ruleOn: false, pattern: defaultPattern(target) };
      }
      return next;
    });
  }

  async function handleCreateTag(input: {
    shortName: string;
    parentId?: string;
  }): Promise<CreateTagForQueueResult> {
    const result = await createTagForQueue(token, input);
    if (result.ok) {
      setTags((prev) => (prev.some((t) => t.id === result.tag.id) ? prev : [...prev, result.tag]));
    }
    return result;
  }

  function handleSave() {
    const payload = items
      .filter((i) => choices[i.transactionId])
      .map((i) => {
        const c = choices[i.transactionId]!;
        return {
          transactionId: i.transactionId,
          tagId: c.tagId,
          ...(c.ruleOn && isUsableRulePattern(c.pattern)
            ? { rule: { payeePattern: c.pattern.trim() } }
            : {}),
        };
      });
    if (payload.length === 0) return;
    setBanner(null);

    startSave(async () => {
      try {
        const res = await saveQueue(token, { items: payload });
        if (!res.ok) {
          setBanner(res.error);
          return;
        }
        applyResults(res.results, res.completed);
      } catch {
        setBanner(
          "Couldn't save. Check your connection and try again. If it keeps happening, your link may have expired - ask " +
            senderName +
            " for a new one."
        );
      }
    });
  }

  function applyResults(results: QueueItemSaveResult[], completed: boolean) {
    const gone = new Set<string>();
    const errors: Record<string, string> = {};
    const newNotices: string[] = [];
    let saved = 0;
    let alreadyTagged = 0;

    for (const r of results) {
      const item = items.find((i) => i.transactionId === r.transactionId);
      const label = item?.payee || "an item";
      if (r.status === "saved") {
        saved++;
        gone.add(r.transactionId);
        if (r.ruleNote) newNotices.push(`${label}: ${r.ruleNote}`);
      } else if (r.status === "already_tagged") {
        alreadyTagged++;
        gone.add(r.transactionId);
      } else if (r.status === "not_in_queue") {
        gone.add(r.transactionId);
      } else {
        errors[r.transactionId] = "Couldn't save this one. Try again.";
      }
    }

    setItems((prev) => prev.filter((i) => !gone.has(i.transactionId)));
    setChoices((prev) => {
      const next = { ...prev };
      for (const id of gone) delete next[id];
      return next;
    });
    setItemErrors(errors);
    setNotices((prev) => [...prev, ...newNotices]);
    setTotals((prev) => ({ ...prev, saved: prev.saved + saved }));

    const failed = Object.keys(errors).length;
    const parts: string[] = [];
    if (saved > 0) parts.push(`Saved ${saved}.`);
    if (alreadyTagged > 0) {
      parts.push(
        `${alreadyTagged} already had a tag, so ${alreadyTagged === 1 ? "it was" : "they were"} left alone.`
      );
    }
    if (failed > 0) parts.push(`${failed} couldn't be saved - try again.`);
    setBanner(parts.length > 0 ? parts.join(" ") : null);

    if (completed) setFinished(true);
  }

  function handleReturn(txId: string) {
    setConfirmReturn(null);
    startReturn(async () => {
      try {
        const res = await returnToEric(token, txId);
        if (!res.ok) {
          setItemErrors((prev) => ({ ...prev, [txId]: res.error }));
          return;
        }
        setItems((prev) => prev.filter((i) => i.transactionId !== txId));
        clearChoice(txId);
        setTotals((prev) => ({ ...prev, sentBack: prev.sentBack + 1 }));
        if (res.completed) setFinished(true);
      } catch {
        setItemErrors((prev) => ({
          ...prev,
          [txId]: "Couldn't send that back. Check your connection and try again.",
        }));
      }
    });
  }

  // ── Finished ──
  if (finished) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6">
        <div className="max-w-sm space-y-3 text-center">
          <h1 className="text-2xl font-semibold">Done - thanks!</h1>
          <p className="text-base text-muted-foreground">
            {totals.saved > 0 && `${totals.saved} tagged. `}
            {totals.sentBack > 0 && `${totals.sentBack} sent back to ${senderName}. `}
            {totals.saved === 0 && totals.sentBack === 0 && "There is nothing left to review. "}
            You can close this page.
          </p>
          {notices.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-left text-sm text-amber-900">
              {notices.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      </main>
    );
  }

  const sheetItem = sheetFor ? items.find((i) => i.transactionId === sheetFor) ?? null : null;

  return (
    <main className="min-h-dvh bg-muted/30 pb-32">
      <header className="px-4 pt-6 pb-3">
        <h1 className="text-xl font-semibold">
          {assigneeName ? `Hi ${assigneeName} - ` : ""}
          {items.length} {items.length === 1 ? "transaction" : "transactions"} to tag
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {senderName} isn&apos;t sure what these are. Tap a transaction to pick a tag, then Save.
        </p>
      </header>

      {banner && (
        <div role="status" className="mx-4 mb-3 rounded-lg border border-input bg-background p-3 text-sm">
          {banner}
        </div>
      )}
      {notices.length > 0 && (
        <ul className="mx-4 mb-3 space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {notices.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      <ul className="space-y-3 px-4">
        {items.map((item) => {
          const choice = choices[item.transactionId];
          const tag = choice ? tagById.get(choice.tagId) : undefined;
          const { text, isOutflow } = formatAmount(item.amount);
          const payeeLabel = item.payee || "(No payee)";
          const similarCount =
            choice && choice.ruleOn
              ? findSimilarItems(choice.pattern, similarityItems, item.transactionId).filter(
                  (id) => !choices[id]
                ).length
              : 0;
          const patternOk = choice ? isUsableRulePattern(choice.pattern) : false;

          return (
            <li key={item.transactionId} className="rounded-xl border bg-background p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {formatDate(item.postedAt)} · {item.bucketLabel}
                  </p>
                  <p className="mt-0.5 break-words text-lg font-medium leading-snug">{payeeLabel}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {item.accountNickname}
                    {item.accountMask ? ` ···${item.accountMask}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={`font-mono text-lg font-semibold ${
                      isOutflow ? "text-destructive" : "text-green-600"
                    }`}
                  >
                    {isOutflow ? "-" : "+"}
                    {text}
                  </p>
                  <p className="text-xs text-muted-foreground">{isOutflow ? "money out" : "money in"}</p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSheetFor(item.transactionId)}
                className={`mt-3 flex min-h-12 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left text-base ${
                  tag ? "border-primary bg-primary/10 font-medium" : "border-dashed border-input text-muted-foreground"
                }`}
              >
                <span className="min-w-0 break-words">{tag ? tag.name : "Choose a tag"}</span>
                <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                  ›
                </span>
              </button>

              {choice && (
                <div className="mt-3 space-y-2">
                  <label className="flex min-h-11 items-center gap-3 text-base">
                    <input
                      type="checkbox"
                      checked={choice.ruleOn}
                      disabled={!patternOk && !choice.ruleOn}
                      onChange={(e) => updateChoice(item.transactionId, { ruleOn: e.target.checked })}
                      className="h-5 w-5 shrink-0"
                    />
                    <span>Always tag this payee this way</span>
                  </label>
                  {choice.ruleOn && (
                    <div className="space-y-2 pl-8">
                      <label className="block text-xs text-muted-foreground" htmlFor={`pat-${item.transactionId}`}>
                        When the payee contains
                      </label>
                      <input
                        id={`pat-${item.transactionId}`}
                        type="text"
                        autoComplete="off"
                        value={choice.pattern}
                        onChange={(e) => updateChoice(item.transactionId, { pattern: e.target.value })}
                        maxLength={255}
                        className="h-12 w-full rounded-lg border border-input bg-background px-3 text-base"
                      />
                      {!patternOk && (
                        <p className="text-sm text-amber-700">
                          That&apos;s too short to match safely, so no rule will be saved.
                        </p>
                      )}
                      {similarCount > 0 && (
                        <button
                          type="button"
                          onClick={() => applyToSimilar(item)}
                          className="min-h-11 rounded-full border border-primary px-4 text-base font-medium text-primary"
                        >
                          Apply to {similarCount} similar
                        </button>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => clearChoice(item.transactionId)}
                    className="min-h-11 text-sm text-muted-foreground underline"
                  >
                    Clear choice
                  </button>
                </div>
              )}

              {itemErrors[item.transactionId] && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {itemErrors[item.transactionId]}
                </p>
              )}

              <div className="mt-2 border-t pt-2">
                {confirmReturn === item.transactionId ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleReturn(item.transactionId)}
                      disabled={isReturning}
                      className="min-h-11 flex-1 rounded-lg bg-muted text-base font-medium disabled:opacity-50"
                    >
                      Yes, send back to {senderName}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmReturn(null)}
                      className="min-h-11 rounded-lg px-4 text-base text-muted-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmReturn(item.transactionId)}
                    className="min-h-11 text-sm text-muted-foreground underline"
                  >
                    Not sure - send back to {senderName}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
        <button
          type="button"
          onClick={handleSave}
          disabled={readyCount === 0 || isSaving}
          className="min-h-12 w-full rounded-lg bg-primary text-base font-semibold text-primary-foreground disabled:opacity-50"
        >
          {isSaving ? "Saving…" : `Save (${readyCount})`}
        </button>
        {readyCount === 0 && (
          <p className="pt-1 text-center text-xs text-muted-foreground">
            Choose a tag on at least one transaction to save.
          </p>
        )}
      </div>

      {sheetItem && (
        <TagPickerSheet
          tags={tags}
          recentTagIds={recentTagIds}
          currentTagId={choices[sheetItem.transactionId]?.tagId ?? null}
          payeeLabel={sheetItem.payee || "(No payee)"}
          onSelect={(tagId) => chooseTag(sheetItem, tagId)}
          onCreate={handleCreateTag}
          onClose={closeSheet}
        />
      )}
    </main>
  );
}
