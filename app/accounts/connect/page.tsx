import { AppShell } from "@/components/app-shell";
import { ConnectClient } from "./connect-client";

export const dynamic = "force-dynamic";

export default function ConnectPage() {
  return (
    <AppShell>
      <ConnectClient />
    </AppShell>
  );
}
