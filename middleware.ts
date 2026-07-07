import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/forgot-password", "/reset-password", "/privacy", "/api/logo", "/api/favicon"];

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
    "/((?!_next/static|_next/image|favicon\\.ico|favicon\\.svg|icon\\.svg|icon-192\\.png|icon-512\\.png|icon\\.png|apple-touch-icon\\.png|apple-icon\\.png|manifest\\.webmanifest|api/auth).*)",
  ],
};
