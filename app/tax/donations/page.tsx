import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import type { Route } from "next";

// /tax/donations -> the current year's donation log. Without this static segment,
// /tax/donations would fall into the dynamic /tax/[workspaceId] route.
export default async function TaxDonationsIndexPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  redirect(`/tax/donations/${new Date().getUTCFullYear()}` as Route);
}
