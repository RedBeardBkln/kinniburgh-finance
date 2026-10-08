import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { carryTargetContext, defaultCarryTarget } from "@/lib/tax-facts/carry-target";
import { loadYearCloseStates } from "@/lib/tax-year-close-store";
import { latestClosedYear } from "@/lib/tax-year-close/state";

// /tax/facts/carry -> the first tax year the carry screen offers. A static segment, so it never falls into the dynamic
// /tax/[workspaceId] route. Writes nothing.
export default async function TaxFactsCarryIndexPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // The first year after the latest year marked filed (a fail-soft read: an unreadable state falls back to 2026).
  const closeLoad = await loadYearCloseStates();
  const closed = closeLoad.state === "ok" ? latestClosedYear(closeLoad.byYear.values()) : null;
  redirect(`/tax/facts/carry/${defaultCarryTarget(carryTargetContext(closed))}` as Route);
}
