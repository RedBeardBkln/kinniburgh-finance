import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getVaultSession } from "@/lib/vault-session";
import { listVaultEntries } from "@/actions/vault";
import { AppShell } from "@/components/app-shell";
import type { Route } from "next";
import { VaultClient } from "@/components/vault/vault-client";

export default async function VaultPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const hasVault = await getVaultSession(session.user.id);
  if (!hasVault) redirect("/vault/verify" as Route);

  const entries = await listVaultEntries();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <VaultClient initialEntries={entries} />
    </AppShell>
  );
}
