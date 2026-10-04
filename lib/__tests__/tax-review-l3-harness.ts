// Test harness for the AI review passes (ai-return-reviewer, Phase B). NOT a test file (no .test suffix).
//
// Builds the same inputs production builds (a computed return, its effective view, the packet read back from its PDF bytes) from the
// synthetic "Eric-shaped" rich fixture, serialises the redacted payload, and provides a mock model transport. No live call is ever
// made from a test: the mock returns canned structured outputs.

import { loadSourcePack } from "@/lib/tax-review-sources";
import { bindFiles, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { runL1 } from "@/lib/tax-review/l1/run-l1";
import { LlmTransportError, type LlmRequest, type LlmResponse, type LlmTransport } from "@/lib/tax-review/llm/client";
import { priceFromEnv } from "@/lib/tax-review/llm/model";
import { buildReviewPayload, serializePayload, type ReviewPayload, type SerializedPayload } from "@/lib/tax-review/llm/payload";
import { estimateAiRun } from "@/lib/tax-review/llm/run";
import { buildRegister, type RegisterEntry } from "@/lib/tax-review/llm/register";
import type { ScrubConfig } from "@/lib/tax-review/llm/scrub";
import type { Finding } from "@/lib/tax-review/types";
import { buildPipeline, richScenario, type Pipeline } from "./tax-review-harness";
import { ERIC_ID, EVA_ID } from "./tax2025-fixtures";

export const PEOPLE = [
  { userId: ERIC_ID, name: "Eric Sample" },
  { userId: EVA_ID, name: "Eva Sample" },
];

export const SCRUB: ScrubConfig = {
  entities: [{ name: "Sample Consulting, LLC", label: "the Consulting LLC", aliases: ["EK Consulting"] }],
  addresses: [{ address: "27 Old Barry Rd", label: "the primary residence" }],
};

export interface L3Fixture {
  pipeline: Pipeline;
  payload: ReviewPayload;
  serialized: SerializedPayload;
  l1Findings: Finding[];
  register: RegisterEntry[];
}

let cached: Promise<L3Fixture> | null = null;

/** The rich scenario's redacted payload (built once per test file). */
export function richFixture(): Promise<L3Fixture> {
  if (cached === null) {
    cached = (async () => {
      const pipeline = await buildPipeline(richScenario());
      const read = await readPacketFiles(pipeline.ctx.packet.files);
      const bindings = bindFiles(pipeline.ctx, read);
      const l1 = await runL1(pipeline.ctx);
      const payload = buildReviewPayload(
        {
          ret: pipeline.ret,
          view: pipeline.ctx.view,
          facts: pipeline.ctx.facts,
          documents: (pipeline.ctx.raw?.documents ?? []).map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, extractionStatus: d.extractionStatus, subjectType: d.subjectType, subjectUserId: d.subjectUserId })),
          bindings,
          l1Findings: l1.findings,
          entityLabels: SCRUB.entities.map((e) => e.label),
        },
        PEOPLE
      );
      const serialized = serializePayload(payload, PEOPLE, SCRUB);
      return { pipeline, payload: serialized.payload, serialized, l1Findings: l1.findings, register: buildRegister({ ret: pipeline.ret, facts: pipeline.ctx.facts }) };
    })();
  }
  return cached;
}

export function estimateFor(f: L3Fixture, model = "claude-opus-5-5") {
  return estimateAiRun(f.payload, loadSourcePack(), priceFromEnv({}), model, f.register);
}

// ── mock transport ────────────────────────────────────────────────────────────

export type MockHandler = (request: LlmRequest, call: number) => LlmResponse | LlmTransportError | Promise<LlmResponse | LlmTransportError>;

export class MockTransport implements LlmTransport {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly handler: MockHandler) {}
  async send(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    const r = await this.handler(request, this.calls.length);
    if (r instanceof LlmTransportError) throw r;
    return r;
  }
}

export function ok(value: unknown, usage = { inputTokens: 1000, outputTokens: 200 }): LlmResponse {
  return { text: JSON.stringify(value), stopReason: "end_turn", usage, model: "mock-model" };
}

/** Which task a request belongs to ("Task a1 (...)" is the first words of the instruction). */
export function taskOf(request: LlmRequest): string {
  return /^Task ([a-f][0-9])/.exec(request.user)?.[1] ?? "?";
}

/** A finding as the model would write it, anchored on a real line of the payload (amounts copied exactly). */
export function finding(payload: ReviewPayload, over: Record<string, unknown> = {}, lineKey = "f1040.9"): Record<string, unknown> {
  const line = payload.lines.find((l) => l.key === lineKey) ?? payload.lines.find((l) => l.amount !== null && l.amount > 1000);
  if (line === undefined) throw new Error("no line to anchor a finding on");
  return {
    category: "other",
    severity: "medium",
    area: "income",
    form: "f1040",
    lineKey: line.key,
    message: `Check ${line.label}: the amount looks different from what the documents show.`,
    evidence: [{ ref: line.key, amount: line.amount }],
    sources: [],
    legalClaim: false,
    recommendedAction: "Compare this line with the documents before filing.",
    ...over,
  };
}

/** A transport whose every task answers with `byTask(taskId)` (default: no findings; e2 narrates nothing; f1 has no challenges). */
export function scriptedTransport(byTask: (task: string, request: LlmRequest, call: number) => unknown | LlmTransportError): MockTransport {
  return new MockTransport((req, call) => {
    const task = taskOf(req);
    const out = byTask(task, req, call);
    if (out instanceof LlmTransportError) return out;
    if (out !== undefined) return ok(out);
    if (task === "f1") return ok({ findings: [], challenges: [] });
    if (task === "e2") return ok({ entries: [] });
    return ok({ findings: [] });
  });
}
