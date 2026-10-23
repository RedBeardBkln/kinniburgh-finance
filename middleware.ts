import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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

export function middleware(req: NextRequest) {
  const session =
    req.cookies.get("authjs.session-token") ??
    req.cookies.get("__Secure-authjs.session-token");
  const isLoggedIn = !!session;
  const { pathname } = req.nextUrl;

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
    "/((?!_next/static|_next/image|favicon\\.ico|favicon\\.svg|favicon-96x96\\.png|icon\\.svg|icon-192\\.png|icon-512\\.png|icon\\.png|apple-touch-icon\\.png|apple-icon\\.png|web-app-manifest-192x192\\.png|web-app-manifest-512x512\\.png|manifest\\.webmanifest|api/auth).*)",
  ],
};
