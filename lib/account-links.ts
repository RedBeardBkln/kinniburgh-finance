// Pure, client-safe: the per-account Transactions link used on the Accounts page.
//
// The link uses the account's OWN entity (not the Accounts page's current bucket), so an EK Consulting account opened
// from the all-entities Accounts view lands on the EK Consulting list. An entity without a slug falls back to
// bucket=taxes, which getEntityBySlug resolves to no entity (the All Entities view), so the account's rows are still
// shown. tab=all: the per-account All view lists that account's transfers too (Needs Review never does).
import type { Route } from "next";

export function accountTransactionsHref(acct: { id: string; entitySlug: string | null }): Route {
  const q = new URLSearchParams({ bucket: acct.entitySlug ?? "taxes", tab: "all", accountId: acct.id });
  return `/transactions?${q.toString()}` as Route;
}
