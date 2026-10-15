import { beforeEach, describe, expect, it, vi } from "vitest";

const linkTokenCreate = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/db", () => ({
  db: { plaidItem: { findUnique: async () => ({ accessTokenEncrypted: "enc" }) } },
}));
vi.mock("@/lib/encrypt", () => ({ decrypt: () => "access-token" }));
vi.mock("@/lib/plaid", () => ({ getPlaidClient: () => ({ linkTokenCreate }) }));

import { GET } from "@/app/api/plaid/link-token/route";

const req = (qs = "") => new Request(`https://example.com/api/plaid/link-token${qs}`, { headers: { host: "example.com" } });
const ok = (token: string) => ({ data: { link_token: token } });

describe("link token: Liabilities consent", () => {
  beforeEach(() => linkTokenCreate.mockReset());

  it("re-link (update mode) asks for Liabilities consent and does not send `products`", async () => {
    linkTokenCreate.mockResolvedValueOnce(ok("tok-1"));
    const res = await GET(req("?itemId=item1"));
    expect(await res.json()).toEqual({ linkToken: "tok-1" });
    const arg = linkTokenCreate.mock.calls[0]![0];
    expect(arg.access_token).toBe("access-token");
    expect(arg.additional_consented_products).toEqual(["liabilities"]);
    expect(arg.products).toBeUndefined();
  });

  it("falls back to a plain update-mode token when the extra consent is refused", async () => {
    linkTokenCreate
      .mockRejectedValueOnce({ response: { status: 400, data: { error_code: "INVALID_FIELD", error_message: "nope" } } })
      .mockResolvedValueOnce(ok("tok-2"));
    const res = await GET(req("?itemId=item1"));
    expect(await res.json()).toEqual({ linkToken: "tok-2" });
    const second = linkTokenCreate.mock.calls[1]![0];
    expect(second.additional_consented_products).toBeUndefined();
    expect(second.access_token).toBe("access-token");
  });

  it("a new connection still requests Transactions + Liabilities as products", async () => {
    linkTokenCreate.mockResolvedValueOnce(ok("tok-3"));
    await GET(req());
    const arg = linkTokenCreate.mock.calls[0]![0];
    expect(arg.products).toEqual(["transactions", "liabilities"]);
    expect(arg.additional_consented_products).toBeUndefined();
  });
});
