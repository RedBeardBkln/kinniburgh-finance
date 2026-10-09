import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { analyzeCardFunding, buildFundingMessage, shortfallIncludesEstimate, type CardDue } from "@/lib/cc-funding";

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
describe("analyzeCardFunding: estimates and the account's other scheduled flows", () => {
  const estimated = (nickname: string, dueIso: string, balance: string, confidence: "high" | "medium" | "low" = "high"): CardDue => ({
    accountNickname: nickname,
    dueDate: d(dueIso),
    statementBalance: dec(balance),
    estimate: { confidence, why: "based on this cycle's charges so far" },
  });

  it("reports the estimated part of the total separately (zero when nothing is estimated)", () => {
    const none = analyzeCardFunding({ currentBalance: dec(2000), minimumBalance: dec(250), cards: [makeCard("A", "2026-09-10", "100")], from: FROM, to: TO });
    expect(none.estimatedTotalDue.toString()).toBe("0");
    const some = analyzeCardFunding({
      currentBalance: dec(5000),
      minimumBalance: dec(250),
      cards: [makeCard("A", "2026-09-10", "100"), estimated("Barclay", "2026-09-20", "2914.91")],
      from: FROM,
      to: TO,
    });
    expect(some.totalDue.toFixed(2)).toBe("3014.91");
    expect(some.estimatedTotalDue.toFixed(2)).toBe("2914.91");
  });

  it("scheduled flows into the account are applied, so a planned transfer is not reported as a shortfall", () => {
    const args = {
      currentBalance: dec(500),
      minimumBalance: dec(250),
      cards: [estimated("Barclay", "2026-09-20", "2914.91")],
      from: FROM,
      to: TO,
    };
    expect(analyzeCardFunding(args).status).toBe("shortfall");
    const covered = analyzeCardFunding({ ...args, otherFlows: [{ date: d("2026-09-15"), amount: dec(3000) }] });
    expect(covered.status).toBe("covered");
    // a flow after the payment day does not help that day
    const late = analyzeCardFunding({ ...args, otherFlows: [{ date: d("2026-09-25"), amount: dec(3000) }] });
    expect(late.status).toBe("shortfall");
  });

  it("outflows among the other flows (bills) make the projection tighter", () => {
    const r = analyzeCardFunding({
      currentBalance: dec(1000),
      minimumBalance: dec(250),
      cards: [makeCard("A", "2026-09-10", "500")],
      from: FROM,
      to: TO,
      otherFlows: [{ date: d("2026-09-05"), amount: dec(-400) }],
    });
    expect(r.status).toBe("shortfall"); // 1000 - 400 - 500 = 100 < 250
    expect(r.shortfall!.toString()).toBe("150");
  });

  it("without other flows the result is the one it always was", () => {
    const cards = [makeCard("Capital One card", "2026-09-05", "500"), makeCard("Barclay card", "2026-09-25", "400")];
    const a = analyzeCardFunding({ currentBalance: dec(900), minimumBalance: dec(250), cards, from: FROM, to: TO });
    const b = analyzeCardFunding({ currentBalance: dec(900), minimumBalance: dec(250), cards, from: FROM, to: TO, otherFlows: [] });
    expect(b).toEqual(a);
  });

  it("peakShortfall covers the lowest point when a later (estimated) payment pushes the balance lower than the first dip", () => {
    const r = analyzeCardFunding({
      currentBalance: dec(499.09),
      minimumBalance: dec(250),
      cards: [makeCard("Capital One", "2026-09-12", "792.68"), estimated("Barclay", "2026-09-25", "2914.91")],
      from: FROM,
      to: TO,
    });
    expect(r.shortfall!.toFixed(2)).toBe("543.59"); // the first dip
    expect(r.peakShortfall!.toFixed(2)).toBe("3458.50"); // 250 - (499.09 - 792.68 - 2914.91)
    expect(r.peakShortfallDate?.toISOString()).toBe(d("2026-09-25").toISOString());
    const covered = analyzeCardFunding({ currentBalance: dec(5000), minimumBalance: dec(250), cards: [makeCard("A", "2026-09-10", "100")], from: FROM, to: TO });
    expect(covered.peakShortfall).toBeNull();
  });
});

describe("shortfallIncludesEstimate: the first-dip amount mentions estimates only when one is due by then", () => {
  const est = (dueIso: string): CardDue => ({ ...makeCard("Barclay", dueIso, "2914.91"), estimate: { confidence: "high", why: "w" } });
  it("live shape: the first dip is the on-file Capital One statement alone (Oct 12); the later estimate (Nov 5) is not part of it", () => {
    const cards = [makeCard("Capital One", "2026-10-12", "792.68"), est("2026-11-05")];
    expect(shortfallIncludesEstimate(cards, d("2026-10-12"))).toBe(false);
  });
  it("an estimate due on or before the first dip is part of it", () => {
    expect(shortfallIncludesEstimate([est("2026-10-12")], d("2026-10-12"))).toBe(true);
    expect(shortfallIncludesEstimate([est("2026-10-05"), makeCard("Capital One", "2026-10-12", "1")], d("2026-10-12"))).toBe(true);
  });
  it("no shortfall date, or no estimate at all, is never 'includes estimates'", () => {
    expect(shortfallIncludesEstimate([est("2026-10-12")], null)).toBe(false);
    expect(shortfallIncludesEstimate([makeCard("A", "2026-10-12", "5")], d("2026-10-12"))).toBe(false);
  });
});

describe("buildFundingMessage: estimates are observational and labelled", () => {
  const fund = (cards: CardDue[]) => {
    const result = analyzeCardFunding({ currentBalance: dec(500), minimumBalance: dec(250), cards, from: FROM, to: TO });
    return buildFundingMessage({ fundingAccountNickname: "Credit Cards", currentBalance: dec(500), minimumBalance: dec(250), minimumBalanceFee: dec(15), result });
  };

  it("an estimated statement is described as an expected payment with its basis, never as a due balance", () => {
    const { body } = fund([
      { accountNickname: "Barclay", dueDate: d("2026-09-20"), statementBalance: dec("2914.91"), estimate: { confidence: "high", why: "based on this cycle's charges so far; the statement closes in about 2 days" } },
    ]);
    expect(body).toContain("expected statement payment of about $2,914.91");
    expect(body).toContain("an estimate based on this cycle's charges so far");
    expect(body).not.toContain("statement due balance");
    expect(body).toContain("Estimated amounts are not final until the statements are issued.");
  });

  it("when later payments make the need larger than the first dip, the message says so", () => {
    const { body } = fund([
      makeCard("Capital One", "2026-09-12", "792.68"),
      { accountNickname: "Barclay", dueDate: d("2026-09-25"), statementBalance: dec("2914.91"), estimate: { confidence: "high", why: "w" } },
    ]);
    expect(body).toContain("The balance keeps falling after that");
    expect(body).toContain("September 25");
  });

  it("a statement on file keeps the original wording and no estimate note; nothing mentions a minimum payment", () => {
    const { body } = fund([makeCard("Barclay card", "2026-09-04", "600")]);
    expect(body).toContain("statement due balance of $600.00 which will be automatically deducted on September 4");
    expect(body).not.toContain("Estimated amounts");
    expect(body.toLowerCase()).not.toContain("minimum payment");
  });
});
