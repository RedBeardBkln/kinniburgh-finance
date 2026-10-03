import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { previewImportSignRepair } from "@/actions/import-sign-repair";
import { ImportSignRepairClient } from "@/components/settings/import-sign-repair-client";

export default async function ImportSignRepairPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const previews = await previewImportSignRepair();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <a href="/settings" className="hover:underline">Settings</a>
            <span>/</span>
            <span>Import Sign Repair</span>
          </div>
          <h1 className="text-2xl font-semibold">Import Sign Repair</h1>
          <p className="text-sm text-muted-foreground">
            Finds checking/savings accounts whose CSV-imported transactions are all stored as
            deposits (positive) — the signature of a debit-only import — and corrects them to
            outflows.
          </p>
        </div>

        <ImportSignRepairClient previews={previews} />
      </div>
    </AppShell>
  );
}
