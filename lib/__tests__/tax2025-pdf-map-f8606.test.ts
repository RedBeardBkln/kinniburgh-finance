import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { lineMeta } from "@/lib/tax2025/line-catalog";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { copiesOf, fillFormCopies, viewForCopy } from "@/lib/tax2025/pdf/copies";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { F8606_NAME_ANSWER, f8606Copies, f8606Map, f8606NameAnswerOf } from "@/lib/tax2025/pdf/maps/f8606";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { buildPacket, formInclusion } from "@/lib/tax2025/pdf";
import { ENGINE_FORM_TITLES, EXPLICIT_NO_PDF } from "@/lib/tax2025/pdf/no-pdf-forms";
import type { PdfLine, PdfReturnView } from "@/lib/tax2025/pdf/types";
import type { LineKey } from "@/lib/tax2025/types";
import { bindFiles, readPdfFile } from "@/lib/tax-review/l1/pdf-read";
import { ERIC_ID, fullFacts1b, owner } from "./tax2025-fixtures";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { engineLine, required, viewWith } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";
const NO_STAMP = { ...DEFAULT_FILL_OPTIONS, stamp: false };
const KEYS_A: LineKey[] = ["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14"];
const KEYS_B: LineKey[] = ["f8606b.1", "f8606b.2", "f8606b.3", "f8606b.14"];

const person = (keys: LineKey[], amounts: number[], status: "computed" | "not_applicable" = "computed"): Partial<Record<LineKey, PdfLine>> =>
  Object.fromEntries(keys.map((k, i) => [k, engineLine(k, amounts[i] ?? 0, status)]));

/** Eric-shaped synthetic view: taxpayer A has the four lines; taxpayer B nothing to file. */
function ericView(over: Partial<Record<LineKey, PdfLine>> = {}, answers: Record<string, string | boolean | null> = {}): PdfReturnView {
  return viewWith({
    lines: { ...person(KEYS_A, [7000, 0, 7000, 7000]), ...person(KEYS_B, [0, 0, 0, 0], "not_applicable"), ...over },
    answers: { filingStatus: "mfj", [f8606NameAnswerOf("a")]: "Alex Example", [f8606NameAnswerOf("b")]: "Sam Q Example", ...answers },
    formsRequired: { f8606: required(true, "A nondeductible contribution was made to a traditional IRA.") },
  });
}

const copyA = (view: PdfReturnView) => viewForCopy(view, copiesOf(f8606Map, view)[0]!);

registerCommonMapTests({
  map: f8606Map,
  fieldCount: 45,
  view: copyA(ericView()),
  expected: {
    [`${P1}f1_01[0]`]: "Alex Example",
    [`${P1}f1_09[0]`]: "7,000",
    [`${P1}f1_10[0]`]: "0",
    [`${P1}f1_11[0]`]: "7,000",
    [`${P1}f1_23[0]`]: "7,000",
  },
  spot: [
    [`${P1}f1_01[0]`, /Name\. If married, file a separate form for each spouse/],
    [`${P1}f1_02[0]`, /social security number/i],
    [`${P1}f1_09[0]`, /1\. Enter your nondeductible contributions to traditional I R As for 2025/],
    [`${P1}f1_10[0]`, /2\. Enter your total basis in traditional I R As/],
    [`${P1}f1_11[0]`, /3\. Add lines 1 and 2/],
    [`${P1}f1_12[0]`, /4\. Enter those contributions included on line 1 that were made/],
    [`${P1}f1_14[0]`, /6\. Enter the value of all your traditional I R As as of Dece/],
    [`${P1}f1_15[0]`, /7\. Enter your distributions from traditional I R As in 2025/],
    [`${P1}f1_22[0]`, /13\. Add lines 11 and 12/],
    [`${P1}f1_23[0]`, /14\. Subtract line 13 from line 3\. This is your total basis in traditional I R A s for 2025 and earlier years/],
    [`${P2}f2_03[0]`, /15c\. Taxable amount/],
    [`${P2}f2_06[0]`, /18\. Taxable amount\. Subtract line 17 from line 16/],
    [`${P2}f2_13[0]`, /25a\. Subtract line 24 from line 23/],
    [`${P2}f2_16[0]`, /Paid Preparer Use Only\. Print\/Type preparer's name/],
  ],
});

describe("Form 8606 map: what prints and what stays blank", () => {
  it("the map prints exactly lines 1, 2, 3 and 14 plus the name; every one of them is a taxpayer-A key", () => {
    const money = f8606Map.lines.filter((l) => l.kind === "money");
    expect(money.map((l) => (l.kind === "money" ? l.line : ""))).toEqual(KEYS_A);
    expect(money.every((l) => l.kind === "money" && l.zero === "print")).toBe(true);
    expect(f8606Map.lines.filter((l) => l.kind === "text").map((l) => (l.kind === "text" ? l.answer : ""))).toEqual([F8606_NAME_ANSWER]);
    expect(f8606Map.engineFormId).toBe("f8606");
    expect(f8606Map.header).toEqual([]);
  });

  it("each blank has a reason; lines 4-13 and 15a-15c carry the flow-box note, Parts II and III their own; the SSN, address and preparer fields are blank by design", () => {
    const by = (reason: string) => f8606Map.blank.filter((b) => b.reason === reason).length;
    expect(by("ssn")).toBe(1);
    expect(by("contact_address")).toBe(6);
    expect(by("owner_statement_na")).toBe(11 + 3 + 12); // lines 4-13 (11 boxes), 15a-15c, Parts II and III
    expect(by("preparer")).toBe(7);
    const notes = new Set(f8606Map.blank.flatMap((b) => (b.note === undefined ? [] : [b.note])));
    expect([...notes].some((n) => n.includes("completed only with a distribution from a traditional IRA or a Roth conversion"))).toBe(true);
    expect([...notes].some((n) => n.includes("Part II") && n.includes("Part III"))).toBe(true);
    for (const n of notes) expect(n).not.toMatch(/CPA/);
  });

  it("the form's lines match the printed labels found independently from the blank PDF (data/forms/2025/line-labels.json)", async () => {
    const { readFileSync } = await import("node:fs");
    const labels = JSON.parse(readFileSync("data/forms/2025/line-labels.json", "utf8")) as Record<string, Record<string, string>>;
    const table = labels["f8606"];
    expect(table).toBeDefined();
    for (const l of f8606Map.lines) {
      if (l.kind !== "money") continue;
      expect(table![l.field], l.field).toBe(lineMeta(l.line as LineKey).formLine);
    }
  });

  it("a blocked line prints nothing and raises a blocking item; a line that could not be computed is never '0' (line 2 missing_input)", async () => {
    const view = copyA(ericView({ "f8606a.2": engineLine("f8606a.2", null, "missing_input", "Needs an owner statement"), "f8606a.3": engineLine("f8606a.3", null, "missing_input", "x"), "f8606a.14": engineLine("f8606a.14", null, "missing_input", "x") }));
    const result = await fillForm("f8606", view, f8606Map, NO_STAMP);
    const fields = await readAllFields(result.bytes);
    expect(fields.get(`${P1}f1_09[0]`)).toBe("7,000");
    expect(fields.get(`${P1}f1_10[0]`)).toBe("");
    expect(fields.get(`${P1}f1_11[0]`)).toBe("");
    expect(fields.get(`${P1}f1_23[0]`)).toBe("");
    expect(result.openItems.filter((i) => i.severity === "blocking").map((i) => i.id).sort()).toEqual(["blank:f8606:f8606a.14", "blank:f8606:f8606a.2", "blank:f8606:f8606a.3"]);
  });

  it("an SSN-looking name is refused (never written); the SSN, address and preparer fields are always empty", async () => {
    const view = copyA(ericView({}, { [f8606NameAnswerOf("a")]: "123-45-6789", [F8606_NAME_ANSWER]: "123-45-6789" }));
    const bad = { ...view, answers: { ...view.answers, [F8606_NAME_ANSWER]: "123-45-6789" } };
    const result = await fillForm("f8606", bad, f8606Map, NO_STAMP);
    const fields = await readAllFields(result.bytes);
    expect(fields.get(`${P1}f1_01[0]`)).toBe("");
    for (const f of ["f1_02", "f1_03", "f1_04", "f1_05", "f1_06", "f1_07", "f1_08"]) expect(fields.get(`${P1}${f}[0]`), f).toBe("");
    for (const f of ["f2_16", "f2_17", "f2_18", "f2_19", "f2_20", "f2_21"]) expect(fields.get(`${P2}${f}[0]`), f).toBe("");
    expect(fields.get(`${P2}c2_1[0]`)).toBe(false);
  });
});

describe("Form 8606 is one form per person (copies)", () => {
  it("Eric only: exactly one copy, suffix a, with the label and Eric's name", () => {
    const copies = f8606Copies(ericView());
    expect(copies.map((c) => c.suffix)).toEqual(["a"]);
    expect(copies[0]!.label).toBe("Taxpayer A: Part I lines 1-3 and 14");
    expect(copies[0]!.answers).toEqual({ [F8606_NAME_ANSWER]: "Alex Example" });
  });

  it("both people: two copies; the B copy shows B's name and B's amounts on the printed lines (re-keyed inside the view only)", async () => {
    const view = ericView({ ...person(KEYS_B, [5000, 0, 5000, 5000]) });
    const copies = f8606Copies(view);
    expect(copies.map((c) => c.suffix)).toEqual(["a", "b"]);
    const sheets = await fillFormCopies("f8606", view, f8606Map, NO_STAMP);
    expect(sheets.map((s) => s.copy?.suffix)).toEqual(["a", "b"]);
    const [a, b] = await Promise.all(sheets.map((s) => readAllFields(s.result.bytes)));
    expect([a!.get(`${P1}f1_01[0]`), a!.get(`${P1}f1_09[0]`), a!.get(`${P1}f1_11[0]`), a!.get(`${P1}f1_23[0]`)]).toEqual(["Alex Example", "7,000", "7,000", "7,000"]);
    expect([b!.get(`${P1}f1_01[0]`), b!.get(`${P1}f1_09[0]`), b!.get(`${P1}f1_11[0]`), b!.get(`${P1}f1_23[0]`)]).toEqual(["Sam Q Example", "5,000", "5,000", "5,000"]);
    // the base view is untouched: line keys of B stay B's
    expect(view.lines["f8606b.1"]?.amount).toBe(5000);
    expect(view.lines["f8606a.1"]?.amount).toBe(7000);
  });

  it("only taxpayer B has a form: one copy, suffix b, printed from B's lines", async () => {
    const view = viewWith({
      lines: { ...person(KEYS_A, [0, 0, 0, 0], "not_applicable"), ...person(KEYS_B, [3000, 0, 3000, 3000]) },
      answers: { filingStatus: "mfj", [f8606NameAnswerOf("b")]: "Sam Q Example" },
      formsRequired: { f8606: required(true) },
    });
    const sheets = await fillFormCopies("f8606", view, f8606Map, NO_STAMP);
    expect(sheets.map((s) => s.copy?.suffix)).toEqual(["b"]);
    const fields = await readAllFields(sheets[0]!.result.bytes);
    expect([fields.get(`${P1}f1_01[0]`), fields.get(`${P1}f1_09[0]`)]).toEqual(["Sam Q Example", "3,000"]);
  });

  it("a blocked person still gets a sheet (the blanks are the point); a person with no Form 8606 (not applicable) gets none", () => {
    const view = ericView({ "f8606b.1": engineLine("f8606b.1", null, "missing_input", "x") });
    expect(f8606Copies(view).map((c) => c.suffix)).toEqual(["a", "b"]);
    expect(f8606Copies(ericView()).map((c) => c.suffix)).toEqual(["a"]);
  });

  it("nobody has a Form 8606 line at all: no copy; the packet then files one blank form only when the engine says it is needed", async () => {
    const view = viewWith({ lines: {}, answers: { filingStatus: "mfj" }, formsRequired: { f8606: required("blocking", "Cannot tell until the IRA questions are answered.") } });
    expect(f8606Copies(view)).toEqual([]);
    const sheets = await fillFormCopies("f8606", view, f8606Map, NO_STAMP);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.copy).toBeNull();
  });

  it("a name that could not be matched is left null on the copy (nothing guessed)", () => {
    const view = ericView({}, { [f8606NameAnswerOf("a")]: null });
    expect(f8606Copies(view)[0]!.answers).toEqual({ [F8606_NAME_ANSWER]: null });
  });

  it("the review's read-back binds each file to the view it was filled from (A to A's lines, B to B's)", async () => {
    const view = ericView({ ...person(KEYS_B, [5000, 0, 5000, 5000]) });
    const packet = await buildPacket(view, { maps: [f8606Map], stamp: false });
    const files = packet.files.filter((f) => f.formId === "f8606");
    expect(files.map((f) => f.name)).toEqual(["01-f8606-a.pdf", "02-f8606-b.pdf"]);
    const read = await Promise.all(files.map((f) => readPdfFile({ ...f, formId: "f8606" })));
    const bound = bindFiles({ maps: [f8606Map], view }, read);
    expect(bound.map((b) => b.view?.lines["f8606a.1"]?.amount)).toEqual([7000, 5000]);
    expect(bound.map((b) => b.file.fields.get(`${P1}f1_09[0]`))).toEqual(["7,000", "5,000"]);
  });
});

describe("Form 8606 in the packet", () => {
  it("is omitted when the engine says it is not required, included (with its reason) when it is", () => {
    expect(formInclusion(f8606Map, viewWith({ lines: {}, formsRequired: { f8606: required(false, "No nondeductible traditional IRA contribution.") } })).include).toBe(false);
    expect(formInclusion(f8606Map, ericView()).include).toBe(true);
  });

  it("the cover lists the form, each copy with its label and the three shared notes (address block, lines 4-13 and 15, Parts II and III) once each", async () => {
    const view = ericView({ ...person(KEYS_B, [5000, 0, 5000, 5000]) });
    const packet = await buildPacket(view, { maps: [f8606Map], stamp: false });
    const f = packet.forms.find((x) => x.formId === "f8606");
    expect(f?.included).toBe(true);
    expect(f?.note).toContain("2 sheet(s)");
    expect(f?.note).toContain("Taxpayer A: Part I lines 1-3 and 14");
    expect(f?.note).toContain("Taxpayer B: Part I lines 1-3 and 14");
    expect(f?.blankNotes?.length).toBe(3);
  });

  it("it is served by a registered map, so it is NOT on the explicit no-PDF list (and has an engine title)", () => {
    expect(FORM_MAPS.some((m) => m.formId === "f8606")).toBe(true);
    expect(EXPLICIT_NO_PDF).not.toContain("f8606");
    expect(ENGINE_FORM_TITLES.f8606).toBe("Form 8606 (Nondeductible IRAs)");
  });

  it("through the REAL engine and adapter: Eric's household gets f8606-a with lines 1, 2, 3 and 14 filled, his name only, nothing else", async () => {
    const f = fullFacts1b();
    const [a, b] = f.returnAnswers.people;
    a!.traditionalIraCents = owner(700_000);
    a!.coveredByWorkplacePlan = owner(false);
    a!.age50Plus = owner(false);
    b!.coveredByWorkplacePlan = owner(true);
    f.income.w2s[0]!.wagesCents = 17_000_000;
    f.household.people = [{ userId: ERIC_ID, name: "Eric Kinniburgh" }, ...f.household.people.slice(1)];
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-05T16:00:00.000Z", generatedBy: "Test" });
    expect(view.answers[f8606NameAnswerOf("a")]).toBe("Eric Kinniburgh");
    const packet = await buildPacket(view, { maps: FORM_MAPS, stamp: false });
    const files = packet.files.filter((x) => x.formId === "f8606");
    expect(files.map((x) => x.name.replace(/^\d+-/, ""))).toEqual(["f8606-a.pdf"]);
    const fields = await readAllFields(files[0]!.bytes);
    const filled = [...fields].filter(([, v]) => v !== "" && v !== false).map(([k, v]) => [k.replace("topmostSubform[0].", ""), v]);
    expect(Object.fromEntries(filled)).toEqual({
      "Page1[0].f1_01[0]": "Eric Kinniburgh",
      "Page1[0].f1_09[0]": "7,000",
      "Page1[0].f1_10[0]": "0",
      "Page1[0].f1_11[0]": "7,000",
      "Page1[0].f1_23[0]": "7,000",
    });
    // nothing the engine requires is missing from the packet's list of absent forms
    expect(packet.forms.find((x) => x.formId === "f8606")?.included).toBe(true);
  });

  it("a person whose name cannot be matched prints no name and raises an advisory item (nothing is guessed)", () => {
    const f = fullFacts1b();
    const [a, b] = f.returnAnswers.people;
    a!.traditionalIraCents = owner(700_000);
    a!.coveredByWorkplacePlan = owner(false);
    a!.age50Plus = owner(false);
    b!.coveredByWorkplacePlan = owner(true);
    f.income.w2s[0]!.wagesCents = 17_000_000;
    a!.userId = null;
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-05T16:00:00.000Z", generatedBy: "Test" });
    expect(view.answers[f8606NameAnswerOf("a")]).toBeUndefined();
    const item = view.openItems.find((i) => i.id === "adapter:f8606.name-unknown:a");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).not.toMatch(/CPA/);
  });
});
