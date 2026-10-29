import { describe, it, expect } from "vitest";
import {
  rowAnchorId,
  sanitizeListQuery,
  transactionDetailHref,
  transactionIdFromHash,
  transactionsReturnHref,
} from "@/lib/transactions-return-link";

const ID = "3f6c2a1e-9b7d-4c1a-8e2f-0a1b2c3d4e5f";

describe("transactions return link", () => {
  it("keeps only the list's known, non-empty keys in a fixed order", () => {
    expect(sanitizeListQuery("tab=all&evil=1&bucket=personal&search=&page=3")).toBe("bucket=personal&tab=all&page=3");
    expect(sanitizeListQuery({ bucket: "personal", tab: "review", page: "1", search: undefined })).toBe(
      "bucket=personal&tab=review&page=1"
    );
    expect(sanitizeListQuery(`search=${"x".repeat(201)}&bucket=personal`)).toBe("bucket=personal");
  });

  it("round-trips the list query through the detail link and back to the row", () => {
    const listQuery = "bucket=sudden-valley&tab=all&page=2&search=home depot&sort=amount&sortDir=asc";
    const detail = transactionDetailHref(ID, listQuery);
    expect(detail.startsWith(`/transactions/${ID}?from=`)).toBe(true);
    const from = new URL(detail, "https://x.test").searchParams.get("from");
    const back = transactionsReturnHref(ID, from);
    expect(back).toBe(
      `/transactions?bucket=sudden-valley&tab=all&page=2&search=home+depot&sort=amount&sortDir=asc#tx-${ID}`
    );
    expect(transactionIdFromHash(new URL(back, "https://x.test").hash)).toBe(ID);
  });

  it("without a list query, links to the plain list with no anchor", () => {
    expect(transactionDetailHref(ID, "")).toBe(`/transactions/${ID}`);
    expect(transactionsReturnHref(ID, undefined)).toBe("/transactions");
    expect(transactionsReturnHref(ID, "junk=1")).toBe("/transactions");
  });

  it("cannot be turned into a link off the list", () => {
    expect(transactionsReturnHref(ID, "https://evil.test/?bucket=personal")).toBe("/transactions");
    expect(transactionsReturnHref(ID, "//evil.test")).toBe("/transactions");
    expect(transactionsReturnHref(ID, "bucket=personal&tab=all#x")).toBe(`/transactions?bucket=personal&tab=all%23x#tx-${ID}`);
  });

  it("parses only well-formed row anchors", () => {
    expect(rowAnchorId(ID)).toBe(`tx-${ID}`);
    expect(transactionIdFromHash(`#tx-${ID}`)).toBe(ID);
    expect(transactionIdFromHash("#upcoming")).toBeNull();
    expect(transactionIdFromHash("#tx-<script>")).toBeNull();
    expect(transactionIdFromHash("")).toBeNull();
  });
});
