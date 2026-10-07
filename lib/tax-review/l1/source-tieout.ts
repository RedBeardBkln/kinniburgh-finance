// L1.C1: source documents -> return (plan section 5.3). Every verified source document's amounts must appear on the return, and
// nothing may be left out: each amount-carrying document is read here DIRECTLY by its extraction field keys (source-docs.ts, not
// resolve-facts.ts) and the totals are compared with the lines of the effective return:
//   W-2 box 1 / 2 / 3+7 / 5 / 6, box 17 (Connecticut), box 12 deferrals and tips / overtime against the owner's answers;
//   1099-INT, 1099-DIV, 1099-B category totals, federal withholding on 1099s, other boxes that must not be silently dropped;
//   Form 1098 interest (and mortgage insurance, which is not deducted), property tax, estimated and extension payments, and the
//   retirement statement (Form 5498) box 1 against the IRA deduction plus the Form 8606 line 1 amount.
// Every document of an amount-carrying type is also classified "used" or "not used: <reason>"; a usable document that is not
// reflected anywhere on the return is a finding.
//
// SERVER SIDE ONLY (it reads the full effective extraction); findings carry document ids and amounts, never payer names.

import { makeFinding, type EvidenceItem, type Finding, type FindingArea, type Severity } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { formIsFiled, lineState, lineTitle, roundCentsHalfUp, usd } from "@/lib/tax-review/l1/helpers";
import { retirementStatementSummary } from "@/lib/retirement-statement";
import { YEAR, dataOf, int, isAmountDoc, isUsableFor2025, list, str, sumCents, uniqueDocs, unusableReason } from "@/lib/tax-review/l1/source-docs";
import { BUSINESS_USE_DEFAULT_TENTHS, formatBusinessUsePercent, formatCentsText, parseBusinessUsePercent, roundMilliCentsToDollars } from "@/lib/tax2025/business-use";
import { scheduleCLineKey, type LineKey } from "@/lib/tax2025/line-catalog";
import type { RawDocument } from "@/lib/tax2025/resolve-facts";

const DOC_CITATION = { sources: [{ kind: "engine" as const, id: "source-documents" }], sourceStatus: "not_applicable" as const };

function docEvidence(docs: readonly { id: string; cents: number | null }[]): EvidenceItem[] {
  return docs.slice(0, 8).map((d) => ({ ref: `doc:${d.id}`, amount: d.cents === null ? null : roundCentsHalfUp(d.cents), status: "document" }));
}

interface Tie {
  id: string;
  key: LineKey;
  /** Whole dollars the documents say. */
  expected: number;
  docs: readonly { id: string; cents: number | null }[];
  what: string;
  tolerance?: number;
  severity?: Severity;
  acceptable?: boolean;
  action?: string;
}

function tie(ctx: L1Context, t: Tie): Finding[] {
  const line = lineState(ctx, t.key);
  if (line.amount === null) return []; // the line has no amount: L1.D1 reports why
  const diff = line.amount - t.expected;
  if (Math.abs(diff) <= (t.tolerance ?? 0)) return [];
  return [
    makeFinding({
      layer: "L1",
      check: `L1.C1.${t.id}`,
      severity: t.severity ?? "blocker",
      area: "income",
      lineKey: t.key,
      ruleTag: t.id,
      message: `${t.what}: the documents add up to ${usd(t.expected)} but ${lineTitle(t.key)} shows ${usd(line.amount)} (difference ${usd(diff)}).`,
      evidence: [{ ref: t.key, amount: line.amount, status: line.status }, ...docEvidence(t.docs)],
      citation: DOC_CITATION,
      recommendedAction: t.action ?? "Do not file with this difference. Open the documents, compare them with the paper copies, and find which one is missing, wrong or attributed to the wrong place. Run the review again after fixing it.",
      acceptable: t.acceptable ?? false,
    }),
  ];
}

function finding(check: string, ruleTag: string, severity: Severity, area: FindingArea, message: string, evidence: EvidenceItem[], acceptable: boolean, action: string): Finding {
  return makeFinding({ layer: "L1", check, severity, area, ruleTag, message, evidence, citation: DOC_CITATION, recommendedAction: action, acceptable });
}

const DEFERRAL_CODES = new Set(["D", "E", "F", "G", "H", "S", "AA", "BB", "EE", "W"]);

// ── W-2 ───────────────────────────────────────────────────────────────────────

function w2Findings(ctx: L1Context, docs: readonly RawDocument[]): Finding[] {
  const out: Finding[] = [];
  const w2s = uniqueDocs(docs, "w2", { ignorePerson: true }); // a W-2 listed under both persons is counted once here (L1.C2 reports it)
  const box = (key: string) => w2s.map((d) => ({ id: d.id, cents: int(dataOf(d)[key]) }));
  const sumBox = (key: string): number | null => sumCents(box(key).map((b) => b.cents));

  const b1 = sumBox("wagesCents");
  if (b1 !== null && w2s.length > 0) out.push(...tie(ctx, { id: "w2-box1", key: "f1040.1a", expected: roundCentsHalfUp(b1), docs: box("wagesCents"), what: "W-2 box 1 (wages)" }));
  const b2 = sumBox("federalWithheldCents");
  if (b2 !== null && w2s.length > 0) out.push(...tie(ctx, { id: "w2-box2", key: "f1040.25a", expected: roundCentsHalfUp(b2), docs: box("federalWithheldCents"), what: "W-2 box 2 (federal income tax withheld)" }));

  // box 3 + 7 of the Schedule C owner's W-2s -> Schedule SE line 8a
  const ownerId = ctx.facts.income.scheduleC.ownerUserId.value;
  if (ownerId !== null && formIsFiled(ctx, "f1040sse", "schse")) {
    const mine = w2s.filter((d) => d.subjectUserId === ownerId);
    const parts = mine.map((d) => {
      const b3 = int(dataOf(d)["socialSecurityWagesCents"]);
      const b7 = int(dataOf(d)["socialSecurityTipsCents"]) ?? 0;
      return { id: d.id, cents: b3 === null ? null : b3 + b7 };
    });
    const s = sumCents(parts.map((p) => p.cents));
    if (s !== null && mine.length > 0) out.push(...tie(ctx, { id: "w2-box3-7", key: "se.8a", expected: roundCentsHalfUp(s), docs: parts, what: "W-2 boxes 3 and 7 (Social Security wages and tips) of the self-employed person" }));
  }
  // Medicare wages / tax -> Form 8959 lines 1 and 19, when the form carries them
  const b5 = sumBox("medicareWagesCents");
  if (b5 !== null && w2s.length > 0 && formIsFiled(ctx, "f8959", "f8959")) out.push(...tie(ctx, { id: "w2-box5", key: "f8959.1", expected: roundCentsHalfUp(b5), docs: box("medicareWagesCents"), what: "W-2 box 5 (Medicare wages)" }));
  const b6 = sumBox("medicareWithheldCents");
  if (b6 !== null && w2s.length > 0 && formIsFiled(ctx, "f8959", "f8959")) out.push(...tie(ctx, { id: "w2-box6", key: "f8959.19", expected: roundCentsHalfUp(b6), docs: box("medicareWithheldCents"), what: "W-2 box 6 (Medicare tax withheld)" }));

  // Connecticut withholding: box 17 lines coded CT (or the older flat amount), each W-2 rounded to whole dollars on its own (Column C of CT-1040)
  const ct = w2s.map((d) => {
    const data = dataOf(d);
    const lines = list(data["stateLines"]);
    if (lines.length > 0) {
      let total = 0;
      for (const l of lines) if ((str(l["stateCode"]) ?? "").toUpperCase() === "CT") total += int(l["stateWithheldCents"]) ?? 0;
      return { id: d.id, cents: total as number | null };
    }
    const legacy = int(data["stateWithheldCents"]);
    return { id: d.id, cents: legacy ?? (d.legacyFormat ? null : 0) };
  });
  if (w2s.length > 0 && ct.every((c) => c.cents !== null)) {
    const perRow = ct.reduce((n, c) => n + roundCentsHalfUp(c.cents ?? 0), 0);
    const ofSum = roundCentsHalfUp(ct.reduce((n, c) => n + (c.cents ?? 0), 0));
    const line = lineState(ctx, "ct1040.18");
    if (line.amount !== null && line.amount !== perRow && line.amount !== ofSum) {
      out.push(...tie(ctx, { id: "w2-box17-ct", key: "ct1040.18", expected: perRow, docs: ct, what: "W-2 box 17 (Connecticut income tax withheld)" }));
    }
  }

  // people: each document's person against the person the return attributes it to
  for (const d of w2s) {
    if (d.subjectType !== "person" || d.subjectUserId === null) {
      out.push(finding("L1.C1.w2-no-person", d.id, "high", "income", "A W-2 is not assigned to a person (it is unassigned or marked joint). Wages by person, Schedule SE and the excess Social Security credit depend on it.", [{ ref: `doc:${d.id}`, amount: null, status: "no person" }], true, "Set the person on the document."));
    }
  }
  const factW2 = ctx.facts.income.w2s;
  for (const person of ctx.raw?.people ?? []) {
    const docSum = sumCents(w2s.filter((d) => d.subjectType === "person" && d.subjectUserId === person.userId).map((d) => int(dataOf(d)["wagesCents"])));
    const factSum = sumCents(factW2.filter((w) => w.personUserId === person.userId).map((w) => w.wagesCents));
    if (docSum !== null && factSum !== null && docSum !== factSum) {
      out.push(
        finding(
          "L1.C1.w2-person",
          person.userId.slice(0, 8),
          "blocker",
          "income",
          `The W-2 wages the documents assign to one household member (${usd(roundCentsHalfUp(docSum))}) differ from the wages the return attributes to that member (${usd(roundCentsHalfUp(factSum))}).`,
          [{ ref: "check:w2-person", amount: roundCentsHalfUp(docSum - factSum), status: "difference" }],
          false,
          "Check which person each W-2 is assigned to on the Documents screen, then run the review again."
        )
      );
    }
  }

  // box 12 deferrals and box 7 tips / box 14 overtime against the owner's answers (they feed the saver's credit, the IRA phase-outs and Schedule 1-A)
  for (const p of ctx.facts.returnAnswers.people) {
    if (p.userId === null) continue;
    const mine = w2s.filter((d) => d.subjectUserId === p.userId);
    const deferral = mine.reduce((n, d) => n + list(dataOf(d)["box12"]).reduce((m, e) => (DEFERRAL_CODES.has((str(e["code"]) ?? "").toUpperCase()) ? m + (int(e["amountCents"]) ?? 0) : m), 0), 0);
    if (deferral > 0 && p.deferralsCents.value !== null && p.deferralsCents.value !== deferral) {
      out.push(
        finding(
          "L1.C1.w2-deferrals",
          p.userId.slice(0, 8),
          "medium",
          "adjustments",
          `The W-2 box 12 deferral codes add up to ${usd(roundCentsHalfUp(deferral))} for one household member, but the questionnaire answer for retirement-plan deferrals is ${usd(roundCentsHalfUp(p.deferralsCents.value))}. The answer feeds the saver's credit and the IRA deduction limits.`,
          [{ ref: "check:w2-deferrals", amount: roundCentsHalfUp(deferral), status: "documents" }],
          true,
          "Correct the questionnaire answer, or accept this finding with the reason the two should differ."
        )
      );
    }
    const tips = mine.reduce((n, d) => n + (int(dataOf(d)["socialSecurityTipsCents"]) ?? 0), 0);
    if (tips > 0 && p.tipsChoice.value === "none") {
      out.push(finding("L1.C1.w2-tips", p.userId.slice(0, 8), "medium", "income", `A W-2 shows Social Security tips (box 7: ${usd(roundCentsHalfUp(tips))}) but the questionnaire says there were no tips; the Schedule 1-A tips deduction is computed from that answer.`, [{ ref: "check:w2-tips", amount: roundCentsHalfUp(tips), status: "documents" }], true, "Check the answer about tips, or accept this finding with the reason."));
    }
    const overtime = mine.reduce((n, d) => n + list(dataOf(d)["box14"]).reduce((m, e) => (/overtime|\bOT\b/i.test(str(e["label"]) ?? "") ? m + (int(e["amountCents"]) ?? 0) : m), 0), 0);
    if (overtime > 0 && p.overtimeChoice.value === "none") {
      out.push(finding("L1.C1.w2-overtime", p.userId.slice(0, 8), "medium", "income", `A W-2 box 14 line looks like overtime (${usd(roundCentsHalfUp(overtime))}) but the questionnaire says there was none; the Schedule 1-A overtime deduction is computed from that answer.`, [{ ref: "check:w2-overtime", amount: roundCentsHalfUp(overtime), status: "documents" }], true, "Check the answer about overtime, or accept this finding with the reason."));
    }
  }
  return out;
}

// ── 1099 ──────────────────────────────────────────────────────────────────────

const BOX_TO_FORM_LINE: Readonly<Record<string, string>> = { A: "1b", G: "1b", B: "2", H: "2", C: "3", I: "3", D: "8b", J: "8b", E: "9", K: "9", F: "10", L: "10" };

function f1099Findings(ctx: L1Context, docs: readonly RawDocument[]): Finding[] {
  const out: Finding[] = [];
  const d1099 = uniqueDocs(docs, "1099");
  const variant = (d: RawDocument): string | null => str(dataOf(d)["formVariant"]);

  // interest: box 1 (or the legacy headline of a 1099-INT) + box 3 + the business bank interest from the books
  const interest = d1099.flatMap((d) => {
    const data = dataOf(d);
    const b1 = int(data["int_box1Cents"]);
    const legacy = b1 === null && variant(d) === "1099-INT" ? int(data["amountCents"]) : null;
    // Mirrors the engine: a printed 1099-INT with box 1 blank and another interest box filled reported 0 in box 1 (its box 3 still counts).
    const variants = Array.isArray(data["variantsPresent"]) ? data["variantsPresent"] : [];
    const isInt1099 = variant(d) === "1099-INT" || variants.includes("1099-INT");
    const otherBox = ["int_box2Cents", "int_box3Cents", "int_box4Cents", "int_box5Cents", "int_box6Cents", "int_box8Cents", "int_box9Cents"].some((k) => int(data[k]) !== null);
    const box1 = b1 ?? legacy ?? (isInt1099 && otherBox ? 0 : null);
    if (box1 === null) return [];
    const b3 = int(data["int_box3Cents"]) ?? (d.legacyFormat ? null : 0);
    return [{ id: d.id, cents: b3 === null ? null : box1 + b3 }];
  });
  const books = (ctx.ret.scheduleC?.booksInterest ?? []).reduce((n, b) => n + b.amountCents, 0);
  const intSum = sumCents(interest.map((i) => i.cents));
  if (intSum !== null && (interest.length > 0 || books > 0)) out.push(...tie(ctx, { id: "int", key: "f1040.2b", expected: roundCentsHalfUp(intSum + books), docs: interest, what: "1099-INT interest (box 1 and box 3) plus interest on the business account per the books" }));

  // dividends
  const divDocs = d1099.flatMap((d) => {
    const data = dataOf(d);
    const hasDiv = ["div_box1aCents", "div_box1bCents", "div_box2aCents", "div_box3Cents", "div_box5Cents", "div_box7Cents", "div_box11Cents"].some((k) => int(data[k]) !== null);
    const legacy = !hasDiv && variant(d) === "1099-DIV" ? int(data["amountCents"]) : null;
    if (!hasDiv && legacy === null) return [];
    const blank = d.legacyFormat ? null : 0;
    return [
      {
        id: d.id,
        ordinary: hasDiv ? int(data["div_box1aCents"]) ?? blank : legacy,
        qualified: hasDiv ? int(data["div_box1bCents"]) ?? blank : null,
        gainDist: hasDiv ? int(data["div_box2aCents"]) ?? blank : null,
      },
    ];
  });
  const ord = sumCents(divDocs.map((d) => d.ordinary));
  if (ord !== null && divDocs.length > 0) out.push(...tie(ctx, { id: "div-ordinary", key: "f1040.3b", expected: roundCentsHalfUp(ord), docs: divDocs.map((d) => ({ id: d.id, cents: d.ordinary })), what: "1099-DIV box 1a (ordinary dividends)" }));
  const qual = sumCents(divDocs.map((d) => d.qualified));
  if (qual !== null && divDocs.length > 0 && divDocs.some((d) => d.qualified !== null)) out.push(...tie(ctx, { id: "div-qualified", key: "f1040.3a", expected: roundCentsHalfUp(qual), docs: divDocs.map((d) => ({ id: d.id, cents: d.qualified })), what: "1099-DIV box 1b (qualified dividends)" }));
  const gd = sumCents(divDocs.map((d) => d.gainDist));
  const sd = ctx.ret.scheduleD;
  if (gd !== null && divDocs.length > 0 && sd !== null) {
    if (sd.required === true) out.push(...tie(ctx, { id: "div-capgain-dist", key: "schd.13", expected: roundCentsHalfUp(gd), docs: divDocs.map((d) => ({ id: d.id, cents: d.gainDist })), what: "1099-DIV box 2a (capital gain distributions)" }));
    else if (sd.exception1) out.push(...tie(ctx, { id: "div-capgain-dist", key: "f1040.7a", expected: roundCentsHalfUp(gd), docs: divDocs.map((d) => ({ id: d.id, cents: d.gainDist })), what: "1099-DIV box 2a (capital gain distributions, Exception 1)" }));
  }

  // federal withholding on 1099s (legacy non-INT documents are excluded by the engine on purpose and raise their own blocking item)
  const wh = d1099.flatMap((d) => {
    if (d.legacyFormat && variant(d) !== "1099-INT") return [];
    const data = dataOf(d);
    const headline = int(data["federalWithheldCents"]);
    const cents = headline ?? ["int_box4Cents", "div_box4Cents", "nec_box4Cents", "misc_box4Cents"].reduce((n, k) => n + (int(data[k]) ?? 0), 0);
    return [{ id: d.id, cents: cents as number | null }];
  });
  if (d1099.length > 0) out.push(...tie(ctx, { id: "1099-withholding", key: "f1040.25b", expected: roundCentsHalfUp(wh.reduce((n, w) => n + (w.cents ?? 0), 0)), docs: wh, what: "Federal tax withheld on 1099 forms (box 4)" }));

  // 1099-B / 1099-DA category totals against Schedule D (one Schedule D line per category as the return routes it)
  const cats = sd?.categories ?? [];
  const perLine = new Map<string, { d: number; e: number | null; g: number; ids: Set<string> }>();
  for (const d of d1099) {
    for (const r of list(dataOf(d)["bSummary"])) {
      const form = str(r["form"]);
      const boxLetter = str(r["box"]);
      if (boxLetter === null) continue;
      const cat = cats.find((c) => c.box === boxLetter && (form === null || c.form === form));
      const line = cat?.line ?? BOX_TO_FORM_LINE[boxLetter];
      if (cat === undefined) {
        out.push(finding("L1.C1.1099b-missing-category", `${d.id}|${boxLetter}`, "blocker", "income", `A 1099 sales summary row for Form 8949 box ${boxLetter} is not on the return: that category has no Schedule D line.`, [{ ref: `doc:${d.id}`, amount: null, status: `box ${boxLetter}` }], false, "Open the document's sales summary and the Schedule D detail; the category must be reported."));
        continue;
      }
      if (line === undefined) continue;
      const acc = perLine.get(line) ?? { d: 0, e: 0 as number | null, g: 0, ids: new Set<string>() };
      acc.d += int(r["proceedsCents"]) ?? 0;
      const cost = int(r["costCents"]);
      acc.e = acc.e === null || cost === null ? (cost === null ? acc.e : null) : acc.e + cost;
      acc.g += int(r["washSaleLossDisallowedCents"]) ?? 0;
      acc.ids.add(d.id);
      perLine.set(line, acc);
    }
  }
  for (const [line, acc] of perLine) {
    const docs1 = [...acc.ids].map((id) => ({ id, cents: null as number | null }));
    out.push(...tie(ctx, { id: `1099b-${line}-d`, key: `schd.${line}.d` as LineKey, expected: roundCentsHalfUp(acc.d), docs: docs1, what: `1099-B proceeds for Schedule D line ${line}` }));
    if (acc.e !== null) out.push(...tie(ctx, { id: `1099b-${line}-e`, key: `schd.${line}.e` as LineKey, expected: roundCentsHalfUp(acc.e), docs: docs1, what: `1099-B cost basis for Schedule D line ${line}` }));
    if (line !== "1a" && line !== "8a") out.push(...tie(ctx, { id: `1099b-${line}-g`, key: `schd.${line}.g` as LineKey, expected: roundCentsHalfUp(acc.g), docs: docs1, what: `1099-B wash sale adjustments for Schedule D line ${line}` }));
  }

  // other boxes (1099-R, SSA, NEC, MISC, ...) must be on a line or in an open item, never silently dropped
  for (const d of d1099) {
    const data = dataOf(d);
    const summaryRead = list(data["bSummary"]).length > 0;
    const others = list(data["otherBoxes"]).filter((e) => !(summaryRead && (str(e["variant"]) ?? "") === "1099-B") && (int(e["amountCents"]) ?? 0) !== 0);
    const direct = ["nec_box1Cents", "misc_box1Cents", "misc_box2Cents", "misc_box3Cents"].filter((k) => (int(data[k]) ?? 0) !== 0);
    if (others.length + direct.length === 0) continue;
    const explained = ctx.ret.openItems.some((i) => i.refs.some((r) => r.id === d.id));
    if (!explained) {
      out.push(finding("L1.C1.other-boxes", d.id, "high", "income", `A 1099 reports ${others.length + direct.length} amount(s) outside interest, dividends and sales (for example 1099-R, 1099-NEC or 1099-MISC boxes) and nothing on the return or in its open items accounts for them.`, [{ ref: `doc:${d.id}`, amount: others.length + direct.length, status: "boxes not on the return" }], true, "Decide where each amount is reported. If it is already included in a line (for example EK Consulting's books), accept this finding with that reason."));
    }
  }
  return out;
}

// ── 1098, property tax, K-1, estimated payments ───────────────────────────────

function deductionFindings(ctx: L1Context, docs: readonly RawDocument[]): Finding[] {
  const out: Finding[] = [];
  const m = uniqueDocs(docs, ["mortgage_interest", "form_1098"]);
  if (m.length > 0) {
    const interest = m.map((d) => ({ id: d.id, cents: int(dataOf(d)["interestCents"]) }));
    const sum = sumCents(interest.map((i) => i.cents));
    const mip = m.reduce((n, d) => n + (int(dataOf(d)["mortgageInsurancePremiumsCents"]) ?? 0), 0);
    const line = lineState(ctx, "scha.8a");
    if (sum !== null && line.amount !== null) {
      const expected = roundCentsHalfUp(sum);
      if (line.amount > expected + 1) {
        out.push(...tie(ctx, { id: "1098-interest", key: "scha.8a", expected, docs: interest, what: "Form 1098 box 1 (mortgage interest); the deduction cannot be more than the interest reported", tolerance: 1 }));
      } else if (line.amount < expected - 1) {
        out.push(...tie(ctx, { id: "1098-interest-less", key: "scha.8a", expected, docs: interest, what: "Form 1098 box 1 (mortgage interest); the return deducts less, which is right only when a limit applies (for example the home acquisition debt limit)", tolerance: 1, severity: "high", acceptable: true, action: "Check that a documented limit explains the lower figure, then accept this finding with that reason." }));
      }
      if (mip > 0 && line.amount > expected + 1 && line.amount <= roundCentsHalfUp(sum + mip) + 1) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.C1.1098-mip",
            severity: "blocker",
            area: "deductions",
            lineKey: "scha.8a",
            message: "Schedule A line 8a appears to include the mortgage insurance premiums reported in Form 1098 box 5. Publication 936 says that itemized deduction has expired.",
            evidence: [{ ref: "scha.8a", amount: line.amount, status: line.status }, { ref: "check:1098-mip", amount: roundCentsHalfUp(mip), status: "documents" }],
            citation: { sources: [{ kind: "spec09", id: "mortgage-insurance", url: "https://www.irs.gov/publications/p936", quote: "The itemized deduction for mortgage insurance premiums has expired." }], sourceStatus: "verified" },
            recommendedAction: "Remove the premiums from line 8a.",
            acceptable: false,
          })
        );
      }
    }
  }
  const pt = uniqueDocs(docs, "property_tax");
  if (pt.length > 0) {
    const paid = pt.map((d) => ({ id: d.id, cents: int(dataOf(d)["paidInTaxYearCents"]) }));
    const sum = sumCents(paid.map((p) => p.cents));
    const l5b = lineState(ctx, "scha.5b").amount;
    const l5c = lineState(ctx, "scha.5c").amount;
    if (sum !== null && l5b !== null && l5c !== null && l5b + l5c > roundCentsHalfUp(sum) + 1) {
      out.push(
        finding("L1.C1.property-tax", "scha", "blocker", "deductions", `Schedule A deducts ${usd(l5b + l5c)} of real estate and personal property tax but the property tax documents show only ${usd(roundCentsHalfUp(sum))} paid in the year.`, [{ ref: "scha.5b", amount: l5b, status: "computed" }, { ref: "scha.5c", amount: l5c, status: "computed" }, ...docEvidence(paid)], false, "Compare the property tax bills with Schedule A lines 5b and 5c.")
      );
    }
  }
  // K-1: not computed by the engine, so each must be explained by an open item
  for (const d of docs.filter((x) => x.docType === "k1" && isUsableFor2025(x))) {
    const hasAmount = Object.entries(dataOf(d)).some(([k, v]) => k.endsWith("Cents") && int(v) !== null && v !== 0);
    if (hasAmount && !ctx.ret.openItems.some((i) => i.refs.some((r) => r.id === d.id))) {
      out.push(finding("L1.C1.k1", d.id, "high", "income", "A Schedule K-1 with amounts is on file but the return does not compute it and no open item explains it.", [{ ref: `doc:${d.id}`, amount: null, status: "k-1 not on the return" }], true, "Decide where the K-1 is reported."));
    }
  }
  return out;
}

function paymentFindings(ctx: L1Context): Finding[] {
  const out: Finding[] = [];
  const pay = ctx.facts.payments;
  const est = (list2: typeof pay.federalEstimates.value): number | null => (list2 === null ? null : list2.filter((e) => e.appliesToTaxYear === 2025).reduce((n, e) => n + e.amountCents, 0));
  const fed = est(pay.federalEstimates.value);
  const fedPrior = pay.federalPriorYearOverpaymentApplied.value;
  if (fed !== null && fedPrior !== null) out.push(...tie(ctx, { id: "fed-estimates", key: "f1040.26", expected: roundCentsHalfUp(fed + fedPrior), docs: [], what: "Federal estimated payments for 2025 plus the 2024 overpayment applied (your answers)" }));
  const ext = pay.federalExtensionPayment.value;
  if (ext !== null) out.push(...tie(ctx, { id: "fed-extension", key: "sch3.10", expected: roundCentsHalfUp(ext), docs: [], what: "The payment made with the extension request (your answer)" }));
  const ct = est(pay.ctEstimates.value);
  const ctPrior = pay.ctPriorYearOverpaymentApplied.value;
  if (ct !== null && ctPrior !== null) out.push(...tie(ctx, { id: "ct-estimates", key: "ct1040.19", expected: roundCentsHalfUp(ct + ctPrior), docs: [], what: "Connecticut estimated payments for 2025 plus the 2024 overpayment applied (your answers)" }));
  const ctExt = pay.ctExtensionPayment.value;
  if (ctExt !== null) out.push(...tie(ctx, { id: "ct-extension", key: "ct1040.20", expected: roundCentsHalfUp(ctExt), docs: [], what: "The payment made with the Connecticut extension request (your answer)" }));
  return out;
}

// ── retirement statements (Form 5498): the traditional IRA contribution ──────

/**
 * Form 5498 box 1 (traditional IRA contributions for 2025, including those made through April 15, 2026) against what the return reflects for that
 * person: the IRA deduction plus the nondeductible part (Form 8606 line 1) is the whole traditional contribution. Read from the document's own
 * extraction field, not through resolve-facts. A difference is a finding the owner can accept with a reason (a contribution at another custodian,
 * or one made for another year, is a real reason).
 */
function retirementFindings(ctx: L1Context, docs: readonly RawDocument[]): Finding[] {
  const out: Finding[] = [];
  // The same Form 5498 uploaded twice is one form (the person is part of the signature, so two people with identical forms stay two); a form whose own
  // form year is not 2025 (a 2024 5498 issued in 2025 carries the 2025 document year) is not this year's figure, as in resolve-facts.ts.
  const stmts = uniqueDocs(docs, "retirement_contribution").filter((d) => {
    const s = retirementStatementSummary(d.extractionData);
    return s.taxYear === null || s.taxYear === YEAR;
  });
  for (const p of ctx.facts.returnAnswers.people) {
    if (p.userId === null) continue;
    const mine = stmts.filter((d) => d.subjectType === "person" && d.subjectUserId === p.userId);
    const box1 = mine.map((d) => ({ id: d.id, cents: int(dataOf(d)["iraContributionsCents"]) }));
    const known = box1.filter((b) => b.cents !== null);
    if (known.length === 0) continue;
    const expected = roundCentsHalfUp(known.reduce((n, b) => n + (b.cents ?? 0), 0));
    const ded = lineState(ctx, `ira.${p.slot}.7` as LineKey);
    const nd = lineState(ctx, `ira.${p.slot}.nd` as LineKey);
    if (ded.amount === null || nd.amount === null) continue; // the IRA lines are not figured: L1.D1 reports why
    const reflected = ded.amount + nd.amount;
    if (reflected === expected) continue;
    out.push(
      makeFinding({
        layer: "L1",
        check: "L1.C1.ira-traditional",
        severity: "high",
        area: "adjustments",
        lineKey: `ira.${p.slot}.nd` as LineKey,
        ruleTag: p.userId.slice(0, 8),
        message: `A retirement statement (Form 5498 box 1) shows ${usd(expected)} of traditional IRA contributions for 2025 for one household member, but the return reflects ${usd(reflected)} (the IRA deduction ${usd(ded.amount)} plus the nondeductible part ${usd(nd.amount)}, which is Form 8606 line 1). The questionnaire answer for the traditional IRA contribution drives both.`,
        evidence: [{ ref: `ira.${p.slot}.7`, amount: ded.amount, status: ded.status }, { ref: `ira.${p.slot}.nd`, amount: nd.amount, status: nd.status }, ...docEvidence(box1)],
        citation: DOC_CITATION,
        recommendedAction: "Correct the questionnaire answer, or accept this finding with the reason the two should differ (a contribution made at another custodian, or one made for another year, can explain it).",
        acceptable: true,
      })
    );
  }
  return out;
}

// ── inventory ─────────────────────────────────────────────────────────────────

function reflectedIn(ctx: L1Context, d: RawDocument): boolean {
  const f = ctx.facts;
  switch (d.docType) {
    case "w2":
      return f.income.w2s.some((w) => w.docId === d.id) || f.income.w2Unusable.some((w) => w.docId === d.id);
    case "1099":
      return (
        f.income.interest.some((x) => x.docId === d.id) ||
        f.income.dividends.some((x) => x.docId === d.id) ||
        f.income.brokerSales.some((x) => x.docId === d.id) ||
        f.income.otherIncomeBoxes.some((x) => x.docId === d.id) ||
        ctx.ret.openItems.some((i) => i.refs.some((r) => r.id === d.id))
      );
    case "mortgage_interest":
    case "form_1098":
      return f.deductions.mortgages.some((x) => x.docId === d.id);
    case "property_tax":
      return f.deductions.propertyTaxBills.some((x) => x.docId === d.id);
    case "retirement_contribution": {
      if ((f.income.retirementStatements ?? []).some((x) => x.docId === d.id)) return true;
      // a statement that states nothing, or states another year, has nothing to reflect
      const s = retirementStatementSummary(d.extractionData);
      return !s.hasReading || (s.taxYear !== null && s.taxYear !== YEAR);
    }
    default:
      return true;
  }
}

function inventoryFindings(ctx: L1Context, docs: readonly RawDocument[]): Finding[] {
  const out: Finding[] = [];
  const kept = new Set(uniqueDocs(docs, AMOUNT_TYPES_FOR_INVENTORY).map((d) => d.id));
  for (const d of docs) {
    if (!isAmountDoc(d)) continue;
    const why = unusableReason(d);
    if (why !== null) {
      out.push(finding("L1.C1.doc-unusable", d.id, "high", "process", `A ${d.docType} document${d.taxYear === null ? "" : ` for ${d.taxYear}`} is not used by the return: ${why}. Any amount on it is missing from the return.`, [{ ref: `doc:${d.id}`, amount: null, status: "not used" }], true, "Open the document: assign its tax year, re-run its extraction, or archive it if it does not belong."));
      continue;
    }
    if (!isUsableFor2025(d) || !kept.has(d.id)) continue; // another year, or an exact duplicate counted once (L1.C2 reports it)
    if (d.docType === "k1" || d.docType === "tax_return") continue;
    if (!reflectedIn(ctx, d)) {
      out.push(finding("L1.C1.doc-not-reflected", d.id, "high", "income", `A usable ${d.docType} document for 2025 is on file but nothing on the return comes from it (it is not used).`, [{ ref: `doc:${d.id}`, amount: null, status: "not used" }], true, "Find out why the return ignores this document. If it carries no amount for 2025, archive it."));
    }
  }
  return out;
}

const AMOUNT_TYPES_FOR_INVENTORY = ["w2", "1099", "mortgage_interest", "form_1098", "property_tax", "retirement_contribution"];

// ── the books -> Schedule C line with the business-use percentage (decision X6 ...) ─────────────────────────────

const BOOKS_CITATION = { sources: [{ kind: "engine" as const, id: "business-use-percentage" }], sourceStatus: "not_applicable" as const };

/**
 * A shared (mixed-use) account's line must equal the booked cents of every account on the line, the shared ones at the recorded
 * percentage (read here from the decision as the sheet and the cover show it, integer math, rounded to whole dollars ONCE), the others at
 * 100%. A recorded percentage below 100% also raises a LOW, non-gating finding so the owner re-confirms the basis. A line pinned by an
 * override is skipped (the override check reports pins).
 */
function businessUseFindings(ctx: L1Context): Finding[] {
  const out: Finding[] = [];
  const sc = ctx.ret.scheduleC;
  const rows = sc?.businessUse ?? [];
  for (const lineId of [...new Set(rows.map((r) => r.lineId))]) {
    const key: LineKey = scheduleCLineKey(lineId);
    const state = lineState(ctx, key);
    const accounts = sc?.lines.find((l) => l.lineId === lineId)?.accounts ?? [];
    let scaled = 0;
    let readable = true;
    for (const a of accounts) {
      if (a.businessUseDecisionId === undefined) {
        scaled += a.rawCents * BUSINESS_USE_DEFAULT_TENTHS;
        continue;
      }
      const decision = ctx.view.decisions.find((d) => d.id === a.businessUseDecisionId);
      const pct = decision === undefined ? null : parseBusinessUsePercent(decision.chosen);
      if (pct === null || !pct.ok) readable = false;
      else scaled += a.rawCents * pct.tenths;
    }
    if (state.amount !== null && state.status !== "overridden" && readable) {
      const expected = roundMilliCentsToDollars(scaled);
      if (state.amount !== expected) {
        out.push(
          makeFinding({
            layer: "L1",
            check: `L1.C1.books-line${lineId}`,
            severity: "blocker",
            area: "deductions",
            lineKey: key,
            ruleTag: `line${lineId}`,
            message: `The books, with the business-use percentage applied to the shared account(s), add up to ${usd(expected)} but ${lineTitle(key)} shows ${usd(state.amount)} (difference ${usd(state.amount - expected)}).`,
            evidence: [{ ref: key, amount: state.amount, status: state.status }, { ref: "check:books-business-use", amount: expected, status: "books" }],
            citation: BOOKS_CITATION,
            recommendedAction: "Do not file with this difference. Compare the line with the books and the recorded business-use percentage, find which one is wrong, and run the review again.",
            acceptable: false,
          })
        );
      }
    }
  }
  for (const r of rows) {
    if (r.status !== "decided" || r.personalCents <= 0) continue;
    out.push(
      makeFinding({
        layer: "L1",
        check: "L1.C1.business-use-share",
        severity: "low",
        area: "deductions",
        lineKey: scheduleCLineKey(r.lineId),
        ruleTag: r.decisionId,
        message: `Business-use share ${formatBusinessUsePercent(r.percentTenths)} (decision ${r.decisionId}): ${formatCentsText(r.personalCents)} of the shared account is treated as personal and is not deducted. The percentage is your own statement; no document supports it.`,
        evidence: [{ ref: `check:decision.${r.decisionId}`, amount: roundMilliCentsToDollars(r.personalCents * BUSINESS_USE_DEFAULT_TENTHS), status: "personal portion" }],
        citation: BOOKS_CITATION,
        recommendedAction:
          "Re-read the basis you recorded and keep what supports it (a bill split, a usage log). The Schedule C instructions do not allow the base rate of the first phone line into your home even if you use it for business; accept this finding once you are satisfied.",
        acceptable: true,
      })
    );
  }
  return out;
}

// ── the overpayment decisions (X7 federal, X8 Connecticut): what is printed adds up to the overpayment ─────────────

/**
 * Only once the owner has RECORDED the decision (an undecided decision prints blank lines and L1.D2 already gates it). Federal: "Lines 35a,
 * 36, and 38 must equal line 34" (Form 1040 instructions, line 38), so line 35a + line 36 + the penalty printed on line 38 (blank = 0) is line 34;
 * when the printed penalty is more than line 34 the instruction says to enter -0- on lines 35a and 36 (the engine's own advisory covers line 37).
 * Connecticut: "Subtract Lines 23, 24, and 24a from Line 22 and enter the result" with lines 24 and 24a left blank, so line 25 + line 23 is line 22.
 * A line without an amount is skipped here (L1.D1 reports why). Read from the effective view: a pin that breaks the sum is a finding too.
 */
function refundSplitFindings(ctx: L1Context): Finding[] {
  const out: Finding[] = [];
  const decided = (id: string): boolean => ctx.view.decisions.some((d) => d.id === id && d.status === "decided");
  if (decided("X7")) {
    const over = lineState(ctx, "f1040.34");
    const refunded = lineState(ctx, "f1040.35a");
    const applied = lineState(ctx, "f1040.36");
    const penalty = lineState(ctx, "f1040.38").amount ?? 0;
    if (over.amount !== null && refunded.amount !== null && applied.amount !== null) {
      const penaltyExceeds = penalty > over.amount;
      const printedTotal = refunded.amount + applied.amount + (penaltyExceeds ? 0 : penalty);
      const expected = penaltyExceeds ? 0 : over.amount;
      if (printedTotal !== expected) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.C1.refund-split-federal",
            severity: "blocker",
            area: "payments",
            lineKey: "f1040.35a",
            ruleTag: "X7",
            message: `Form 1040 lines 35a (${usd(refunded.amount)}), 36 (${usd(applied.amount)}) and the penalty on line 38 (${usd(penalty)}) add up to ${usd(printedTotal)}, but the instructions say they must equal line 34 (${usd(over.amount)}).`,
            evidence: [
              { ref: "f1040.34", amount: over.amount, status: over.status },
              { ref: "f1040.35a", amount: refunded.amount, status: refunded.status },
              { ref: "f1040.36", amount: applied.amount, status: applied.status },
              { ref: "f1040.38", amount: penalty, status: lineState(ctx, "f1040.38").status },
            ],
            citation: { sources: [{ kind: "source_pack", id: "i1040gi", quote: "Lines 35a, 36, and 38 must equal line 34." }], sourceStatus: "verified" },
            recommendedAction: "Do not file with this difference. Record decision X7 again, or remove the override that changed one of these lines, and run the review again.",
            acceptable: false,
          })
        );
      }
    }
  }
  if (decided("X8")) {
    const over = lineState(ctx, "ct1040.22");
    const applied = lineState(ctx, "ct1040.23");
    const refunded = lineState(ctx, "ct1040.25");
    if (over.amount !== null && applied.amount !== null && refunded.amount !== null && applied.amount + refunded.amount !== over.amount) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.C1.refund-split-ct",
          severity: "blocker",
          area: "state",
          lineKey: "ct1040.25",
          ruleTag: "X8",
          message: `CT-1040 line 25 (${usd(refunded.amount)}) and line 23 (${usd(applied.amount)}) add up to ${usd(applied.amount + refunded.amount)}, but line 25 is line 22 (${usd(over.amount)}) less lines 23, 24 and 24a (24 and 24a are blank).`,
          evidence: [
            { ref: "ct1040.22", amount: over.amount, status: over.status },
            { ref: "ct1040.23", amount: applied.amount, status: applied.status },
            { ref: "ct1040.25", amount: refunded.amount, status: refunded.status },
          ],
          citation: { sources: [{ kind: "source_pack", id: "ct1040i", quote: "Subtract Lines 23, 24, and 24a from Line 22 and enter the result." }], sourceStatus: "verified" },
          recommendedAction: "Do not file with this difference. Record decision X8 again, or remove the override that changed one of these lines, and run the review again.",
          acceptable: false,
        })
      );
    }
  }
  return out;
}

export const sourceTieoutCheck: L1Check = {
  id: "L1.C1",
  description: "Verified source documents tie to the return (W-2, 1099, 1098, property tax, payments); nothing is left out",
  run(ctx: L1Context): Finding[] {
    if (ctx.raw === null) {
      return [
        ...businessUseFindings(ctx),
        ...refundSplitFindings(ctx),
        makeFinding({
          layer: "L1",
          check: "L1.C1.no-documents",
          severity: "blocker",
          area: "process",
          message: "The source documents were not available to this review run, so the amounts on the return could not be compared with them.",
          evidence: [{ ref: "check:documents", amount: null, status: "not available" }],
          recommendedAction: "Run the review again. Compare the return with your documents by hand until it can.",
          acceptable: false,
        }),
      ];
    }
    const docs = ctx.raw.documents;
    return [...w2Findings(ctx, docs), ...f1099Findings(ctx, docs), ...deductionFindings(ctx, docs), ...retirementFindings(ctx, docs), ...paymentFindings(ctx), ...businessUseFindings(ctx), ...refundSplitFindings(ctx), ...inventoryFindings(ctx, docs)];
  },
};
