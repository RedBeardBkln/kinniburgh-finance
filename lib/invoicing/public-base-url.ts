// INVOICE_PUBLIC_BASE_URL: the optional public origin of the client's invoice links (e.g. a separate pay domain). PURE and edge-safe:
// no imports, no env reads, no Node APIs (middleware.ts imports it as well as lib/invoicing/stripe/pay-env.ts). Never logs or returns
// anything but the parsed origin / host.

/** The optional variable that holds the public origin of client links (name only; the value is never shown or logged). */
export const INVOICE_PUBLIC_BASE_URL_VAR = "INVOICE_PUBLIC_BASE_URL";

export type PublicBaseUrlMode = "test" | "live" | null;

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

// scheme://host[:port] with an optional single trailing "/": no credentials (@), path, query (?), fragment (#), backslash or whitespace.
const ORIGIN_SHAPE = /^https?:\/\/[^\s/?#@\\]+\/?$/;

/**
 * Validates INVOICE_PUBLIC_BASE_URL. Leading and trailing whitespace is trimmed (as `resolveAppBaseUrl` does for NEXTAUTH_URL); the
 * rest must be an absolute origin only: https always, except a localhost host (http or https), which is accepted ONLY in Stripe test
 * mode. Returns the origin without a trailing slash (the host as the URL parser normalises it: lower case, default port dropped), or
 * null when invalid.
 */
export function parseInvoicePublicBaseUrl(raw: string, mode: PublicBaseUrlMode): string | null {
  const value = raw.trim();
  if (!ORIGIN_SHAPE.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") return null;
  if (url.hostname === "") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const local = isLocalHost(url.hostname);
  if (local && mode !== "test") return null;
  if (url.protocol === "http:" && !local) return null;
  return url.origin;
}

/**
 * The host (lower case, with a non-default port) that only serves invoice pages, or null when INVOICE_PUBLIC_BASE_URL is unset or
 * invalid (then no host is restricted). `stripeModeRaw` is STRIPE_MODE as set ("test" | "live"; anything else counts as unset).
 */
export function invoicePayHost(raw: string | undefined, stripeModeRaw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const mode: PublicBaseUrlMode = stripeModeRaw === "test" || stripeModeRaw === "live" ? stripeModeRaw : null;
  const origin = parseInvoicePublicBaseUrl(raw, mode);
  return origin ? new URL(origin).host : null;
}

/**
 * What the pay host may serve (everything else there is a plain 404): the client's invoice link pages /i and /i/... (the page, its
 * PDF, /i/paid, /i/cancelled and the server-action POSTs those pages make to their own path), plus the two icon routes the root layout
 * links (/api/favicon, /api/logo; already public on every host). The framework and static assets the /i pages load (/_next/static/**,
 * /favicon.ico, /favicon-96x96.png, /favicon.svg, /apple-touch-icon.png, /manifest.webmanifest and its icons) never reach the
 * middleware (its matcher excludes them), so they are served on every host as before.
 */
export function isPayHostPath(pathname: string): boolean {
  if (pathname === "/i" || pathname.startsWith("/i/")) return true;
  return pathname === "/api/favicon" || pathname === "/api/logo";
}
