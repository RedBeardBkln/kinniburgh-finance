"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Route } from "next";

interface Account {
  id: string;
  nickname: string;
  mask: string | null;
}

interface Tag {
  id: string;
  name: string;
}

interface Props {
  bucket: string;
  tab: string;
  accounts: Account[];
  tags: Tag[];
  currentSearch: string;
  currentAccountId: string;
  currentTagId: string;
  currentDateFrom: string;
  currentDateTo: string;
  currentSort: string;
  currentSortDir: string;
}

export function TransactionsFilterBar({
  bucket,
  tab,
  accounts,
  tags,
  currentSearch,
  currentAccountId,
  currentTagId,
  currentDateFrom,
  currentDateTo,
  currentSort,
  currentSortDir,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [search, setSearch] = useState(currentSearch);
  const [accountId, setAccountId] = useState(currentAccountId);
  const [tagId, setTagId] = useState(currentTagId);
  const [dateFrom, setDateFrom] = useState(currentDateFrom);
  const [dateTo, setDateTo] = useState(currentDateTo);

  function buildUrl(overrides: Record<string, string | undefined> = {}) {
    const base: Record<string, string> = { bucket, tab, page: "1" };
    if (search) base.search = search;
    if (accountId) base.accountId = accountId;
    if (tagId) base.tagId = tagId;
    if (dateFrom) base.dateFrom = dateFrom;
    if (dateTo) base.dateTo = dateTo;
    if (currentSort !== "date") base.sort = currentSort;
    if (currentSortDir !== "desc") base.sortDir = currentSortDir;

    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined || v === "") delete base[k];
      else base[k] = v;
    }
    return `/transactions?${new URLSearchParams(base).toString()}`;
  }

  function apply() {
    startTransition(() => router.push(buildUrl() as Route));
  }

  function clear() {
    setSearch("");
    setAccountId("");
    setTagId("");
    setDateFrom("");
    setDateTo("");
    startTransition(() =>
      router.push(`/transactions?bucket=${bucket}&tab=${tab}` as Route)
    );
  }

  function toggleSort(col: string) {
    const newDir =
      currentSort === col
        ? currentSortDir === "asc" ? "desc" : "asc"
        : "asc";
    startTransition(() =>
      router.push(buildUrl({ sort: col, sortDir: newDir, page: "1" }) as Route)
    );
  }

  const hasFilters = !!(search || accountId || tagId || dateFrom || dateTo);

  return (
    <div className="space-y-2 rounded-lg border bg-card/50 p-3">
      {/* Filter row */}
      <div className="flex flex-wrap gap-2 items-end">
        <input
          type="text"
          placeholder="Search payee or description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
          className="h-9 flex-1 min-w-[200px] rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          title="From date"
        />
        <span className="text-xs text-muted-foreground self-center">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          title="To date"
        />

        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.nickname}{a.mask ? ` ···${a.mask}` : ""}
            </option>
          ))}
        </select>

        <select
          value={tagId}
          onChange={(e) => setTagId(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        <button
          onClick={apply}
          disabled={isPending}
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60"
        >
          {isPending ? "…" : "Filter"}
        </button>

        {hasFilters && (
          <button
            onClick={clear}
            disabled={isPending}
            className="h-9 px-3 rounded-md border border-input bg-background text-sm hover:bg-accent disabled:opacity-60"
          >
            Clear
          </button>
        )}
      </div>

      {/* Sort row */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Sort by:</span>
        {(
          [
            { col: "date", label: "Date" },
            { col: "payee", label: "Payee" },
            { col: "amount", label: "Amount" },
          ] as const
        ).map(({ col, label }) => {
          const active = currentSort === col;
          return (
            <button
              key={col}
              onClick={() => toggleSort(col)}
              disabled={isPending}
              className={cn(
                "inline-flex items-center gap-0.5 text-xs px-2.5 py-1 rounded-md border transition-colors disabled:opacity-60",
                active
                  ? "border-primary bg-primary/10 text-primary font-medium"
                  : "border-input text-muted-foreground hover:bg-accent"
              )}
            >
              {label}
              {active && (
                <span className="ml-0.5 text-[10px]">
                  {currentSortDir === "asc" ? "↑" : "↓"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
