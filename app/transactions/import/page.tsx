import { AppShell } from "@/components/app-shell";
import { ImportClient } from "./import-client";

export const dynamic = "force-dynamic";

export default function ImportPage() {
  return (
    <AppShell>
      <ImportClient />
    </AppShell>
  );
}
