import { describe, expect, it } from "vitest";
import { buildParams } from "@/lib/advisor/anthropic";
import { loadAdvisorConfig } from "@/lib/advisor/config";
import { toolDefinitions, sortTools } from "@/lib/advisor/tools/registry";
import { ADVISOR_TOOLS } from "@/lib/advisor/tools/all-tools";

// advisor-ai-chatbot-phase2, Decision A: strict tool schemas are OFF by default; payer-name policy follows TAX_REVIEW_PAYER_NAMES.

describe("strict tool schemas are opt-in", () => {
  it("defaults to off", () => {
    expect(loadAdvisorConfig({}).strictTools).toBe(false);
    expect(loadAdvisorConfig({ ADVISOR_STRICT_TOOLS: "" }).strictTools).toBe(false);
  });

  it("ADVISOR_STRICT_TOOLS=1 opts in; 0 / false / off / no keep it off", () => {
    expect(loadAdvisorConfig({ ADVISOR_STRICT_TOOLS: "1" }).strictTools).toBe(true);
    expect(loadAdvisorConfig({ ADVISOR_STRICT_TOOLS: "true" }).strictTools).toBe(true);
    for (const v of ["0", "false", "off", "no"]) expect(loadAdvisorConfig({ ADVISOR_STRICT_TOOLS: v }).strictTools, v).toBe(false);
  });

  it("with the default config no tool of the real set carries a strict flag; with the opt-in all do", () => {
    const base = { tools: toolDefinitions(sortTools(ADVISOR_TOOLS), { strict: true }), system: { frozen: "f", volatile: "v" }, messages: [{ role: "user" as const, content: "hi" }], userId: "u", level: 0 as const };
    const off = buildParams({ ...base, cfg: loadAdvisorConfig({}) });
    for (const t of off.tools as unknown as Record<string, unknown>[]) expect("strict" in t).toBe(false);
    const on = buildParams({ ...base, cfg: loadAdvisorConfig({ ADVISOR_STRICT_TOOLS: "1" }) });
    for (const t of on.tools as unknown as Record<string, unknown>[]) expect(t.strict).toBe(true);
  });
});

describe("payerNames", () => {
  it("defaults to keep, like the AI Return Reviewer", () => {
    expect(loadAdvisorConfig({}).payerNames).toBe("keep");
  });

  it("only the value generic hides names; anything else means keep", () => {
    expect(loadAdvisorConfig({ TAX_REVIEW_PAYER_NAMES: "generic" }).payerNames).toBe("generic");
    expect(loadAdvisorConfig({ TAX_REVIEW_PAYER_NAMES: " Generic " }).payerNames).toBe("generic");
    for (const v of ["keep", "", "off", "genericx", "1"]) expect(loadAdvisorConfig({ TAX_REVIEW_PAYER_NAMES: v }).payerNames, v).toBe("keep");
  });
});
