import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadSourcePack } from "@/lib/tax-review-sources";
import { indexPayload, type ReviewPayload } from "@/lib/tax-review/llm/payload";
import { applyNarrations, figuresIn, numbersIn, validateChallenges, validateFindings, type ValidationContext } from "@/lib/tax-review/llm/validate";
import { adversarialJsonSchema, findingsJsonSchema, modelFindingSchema, registerJsonSchema } from "@/lib/tax-review/llm/schemas";
import { jsonSchemaFor, promptHash, SYSTEM_PROMPT, TASKS, taskPromptHash, type TaskDef } from "@/lib/tax-review/llm/tasks";
import { gateSnapshot, evaluateGate, isGatingFinding, findingStatus } from "@/lib/tax-review/gate";
import { buildRegister } from "@/lib/tax-review/llm/register";
import { finding, richFixture, type L3Fixture } from "./tax-review-l3-harness";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Golden-finding tests for the validators (ai-return-reviewer, B3; plan 9.3 a-e, i, k, l): what the model returns is checked by code.

let fx: L3Fixture;
let payload: ReviewPayload;
let ctx: ValidationContext;
const pack = loadSourcePack();
const QUOTE = "If you are filing a joint return, your spouse must also sign.";

beforeAll(async () => {
  fx = await richFixture();
  payload = fx.payload;
  ctx = { pass: "deductions", categories: ["eligibility", "limit_or_phaseout", "wrong_amount", "other"], index: indexPayload(payload), pack, excerptNumbers: new Set() };
});

const one = (over: Record<string, unknown> = {}, lineKey?: string) => validateFindings([finding(payload, over, lineKey)], ctx);

describe("line and value existence (a, b)", () => {
  it("a finding citing a line that does not exist is rejected, kept only as a reason class", () => {
    const r = one({ lineKey: "f1040.999", evidence: [] });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([{ reason: "unknown_line", category: "other" }]);
    const r2 = one({ evidence: [{ ref: "f1040.999", amount: 5 }] });
    expect(r2.rejected[0]?.reason).toBe("unknown_line");
  });
  it("an evidence amount that differs from the payload's value is rejected", () => {
    const line = payload.lines.find((l) => l.key === "f1040.9");
    const r = one({ evidence: [{ ref: "f1040.9", amount: (line?.amount ?? 0) + 1 }] });
    expect(r.rejected[0]?.reason).toBe("value_mismatch");
    expect(one({ evidence: [{ ref: "f1040.9", amount: null }] }).rejected[0]?.reason).toBe("value_mismatch");
  });
  it("an exact amount, a document reference, a headline row and a reference to a line with no amount are accepted", () => {
    expect(one().accepted).toHaveLength(1);
    const doc = payload.documents.find((d) => d.usedBy.includes("w2"));
    const w2 = payload.income.w2[0];
    expect(doc).toBeDefined();
    const withDoc = one({ evidence: [{ ref: `doc:${String(w2?.["doc"])}`, amount: (w2?.["box1"] as number) ?? null }] });
    expect(withDoc.accepted).toHaveLength(1);
    expect(withDoc.accepted[0]?.evidence[0]?.ref.startsWith("doc:")).toBe(true);
    expect(one({ evidence: [{ ref: "head:agi", amount: payload.headline["agi"]?.amount ?? null }] }).accepted).toHaveLength(1);
    expect(one({ evidence: [{ ref: "doc:zzzzzzzz", amount: null }] }).rejected[0]?.reason).toBe("unknown_ref");
    expect(one({ evidence: [{ ref: "head:bogus", amount: null }] }).rejected[0]?.reason).toBe("unknown_ref");
    expect(one({ evidence: [{ ref: "pdf:f1040:x", amount: null }] }).rejected[0]?.reason).toBe("unknown_ref");
  });
  it("a document amount that is not one of that document's numbers is rejected", () => {
    const w2 = payload.income.w2[0];
    const r = one({ evidence: [{ ref: `doc:${String(w2?.["doc"])}`, amount: 987_654 }] });
    expect(r.rejected[0]?.reason).toBe("value_mismatch");
  });
  it("a malformed finding is rejected as schema, one bad finding does not drop the others", () => {
    const r = validateFindings([{ nonsense: true }, finding(payload), "text", null], ctx);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason)).toEqual(["schema", "schema", "schema"]);
  });
});

describe("citations: law claims need a source the code can check (c, d)", () => {
  it("a law claim with no source is stored as unverified, capped at medium, original severity kept, and it still gates (D2)", () => {
    const r = one({ severity: "high", legalClaim: true, sources: [] });
    const f = r.accepted[0];
    expect(f?.severity).toBe("medium");
    expect(f?.downgradedFrom).toBe("high");
    expect(f?.citation.sourceStatus).toBe("unverified");
    expect(r.unverified).toBe(1);
    expect(r.downgraded).toBe(1);
    expect(f !== undefined && isGatingFinding(f)).toBe(true);
    expect(f !== undefined && findingStatus(f, [])).toBe("open");
  });
  it("a quote that is not in the pinned source is unverified; a verbatim quote verifies", () => {
    const bad = one({ severity: "high", legalClaim: true, sources: [{ kind: "source_pack", id: "i1040gi", quote: "Both spouses should always sign every joint return in black ink." }] });
    expect(bad.accepted[0]?.citation.sourceStatus).toBe("unverified");
    const good = one({ severity: "high", legalClaim: true, sources: [{ kind: "source_pack", id: "i1040gi", quote: QUOTE }] });
    expect(good.accepted[0]?.citation.sourceStatus).toBe("verified");
    expect(good.accepted[0]?.severity).toBe("high");
    expect(good.accepted[0]?.citation.sources[0]?.url).toMatch(/irs\.gov/);
    const wrongSource = one({ severity: "high", legalClaim: true, sources: [{ kind: "source_pack", id: "i8960", quote: QUOTE }] });
    expect(wrongSource.accepted[0]?.citation.sourceStatus).toBe("unverified");
    const unknownSource = one({ legalClaim: true, sources: [{ kind: "source_pack", id: "nope", quote: QUOTE }] });
    expect(unknownSource.accepted[0]?.citation.sourceStatus).toBe("unverified");
  });
  it("a constant id that exists verifies; one that does not is unverified", () => {
    expect(one({ legalClaim: true, sources: [{ kind: "constant", id: "STANDARD_DEDUCTION_MFJ", quote: null }] }).accepted[0]?.citation.sourceStatus).toBe("verified");
    expect(one({ legalClaim: true, sources: [{ kind: "constant", id: "MADE_UP_CONSTANT", quote: null }] }).accepted[0]?.citation.sourceStatus).toBe("unverified");
  });
  it("a form-text quote verifies only against the printed form text of the payload", () => {
    const row = payload.forms.find((f) => f.formId === "f1040")?.rows[0];
    expect(row).toBeDefined();
    const label = `${row?.label ?? ""} ${row?.printed ?? ""}`;
    expect(one({ legalClaim: true, sources: [{ kind: "form_text", id: "f1040", quote: label }] }).accepted[0]?.citation.sourceStatus).toBe("verified");
    expect(one({ legalClaim: true, sources: [{ kind: "form_text", id: "f1040", quote: "text that is not on any form" }] }).accepted[0]?.citation.sourceStatus).toBe("unverified");
  });
  it("spec and heuristic citations cannot verify a law claim", () => {
    expect(one({ legalClaim: true, sources: [{ kind: "spec09", id: "specs/09", quote: QUOTE }] }).accepted[0]?.citation.sourceStatus).toBe("unverified");
    expect(one({ legalClaim: true, sources: [{ kind: "heuristic", id: "gut feeling", quote: null }] }).accepted[0]?.citation.sourceStatus).toBe("unverified");
  });
  it("a claim that is not about the law needs no source (not applicable)", () => {
    expect(one({ legalClaim: false }).accepted[0]?.citation.sourceStatus).toBe("not_applicable");
  });
});

describe("severity guards", () => {
  it("the model cannot emit a blocker unless a law claim is verified", () => {
    expect(one({ severity: "blocker", legalClaim: false }).accepted[0]?.severity).toBe("high");
    expect(one({ severity: "blocker", legalClaim: false }).accepted[0]?.downgradedFrom).toBe("blocker");
    expect(one({ severity: "blocker", legalClaim: true, sources: [] }).accepted[0]?.severity).toBe("medium");
    const ok = one({ severity: "blocker", legalClaim: true, sources: [{ kind: "source_pack", id: "i1040gi", quote: QUOTE }] });
    expect(ok.accepted[0]?.severity).toBe("blocker");
  });
  it("a serious finding that points at nothing in the return is unverified and capped", () => {
    const r = one({ severity: "high", lineKey: null, evidence: [], legalClaim: false });
    expect(r.accepted[0]?.severity).toBe("medium");
    expect(r.accepted[0]?.citation.sourceStatus).toBe("unverified");
    expect(r.accepted[0]?.downgradedFrom).toBe("high");
  });
  it("an L3 finding is always acceptable, deterministic-looking fields are forced, and stray keys are stripped (i)", () => {
    const r = validateFindings([{ ...finding(payload), status: "accepted", acceptable: false, layer: "L1", gate: "passed", verdict: "PASSED", severity: "info" }], ctx);
    const f = r.accepted[0];
    expect(f?.layer).toBe("L3");
    expect(f?.acceptable).toBe(true);
    expect(f?.origin).toBe("llm");
    expect(JSON.stringify(f)).not.toMatch(/PASSED|"verdict"|"gate"|"status":"accepted"/);
    expect(modelFindingSchema.safeParse({ ...finding(payload), status: "accepted" }).success).toBe(true);
  });
  it("an unknown category becomes 'other'; the check id names the pass and the category", () => {
    expect(one({ category: "free_text_category" }).accepted[0]?.check).toBe("L3.deductions.other");
    expect(one({ category: "eligibility" }).accepted[0]?.check).toBe("L3.deductions.eligibility");
  });
  it("duplicates (same pass, category, line, first reference) collapse to the more serious one", () => {
    const r = validateFindings([finding(payload, { severity: "low" }), finding(payload, { severity: "high", message: "A second report of the same thing on this line." })], ctx);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]?.severity).toBe("high");
  });
  it("the finding key is stable: the same defect worded differently is the same finding", () => {
    const a = one({ message: "The amount on this line looks wrong compared to the documents." }).accepted[0];
    const b = one({ message: "Line total seems inconsistent with the source documents." }).accepted[0];
    expect(a?.key).toBeDefined();
    expect(a?.key).toBe(b?.key);
  });
});

describe("dollar-figure guard (e)", () => {
  const agi = (): number => payload.lines.find((l) => l.key === "f1040.11a")?.amount ?? 0;
  it("a figure in the payload is fine", () => {
    const r = one({ message: `AGI is $${agi().toLocaleString("en-US")} on the return; check it against the documents.` });
    expect(r.accepted[0]?.citation.sourceStatus).toBe("not_applicable");
    expect(r.unverified).toBe(0);
  });
  it("a figure that is not in the payload downgrades the finding to unverified", () => {
    const r = one({ severity: "high", message: "You will owe an extra $98,765 in tax because of this line." });
    expect(r.accepted[0]?.citation.sourceStatus).toBe("unverified");
    expect(r.accepted[0]?.severity).toBe("medium");
    expect(r.accepted[0]?.message).toMatch(/not in the return data/);
  });
  it("a sum or a difference of the amounts the finding cites is allowed", () => {
    const a = payload.lines.find((l) => l.key === "f1040.9")?.amount ?? 0;
    const b = payload.lines.find((l) => l.key === "f1040.11a")?.amount ?? 0;
    const r = one({ message: `Line 9 is $${(a - b).toLocaleString("en-US")} different from AGI.`, evidence: [{ ref: "f1040.9", amount: a }, { ref: "f1040.11a", amount: b }] });
    expect(r.unverified).toBe(0);
  });
  it("a law figure that appears in the quoted source text given to the task is allowed", () => {
    const extra = { ...ctx, excerptNumbers: numbersIn("The threshold is $1,234,567 for this purpose.") };
    const r = validateFindings([finding(payload, { message: "The limit of $1,234,567 may apply here, per the instructions." })], extra);
    expect(r.unverified).toBe(0);
    expect(validateFindings([finding(payload, { message: "The limit of $7,654,321 may apply here, per the instructions." })], extra).unverified).toBe(1);
  });
  it("figuresIn / numbersIn parse money-looking numbers", () => {
    expect(figuresIn("pay $1,234.56 and 273,291 and $5")).toEqual([1234.56, 273291, 5]);
    expect(figuresIn("no money here, 12 items")).toEqual([]);
    expect([...numbersIn("a 1,000 b 2.5")].sort()).toEqual([1000, 2.5]);
  });
});

describe("identifier-shaped text in what the model returns", () => {
  it("a finding whose text looks like an SSN, an EIN or a long number is dropped and counted", () => {
    for (const text of ["Taxpayer SSN 123-45-6789 appears twice.", "Check the account 1234567890123 against the statement.", "The employer 12-3456789 is listed twice on the return."]) {
      const r = one({ message: text });
      expect(r.accepted).toEqual([]);
      expect(r.privacyDropped).toBe(1);
      expect(r.rejected).toEqual([]);
    }
    expect(one({ sources: [{ kind: "source_pack", id: "i1040gi", quote: "123-45-6789 is not a quote" }] }).privacyDropped).toBe(1);
    expect(one({ recommendedAction: "Call 123456789 now to fix this please." }).privacyDropped).toBe(1);
  });
});

describe("wording", () => {
  it("a finding never says CPA: owner wording is applied before it is stored", () => {
    const r = one({ message: "This needs the CPA to decide whether the expense is deductible.", recommendedAction: "Ask the CPA about this line before filing." });
    expect(r.accepted[0]?.message).not.toMatch(/\bCPA\b/);
    expect(r.accepted[0]?.recommendedAction).not.toMatch(/\bCPA\b/);
  });
});

describe("challenges (adversarial pass): annotation only", () => {
  const known = new Set(["a".repeat(16), "b".repeat(16)]);
  it("keeps challenges against known finding keys, one per key, drops identifiers", () => {
    const out = validateChallenges(
      [
        { findingKey: "a".repeat(16), note: "The finding misreads the line it cites." },
        { findingKey: "a".repeat(16), note: "A second note about the same finding." },
        { findingKey: "c".repeat(16), note: "Unknown finding key." },
        { findingKey: "b".repeat(16), note: "Contains 123-45-6789 inside the note." },
        { findingKey: "nonsense", note: "bad key" },
      ],
      known
    );
    expect(out).toEqual([{ findingKey: "a".repeat(16), note: "The finding misreads the line it cites." }]);
  });
});

describe("register narration (e2)", () => {
  it("only existing entries can be narrated; id, topic, dollar impact, status and who decides are never taken from the model", () => {
    const entries = fx.register;
    expect(entries.length).toBeGreaterThan(0);
    const e = entries[0];
    if (e === undefined) throw new Error("no entry");
    const out = applyNarrations(entries, [{ id: e.id, recommendedPosition: "Use the conservative position until you decide.", alternative: null, rationale: "Because the rule is not settled.", sources: [{ kind: "constant", id: "STANDARD_DEDUCTION_MFJ", quote: null }] }, { id: "decision:X99", recommendedPosition: "Invented entry that does not exist.", alternative: null, rationale: null, sources: [] }, { id: e.id, recommendedPosition: "A second narration of the same entry here.", alternative: null, rationale: null, sources: [] }], ctx);
    expect(out.narrated).toBe(1);
    expect(out.rejected).toBe(2);
    expect(out.entries).toHaveLength(entries.length);
    const n = out.entries[0];
    expect(n?.narrated).toBe(true);
    expect(n?.recommendedPosition).toBe("Use the conservative position until you decide.");
    expect(n?.dollarImpact).toEqual(e.dollarImpact);
    expect(n?.status).toBe(e.status);
    expect(n?.whoDecides).toBe("Eric");
    expect(n?.topic).toBe(e.topic);
  });
  it("an invented dollar figure or an identifier in a narration rejects it", () => {
    const e = fx.register[0];
    if (e === undefined) throw new Error("no entry");
    const bad = applyNarrations(fx.register, [{ id: e.id, recommendedPosition: "This will save you $87,654 in tax if you choose it.", alternative: null, rationale: null, sources: [] }, { id: e.id, recommendedPosition: "Call 123-45-6789 about the position please.", alternative: null, rationale: null, sources: [] }], ctx);
    expect(bad.narrated).toBe(0);
    expect(bad.rejected).toBe(2);
    expect(bad.entries[0]?.narrated).toBe(false);
  });
  it("an unverifiable quote is kept as an unverified source, never as verified", () => {
    const e = fx.register[0];
    if (e === undefined) throw new Error("no entry");
    const out = applyNarrations(fx.register, [{ id: e.id, recommendedPosition: "Use the conservative position until you decide.", alternative: null, rationale: null, sources: [{ kind: "source_pack", id: "i1040gi", quote: "A sentence the instructions never contain anywhere at all." }, { kind: "source_pack", id: "i1040gi", quote: QUOTE }] }], ctx);
    const sources = out.entries[0]?.sources.filter((s) => s.kind === "source_pack") ?? [];
    expect(sources.map((s) => s.verified)).toEqual([false, true]);
  });
});

describe("prompts and schemas (k, l)", () => {
  it("the prompt hash changes when any prompt, category list, schema or token budget changes", () => {
    const base = promptHash();
    const t: TaskDef = { ...TASKS[0]!, instruction: `${TASKS[0]!.instruction} x` };
    expect(taskPromptHash(t)).not.toBe(taskPromptHash(TASKS[0]!));
    expect(taskPromptHash({ ...TASKS[0]!, categories: [...TASKS[0]!.categories, "extra"] })).not.toBe(taskPromptHash(TASKS[0]!));
    expect(taskPromptHash({ ...TASKS[0]!, maxTokens: TASKS[0]!.maxTokens + 1 })).not.toBe(taskPromptHash(TASKS[0]!));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(promptHash()).toBe(base);
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(500);
  });
  it("every task has a distinct id and its JSON schema is strict at every object level", () => {
    expect(new Set(TASKS.map((x) => x.id)).size).toBe(TASKS.length);
    expect(TASKS).toHaveLength(13);
    const strict = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(strict);
      const o = node as Record<string, unknown>;
      if (o["type"] === "object") {
        expect(o["additionalProperties"]).toBe(false);
        expect([...(o["required"] as string[])].sort()).toEqual(Object.keys(o["properties"] as object).sort());
      }
      for (const v of Object.values(o)) strict(v);
    };
    for (const t of TASKS) strict(jsonSchemaFor(t));
    strict(registerJsonSchema());
    strict(adversarialJsonSchema(["x"]));
    strict(findingsJsonSchema(["x"]));
  });
  it("a finding the schema describes round-trips through the model-finding schema", () => {
    const f = finding(payload, { category: "eligibility", sources: [{ kind: "constant", id: "STANDARD_DEDUCTION_MFJ", quote: null }], legalClaim: true });
    expect(modelFindingSchema.safeParse(f).success).toBe(true);
    const schema = findingsJsonSchema(["eligibility"]) as { properties: { findings: { items: { properties: Record<string, unknown>; required: string[] } } } };
    expect(Object.keys(f).sort()).toEqual([...schema.properties.findings.items.required].sort());
  });
  it("the finding categories in a task's schema are the ones its validator accepts", () => {
    for (const t of TASKS.filter((x) => x.kind !== "register")) {
      const json = JSON.stringify(jsonSchemaFor(t));
      for (const c of t.categories) expect(json).toContain(`"${c}"`);
    }
  });
});

describe("the model can only add: a pile of findings changes the verdict only by adding open items (gate integration)", () => {
  it("L3 findings are open and counted by the gate, never accepted and never closing anything", () => {
    const r = validateFindings([finding(payload, { severity: "high" }), finding(payload, { severity: "medium", category: "wrong_amount" })], ctx);
    const gate = evaluateGate({
      runFingerprint: "f".repeat(64),
      currentFingerprint: "f".repeat(64),
      engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
      findings: r.accepted,
      dispositions: [],
      l1: { status: "completed" },
      l2: { status: "completed", coverageListed: true },
      l3: { status: "completed", adversarialCompleted: true },
    });
    expect(gate.verdict).toBe("flagged");
    expect(gate.openGating.map((o) => o.layer)).toEqual(["L3"]);
    expect(gateSnapshot(gate).openGating).toBe(1);
    expect(buildRegister({ ret: fx.pipeline.ret, facts: fx.pipeline.ctx.facts }).length).toBe(fx.register.length);
  });
});
