import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  typedRoutes: true,
  serverExternalPackages: ["@anthropic-ai/sdk", "@prisma/client", "prisma"],
  // The PDF routes read the blank IRS/CT forms (and their manifest) from disk at run
  // time via process.cwd(); the file tracer cannot see those dynamic paths, so ship
  // data/forms explicitly. The key is a picomatch glob over route paths, so the
  // dynamic segments ([year], [form]) are covered by "**" rather than spelled out.
  outputFileTracingIncludes: {
    "/api/tax/forms/**": ["./data/forms/**/*"],
    // The Final review page hosts server actions that read the blank forms (the packet is built and read back) and, for the AI review
    // passes, the pinned source pack (data/tax-sources: IRS / Connecticut instruction text, manifest, topics). Same reason: dynamic paths.
    "/tax/forms/**": ["./data/forms/**/*", "./data/tax-sources/**/*"],
    // The advisor chat route reads the TY2025 review state, which builds its link context from the blank forms (failure only costs the links).
    "/api/advisor/**": ["./data/forms/**/*"],
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), payment=()",
        },
        { key: "X-XSS-Protection", value: "1; mode=block" },
      ],
    },
    {
      // The magic-link page carries its token in the URL path: never leak it
      // through the Referer header. Listed AFTER the catch-all above so this
      // value overrides that one for /queue/* (Next applies matching header
      // rules in order, last wins per key).
      source: "/queue/:path*",
      headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
    },
  ],
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  telemetry: false,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
});
