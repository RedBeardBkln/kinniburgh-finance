import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoicingNav } from "@/components/invoicing/invoicing-nav";
import { NotMigratedNotice } from "@/components/invoicing/gate-notices";
import { SetupForm } from "@/components/invoicing/setup-form";
import { CounterForm, EinForm, LogoForm, OnlinePaymentsForm, ProfileForm, RemitForm, type OnlinePaymentsEnvView } from "@/components/invoicing/settings-forms";
import { PAY_FEATURE_NOT_SET_UP } from "@/lib/invoicing/constants";
import { loadPaySettings } from "@/lib/invoicing/pay-build";
import { payBaseUrlProblemMessage, payEnvironment } from "@/lib/invoicing/stripe/pay-env";
import { STRIPE_MODE_MISMATCH_MESSAGE, STRIPE_NOT_CONFIGURED_MESSAGE } from "@/lib/invoicing/stripe/preflight";
import { loadGlCodes, loadGlCodesLite } from "@/lib/invoicing/catalog-build";
import { loadInvoicingContext } from "@/lib/invoicing/gate-build";
import { suggestGlMap } from "@/lib/invoicing/gl-map";
import { formatDisplayNumber, formatQuoteNumber } from "@/lib/invoicing/numbering";
import { downloadLogoFile } from "@/lib/supabase-storage";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function InvoicingSettingsPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login" as Route);
  const { slug } = await params;
  const ctx = await loadInvoicingContext(slug, session.user.id);
  if (ctx.status === "not_allowed") notFound();

  const shell = (children: React.ReactNode) => (
    <AppShell userName={session.user?.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Invoicing settings</h1>
          <p className="text-sm text-muted-foreground">Numbering, business block, where payments are sent, and the account map.</p>
        </div>
        <InvoicingNav slug={slug} active="settings" />
        {children}
      </div>
    </AppShell>
  );

  if (ctx.status === "not_migrated") return shell(<NotMigratedNotice />);

  if (ctx.status === "needs_setup") {
    if (!ctx.owner.allowed) {
      return shell(
        <Card>
          <CardContent className="py-6 text-sm">
            Invoicing has not been set up yet. {ctx.owner.reason} Setup is done by the owner.
          </CardContent>
        </Card>
      );
    }
    const [glOptions, lite] = await Promise.all([loadGlCodes(ctx.entity.id), loadGlCodesLite(ctx.entity.id)]);
    return shell(
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Set up invoicing for {ctx.entity.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <SetupForm slug={slug} glOptions={glOptions} suggestedGlMap={suggestGlMap(lite)} suggestedPayee={ctx.entity.name} />
        </CardContent>
      </Card>
    );
  }

  const { profile, owner } = ctx;
  const [glOptions, pay] = await Promise.all([loadGlCodes(ctx.entity.id), loadPaySettings(ctx.entity.id)]);
  // Online payments (Phase 2): booleans and a mode word only, never an env value.
  const env = payEnvironment(process.env);
  const payEnv: OnlinePaymentsEnvView = {
    configured: env.configured,
    mode: env.mode,
    hasBaseUrl: env.baseUrl !== null,
    problem: !env.preflight.ok
      ? env.preflight.category === "mode_mismatch"
        ? STRIPE_MODE_MISMATCH_MESSAGE
        : STRIPE_NOT_CONFIGURED_MESSAGE
      : env.baseUrl === null
        ? payBaseUrlProblemMessage(env.baseUrlProblem ?? "app_url_missing")
        : null,
  };

  let logoSrc: string | null = null;
  if (profile.logoKey && profile.logoMime) {
    try {
      const bytes = await downloadLogoFile(profile.logoKey);
      logoSrc = `data:${profile.logoMime};base64,${bytes.toString("base64")}`;
    } catch {
      logoSrc = null; // a missing preview never breaks the page
    }
  }

  return shell(
    <>
      {!profile.setupComplete ? (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
          Invoices cannot be issued yet: {profile.setupMissing.join(" and ")} {profile.setupMissing.length === 1 ? "is" : "are"} not set.
        </div>
      ) : null}
      {!owner.allowed ? (
        <div className="rounded-md border px-4 py-3 text-sm text-muted-foreground">
          View only. {owner.reason} The settings below can be changed by the owner.
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <div>Invoicing started: {profile.goLiveOn}</div>
          <div>Next invoice number: {formatDisplayNumber(profile.invoicePrefix, profile.nextInvoiceNumber, profile.numberPad)}</div>
          <div>
            Next quote number: {formatQuoteNumber(profile.quotePrefix, profile.nextQuoteNumber, profile.numberPad)}{" "}
            <span className="text-xs text-muted-foreground">(quotes are not available yet; this only reserves their numbering)</span>
          </div>
          <div>Terms: {profile.termsLabel}</div>
          <div>Reply-to: {profile.replyToEmail ?? "not set"}</div>
          <div className="whitespace-pre-line sm:col-span-2">Business address: {profile.businessAddress ?? "not set"}</div>
          <div className="sm:col-span-2 text-xs text-muted-foreground">
            Reimbursable items are billed gross (an unconfirmed default): the cost stays an expense and the billed price is income. Sales tax is not
            calculated; the taxable flag is only stored.
          </div>
        </CardContent>
      </Card>

      {owner.allowed ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Business, terms and accounts</CardTitle>
            </CardHeader>
            <CardContent>
              <ProfileForm slug={slug} profile={profile} glOptions={glOptions} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Invoice numbering</CardTitle>
            </CardHeader>
            <CardContent>
              <CounterForm slug={slug} next={profile.nextInvoiceNumber} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Logo</CardTitle>
            </CardHeader>
            <CardContent>
              <LogoForm slug={slug} hasLogo={profile.logoKey !== null} previewSrc={logoSrc} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Where payments are sent</CardTitle>
            </CardHeader>
            <CardContent>
              <RemitForm slug={slug} profile={profile} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Online payments</CardTitle>
            </CardHeader>
            <CardContent>
              {pay.status === "ok" ? (
                <OnlinePaymentsForm slug={slug} enabled={pay.stripePayEnabled} ttlDays={pay.publicTokenTtlDays} env={payEnv} />
              ) : (
                <p className="text-sm text-muted-foreground">{PAY_FEATURE_NOT_SET_UP}</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Business EIN</CardTitle>
            </CardHeader>
            <CardContent>
              <EinForm slug={slug} last4={profile.einLast4} />
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Online payments</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {pay.status === "ok" ? `Online payments are ${pay.stripePayEnabled ? "on" : "off"}. Client links stay valid for ${pay.publicTokenTtlDays} days.` : PAY_FEATURE_NOT_SET_UP}
          </CardContent>
        </Card>
      )}
    </>
  );
}
