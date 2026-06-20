import { AppShell } from "@/components/app-shell";
import { UploadClient } from "./upload-client";

export const dynamic = "force-dynamic";

export default function ReceiptUploadPage() {
  return (
    <AppShell>
      <UploadClient />
    </AppShell>
  );
}
