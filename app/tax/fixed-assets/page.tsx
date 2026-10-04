import { auth } from "@/lib/auth";
import { defaultFilingTaxYear } from "@/lib/tax-default-year";
import { redirect } from "next/navigation";
import type { Route } from "next";

// /tax/fixed-assets -> the current year's fixed-asset register. Without this
// static segment, /tax/fixed-assets would fall into the dynamic /tax/[workspaceId] route.
export default async function TaxFixedAssetsIndexPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  redirect(`/tax/fixed-assets/${defaultFilingTaxYear()}` as Route);
}
