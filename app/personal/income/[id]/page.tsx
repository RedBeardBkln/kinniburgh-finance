import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getPaystubSignedUrl } from "@/lib/supabase-storage";
import { PaystubConfirmForm } from "@/components/income/paystub-confirm-form";
import type { LabeledAmount } from "@/lib/paystub-extract";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PaystubDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { id } = await params;
  const paystub = await db.paystub.findUnique({ where: { id } });
  if (!paystub || paystub.archivedAt) notFound();

  const [signedUrl, personalAccounts] = await Promise.all([
    getPaystubSignedUrl(paystub.fileKey).catch(() => null),
    db.account.findMany({
      where: { entityId: paystub.entityId, archivedAt: null },
      select: { id: true, nickname: true, mask: true },
      orderBy: { nickname: "asc" },
    }),
  ]);

  const isImage = paystub.fileKey.match(/\.(jpg|jpeg|png|webp)$/i);
  const isPdf = paystub.fileKey.endsWith(".pdf");

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Review Paystub</h1>
          <a
            href="/personal/income"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to Income
          </a>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* File preview */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Paystub document</CardTitle>
            </CardHeader>
            <CardContent>
              {!signedUrl ? (
                <p className="text-sm text-muted-foreground">Preview unavailable</p>
              ) : isImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={signedUrl}
                  alt="Paystub"
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
          <PaystubConfirmForm
            paystubId={paystub.id}
            initialEmployeeName={paystub.employeeName ?? ""}
            initialEmployerName={paystub.employerName ?? ""}
            initialPayPeriodStart={
              paystub.payPeriodStart ? paystub.payPeriodStart.toISOString().split("T")[0]! : ""
            }
            initialPayPeriodEnd={
              paystub.payPeriodEnd ? paystub.payPeriodEnd.toISOString().split("T")[0]! : ""
            }
            initialPayDate={
              paystub.payDate ? paystub.payDate.toISOString().split("T")[0]! : ""
            }
            initialPayFrequency={paystub.payFrequency ?? "biweekly"}
            initialGrossPayCents={paystub.grossPayCents}
            initialPretaxDeductions={
              (paystub.pretaxDeductions as unknown as LabeledAmount[] | null) ?? []
            }
            initialTaxesCents={paystub.taxesCents}
            initialTaxBreakdown={
              (paystub.taxBreakdown as unknown as LabeledAmount[] | null) ?? []
            }
            initialNetPayCents={paystub.netPayCents}
            initialNotes={paystub.notes ?? ""}
            extractStatus={paystub.extractStatus}
            confirmedAt={paystub.confirmedAt?.toISOString() ?? null}
            accounts={personalAccounts}
          />
        </div>
      </div>
    </AppShell>
  );
}