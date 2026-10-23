import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { invoicePayHost, isPayHostPath } from "@/lib/invoicing/public-base-url";

// "/queue" is the Assign-to-Eva magic-link page (/queue/[token]). It is NOT
// session-gated here: the middleware only checks cookie presence anyway, and the
// real gate is per-request token validation in app/queue/[token]/page.tsx and in
// every export of actions/review-queue.ts. Keep this entry exactly "/queue" -
// the prefix match below then covers only /queue and /queue/... and nothing else.
//
// "/i" is the EK Consulting client's invoice link (/i/[token], its PDF, and the static /i/paid and
// /i/cancelled pages) and "/api/stripe/webhook" is the Stripe webhook. Same rule: the gate is NOT
// here. The link page, its PDF route and every export of actions/public-invoice.ts validate the
// token on each request; the webhook verifies the Stripe signature on the raw body before anything
// else. Keep these entries exact: "/i" covers only /i and /i/... (not /invoices, /income or
// /insurance), and "/api/stripe/webhook" covers nothing else under /api/stripe.
const PUBLIC_PATHS = ["/login", "/forgot-password", "/reset-password", "/privacy", "/offline", "/queue", "/api/logo", "/api/favicon", "/api/cron", "/i", "/api/stripe/webhook"];

// The pay domain (INVOICE_PUBLIC_BASE_URL, e.g. a separate host for client invoice links) serves ONLY the invoice pages: on that host
// every path outside isPayHostPath() is a plain 404 (no redirect, no login page, nothing naming the main app's host). This branch only
// ever NARROWS what is served: an allowed path continues into the normal rules below unchanged (so the session gate still applies to
// anything that is not public). Unset or invalid variable = no host is restricted. Every other host behaves exactly as before (the main
// app still serves /i, so links already sent keep working).
function payHostNotFound(): NextResponse {
  return new NextResponse("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const payHost = invoicePayHost(process.env.INVOICE_PUBLIC_BASE_URL, process.env.STRIPE_MODE);
  if (payHost !== null && req.nextUrl.host.toLowerCase() === payHost && !isPayHostPath(pathname)) {
    return payHostNotFound();
  }

  // NextAuth's own routes (/api/auth/**) were excluded from the matcher before the pay-domain rule existed; they now run through the
  // middleware only so the pay host can 404 them. On every other host they pass untouched, exactly as before (never the login gate).
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  const session =
    req.cookies.get("authjs.session-token") ??
    req.cookies.get("__Secure-authjs.session-token");
  const isLoggedIn = !!session;

  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );

  if (isPublic) {
    if (isLoggedIn && pathname === "/login") {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  if (!isLoggedIn) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|favicon\\.svg|favicon-96x96\\.png|icon\\.svg|icon-192\\.png|icon-512\\.png|icon\\.png|apple-touch-icon\\.png|apple-icon\\.png|web-app-manifest-192x192\\.png|web-app-manifest-512x512\\.png|manifest\\.webmanifest).*)",
  ],
};
