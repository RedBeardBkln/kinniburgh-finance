// Shared checks for the per-form map tests (T2a/T2b). Not a test file (no .test suffix).
//   assertMapKeysAreReal(map)       every money line key is in the real engine LINE_KEYS
//                                    (never a pending key: the engine covers these forms)
//   assertMoneyFieldsMatchSpeak(map) every money field's IRS "speak" text names the printed
//                                    line the engine key stands for (automatic, all fields)
//   assertSpeak(map's formId, rows)  hand-picked spot checks: field -> expected speak pattern
//   assertPrivateFieldsNeverFilled   SSN / EIN / bank / PIN / preparer / address / phone /
//                                    email / occupation / signature fields are only ever blank
// The speak text lives in data/forms/2025/catalog/<formId>.fields.json (the IRS XFA
// accessibility description of each field, joined by full name).

import { describe, expect, it } from "vitest";
import { LINE_KEYS, lineMeta } from "@/lib/tax2025/types";
import type { FormMap, MapBlank, PdfReturnView } from "@/lib/tax2025/pdf/types";
import { assertMapComplete, assertMapGolden, loadCatalog, type FieldValue } from "./tax2025-pdf-harness";

const REAL_KEYS = new Set<string>(LINE_KEYS);

export function assertMapKeysAreReal(map: FormMap): void {
  for (const l of map.lines) {
    if (l.kind !== "money") continue;
    expect(REAL_KEYS.has(l.line), `${map.formId}: ${l.line} is not in the engine LINE_KEYS`).toBe(true);
  }
}

function speakByName(formId: string): Map<string, string> {
  return new Map(loadCatalog(formId).fields.map((f) => [f.name, f.speak ?? ""]));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the speak text prints line `id` ("8z." / "17a." / "6. ...: a." for the first sub-line). */
export function speakNamesLine(speak: string, id: string): boolean {
  const direct = new RegExp(`(?:^|[\\s.])${escapeRegExp(id)}\\.`);
  if (direct.test(speak)) return true;
  // First sub-line of a lettered group is printed "N. Heading: a. Text" (e.g. Schedule 3 line 6a).
  const m = /^(\d+)a$/.exec(id);
  if (m && m[1]) return new RegExp(`(?:^|[\\s.])${m[1]}\\.\\s.*\\ba\\.`).test(speak);
  return false;
}

export function assertMoneyFieldsMatchSpeak(map: FormMap): void {
  const speak = speakByName(map.formId);
  let checked = 0;
  for (const l of map.lines) {
    if (l.kind !== "money") continue;
    const text = speak.get(l.field);
    expect(text, `${map.formId}: field ${l.field} has no speak text`).toBeTruthy();
    const id = lineMeta(l.line as Parameters<typeof lineMeta>[0]).formLine;
    expect(speakNamesLine(text ?? "", id), `${map.formId}: ${l.field} speak "${text}" does not name line ${id} (${l.line})`).toBe(true);
    checked += 1;
  }
  expect(checked).toBeGreaterThan(0);
}

/** Hand-picked spot checks: `[field, pattern the IRS speak text must match]`. */
export function assertSpeak(formId: string, rows: ReadonlyArray<readonly [string, RegExp]>): void {
  const speak = speakByName(formId);
  expect(rows.length).toBeGreaterThanOrEqual(10);
  for (const [field, pattern] of rows) {
    const text = speak.get(field);
    expect(text, `${formId}: unknown field ${field}`).toBeDefined();
    expect(text, `${formId}: ${field}`).toMatch(pattern);
  }
}

const PRIVATE_SPEAK =
  /social security number|S S N|E I N|Employer I D|Routing|Account number|P I N|Phone no|Email|Home address|Business address|Preparer|Firm's|Designee|signature|occupation|identifying no/i;

function blankedNames(map: FormMap, fieldNames: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const b of map.blank as MapBlank[]) {
    if ("field" in b) out.add(b.field);
    else for (const n of fieldNames) if (b.match.test(n)) out.add(n);
  }
  return out;
}

/**
 * No field whose IRS description is sensitive (SSN, EIN, bank, PIN, preparer, address ...) is mapped to a line, header or table.
 * `moneyFieldsWithPartCaption` names money fields whose accessibility text merely QUOTES a part caution ("must have a valid social
 * security number"): each must be a mapped money line, so the exemption can never hide a real SSN box.
 */
export function assertPrivateFieldsNeverFilled(map: FormMap, moneyFieldsWithPartCaption: readonly string[] = []): void {
  const moneyFields = new Set(map.lines.flatMap((l) => (l.kind === "money" ? [l.field] : [])));
  for (const name of moneyFieldsWithPartCaption) expect(moneyFields.has(name), `${map.formId}: exempt field ${name} must be a mapped money line`).toBe(true);
  const cat = loadCatalog(map.formId);
  const names = cat.fields.map((f) => f.name);
  const blank = blankedNames(map, names);
  let seen = 0;
  for (const f of cat.fields) {
    if (!PRIVATE_SPEAK.test(f.speak ?? "")) continue;
    seen += 1;
    if (moneyFieldsWithPartCaption.includes(f.name)) continue;
    expect(blank.has(f.name), `${map.formId}: sensitive field ${f.name} ("${f.speak}") must be blank by design`).toBe(true);
  }
  expect(seen, `${map.formId}: expected at least the SSN field`).toBeGreaterThan(0);
}

export interface CommonMapSuite {
  map: FormMap;
  /** Number of AcroForm fields of the blank form. */
  fieldCount: number;
  /** The synthetic MFJ view to fill. */
  view: PdfReturnView;
  /** Hand-formatted read-back of every field that must be non-empty; all others must be empty / unchecked. */
  expected: Readonly<Record<string, FieldValue>>;
  /** At least 10 hand-picked (field, speak pattern) spot checks. */
  spot: ReadonlyArray<readonly [string, RegExp]>;
  /** Money fields whose speak text only quotes a part caution about social security numbers (see assertPrivateFieldsNeverFilled). */
  moneyFieldsWithPartCaption?: readonly string[];
}

/** The checks every form map must pass (T2a/T2b acceptance): completeness, real keys, speak match, privacy, golden read-back. */
export function registerCommonMapTests(s: CommonMapSuite): void {
  const id = s.map.formId;
  describe(`${id} map: completeness and keys`, () => {
    it(`claims every one of the ${s.fieldCount} fields exactly once`, () => {
      expect(loadCatalog(id).fields).toHaveLength(s.fieldCount);
      assertMapComplete(s.map);
    });

    it("every money line key exists in the real engine LINE_KEYS (no pending keys)", () => {
      assertMapKeysAreReal(s.map);
    });

    it("no field is claimed by a money line twice and no line key is mapped to two fields", () => {
      const keys = s.map.lines.filter((l) => l.kind === "money").map((l) => (l.kind === "money" ? l.line : ""));
      expect(new Set(keys).size, "a line key is shown in two fields").toBe(keys.length);
    });

    it("every money field's IRS speak text names the printed line of its engine key", () => {
      assertMoneyFieldsMatchSpeak(s.map);
    });

    it("spot check: hand-picked mapped fields match the catalog description", () => {
      assertSpeak(id, s.spot);
    });

    it("SSN, EIN, bank, PIN, preparer, address, phone, email, occupation and signature fields are blank by design", () => {
      assertPrivateFieldsNeverFilled(s.map, s.moneyFieldsWithPartCaption ?? []);
    });
  });

  describe(`${id} map: golden read-back`, () => {
    it("re-loaded values equal the hand-formatted expectation; every other field is empty / unchecked", async () => {
      const result = await assertMapGolden(s.map, s.view, s.expected);
      expect(result.filledFields.length).toBe(Object.keys(s.expected).length);
    });
  });
}
