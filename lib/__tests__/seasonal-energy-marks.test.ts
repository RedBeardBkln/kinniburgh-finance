// carry-forward-seasonal-energy, step 2, Round 1 (D1): a "Not heating oil" mark is DURABLE. Plaid archives a pending row
// and adds the posted one under a NEW id; a mark therefore carries a signature (account, cents, payee key, date) so the
// posted twin inherits it. Pure tests of lib/seasonal-energy-marks.ts plus the model and the card using it.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { Decimal } from "@prisma/client/runtime/library";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/actions/seasonal-settings", () => ({ addOilPrice: vi.fn(), removeOilPrice: vi.fn(), setMcCarthyNotOil: vi.fn() }));

import {
  applyToggle,
  MARK_WINDOW_DAYS,
  parseMarks,
  payeeKey,
  payeesAlike,
  resolveMarks,
  serializeMarks,
  sigMatches,
  signatureOf,
  type MarkRow,
  type OilMark,
} from "@/lib/seasonal-energy-marks";
import { buildSiteEnergy, type EnergyEntityRef, type RawEnergyTx, type SeasonalLineRef } from "@/lib/seasonal-energy";
import { PENDING_NOTE, toUiSite } from "@/lib/seasonal-energy-view";
import { SeasonalCard } from "@/components/forecast/seasonal-card";
import { OIL_EXCLUDED_CAP } from "@/lib/seasonal-energy-prices";

(globalThis as unknown as { React: typeof React }).React = React;

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const row = (id: string, accountId: string, amount: string, payee: string, date: string): MarkRow => ({ id, accountId, amount, payee, date: D(date) });

describe("payee keys", () => {
  it("lower-case words; alike = equal or a whole-word prefix", () => {
    expect(payeeKey("MCCARTHY HEATING  OIL-SERV 860")).toBe("mccarthy heating oil serv 860");
    expect(payeesAlike("mccarthy heating oil", "mccarthy heating oil serv 860")).toBe(true);
    expect(payeesAlike("mccarthy heating oil", "mccarthy heating oil")).toBe(true);
    expect(payeesAlike("mccarthy heating", "mccarthy heating oil")).toBe(true);
    expect(payeesAlike("mccarthy", "mccarthyx heating")).toBe(false); // not a whole-word prefix
    expect(payeesAlike("valero", "mccarthy heating oil")).toBe(false);
    expect(payeesAlike("", "mccarthy")).toBe(false);
  });
});

describe("signatures", () => {
  const r = row("r1", "acct-1", "-1036.75", "mccarthy heating oil", "2026-10-09");
  it("uses the absolute amount in cents, the account id, the payee key and the date", () => {
    expect(signatureOf(r)).toEqual({ a: "acct-1", c: 103675, p: "mccarthy heating oil", on: "2026-10-09" });
    expect(signatureOf({ ...r, amount: new Decimal("1036.75") }).c).toBe(103675);
  });
  it("matches the same charge up to 5 days apart and nothing else", () => {
    const sig = signatureOf(r);
    const at = (date: string, over: Partial<MarkRow> = {}) => sigMatches(sig, { ...r, id: "x", date: D(date), ...over });
    expect(MARK_WINDOW_DAYS).toBe(5);
    expect(at("2026-10-09")).toBe(true);
    expect(at("2026-10-10")).toBe(true); // posted a day later
    expect(at("2026-10-14")).toBe(true); // exactly 5 days
    expect(at("2026-10-15")).toBe(false);
    expect(at("2026-10-04")).toBe(true);
    expect(at("2026-10-03")).toBe(false);
    expect(at("2026-10-09", { accountId: "acct-2" })).toBe(false);
    expect(at("2026-10-09", { amount: "-1036.76" })).toBe(false);
    expect(at("2026-10-09", { payee: "valero" })).toBe(false);
    expect(at("2026-10-10", { payee: "MCCARTHY HEATING OIL SERV 860" })).toBe(true); // the posted text is longer
  });
});

describe("parse / serialize", () => {
  it("reads the first format (bare ids) and the new one; drops junk and duplicates; caps", () => {
    const sig = { a: "acct-1", c: 100, p: "mccarthy heating oil", on: "2026-10-09" };
    const raw = JSON.stringify([U(1), { id: U(2), sig }, { id: U(2) }, "abc", 42, null, { id: "not an id" }, { id: U(3), sig: { a: "", c: 1, p: "x", on: "2026-01-01" } }]);
    expect(parseMarks(raw)).toEqual({ marks: [{ id: U(1) }, { id: U(2), sig }, { id: U(3) }], corrupt: false });
    expect(parseMarks(null)).toEqual({ marks: [], corrupt: false });
    expect(parseMarks("{nope").corrupt).toBe(true);
    expect(parseMarks('{"a":1}').corrupt).toBe(true);
    const many = Array.from({ length: OIL_EXCLUDED_CAP + 50 }, (_, i) => U(i + 10));
    expect(parseMarks(JSON.stringify(many)).marks).toHaveLength(OIL_EXCLUDED_CAP);
    const round = serializeMarks([{ id: U(2), sig }]);
    expect(parseMarks(round).marks).toEqual([{ id: U(2), sig }]);
  });
});

describe("resolveMarks: a mark survives the pending -> posted re-id", () => {
  const pending = row(U(10), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-09");
  const mark: OilMark = { id: pending.id, sig: signatureOf(pending) };
  const posted = row(U(11), "acct-b", "-1036.75", "mccarthy heating oil serv 860 4432839 ct", "2026-10-10"); // new id, a day later

  it("while the pending row exists the mark is on it (by id)", () => {
    expect(resolveMarks([mark], [pending]).excludedIds).toEqual(new Set([pending.id]));
  });

  it("after the sync replaces it, the posted twin stays excluded (inherited through the signature)", () => {
    const r = resolveMarks([mark], [posted]);
    expect(r.excludedIds).toEqual(new Set([posted.id]));
    expect(r.inherited).toBe(1);
  });

  it("an id-only mark (the first format) cannot follow the row: it is orphaned, which is why the signature exists", () => {
    expect(resolveMarks([{ id: pending.id }], [posted]).excludedIds.size).toBe(0);
  });

  it("two same-amount rows are not both swallowed by one mark", () => {
    const twinA = row(U(12), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-10");
    const twinB = row(U(13), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-11");
    const r = resolveMarks([mark], [twinA, twinB]);
    expect(r.excludedIds.size).toBe(1);
    expect(r.excludedIds.has(twinA.id)).toBe(true); // the closest on/after the marked date
    // two marks, two rows: each mark covers one
    const two = resolveMarks([mark, { id: U(99), sig: signatureOf(pending) }], [twinA, twinB]);
    expect(two.excludedIds).toEqual(new Set([twinA.id, twinB.id]));
  });

  it("a row already matched by another mark (by id) is skipped by a signature match", () => {
    const first = row(U(20), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-09");
    const stale: OilMark = { id: U(21), sig: signatureOf(first) }; // its own row is gone
    const r = resolveMarks([{ id: first.id, sig: signatureOf(first) }, stale], [first]);
    expect(r.excludedIds).toEqual(new Set([first.id])); // the stale mark finds nothing else to claim
    expect(r.inherited).toBe(0);
  });

  it("outside the window, on another account, another amount or another payee: not matched", () => {
    for (const other of [
      row(U(30), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-15"),
      row(U(31), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-03"),
      row(U(32), "acct-c", "-1036.75", "mccarthy heating oil", "2026-10-10"),
      row(U(33), "acct-b", "-1036.74", "mccarthy heating oil", "2026-10-10"),
      row(U(34), "acct-b", "-1036.75", "valero", "2026-10-10"),
    ]) {
      expect(resolveMarks([mark], [other]).excludedIds.size, other.id).toBe(0);
    }
  });

  it("prefers a row on or after the marked date over an earlier one, then the closest", () => {
    const before = row(U(40), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-08");
    const after = row(U(41), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-13");
    expect(resolveMarks([mark], [before, after]).excludedIds).toEqual(new Set([after.id]));
    const near = row(U(42), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-10");
    expect(resolveMarks([mark], [after, near]).excludedIds).toEqual(new Set([near.id]));
  });

  it("is deterministic: the same inputs in any order give the same answer", () => {
    const rows = [row(U(50), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-10"), row(U(51), "acct-b", "-1036.75", "mccarthy heating oil", "2026-10-10")];
    const a = resolveMarks([mark], rows);
    const b = resolveMarks([mark], [...rows].reverse());
    expect([...a.excludedIds]).toEqual([...b.excludedIds]);
  });
});

describe("applyToggle", () => {
  const target = { id: U(100), sig: { a: "acct-b", c: 103675, p: "mccarthy heating oil", on: "2026-10-10" } };
  const stale: OilMark = { id: U(101), sig: { a: "acct-b", c: 103675, p: "mccarthy heating oil", on: "2026-10-09" } };
  const none = new Set<string>();

  it("mark on: adds a new entry; the same id again is a no-op", () => {
    const a = applyToggle([], target, true, none);
    expect(a).toEqual({ ok: true, value: [target] });
    const b = applyToggle(a.ok ? a.value : [], target, true, new Set([target.id]));
    expect(b).toEqual({ ok: true, value: [target] });
  });

  it("mark on: a STALE entry with an alike signature is replaced in the same slot (no extra cap slot)", () => {
    const r = applyToggle([stale], target, true, none);
    expect(r).toEqual({ ok: true, value: [target] });
  });

  it("mark on: a LIVE entry is never taken over by a look-alike (two identical deliveries stay two decisions)", () => {
    const r = applyToggle([stale], target, true, new Set([stale.id]));
    expect(r.ok && r.value.map((m) => m.id)).toEqual([stale.id, target.id]);
  });

  it("mark off: removes the entry by id, or the stale twin; leaves the others", () => {
    const other: OilMark = { id: U(102), sig: { a: "acct-z", c: 5, p: "x", on: "2026-01-01" } };
    expect(applyToggle([other, target], target, false, new Set([target.id]))).toEqual({ ok: true, value: [other] });
    expect(applyToggle([other, stale], target, false, new Set([other.id]))).toEqual({ ok: true, value: [other] });
    expect(applyToggle([other], target, false, new Set([other.id]))).toEqual({ ok: true, value: [other] });
    // a live look-alike is not removed by counting a different row again
    expect(applyToggle([stale], target, false, new Set([stale.id]))).toEqual({ ok: true, value: [stale] });
  });

  it("a legacy id-only entry gains its signature when marked again", () => {
    expect(applyToggle([{ id: target.id }], target, true, new Set([target.id]))).toEqual({ ok: true, value: [target] });
  });

  it("the cap holds: a new entry at the cap is refused, replacing a stale one and removing still work", () => {
    const full: OilMark[] = Array.from({ length: OIL_EXCLUDED_CAP }, (_, i) => ({ id: U(1000 + i), sig: { a: `acct-${i}`, c: i, p: "x", on: "2026-01-01" } }));
    const alive = new Set(full.map((m) => m.id));
    expect(applyToggle(full, target, true, alive).ok).toBe(false);
    const withStale = [...full.slice(1), stale];
    expect(applyToggle(withStale, target, true, new Set(full.slice(1).map((m) => m.id)))).toMatchObject({ ok: true });
    const removed = applyToggle(full, { id: full[0]!.id, sig: full[0]!.sig! }, false, alive);
    expect(removed.ok && removed.value).toHaveLength(OIL_EXCLUDED_CAP - 1);
  });

  it("refuses an id that does not look like a transaction id", () => {
    expect(applyToggle([], { id: "not an id!", sig: target.sig }, true, none).ok).toBe(false);
  });
});

// ── the model, the card ─────────────────────────────────────────────────────────

const NOW = new Date("2026-10-10T12:00:00Z");
const P: EnergyEntityRef = { id: "ent-p", name: "Personal", slug: "personal" };
const L_OIL: SeasonalLineRef = { entityId: "ent-p", tagId: "t-op", tagName: "Utilities / Oil", kind: "oil" };
const tx = (id: string, date: string, outflow: string, over: Partial<RawEnergyTx> = {}): RawEnergyTx => ({
  id,
  date: D(date),
  amount: new Decimal(outflow).negated(),
  entityId: "ent-p",
  payee: "mccarthy heating oil",
  account: "Barclay",
  accountId: "acct-barclay",
  pending: false,
  tagPaths: [],
  ...over,
});
const site = (txs: RawEnergyTx[], oilMarks: OilMark[]) =>
  buildSiteEnergy({ entity: P, lines: [L_OIL], txs, entities: [P], priceEntries: [], flatMonthly: {}, replaceDraws: false, oilMarks, now: NOW });

describe("the oil history honours durable marks", () => {
  const pendingTx = tx("00000000-0000-4000-8000-0000000000a1", "2026-10-09", "1036.75", { pending: true });
  const mark: OilMark = { id: pendingTx.id, sig: signatureOf({ id: pendingTx.id, accountId: "acct-barclay", amount: "-1036.75", payee: pendingTx.payee, date: pendingTx.date }) };

  it("a marked PENDING row is excluded", () => {
    const s = site([pendingTx], [mark]);
    expect(s.oil!.facts.excluded.map((p) => p.id)).toEqual([pendingTx.id]);
    expect(s.oil!.facts.trailingAsPaid.toFixed(2)).toBe("0.00");
  });

  it("... and stays excluded after its twin posts under a NEW id (the pending row is archived and gone)", () => {
    const posted = tx("00000000-0000-4000-8000-0000000000b2", "2026-10-10", "1036.75", { pending: false, payee: "mccarthy heating oil serv 860 4432839 ct" });
    const s = site([posted], [mark]);
    expect(s.oil!.facts.excluded.map((p) => p.id)).toEqual([posted.id]);
    expect(s.oil!.facts.counted).toEqual([]);
    expect(s.oil!.facts.check).toEqual([]);
  });

  it("an id-only mark of the first format does not follow the twin (it reappears for the owner to see)", () => {
    const posted = tx("00000000-0000-4000-8000-0000000000b2", "2026-10-10", "1036.75");
    const s = site([posted], [{ id: pendingTx.id }]);
    expect(s.oil!.facts.excluded).toEqual([]);
    expect(s.oil!.facts.counted.map((p) => p.id)).toEqual([posted.id]);
  });

  it("two identical charges: one mark covers only one of them", () => {
    const a = tx("00000000-0000-4000-8000-0000000000c1", "2026-10-09", "1036.75");
    const b = tx("00000000-0000-4000-8000-0000000000c2", "2026-10-10", "1036.75");
    const s = site([a, b], [mark]);
    expect(s.oil!.facts.excluded).toHaveLength(1);
    expect(s.oil!.facts.counted).toHaveLength(1);
  });

  it("outside the window the twin is a different charge and is counted again", () => {
    const later = tx("00000000-0000-4000-8000-0000000000d1", "2026-10-20", "1036.75");
    expect(site([later], [mark]).oil!.facts.excluded).toEqual([]);
  });

  it("works for a row from the EK Consulting books read into the Personal house", () => {
    const ekc: EnergyEntityRef = { id: "ent-ekc", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting" };
    const pend = tx("00000000-0000-4000-8000-0000000000e1", "2026-10-09", "500", { entityId: "ent-ekc", accountId: "acct-cap1", pending: true });
    const m: OilMark = { id: pend.id, sig: signatureOf({ id: pend.id, accountId: "acct-cap1", amount: "-500", payee: pend.payee, date: pend.date }) };
    const posted = tx("00000000-0000-4000-8000-0000000000e2", "2026-10-10", "500", { entityId: "ent-ekc", accountId: "acct-cap1" });
    const s = buildSiteEnergy({ entity: P, lines: [L_OIL], txs: [posted], entities: [P, ekc], priceEntries: [], flatMonthly: {}, replaceDraws: false, oilMarks: [m], now: NOW });
    expect(s.oil!.facts.excluded.map((p) => p.id)).toEqual([posted.id]);
  });
});

describe("the pending caveat on the card", () => {
  const pendingTx = tx("00000000-0000-4000-8000-0000000000a1", "2026-10-09", "1036.75", { pending: true });
  const html = (oilMarks: OilMark[]) => renderToStaticMarkup(React.createElement(SeasonalCard, { sites: [toUiSite(site([pendingTx], oilMarks), NOW, { pricesCorrupt: false })] }));

  it("a pending row in the check list says the mark carries over when it posts", () => {
    expect(PENDING_NOTE).toBe("Pending: the mark carries over when it posts.");
    expect(html([])).toContain(PENDING_NOTE);
  });
  it("... and so does a pending row already marked", () => {
    const m: OilMark = { id: pendingTx.id, sig: signatureOf({ id: pendingTx.id, accountId: "acct-barclay", amount: "-1036.75", payee: pendingTx.payee, date: pendingTx.date }) };
    expect(html([m])).toContain(PENDING_NOTE);
  });
  it("a posted row has no such note", () => {
    const posted = tx("00000000-0000-4000-8000-0000000000b2", "2026-10-10", "1036.75");
    const out = renderToStaticMarkup(React.createElement(SeasonalCard, { sites: [toUiSite(site([posted], []), NOW, { pricesCorrupt: false })] }));
    expect(out).not.toContain(PENDING_NOTE);
  });
});
