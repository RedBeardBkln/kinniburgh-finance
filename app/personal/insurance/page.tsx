import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { db } from "@/lib/db";
import { listPolicies } from "@/actions/insurance";
import { InsurancePolicyCard } from "@/components/insurance/insurance-policy-card";
import { AddPolicyForm } from "@/components/insurance/add-policy-form";
import type { Route } from "next";

export default async function InsurancePage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const entities = await db.entity.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const policies = await listPolicies();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Life & Property Insurance</h1>
          <p className="text-sm text-muted-foreground">
            Policy summaries and cash value tracking. Observations only — not financial advice.
          </p>
        </div>

        <AddPolicyForm entities={entities} />

        {policies.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No policies yet. Add one above or upload a policy document from the Document Vault.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {policies.map((policy) => (
            <InsurancePolicyCard key={policy.id} policy={policy} />
          ))}
        </div>
      </div>
    </AppShell>
  );
}
