import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { VaultVerifyClient } from "@/components/vault/vault-verify-client";

export default async function VaultVerifyPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return <VaultVerifyClient />;
}
