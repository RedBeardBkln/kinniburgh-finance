import { AppShell } from "@/components/app-shell";
import { NewTransactionClient } from "./new-client";

export const dynamic = "force-dynamic";

export default function NewTransactionPage() {
  return (
    <AppShell>
      <NewTransactionClient />
    </AppShell>
  );
}
