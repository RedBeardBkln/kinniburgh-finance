import { describe, it, expect } from "vitest";
import { bucketPathFor } from "@/lib/buckets";

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

  describe("envelope is limited to personal / sudden-valley / taxes", () => {
    it("keeps envelope when the target bucket supports it", () => {
      expect(bucketPathFor("/envelope", "sudden-valley")).toBe("/envelope");
      expect(bucketPathFor("/envelope", "personal")).toBe("/envelope");
      expect(bucketPathFor("/envelope", "taxes")).toBe("/envelope");
    });

    it("falls back to dashboard for buckets without envelopes", () => {
      expect(bucketPathFor("/envelope", "ek-consulting")).toBe("/");
      expect(bucketPathFor("/envelope", "mezzo")).toBe("/");
    });
  });

  describe("tax and projects are aggregate views — unchanged", () => {
    it.each(["/tax", "/tax/some-workspace", "/projects", "/projects/abc"])(
      "%s stays the same for any bucket",
      (pathname) => {
        expect(bucketPathFor(pathname, "ek-consulting")).toBe(pathname);
        expect(bucketPathFor(pathname, "personal")).toBe(pathname);
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