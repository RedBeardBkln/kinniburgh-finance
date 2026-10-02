import { describe, it, expect } from "vitest";
import {
  EXTRACTION_EVENT_CAP,
  appendExtractionEvent,
  applyCorrectionSet,
  countCorrections,
  jsonEqual,
} from "@/lib/extraction-corrections";

describe("countCorrections", () => {
  it("counts fields and tolerates null / malformed JSON", () => {
    expect(countCorrections(null)).toBe(0);
    expect(countCorrections(undefined)).toBe(0);
    expect(countCorrections("x")).toBe(0);
    expect(countCorrections([])).toBe(0);
    expect(countCorrections({})).toBe(0);
    expect(countCorrections({ fields: null })).toBe(0);
    expect(countCorrections({ fields: { a: {}, b: {} } })).toBe(2);
  });
});

describe("appendExtractionEvent", () => {
  const ev = (n: number) => ({ type: "re-extracted" as const, at: `2026-10-0${n}T00:00:00.000Z`, by: "u" });

  it("creates an overlay from nothing", () => {
    expect(appendExtractionEvent(null, ev(1))).toEqual({ version: 1, fields: {}, events: [ev(1)] });
  });

  it("preserves existing corrected fields untouched", () => {
    const fields = { wagesCents: { value: 5, aiValue: 4 } };
    const out = appendExtractionEvent({ version: 1, fields, events: [] }, ev(2));
    expect(out.fields).toEqual(fields);
    expect(out.events).toEqual([ev(2)]);
  });

  it("caps events, dropping the oldest, and ignores malformed ones", () => {
    let overlay: unknown = { version: 1, fields: {}, events: [{ nonsense: true }] };
    for (let i = 0; i < EXTRACTION_EVENT_CAP + 5; i++) {
      overlay = appendExtractionEvent(overlay, { type: "corrected", at: String(i), by: "u" });
    }
    const out = overlay as { events: { at: string }[] };
    expect(out.events).toHaveLength(EXTRACTION_EVENT_CAP);
    expect(out.events[out.events.length - 1]?.at).toBe(String(EXTRACTION_EVENT_CAP + 4));
    expect(out.events[0]?.at).toBe("5");
  });
});

describe("jsonEqual", () => {
  it("compares JSON structurally, treating null and undefined alike", () => {
    expect(jsonEqual(1, 1)).toBe(true);
    expect(jsonEqual(null, undefined)).toBe(true);
    expect(jsonEqual(null, 0)).toBe(false);
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual([{ code: "D" }], [{ code: "D" }])).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
  });
});

describe("applyCorrectionSet", () => {
  const known = new Set(["wagesCents", "federalWithheldCents", "employerName", "box12"]);
  const T1 = "2026-10-02T10:00:00.000Z";
  const T2 = "2026-10-03T10:00:00.000Z";
  const ai = { wagesCents: 5000000, federalWithheldCents: 800000, employerName: "Acme", box12: null };

  it("records a correction with the AI value, who and when, plus a corrected event", () => {
    const { overlay, changed } = applyCorrectionSet(null, { wagesCents: 5100000 }, ai, known, T1, "u1");
    expect(changed).toBe(true);
    expect(overlay.fields).toEqual({
      wagesCents: { value: 5100000, aiValue: 5000000, correctedAt: T1, correctedById: "u1" },
    });
    expect(overlay.events).toEqual([{ type: "corrected", at: T1, by: "u1" }]);
  });

  it("a submitted value equal to the AI value is not a correction", () => {
    const { overlay, changed } = applyCorrectionSet(null, { wagesCents: 5000000 }, ai, known, T1, "u1");
    expect(changed).toBe(false);
    expect(overlay.fields).toEqual({});
    expect(overlay.events).toEqual([]);
  });

  it("keeps aiValue from the FIRST correction when a key is corrected again", () => {
    const first = applyCorrectionSet(null, { wagesCents: 5100000 }, ai, known, T1, "u1").overlay;
    // the AI reading changed in between (a re-extract)
    const newAi = { ...ai, wagesCents: 5050000 };
    const second = applyCorrectionSet(first, { wagesCents: 5200000 }, newAi, known, T2, "u2");
    expect(second.changed).toBe(true);
    expect(second.overlay.fields.wagesCents).toEqual({
      value: 5200000,
      aiValue: 5000000, // from the first correction, not 5050000
      correctedAt: T2,
      correctedById: "u2",
    });
  });

  it("an unchanged re-submit keeps who/when and adds no event", () => {
    const first = applyCorrectionSet(null, { wagesCents: 5100000 }, ai, known, T1, "u1").overlay;
    const again = applyCorrectionSet(first, { wagesCents: 5100000 }, ai, known, T2, "u2");
    expect(again.changed).toBe(false);
    expect(again.overlay.fields).toEqual(first.fields);
    expect(again.overlay.events).toEqual(first.events);
  });

  it("a key left out of the submitted set is reverted (removed); null is a real correction", () => {
    const first = applyCorrectionSet(
      null,
      { wagesCents: 5100000, federalWithheldCents: null },
      ai,
      known,
      T1,
      "u1"
    ).overlay;
    expect(first.fields.federalWithheldCents).toMatchObject({ value: null, aiValue: 800000 });
    const reverted = applyCorrectionSet(first, { federalWithheldCents: null }, ai, known, T2, "u1");
    expect(reverted.changed).toBe(true);
    expect(Object.keys(reverted.overlay.fields)).toEqual(["federalWithheldCents"]);
  });

  it("preserves inert entries (keys outside the current schema) instead of deleting them", () => {
    const existing = {
      version: 1,
      fields: { oldKey: { value: 1, aiValue: 2, correctedAt: T1, correctedById: "u1" } },
      events: [],
    };
    const { overlay } = applyCorrectionSet(existing, { wagesCents: 5100000 }, ai, known, T2, "u1");
    expect(overlay.fields.oldKey).toEqual(existing.fields.oldKey);
    expect(overlay.fields.wagesCents).toBeDefined();
  });

  it("compares list values structurally and does not mutate its inputs", () => {
    const existing = { version: 1, fields: {}, events: [] };
    const submitted = { box12: [{ code: "D", amountCents: 100 }] };
    const snapshot = JSON.stringify([existing, submitted, ai]);
    const { overlay } = applyCorrectionSet(existing, submitted, ai, known, T1, "u1");
    expect(overlay.fields.box12).toMatchObject({ value: [{ code: "D", amountCents: 100 }], aiValue: null });
    expect(JSON.stringify([existing, submitted, ai])).toBe(snapshot);
  });
});
