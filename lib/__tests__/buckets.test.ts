import { describe, it, expect } from "vitest";
import { bucketPathFor, inferBucketFromPathname } from "@/lib/buckets";

describe("bucketPathFor", () => {
  describe("bucket-scoped core pages keep the same page", () => {
    it.each([
      "/",
      "/transactions",
      "/transactions/abc-123",
      "/transactions/new",
      "/transactions/import",
      "/budgets",
      "/forecast",
      "/accounts",
      "/accounts/connect",
      "/receipts",
      "/receipts/xyz",
      "/receipts/upload",
    ])("%s → same page", (pathname) => {
      expect(bucketPathFor(pathname, "ek-consulting")).toBe(pathname);
      expect(bucketPathFor(pathname, "sudden-valley")).toBe(pathname);
      expect(bucketPathFor(pathname, "personal")).toBe(pathname);
    });
  });

  describe("business sub-pages swap the slug", () => {
    it.each(["revenue", "pl", "gl", "mileage", "vendors", "cash-flow", "balance-sheet"])(
      "/business/ek-consulting/%s → /business/sudden-valley/%s",
      (sub) => {
        expect(bucketPathFor(`/business/ek-consulting/${sub}`, "sudden-valley")).toBe(
          `/business/sudden-valley/${sub}`
        );
        expect(bucketPathFor(`/business/sudden-valley/${sub}`, "mezzo")).toBe(
          `/business/mezzo/${sub}`
        );
      }
    );

    it("business sub-page → personal lands on the dashboard", () => {
      expect(bucketPathFor("/business/ek-consulting/revenue", "personal")).toBe("/");
    });
  });

  describe("personal-only pages map to business equivalents", () => {
    it("income → business revenue", () => {
      expect(bucketPathFor("/personal/income", "ek-consulting")).toBe(
        "/business/ek-consulting/revenue"
      );
      expect(bucketPathFor("/personal/income", "sudden-valley")).toBe(
        "/business/sudden-valley/revenue"
      );
    });

    it("debt-free works for any bucket (entity-scoped)", () => {
      expect(bucketPathFor("/personal/debt-free", "ek-consulting")).toBe("/personal/debt-free");
    });

    it("personal page from personal bucket stays put", () => {
      expect(bucketPathFor("/personal/mortgage", "personal")).toBe("/personal/mortgage");
    });

    it("unmapped personal page from a business bucket → dashboard", () => {
      expect(bucketPathFor("/personal/mortgage", "ek-consulting")).toBe("/");
      expect(bucketPathFor("/personal/retirement", "mezzo")).toBe("/");
    });
  });

  describe("envelope is limited to personal / sudden-valley (entity targets)", () => {
    // Note: "taxes" was previously included in ENVELOPE_BUCKETS/this check, but
    // targetBucket === "taxes" is now handled unconditionally by the
    // "switching to taxes/projects" block above (any non-/tax* pathname → "/tax"),
    // which takes priority — see that block for the taxes case.
    it("keeps envelope when the target bucket supports it", () => {
      expect(bucketPathFor("/envelope", "sudden-valley")).toBe("/envelope");
      expect(bucketPathFor("/envelope", "personal")).toBe("/envelope");
    });

    it("falls back to dashboard for buckets without envelopes", () => {
      expect(bucketPathFor("/envelope", "ek-consulting")).toBe("/");
      expect(bucketPathFor("/envelope", "mezzo")).toBe("/");
    });
  });

  describe("switching away from tax/projects lands on the dashboard", () => {
    it.each(["/tax", "/tax/some-workspace", "/projects", "/projects/abc"])(
      "%s → / for any entity bucket",
      (pathname) => {
        expect(bucketPathFor(pathname, "ek-consulting")).toBe("/");
        expect(bucketPathFor(pathname, "sudden-valley")).toBe("/");
        expect(bucketPathFor(pathname, "personal")).toBe("/");
      }
    );
  });

  describe("switching to taxes/projects", () => {
    it.each(["/", "/transactions", "/business/ek-consulting/revenue", "/personal/mortgage"])(
      "%s → /tax when targeting taxes",
      (pathname) => {
        expect(bucketPathFor(pathname, "taxes")).toBe("/tax");
      }
    );

    it.each(["/", "/transactions", "/business/ek-consulting/revenue", "/personal/mortgage"])(
      "%s → /projects when targeting projects",
      (pathname) => {
        expect(bucketPathFor(pathname, "projects")).toBe("/projects");
      }
    );

    it.each(["/tax", "/tax/some-workspace"])(
      "%s stays the same when already targeting taxes",
      (pathname) => {
        expect(bucketPathFor(pathname, "taxes")).toBe(pathname);
      }
    );

    it.each(["/projects", "/projects/abc"])(
      "%s stays the same when already targeting projects",
      (pathname) => {
        expect(bucketPathFor(pathname, "projects")).toBe(pathname);
      }
    );
  });

  describe("unrecognized routes fall back to the dashboard", () => {
    it.each(["/settings", "/tags", "/tag-rules", "/vault", "/notifications", "/advisor", "/documents"])(
      "%s → /",
      (pathname) => {
        expect(bucketPathFor(pathname, "ek-consulting")).toBe("/");
        expect(bucketPathFor(pathname, "personal")).toBe("/");
      }
    );
  });
});

describe("inferBucketFromPathname", () => {
  it.each([
    ["/tax", "taxes"],
    ["/tax/foo", "taxes"],
    ["/projects", "projects"],
    ["/projects/foo", "projects"],
    ["/business/sudden-valley/revenue", "sudden-valley"],
  ] as const)("%s → %s", (pathname, expected) => {
    expect(inferBucketFromPathname(pathname)).toBe(expected);
  });

  it("/business/ (no slug) → \"\" (split(\"/\")[2] on a trailing slash is an empty string, not undefined)", () => {
    expect(inferBucketFromPathname("/business/")).toBe("");
  });

  it.each(["/", "/transactions"])("%s → null", (pathname) => {
    expect(inferBucketFromPathname(pathname)).toBeNull();
  });
});