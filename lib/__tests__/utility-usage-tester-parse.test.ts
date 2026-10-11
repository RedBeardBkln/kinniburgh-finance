// TESTER (utility-usage-upload): adversarial probes of lib/utility-usage-parse.ts written independently of the Coder's
// tests: a month/number differential against my own naive readers, hostile text shapes, header-detection hazards,
// private-identifier handling, performance bounds, and a boundary-biased seeded fuzz with invariants. All data synthetic.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  MAX_CELL,
  MAX_ROWS,
  MAX_TEXT_CHARS,
  parseMonthCell,
  parseNumberCell,
  parseUsageText,
  type ColumnRole,
  type ParseInput,
  type UsageKind,
} from "@/lib/utility-usage-parse";

const TODAY = "2026-10-10";
const NO_SOLAR = { solarLiveFrom: null };
const PERSONAL = { solarLiveFrom: "2023-03" };

function parse(kind: UsageKind, text: string, over: Partial<ParseInput> = {}) {
  return parseUsageText({ kind, text, today: TODAY, site: NO_SOLAR, ...over });
}
function ok(kind: UsageKind, text: string, over: Partial<ParseInput> = {}) {
  const out = parse(kind, text, over);
  if (!out.ok) throw new Error(`expected ok, got: ${out.error}`);
  return out;
}

// Seeded PRNG (mulberry32)
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

describe("TESTER month cells: differential against an independent reader", () => {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  it("every accepted spelling of every real month 2015-2030 maps to the same YYYY-MM", () => {
    for (let y = 2015; y <= 2030; y++) {
      for (let m = 1; m <= 12; m++) {
        const want = `${y}-${pad(m)}`;
        const spellings = [
          `${y}-${pad(m)}`, `${y}/${pad(m)}`, `${y}-${m}`, `${m}/${y}`, `${pad(m)}/${y}`,
          `${MON[m - 1]} ${y}`, `${FULL[m - 1]} ${y}`, `${MON[m - 1]}, ${y}`, `${MON[m - 1]!.toLowerCase()} ${y}`, `${MON[m - 1]!.toUpperCase()} ${y}`,
        ];
        for (const s of spellings) {
          const r = parseMonthCell(s);
          expect(r, s).toEqual({ ok: true, period: want, day: null });
        }
        for (const d of [1, 15, dim(y, m)]) {
          for (const s of [`${y}-${pad(m)}-${pad(d)}`, `${m}/${d}/${y}`, `${pad(m)}/${pad(d)}/${y}`, `${MON[m - 1]} ${d}, ${y}`]) {
            const r = parseMonthCell(s);
            expect(r, s).toEqual({ ok: true, period: want, day: d });
          }
        }
        // one past the last day is refused in every full-date spelling
        const bad = dim(y, m) + 1;
        for (const s of [`${y}-${pad(m)}-${pad(bad)}`, `${m}/${bad}/${y}`, `${MON[m - 1]} ${bad}, ${y}`]) {
          expect(parseMonthCell(s).ok, s).toBe(false);
        }
      }
    }
  });

  it("refuses month 0, 13+, day 0, two-digit years, serials, D/M/Y with day > 12, bare years and junk, never throws", () => {
    const bad = ["2024-00", "2024-13", "0/2024", "13/2024", "2024-01-00", "1/0/2024", "13/1/2024", "31/12/2024", "Jan-24", "Jan 24", "1/24", "1/1/24", "45292", "45292.5", "202401", "2024", "24", "Foo 2024", "Janu 2024", "Jan 2024 extra", "2024-1-1-1", "", "   ", "​2024-01", "２０２４-０１", "2024-01\u0000"];
    for (const s of bad) expect(parseMonthCell(s).ok, JSON.stringify(s)).toBe(false);
    const rnd = rng(7);
    const alphabet = "0123456789/-., JanFebMarAprMayJunJulAugSepOctNovDec:T";
    for (let i = 0; i < 20000; i++) {
      let s = "";
      const n = Math.floor(rnd() * 14);
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = parseMonthCell(s);
      if (r.ok) {
        expect(r.period).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
        if (r.day !== null) expect(r.day).toBeLessThanOrEqual(dim(Number(r.period.slice(0, 4)), Number(r.period.slice(5, 7))));
      }
    }
  });
});

describe("TESTER number cells: differential against an independent reader", () => {
  it("plain, grouped, $, parenthesised, trailing-unit spellings all equal the same Decimal; too many decimals never rounds", () => {
    const r = rng(11);
    for (let i = 0; i < 4000; i++) {
      const whole = Math.floor(r() * 10 ** Math.floor(r() * 7));
      const decs = Math.floor(r() * 4); // 0..3
      const frac = Array.from({ length: decs }, () => Math.floor(r() * 10)).join("");
      const plain = decs > 0 ? `${whole}.${frac}` : `${whole}`;
      const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (decs > 0 ? `.${frac}` : "");
      const want = new Decimal(plain);
      for (const s of [plain, grouped, ` ${plain} `, `${plain} kWh`, `${plain}kwh`]) {
        const got = parseNumberCell(s, { maxDecimals: 3, kind: "electric" });
        expect(got.kind, s).toBe("ok");
        if (got.kind === "ok") expect(got.value.equals(want), s).toBe(true);
      }
      const dollars = parseNumberCell(`$${grouped}`, { maxDecimals: 3 });
      expect(dollars.kind).toBe("ok");
      const neg = parseNumberCell(`(${grouped})`, { maxDecimals: 3 });
      expect(neg.kind).toBe("ok");
      if (neg.kind === "ok") expect(neg.value.equals(want.negated())).toBe(true);
      // one more decimal than allowed
      expect(parseNumberCell(`${plain}${decs === 0 ? "." : ""}1234`.slice(0, plain.length + (decs === 0 ? 5 : 4)), { maxDecimals: 3 }).kind === "error" || decs + 4 <= 3).toBe(true);
    }
  });

  it("refuses scientific, hex, signs in the wrong place, unicode digits/minus, double separators, Infinity", () => {
    const bad = ["1e3", "1E3", "0x10", "NaN", "Infinity", "-Infinity", "+5", "--5", "5-", "1.2.3", "1,,234", "1,23,456", "12,34", ",5", "5,", "1 000", "１２３", "−5", "5 kWh x", "$$5", "5$", "$ -5x", "1.234,5", "0,5", ".", "-", "٣"];
    for (const s of bad) {
      const got = parseNumberCell(s, { maxDecimals: 3, kind: "electric" });
      expect(got.kind === "error" || got.kind === "absent", JSON.stringify(s)).toBe(true);
      if (s !== "-") expect(got.kind, JSON.stringify(s)).not.toBe("ok");
    }
  });

  it("a 4-decimal quantity is an error everywhere it can appear, and 9+ integer digits cannot overflow the DB column", () => {
    const o = parse("oil", "Date,Gallons\n2026-01-05,100.1234\n");
    expect(o.ok && o.rows[0]!.status).toBe("error");
    const big = parse("electric", "Month,kWh\n2025-01,1234567890\n");
    expect(big.ok && big.rows[0]!.status).toBe("error");
    const cost = parse("oil", "Date,Gallons,Cost\n2026-01-05,100,350.123\n");
    expect(cost.ok && cost.rows[0]!.status).toBe("error");
  });
});

describe("TESTER hostile text shapes", () => {
  it("the 200,000-character limit is exact and a refused input returns no rows", () => {
    const head = "Month,kWh\n";
    const fill = (n: number) => head + "2025-01,100\n" + " ".repeat(Math.max(0, n - head.length - 12));
    expect(parse("electric", fill(MAX_TEXT_CHARS)).ok).toBe(true);
    const over = parse("electric", fill(MAX_TEXT_CHARS + 1));
    expect(over.ok).toBe(false);
  });

  it("giant hostile inputs return in well under a second", () => {
    const t0 = Date.now();
    const cases = [
      "a,".repeat(99_999),
      "\n".repeat(199_999) + "x",
      '"' + "a".repeat(199_990),
      ("x,\n".repeat(60_000)).slice(0, 199_999),
      '"""'.repeat(66_000),
      "\t".repeat(199_000) + "a",
      ("Month,kWh\n" + "2024-01,5\n".repeat(19_000)).slice(0, 199_990),
    ];
    for (const c of cases) {
      const r = parse("electric", c);
      if (r.ok) expect(r.rows.length).toBeLessThanOrEqual(MAX_ROWS);
    }
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("a header row cannot hide data: BOM + CRLF + quoted header + trailing blank lines", () => {
    const text = '﻿"Month","kWh","Cost"\r\n"2025-01","1,200","$150.50"\r\n\r\n\r\n';
    const out = ok("electric", text);
    expect(out.hasHeader).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ status: "new", period: "2025-01", quantity: "1200.000", costCents: 15050 });
  });

  it("a quoted newline inside a note does not shift later line numbers or merge rows", () => {
    const out = ok("electric", 'Month,kWh,Note\n2025-01,100,"line one\nline two"\n2025-02,110,\n2025-03,x,\n');
    expect(out.rows.map((r) => r.line)).toEqual([2, 4, 5]);
    expect(out.rows[2]!.status).toBe("error");
  });

  it("a stray quote in the middle of an unquoted cell is kept literally (not a quote start)", () => {
    const out = ok("electric", 'Month,kWh,Note\n2025-01,100,5" pipe\n2025-02,110,ok\n');
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]!.note).toBe('5" pipe');
  });

  it("text after a closing quote is appended, not a crash", () => {
    const out = ok("electric", 'Month,kWh,Note\n2025-01,100,"abc"def\n');
    expect(out.rows[0]!.status).toBe("new");
    expect(out.rows[0]!.note).toBe("abcdef");
  });

  it("lone CR, CRLF and LF produce identical results", () => {
    const base = ["Month,kWh,Cost", "2025-01,100,10.00", "2025-02,110,11.00", "2025-03,120,12.00"];
    const a = ok("electric", base.join("\n"));
    const b = ok("electric", base.join("\r\n"));
    const c = ok("electric", base.join("\r"));
    expect(JSON.stringify(b.rows)).toBe(JSON.stringify(a.rows));
    expect(JSON.stringify(c.rows)).toBe(JSON.stringify(a.rows));
  });

  it("refuses NUL, other C0 controls, DEL and U+2028 anywhere (whole input, no rows)", () => {
    for (const ch of ["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u001b", "\u007f", " ", " "]) {
      const r = parse("electric", `Month,kWh\n2025-01,100${ch}\n2025-02,110\n`);
      expect(r.ok, JSON.stringify(ch)).toBe(false);
    }
  });

  it("delimiter sniff: semicolon file with comma-decimal numbers is refused row by row, not silently misread", () => {
    const out = ok("electric", "Month;kWh;Cost\n2025-01;100;12,50\n2025-02;110;13,75\n");
    expect(out.delimiter).toBe(";");
    for (const r of out.rows) expect(r.status).toBe("error");
  });

  it("delimiter sniff ignores delimiters inside quotes on the first line", () => {
    const out = ok("electric", '"Month, billed";kWh;Cost\n2025-01;100;10.00\n', { mapping: ["month", "quantity", "cost"] });
    expect(out.delimiter).toBe(";");
    expect(out.rows[0]!.status).toBe("new");
  });

  it("a mapping longer than the column count, or with the wrong roles for the kind, is a mapping error, never rows", () => {
    const text = "Month,kWh\n2025-01,100\n";
    const longMap = parse("electric", text, { mapping: ["month", "quantity", "cost", "note", "note"] });
    expect(longMap.ok && longMap.rows.length).toBe(2 - 1); // extra roles beyond the columns are dropped
    const dup = parse("electric", text, { mapping: ["month", "month"] });
    expect(dup.ok && dup.mappingError).toBeTruthy();
    const oilUnit = parse("oil", "Date,Gallons\n2026-01-05,100\n", { mapping: ["month", "unit"] });
    expect(oilUnit.ok && oilUnit.mappingError).toBeTruthy();
    const noQty = parse("electric", text, { mapping: ["month", "ignore"] });
    expect(noQty.ok && noQty.mappingError && noQty.rows).toEqual([]);
  });

  it("columns the owner ignores never reach a row (an SSN-shaped column is dropped, not stored)", () => {
    const out = ok("electric", "Month,kWh,Account,Cost\n2025-01,100,123-45-6789,10.00\n", { mapping: ["month", "quantity", "ignore", "cost"] });
    expect(JSON.stringify(out.rows)).not.toContain("6789");
    expect(out.rows[0]!.note).toBeNull();
  });
});

describe("TESTER header-detection hazard: a first data row that cannot be read must not vanish as a 'header'", () => {
  it("a first row with an unreadable month and a readable number is data, reported as an error row", () => {
    const out = ok("electric", "Jan-24,500\n2025-02,100\n");
    expect(out.hasHeader).toBe(false);
    expect(out.rows[0]!.status).toBe("error");
  });
  it("a first row with an unreadable month and NO readable cell is taken as a header (visible in the column labels)", () => {
    const out = ok("electric", "Jan-24,n/a\n2025-02,100\n");
    // Documented behaviour probe: the first line becomes the header row. The preview shows it as the column labels.
    expect(out.hasHeader).toBe(true);
    expect(out.columns[0]!.header).toBe("Jan-24");
  });
});

describe("TESTER notes: injection and private identifiers", () => {
  const rowWithNote = (note: string) => {
    const out = ok("electric", `Month,kWh,Note\n2025-01,100,"${note.replace(/"/g, '""')}"\n`);
    return out.rows[0]!;
  };
  // Formerly defect probes (D1, fixed in round 2): the formula check now runs on the cleaned value as well, with leading
  // whitespace, NBSP, U+FEFF and zero-width characters skipped, and a leading line break / TAB refused.
  it("DEFECT: a quoted note that starts with a newline then '=' is refused (stored note must not start with = + @)", () => {
    const r = rowWithNote("\n=1+1");
    expect(r.note === null || !/^[=+@]/.test(r.note)).toBe(true);
  });
  it("DEFECT: a note that starts with CR then '=' is refused (the plan lists CR explicitly)", () => {
    const r = rowWithNote("\r=cmd|' /C calc'!A0");
    expect(r.note === null || !/^[=+@]/.test(r.note)).toBe(true);
  });
  it("DEFECT: a note that starts with a non-breaking space then '=' is refused", () => {
    const r = rowWithNote(" =1+1");
    expect(r.note === null || !/^[=+@]/.test(r.note)).toBe(true);
  });
  it("DEFECT: a note that starts with U+FEFF then '+' is refused", () => {
    const r = rowWithNote("﻿+1+1");
    expect(r.note === null || !/^[=+@]/.test(r.note)).toBe(true);
  });
  it.each([
    ["=1+1"], ["+1+1"], ["@SUM(A1)"], ["  =cmd|' /C calc'!A0"], ["\t=1+1"], [' "=1+1'],
  ])("refuses a formula-leading note %j", (n) => {
    const r = rowWithNote(n);
    // a leading quote char is not a formula start, the rest are
    if (n === ' "=1+1') expect(r.status).toBe("new");
    else expect(r.status).toBe("error");
  });
  it("records (as a probe, not a requirement) that a leading minus is NOT refused in notes", () => {
    expect(rowWithNote("-2+3").status).toBe("new");
  });
  it.each([["123-45-6789"], ["SSN 123 45 6789"], ["123456789"], ["12-3456789"], ["acct 4111111111111111"], ["Account 000123456789"], ["DOB 01/02/1980"]])(
    "refuses an SSN/EIN/account/DOB-like note %j",
    (n) => {
      const r = rowWithNote(n);
      expect(r.status).toBe("error");
      expect(JSON.stringify(r)).not.toContain("6789");
    }
  );
  it.each([["solar credit 1,245 kWh"], ["surplus 350.5 kWh sent back"], ["winter 2024-25"], ["rate 0.1234 per kWh"], ["credit $45.12"], ["meter read 2025-01-31"], ["3 cords seasoned"]])(
    "does not refuse an ordinary note %j (false-positive probe)",
    (n) => {
      expect(rowWithNote(n).status, n).toBe("new");
    }
  );
  it("a note of exactly 120 characters is kept; 121 is refused; control chars are stripped, never stored", () => {
    expect(rowWithNote("a".repeat(120)).note).toHaveLength(120);
    expect(rowWithNote("a".repeat(121)).status).toBe("error");
    const withTab = rowWithNote("a\tb");
    expect(withTab.status).toBe("new");
  });
});

describe("TESTER firewood and oil unit/range edges", () => {
  it("firewood: 0.25 and 20 cords are accepted, 0.24 / 20.001 refused; face cord 0.5 / 60 accepted", () => {
    const f = (q: string, unit: string) => ok("firewood", `Date,Qty,Unit\n2025-10-01,${q},${unit}\n`).rows[0]!.status;
    expect(f("0.25", "cord")).toBe("new");
    expect(f("20", "cords")).toBe("new");
    expect(f("0.24", "cord")).toBe("error");
    expect(f("20.001", "cord")).toBe("error");
    expect(f("0.5", "face cord")).toBe("new");
    expect(f("60", "Face_Cords")).toBe("new");
    expect(f("60.001", "face cord")).toBe("error");
    expect(f("2", "ton")).toBe("error");
  });
  it("oil: 2,000 gallons accepted (with a warning), 2,000.001 refused, price per gallon edges 0.50 and 12.00 accepted", () => {
    const o = (g: string, c: string) => ok("oil", `Date,Gallons,Cost\n2026-01-05,${g},${c}\n`).rows[0]!;
    expect(o("2000", "").status).toBe("new");
    expect(o("2000.001", "").status).toBe("error");
    expect(o("100", "50.00").status).toBe("new");
    expect(o("100", "49.99").status).toBe("error");
    expect(o("100", "1200.00").status).toBe("new");
    expect(o("100", "1200.01").status).toBe("error");
  });
});

describe("TESTER period rules", () => {
  it("electric: last finished month ok, current month and next refused; exactly 120 months back ok, 121 refused", () => {
    const e = (p: string) => ok("electric", `Month,kWh\n${p},100\n`).rows[0]!.status;
    expect(e("2026-09")).toBe("new");
    expect(e("2026-10")).toBe("error");
    expect(e("2026-11")).toBe("error");
    expect(e("2016-10")).toBe("new");
    expect(e("2016-09")).toBe("error");
  });
  it("oil/firewood: today ok, tomorrow refused, month-end dates handled; leap day only in a leap year", () => {
    const o = (d: string) => ok("oil", `Date,Gallons\n${d},100\n`).rows[0]!.status;
    expect(o("2026-10-10")).toBe("new");
    expect(o("2026-10-11")).toBe("error");
    expect(o("2024-02-29")).toBe("new");
    expect(o("2025-02-29")).toBe("error");
    expect(o("2100-02-29")).toBe("error");
  });
  it("solar boundary: 2023-03 itself is counted, 2023-02 is kept with a warning (Personal), nothing flagged for other houses", () => {
    const p = ok("electric", "Month,kWh\n2023-02,100\n2023-03,100\n", { site: PERSONAL });
    expect(p.rows[0]!.warnings.join(" ")).toMatch(/before solar/);
    expect(p.rows[1]!.warnings).toEqual([]);
    const s = ok("electric", "Month,kWh\n2023-02,100\n", { site: NO_SOLAR });
    expect(s.rows[0]!.warnings).toEqual([]);
  });
  it("period end: midpoint across a month boundary, 62-day span ok, 63 refused", () => {
    const m = ["month", "periodEnd", "quantity"] as ColumnRole[];
    const r = (a: string, b: string) => ok("electric", `Start,End,kWh\n${a},${b},100\n`, { mapping: m }).rows[0]!;
    expect(r("1/20/2025", "2/19/2025")).toMatchObject({ status: "new", period: "2025-02" }); // midpoint Feb 4
    expect(r("1/16/2025", "2/14/2025")).toMatchObject({ status: "new", period: "2025-01" }); // midpoint Jan 31
    expect(r("1/1/2025", "3/3/2025").status).toBe("new"); // 61 days
    expect(r("1/1/2025", "3/4/2025").status).toBe("new"); // 62 days
    expect(r("1/1/2025", "3/5/2025").status).toBe("error"); // 63 days
    expect(r("2/1/2025", "1/1/2025").status).toBe("error");
  });
});

describe("TESTER boundary-biased fuzz: every accepted row obeys the plan's ranges", () => {
  it("6000 hostile-ish tables across kinds, all mappings", () => {
    const r = rng(2026);
    const monthCells = ["2025-01", "2026-09", "2026-10", "2016-09", "2016-10", "Jan 2025", "13/2025", "2/30/2025", "2026-10-10", "2026-10-11", "1/1/2025", "Feb 29, 2024", "Jan-25", "", "x"];
    const qty = ["0", "1", "100.5", "5000", "5000.001", "20000", "20000.001", "-1", "(5)", "2000", "2000.001", "0.25", "0.249", "20", "20.01", "60", "1,234", "1.234,5", "1e3", "", "n/a", "9999999999", "12.3456"];
    const cost = ["", "0", "10.00", "-5000", "-5000.01", "20000", "20000.01", "50000", "50000.01", "$1,234.56", "(12.30)", "abc", "1.005", "49.99"];
    const notes = ["", "ok", "=1+1", "123-45-6789", "a".repeat(121), "solar credit"];
    const kinds: UsageKind[] = ["electric", "oil", "firewood"];
    let accepted = 0;
    for (let i = 0; i < 6000; i++) {
      const kind = pick(r, kinds);
      const n = 1 + Math.floor(r() * 5);
      const lines = ["Month,Qty,Cost,Note"];
      for (let j = 0; j < n; j++) lines.push([pick(r, monthCells), pick(r, qty), pick(r, cost), pick(r, notes)].join(","));
      const out = parse(kind, lines.join(r() < 0.5 ? "\n" : "\r\n"), { site: r() < 0.5 ? PERSONAL : NO_SOLAR });
      if (!out.ok) continue;
      const seen = new Set<string>();
      for (const row of out.rows) {
        if (row.status === "error") {
          expect(row.key).toBeNull();
          expect(row.errors.length).toBeGreaterThan(0);
          for (const e of row.errors) expect(e.length).toBeLessThan(400);
          continue;
        }
        accepted++;
        expect(row.period).toMatch(/^\d{4}-\d{2}$/);
        expect(row.occurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const q = new Decimal(row.quantity!);
        expect(q.decimalPlaces()).toBeLessThanOrEqual(3);
        if (kind === "electric") {
          expect(q.gte(0) && q.lte(20000)).toBe(true);
          expect(row.period! < "2026-10" && row.period! >= "2016-10").toBe(true);
          expect(row.occurredOn).toBe(`${row.period}-01`);
        } else if (kind === "oil") {
          expect(q.gt(0) && q.lte(2000)).toBe(true);
          expect(row.occurredOn! <= TODAY).toBe(true);
        } else {
          expect(q.gte(0.25) && q.lte(20)).toBe(true);
        }
        if (row.costCents !== null) {
          expect(Number.isInteger(row.costCents)).toBe(true);
          if (kind === "electric") expect(row.costCents >= -500000 && row.costCents <= 2000000).toBe(true);
          else expect(row.costCents >= 0 && row.costCents <= 5000000).toBe(true);
        }
        if (row.note !== null) {
          expect(row.note.length).toBeLessThanOrEqual(120);
          expect(row.note).not.toMatch(/^[=+@\t\r]/);
          expect(row.note).not.toMatch(/123-45-6789/);
        }
        if (row.status === "new") {
          expect(seen.has(row.key!), "two live-new rows share a key").toBe(false);
          seen.add(row.key!);
        }
      }
    }
    expect(accepted).toBeGreaterThan(500);
  });
});

describe("TESTER exported limit constants are the plan's numbers", () => {
  it("pins the literals", () => {
    expect(MAX_TEXT_CHARS).toBe(200_000);
    expect(MAX_ROWS).toBe(600);
    expect(MAX_CELL).toBe(200);
  });
});
