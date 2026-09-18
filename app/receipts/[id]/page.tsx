import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getReceiptSignedUrl } from "@/lib/supabase-storage";
import { findMatchingTransactions, getReceiptFormData } from "@/actions/receipts";
import { ReceiptConfirmForm } from "@/components/receipts/receipt-confirm-form";
import { Prisma } from "@prisma/client";
import { decimalToNumber } from "@/lib/utils";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ transactionId?: string }>;
}

export default async function ReceiptDetailPage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { id } = await params;
  const { transactionId: pinnedTransactionId } = await searchParams;
  const receipt = await db.receipt.findUnique({ where: { id } });
  if (!receipt || receipt.archivedAt) notFound();

  const [signedUrl, matches, allTags, formData, pinnedTransaction] = await Promise.all([
    getReceiptSignedUrl(receipt.fileKey).catch(() => null),
    findMatchingTransactions(id, receipt.accountId ?? undefined),
    db.tag.findMany({ orderBy: { name: "asc" } }),
    getReceiptFormData(receipt.entityId),
    pinnedTransactionId
      ? db.transaction.findUnique({
          where: { id: pinnedTransactionId, archivedAt: null },
          select: {
            id: true,
            postedAt: true,
            amount: true,
            payeeRaw: true,
            accountId: true,
            account: { select: { nickname: true } },
          },
        })
      : Promise.resolve(null),
  ]);

  // Prepend the pinned transaction into the match list, only if
  // findMatchingTransactions's fuzzy (±7 days/±2%) search didn't already
  // surface the exact same row.
  const allMatches =
    pinnedTransaction && !matches.some((m) => m.id === pinnedTransaction.id)
      ? [
          {
            id: pinnedTransaction.id,
            postedAt: pinnedTransaction.postedAt,
            amount: pinnedTransaction.amount.toString(),
            payeeRaw: pinnedTransaction.payeeRaw,
            accountNickname: pinnedTransaction.account.nickname,
          },
          ...matches,
        ]
      : matches;

  const isImage = receipt.fileKey.match(/\.(jpg|jpeg|png|webp)$/i);
  const isPdf = receipt.fileKey.endsWith(".pdf");

  const totalStr = receipt.total
    ? decimalToNumber(new Prisma.Decimal(receipt.total)).toFixed(2)
    : "";
  const dateStr = receipt.receiptDate
    ? receipt.receiptDate.toISOString().split("T")[0]!
    : "";

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Review Receipt</h1>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* File preview */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Receipt Image</CardTitle>
            </CardHeader>
            <CardContent>
              {!signedUrl ? (
                <p className="text-sm text-muted-foreground">Preview unavailable</p>
              ) : isImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={signedUrl}
                  alt="Receipt"
                  className="w-full rounded-md border object-contain max-h-[600px]"
                />
              ) : isPdf ? (
                <embed
                  src={signedUrl}
                  type="application/pdf"
                  className="w-full h-[600px] rounded-md border"
                />
              ) : (
                <a href={signedUrl} className="text-sm text-primary hover:underline">
                  Download file
                </a>
              )}
            </CardContent>
          </Card>

          {/* Confirm form */}
          <ReceiptConfirmForm
            receiptId={id}
            initialVendor={receipt.vendor ?? ""}
            initialDate={dateStr}
            initialTotal={totalStr}
            initialDescription={receipt.description ?? ""}
            initialGlCode={receipt.glCode ?? ""}
            initialMemo={receipt.memo ?? ""}
            initialAccountId={pinnedTransaction?.accountId ?? receipt.accountId ?? null}
            initialTaxCategory={receipt.taxCategory ?? null}
            initialProjectId={receipt.projectId ?? null}
            initialTransactionId={pinnedTransaction?.id}
            ocrStatus={receipt.ocrStatus}
            confirmedAt={receipt.confirmedAt?.toISOString() ?? null}
            matches={allMatches}
            allTags={allTags.map((t) => ({ id: t.id, name: t.name, shortName: t.shortName, parentId: t.parentId }))}
            accounts={formData.accounts}
            projects={formData.projects}
            glCodes={formData.glCodes}
          />
        </div>
      </div>
    </AppShell>
  );
}
