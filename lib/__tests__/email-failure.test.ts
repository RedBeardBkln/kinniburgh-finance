import { describe, expect, it } from "vitest";
import { emailFailureCode } from "@/lib/email-failure";

describe("emailFailureCode", () => {
  it("returns Resend's short code and status, never the message", () => {
    const err = Object.assign(new Error("Email failed: bad address someone@example.test"), { providerCode: "validation_error", statusCode: 422 });
    expect(emailFailureCode(err)).toBe("validation_error 422");
    expect(emailFailureCode(err)).not.toContain("@");
  });
  it("falls back to the error name", () => {
    expect(emailFailureCode(new Error("Email failed: x@y.test"))).toBe("Error");
    expect(emailFailureCode(Object.assign(new Error("m"), { providerCode: "application_error", statusCode: null }))).toBe("application_error");
    expect(emailFailureCode("nope")).toBe("UnknownError");
  });
});
