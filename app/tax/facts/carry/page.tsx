import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { carryTargetContext, defaultCarryTarget } from "@/lib/tax-facts/carry-target";

// /tax/facts/carry -> the first tax year the carry screen offers. A static segment, so it never falls into the dynamic
// /tax/[workspaceId] route. Reads nothing and writes nothing.
export default async function TaxFactsCarryIndexPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  redirect(`/tax/facts/carry/${defaultCarryTarget(carryTargetContext(null))}` as Route);
}
