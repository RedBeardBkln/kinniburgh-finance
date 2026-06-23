import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { UploadClient } from "./upload-client";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ bucket?: string }>;
}

export default async function ReceiptUploadPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const bucket = params.bucket ?? "personal";
  const entity = await getEntityBySlug(bucket);
  const entityLabel = entity?.navLabel ?? entity?.name ?? "All Entities";

  return (
    <AppShell>
      <UploadClient entityLabel={entityLabel} />
    </AppShell>
  );
}
