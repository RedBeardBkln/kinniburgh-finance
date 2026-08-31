import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { analyzeCardFunding, buildFundingMessage, type CardDue } from "@/lib/cc-funding";

function d(iso: string) {
  return new Date(iso + "T00:00:00Z");
}
function dec(n: string | number) {
  return new Decimal(String(n));
}

function makeCard(nickname: string, dueIso: string, balance: string): CardDue {
  return {
    accountNickname: nickname,
    dueDate: d(dueIso),
    statementBalance: dec(balance),
    minimumPayment: null,
  };
}

// 2026-09-01 is the forecast start throughout
const FROM = d("2026-09-01");
const TO = d("2026-10-01");

describe("analyzeCardFunding", () => {
  it("covered: enough funds for all payments plus the minimum", () => {
    const result = analyzeCardFunding({
      currentBalance: dec(2000),
      minimumBalance: dec(250),
      cards: [makeCard("Capital One card", "2026-09-15", "800")],
      from: FROM,
      to: TO,
    });
    expect(result.status).toBe("covered");
    expect(result.totalDue.toString()).toBe("800");
    expect(result.shortfall).toBeNull();
  });

  it("shortfall: payment dips the account below the minimum", () => {
    const result = analyzeCardFunding({
      currentBalance: dec(400), // the owner's example
      minimumBalance: dec(250),
      cards: [makeCard("Barclay card", "2026-09-04", "500")],
      from: FROM,
      to: TO,
    });
    expect(result.status).toBe("shortfall");
    // 400 - 500 = -100; needs 350 to restore 250
    expect(result.shortfall!.toString()).toBe("350");
    expect(result.firstShortfallDate?.toISOString()).toBe(d("2026-09-04").toISOString());
  });

  it("at_risk: covered but under the $50 cushion", () => {
    const result = analyzeCardFunding({
      currentBalance: dec(1000),
      minimumBalance: dec(250),
      cards: [makeCard("JetBlue card", "2026-09-10", "750")],
      from: FROM,
      to: TO,
    });
    // 1000 - 750 = 250 exactly → worst-day minus min = 0 < 50
    expect(result.status).toBe("at_risk");
    expect(result.shortfall).toBeNull();
  });

  it("handles multiple cards on the same due date", () => {
    const result = analyzeCardFunding({
      currentBalance: dec(1200),
      minimumBalance: dec(250),
      cards: [
        makeCard("Capital One card", "2026-09-20", "400"),
        makeCard("Barclay card", "2026-09-20", "350"),
      ],
      from: FROM,
      to: TO,
    });
    expect(result.totalDue.toString()).toBe("750");
    // 1200 - 750 = 450 >= 250, cushion 200 → covered
    expect(result.status).toBe("covered");
    const day = result.daily.find((x) => x.date.toISOString().startsWith("2026-09-20"));
    expect(day!.paymentsThatDay).toHaveLength(2);
  });

  it("uses the worst shortfall day when payments span dates", () => {
    const result = analyzeCardFunding({
      currentBalance: dec(900),
      minimumBalance: dec(250),
      cards: [
        makeCard("Capital One card", "2026-09-05", "500"),
        makeCard("Barclay card", "2026-09-25", "400"),
      ],
      from: FROM,
      to: TO,
    });
    // After first: 900-500=400 (ok). After second: 400-400=0 < 250 → shortfall 250 on the 25th
    expect(result.status).toBe("shortfall");
    expect(result.shortfall!.toString()).toBe("250");
    expect(result.firstShortfallDate?.toISOString()).toBe(d("2026-09-25").toISOString());
  });

  it("ignores cards outside the horizon in daily projection but includes them in list input only if caller filters — caller's job", () => {
    const result = analyzeCardFunding({
      currentBalance: dec(500),
      minimumBalance: dec(250),
      cards: [makeCard("Capital One card", "2026-09-10", "100")],
      from: d("2026-10-01"), // horizon excludes the due date
      to: d("2026-11-01"),
    });
    // totalDue still counts the card, but no payment applies within the window
    expect(result.totalDue.toString()).toBe("100");
    expect(result.status).toBe("covered");
  });

  it("no minimum balance rule → shortfall only below zero", () => {
    const result = analyzeCardFunding({
      currentBalance: dec(400),
      minimumBalance: null,
      cards: [makeCard("Barclay card", "2026-09-04", "500")],
      from: FROM,
      to: TO,
    });
    // 400 - 500 = -100 < 0 → shortfall 100 even without a minimum
    expect(result.status).toBe("shortfall");
    expect(result.shortfall!.toString()).toBe("100");
  });
});

describe("buildFundingMessage", () => {
  it("builds the owner's example message format", () => {
    const result = analyzeCardFunding({
      currentBalance: dec(400),
      minimumBalance: dec(250),
      cards: [makeCard("Barclay card", "2026-09-04", "500")],
      from: FROM,
      to: TO,
    });
    const { title, body } = buildFundingMessage({
      fundingAccountNickname: "Credit Cards",
      currentBalance: dec(400),
      minimumBalance: dec(250),
      minimumBalanceFee: dec(15),
      result,
    });
    expect(title).toContain("Credit Cards");
    expect(body).toContain("current balance of $400.00");
    expect(body).toContain("Barclay card");
    expect(body).toContain("$500.00");
    expect(body).toContain("September 4");
    expect(body).toContain("transfer $350.00");
    expect(body).toContain("$15.00 monthly low balance fee");
  });

  it("covered messages state the account remains above the minimum", () => {
    const result = analyzeCardFunding({
      currentBalance: dec(2000),
      minimumBalance: dec(250),
      cards: [makeCard("Capital One card", "2026-09-15", "800")],
      from: FROM,
      to: TO,
    });
    const { body } = buildFundingMessage({
      fundingAccountNickname: "Credit Cards",
      currentBalance: dec(2000),
      minimumBalance: dec(250),
      minimumBalanceFee: dec(15),
      result,
    });
    expect(body).toContain("remain above the minimum balance");
  });

  it("at_risk messages mention the tight cushion", () => {
    const result = analyzeCardFunding({
      currentBalance: dec(1000),
      minimumBalance: dec(250),
      cards: [makeCard("JetBlue card", "2026-09-10", "750")],
      from: FROM,
      to: TO,
    });
    const { body } = buildFundingMessage({
      fundingAccountNickname: "Credit Cards",
      currentBalance: dec(1000),
      minimumBalance: dec(250),
      minimumBalanceFee: dec(15),
      result,
    });
    expect(body).toContain("less than $50 of cushion");
  });
});