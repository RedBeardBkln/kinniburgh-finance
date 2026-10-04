import { auth } from "@/lib/auth";
import { defaultFilingTaxYear } from "@/lib/tax-default-year";
import { redirect } from "next/navigation";
import type { Route } from "next";

// /tax/forms -> the current year's Forms page. Without this static segment,
// /tax/forms would fall into the dynamic /tax/[workspaceId] route.
export default async function TaxFormsIndexPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  redirect(`/tax/forms/${defaultFilingTaxYear()}` as Route);
}
