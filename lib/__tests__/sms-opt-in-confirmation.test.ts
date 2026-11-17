import { describe, expect, it, vi } from "vitest";
import { SMS_OPT_IN_CONFIRMATION_TEXT } from "@/lib/sms-consent-text";
import {
  OPT_IN_CONFIRMATION_NOT_CONFIGURED,
  OPT_IN_CONFIRMATION_SENT,
  describeOptInConfirmation,
  sendOptInConfirmation,
} from "@/lib/sms-opt-in-confirmation";
import { SINGLE_SEGMENT_MAX, TWILIO_OPTED_OUT_ERROR, isGsm7Basic } from "@/lib/twilio-sms";

const ENV = {
  TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
  TWILIO_API_KEY_SID: "SK" + "1".repeat(32),
  TWILIO_API_KEY_SECRET: "fake-secret-value-for-tests-only",
  TWILIO_MESSAGING_SERVICE_SID: "MG" + "2".repeat(32),
};
const TO = "+12025550123";

describe("opt-in confirmation wording", () => {
  it("is the exact approved text, one GSM-7 segment, with brand, frequency, rates, HELP and STOP", () => {
    expect(SMS_OPT_IN_CONFIRMATION_TEXT).toBe(
      "Banana Stand: You're signed up for review alerts. Msg freq varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out."
    );
    expect(SMS_OPT_IN_CONFIRMATION_TEXT.length).toBeLessThanOrEqual(SINGLE_SEGMENT_MAX);
    expect(isGsm7Basic(SMS_OPT_IN_CONFIRMATION_TEXT)).toBe(true);
  });
});

describe("sendOptInConfirmation", () => {
  it("sends the text as-is (no second brand prefix, no extra footer)", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 201 }));
    const res = await sendOptInConfirmation(TO, { env: ENV, fetchFn });
    expect(res).toEqual({ status: "sent" });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const form = new URLSearchParams(String(init.body));
    expect(form.get("Body")).toBe(SMS_OPT_IN_CONFIRMATION_TEXT);
    expect(form.get("To")).toBe(TO);
  });

  it("does nothing on the network when Twilio is not configured", async () => {
    const fetchFn = vi.fn();
    expect(await sendOptInConfirmation(TO, { env: {}, fetchFn })).toEqual({ status: "not_configured" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps a Twilio refusal to a fixed sentence and never throws", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ code: 21610, message: `blocked ${TO}` }), { status: 400 }));
    expect(await sendOptInConfirmation(TO, { env: ENV, fetchFn })).toEqual({ status: "failed", error: TWILIO_OPTED_OUT_ERROR });
    const boom = vi.fn(async () => {
      throw new Error(`network down for ${TO}`);
    });
    const res = await sendOptInConfirmation(TO, { env: ENV, fetchFn: boom });
    expect(res.status).toBe("failed");
    expect(JSON.stringify(res)).not.toContain("0123");
  });

  it("describes each outcome", () => {
    expect(describeOptInConfirmation({ status: "sent" })).toBe(OPT_IN_CONFIRMATION_SENT);
    expect(describeOptInConfirmation({ status: "not_configured" })).toBe(OPT_IN_CONFIRMATION_NOT_CONFIGURED);
    expect(describeOptInConfirmation({ status: "failed", error: "X." })).toBe("The confirmation text could not be sent: X.");
  });
});
