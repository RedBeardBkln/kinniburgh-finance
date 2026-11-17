import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SINGLE_SEGMENT_MAX,
  SMS_BRAND_PREFIX,
  STOP_FOOTER,
  TWILIO_BAD_CREDENTIALS_ERROR,
  TWILIO_ENV_VARS,
  TWILIO_NO_VALID_NUMBER_ERROR,
  TWILIO_OPTED_OUT_ERROR,
  TWILIO_UNREACHABLE_ERROR,
  createTwilioSmsSender,
  getTwilioConfig,
  isGsm7Basic,
  withStopFooter,
  type FetchFn,
  type TwilioConfig,
} from "@/lib/twilio-sms";
import { SMS_BODY_MAX, buildReviewSmsBody, getDeliveryChannel, getSmsSender, resolveDeliveryAddress } from "@/lib/sms-sender";

// No network: every fetch here is a fake. SIDs are built at runtime so no Twilio-shaped literal sits in the source.
const ACCOUNT = "AC" + "0".repeat(31) + "1";
const KEY_SID = "SK" + "0".repeat(31) + "2";
const SERVICE = "MG" + "0".repeat(31) + "3";
const SECRET = "s".repeat(12) + "ecretvalue99";
const CONFIG: TwilioConfig = { accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, messagingServiceSid: SERVICE };
const ENV = {
  REVIEW_DELIVERY: "twilio",
  TWILIO_ACCOUNT_SID: ACCOUNT,
  TWILIO_API_KEY_SID: KEY_SID,
  TWILIO_API_KEY_SECRET: SECRET,
  TWILIO_MESSAGING_SERVICE_SID: SERVICE,
};
const TO = "+12025550123";
const TOKEN = "T".repeat(43);
const BODY = `Eric has 3 transactions for you to tag: https://ericandeva.com/queue/${TOKEN}`;

afterEach(() => vi.restoreAllMocks());

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function spyConsole() {
  return [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "debug").mockImplementation(() => {}),
  ];
}

describe("getTwilioConfig (pre-flight)", () => {
  it("accepts a well-formed config (trimmed)", () => {
    const r = getTwilioConfig({ ...ENV, TWILIO_ACCOUNT_SID: `  ${ACCOUNT} ` });
    expect(r).toEqual({ ok: true, config: CONFIG });
  });

  it.each(TWILIO_ENV_VARS)("missing %s is refused, naming only that variable", (name) => {
    const r = getTwilioConfig({ ...ENV, [name]: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(name);
      for (const other of TWILIO_ENV_VARS) if (other !== name) expect(r.error).not.toContain(other);
      for (const v of [ACCOUNT, KEY_SID, SECRET, SERVICE]) expect(r.error).not.toContain(v);
    }
  });

  it.each([
    ["TWILIO_ACCOUNT_SID", "AC" + "z".repeat(32)],
    ["TWILIO_ACCOUNT_SID", "MG" + "0".repeat(32)],
    ["TWILIO_API_KEY_SID", "SK" + "0".repeat(31)],
    ["TWILIO_MESSAGING_SERVICE_SID", "MG" + "0".repeat(33)],
    ["TWILIO_API_KEY_SECRET", "short"],
    ["TWILIO_API_KEY_SECRET", "has a space in it 1234567"],
    ["TWILIO_API_KEY_SECRET", "x".repeat(129)],
  ])("malformed %s is refused without echoing the value", (name, value) => {
    const r = getTwilioConfig({ ...ENV, [name]: value });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(name);
      expect(r.error).not.toContain(value);
    }
  });

  it("names every bad variable", () => {
    const r = getTwilioConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) for (const n of TWILIO_ENV_VARS) expect(r.error).toContain(n);
  });
});

describe("Twilio sender request", () => {
  it("POSTs the form to the Messages endpoint with Basic auth", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(201, { sid: "SM" + "0".repeat(32), status: "accepted" }));
    const res = await createTwilioSmsSender(CONFIG, fetchFn).send(TO, BODY);
    expect(res).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages.json`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${KEY_SID}:${SECRET}`).toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(init.body));
    expect([...form.keys()].sort()).toEqual(["Body", "MessagingServiceSid", "To"]);
    expect(form.get("To")).toBe(TO);
    expect(form.get("MessagingServiceSid")).toBe(SERVICE);
    expect(form.get("Body")).toBe(SMS_BRAND_PREFIX + BODY + STOP_FOOTER);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a recipient that is not a US E.164 number without calling fetch", async () => {
    const fetchFn = vi.fn<FetchFn>();
    for (const to of ["2025550123", "+442079460123", "eva@example.test", ""]) {
      expect(await createTwilioSmsSender(CONFIG, fetchFn).send(to, BODY)).toEqual({ ok: false, error: TWILIO_NO_VALID_NUMBER_ERROR });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("Twilio sender errors", () => {
  const LEAKY = {
    message: `Attempt to send to unsubscribed recipient +12025550123 eva@example.test ${TOKEN} ${SECRET} https://www.twilio.com/docs/errors/x`,
    more_info: "https://www.twilio.com/docs/errors/21610",
    status: 400,
  };

  function assertNoLeak(error: string) {
    expect(error).not.toContain("2025550123");
    expect(error).not.toMatch(/http/i);
    expect(error).not.toContain(TOKEN);
    expect(error).not.toContain(SECRET);
    expect(error).not.toContain(KEY_SID);
    expect(error).not.toContain("@");
  }

  it("21610 is the opted-out message exactly", async () => {
    const res = await createTwilioSmsSender(CONFIG, async () => jsonResponse(400, { ...LEAKY, code: 21610 })).send(TO, BODY);
    expect(res).toEqual({ ok: false, error: TWILIO_OPTED_OUT_ERROR });
    expect(TWILIO_OPTED_OUT_ERROR).toBe("The recipient has opted out by replying STOP.");
  });

  it("maps known codes to fixed sentences and others to the code only", async () => {
    const cases: Array<[number, unknown, RegExp | string]> = [
      [401, { ...LEAKY, code: 20003 }, TWILIO_BAD_CREDENTIALS_ERROR],
      [400, { ...LEAKY, code: 21211 }, /21211/],
      [400, { ...LEAKY, code: 21614 }, /21614/],
      [400, { ...LEAKY, code: 30007 }, "Twilio refused the message (error 30007)."],
      [500, { ...LEAKY, code: "21610" }, "Twilio refused the message (status 500)."],
      [400, { ...LEAKY }, "Twilio refused the message (status 400)."],
      [400, { ...LEAKY, code: 1.5 }, "Twilio refused the message (status 400)."],
    ];
    for (const [status, body, expected] of cases) {
      const res = await createTwilioSmsSender(CONFIG, async () => jsonResponse(status, body)).send(TO, BODY);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        if (typeof expected === "string") expect(res.error).toBe(expected);
        else expect(res.error).toMatch(expected);
        assertNoLeak(res.error);
      }
    }
  });

  it("a non-JSON error body falls back to the status code", async () => {
    const res = await createTwilioSmsSender(CONFIG, async () => new Response(`oops ${TO} ${TOKEN}`, { status: 502 })).send(TO, BODY);
    expect(res).toEqual({ ok: false, error: "Twilio refused the message (status 502)." });
  });

  it("a thrown fetch or a timeout is the unreachable message", async () => {
    const thrown = await createTwilioSmsSender(CONFIG, async () => {
      throw new Error(`connect ECONNREFUSED https://api.twilio.com ${TO} ${SECRET}`);
    }).send(TO, BODY);
    expect(thrown).toEqual({ ok: false, error: TWILIO_UNREACHABLE_ERROR });
    const timeout = await createTwilioSmsSender(CONFIG, async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }).send(TO, BODY);
    expect(timeout).toEqual({ ok: false, error: TWILIO_UNREACHABLE_ERROR });
    const aborted = await createTwilioSmsSender(CONFIG, async () => {
      throw new DOMException("aborted", "AbortError");
    }).send(TO, BODY);
    expect(aborted).toEqual({ ok: false, error: TWILIO_UNREACHABLE_ERROR });
  });

  it("never calls console on any path", async () => {
    const spies = spyConsole();
    const fetches: FetchFn[] = [
      async () => jsonResponse(201, {}),
      async () => jsonResponse(400, { ...LEAKY, code: 21610 }),
      async () => new Response("x", { status: 500 }),
      async () => {
        throw new Error(`boom ${TO}`);
      },
    ];
    for (const f of fetches) await createTwilioSmsSender(CONFIG, f).send(TO, BODY);
    await createTwilioSmsSender(CONFIG, async () => jsonResponse(201, {})).send("bad", BODY);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("STOP footer", () => {
  it("is 23 characters", () => {
    expect(STOP_FOOTER).toBe(" Reply STOP to opt out.");
    expect(STOP_FOOTER.length).toBe(23);
  });

  it("is appended at 159 and 160 total, omitted at 161", () => {
    const at = (total: number) => "a".repeat(total - STOP_FOOTER.length);
    expect(withStopFooter(at(159))).toBe(at(159) + STOP_FOOTER);
    expect(withStopFooter(at(160))).toBe(at(160) + STOP_FOOTER);
    expect((at(160) + STOP_FOOTER).length).toBe(SINGLE_SEGMENT_MAX);
    expect(withStopFooter(at(161))).toBe(at(161));
  });

  it("is omitted for a non-GSM character or an extension-table character", () => {
    expect(withStopFooter("Zoë has transactions: x")).toBe("Zoë has transactions: x");
    expect(withStopFooter("Hi \u{1F600}")).toBe("Hi \u{1F600}");
    for (const ch of ["[", "]", "{", "}", "\\", "^", "~", "|", "€"]) {
      expect(withStopFooter(`a${ch}b`)).toBe(`a${ch}b`);
    }
    // Basic-table accented letters keep it.
    expect(isGsm7Basic("éèñü")).toBe(true);
    expect(withStopFooter("René x")).toBe("René x" + STOP_FOOTER);
  });

  it("fits the realistic hosts", () => {
    const vercel = buildReviewSmsBody({ kind: "reminder", url: `https://kinniburgh-finance.vercel.app/queue/${TOKEN}`, senderName: "Eric" });
    expect(withStopFooter(vercel)).toBe(vercel + STOP_FOOTER);
    expect((vercel + STOP_FOOTER).length).toBeLessThanOrEqual(160);
    const main = buildReviewSmsBody({ kind: "initial", url: `https://ericandeva.com/queue/${TOKEN}`, count: 99, senderName: "Eric" });
    expect(withStopFooter(main)).toBe(main + STOP_FOOTER);
  });

  it("leaves the 140 body cap of buildReviewSmsBody unchanged", () => {
    expect(SMS_BODY_MAX).toBe(140);
    const long = buildReviewSmsBody({ kind: "initial", url: `https://${"h".repeat(80)}.test/queue/${TOKEN}`, count: 5 });
    expect(long.startsWith("Transactions to tag:")).toBe(true);
  });
});

describe("channel selection", () => {
  it("getDeliveryChannel", () => {
    expect(getDeliveryChannel({})).toBe("email");
    expect(getDeliveryChannel({ REVIEW_DELIVERY: "" })).toBe("email");
    expect(getDeliveryChannel({ REVIEW_DELIVERY: "carrier-pigeon" })).toBe("email");
    expect(getDeliveryChannel({ REVIEW_DELIVERY: "sms" })).toBe("sms");
    expect(getDeliveryChannel({ REVIEW_DELIVERY: " TWILIO " })).toBe("twilio");
  });

  it("resolveDeliveryAddress never supplies a twilio recipient", () => {
    expect(resolveDeliveryAddress("eva@example.test", { REVIEW_DELIVERY: "twilio", EVA_SMS_GATEWAY_ADDRESS: "x@y.test" })).toBeNull();
  });

  it("a twilio channel with a bad config gives a sender that fails without any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const sender = getSmsSender({ ...ENV, TWILIO_API_KEY_SECRET: "" });
    const res = await sender.send(TO, BODY);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("TWILIO_API_KEY_SECRET");
      expect(res.error).not.toContain(ACCOUNT);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a twilio channel with a good config sends through fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, {}));
    const res = await getSmsSender(ENV).send(TO, BODY);
    expect(res).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(ACCOUNT);
  });
});
