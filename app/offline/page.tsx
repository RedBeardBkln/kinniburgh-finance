export const metadata = {
  title: "You're Offline — Banana Stand",
};

/**
 * Static offline fallback page, served by the service worker (public/sw.js)
 * when a navigation request fails due to no network connection.
 *
 * Deliberately styled with inline `style` attributes instead of Tailwind
 * utility classNames: the service worker only precaches this page's HTML
 * document, not any CSS chunk (Tailwind's compiled stylesheet lives at a
 * build-hash-named URL that changes every deploy). Inline styles have no
 * dependency on any hashed build asset, so this page always renders
 * correctly styled from cache no matter how stale it is relative to the
 * current deploy.
 *
 * No data fetching, no `db`/`requireAuth`/`cookies()`/`headers()` calls —
 * must remain eligible for Next's static prerendering so the service
 * worker can precache a single, stable HTML response.
 */
export default function OfflinePage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "24px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        backgroundColor: "#fffbeb",
        color: "#1c1917",
      }}
    >
      <svg
        width="56"
        height="56"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#d97706"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ marginBottom: "16px" }}
      >
        <path d="M1 1l22 22" />
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
        <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>

      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 8px" }}>
        You&apos;re offline
      </h1>

      <p
        style={{
          fontSize: "15px",
          lineHeight: 1.5,
          maxWidth: "360px",
          margin: "0 0 24px",
          color: "#57534e",
        }}
      >
        Banana Stand needs a network connection to load your data. Nothing
        shown here reflects your current accounts or balances — reconnect and
        try again.
      </p>

      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberately a
          plain anchor, not next/link's Link: this forces a full navigation on every
          click, which the service worker's fetch handler can either let through (if
          back online) or re-serve from cache (if still offline). Link's client-side
          RSC navigation would not trigger the same fetch-and-catch behavior. */}
      <a
        href="/"
        style={{
          display: "inline-block",
          padding: "10px 20px",
          borderRadius: "6px",
          backgroundColor: "#d97706",
          color: "#fffbeb",
          fontSize: "14px",
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        Try again
      </a>
    </div>
  );
}
