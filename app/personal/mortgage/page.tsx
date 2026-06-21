import { AppShell } from "@/components/app-shell";
import { MortgageClient } from "./mortgage-client";

export const dynamic = "force-dynamic";

export default function MortgagePage() {
  return (
    <AppShell>
      <MortgageClient />
    </AppShell>
  );
}
