/**
 * B0 model availability probe for the AI Return Reviewer (ai-return-reviewer, Phase B).
 *
 *   node_modules/.bin/tsx scripts/tax-review/probe-models.ts [--env <path to .env>] [--models id1,id2,...]
 *
 * Makes ONE tiny call (max_tokens 16, a harmless prompt with NO tax data) per candidate model id and prints which ones
 * work. Then, for the first working id only, one tiny call with output_config.format (structured output) to learn
 * whether the model accepts it. No tax data, no database, no file is written. The API key is read from ANTHROPIC_API_KEY
 * (or from the .env file named by --env) and is never printed; only the HTTP status class / error name is shown.
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { createAnthropicTransport } from "@/lib/tax-review-anthropic";
import { runStructured } from "@/lib/tax-review/llm/client";
import { adversarialOutputSchema, findingsOutputSchema, registerOutputSchema } from "@/lib/tax-review/llm/schemas";
import { jsonSchemaFor, TASKS } from "@/lib/tax-review/llm/tasks";

const DEFAULT_CANDIDATES = ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-sonnet-5-5", "claude-opus-4-8"];

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadKeyFromEnvFile(path: string): string | undefined {
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/.exec(line);
    if (m !== null) return (m[1] ?? "").replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function describeError(err: unknown): string {
  if (err !== null && typeof err === "object" && "status" in err) return `${err instanceof Error ? err.name : "Error"} status ${String((err as { status: unknown }).status)}`;
  return err instanceof Error ? err.name : "unknown error";
}

async function main(): Promise<void> {
  const envPath = argValue("--env");
  const apiKey = process.env.ANTHROPIC_API_KEY ?? (envPath !== undefined ? loadKeyFromEnvFile(envPath) : undefined);
  if (apiKey === undefined || apiKey === "") {
    console.error("No ANTHROPIC_API_KEY (set it or pass --env <path>).");
    process.exit(1);
  }
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const candidates = (argValue("--models") ?? DEFAULT_CANDIDATES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const working: string[] = [];
  for (const model of candidates) {
    try {
      const message = await client.messages.create({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ok" }] });
      console.log(`${model}: WORKS (stop_reason ${message.stop_reason}, in ${message.usage.input_tokens}, out ${message.usage.output_tokens})`);
      working.push(model);
    } catch (err) {
      console.log(`${model}: unavailable (${describeError(err)})`);
    }
  }
  console.log(`working: ${working.join(", ") || "none"}`);
  const first = working[0];
  if (first !== undefined) {
    try {
      const message = await client.messages.create({
        model: first,
        max_tokens: 64,
        messages: [{ role: "user", content: "Give a one-word answer." }],
        output_config: {
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
          },
        },
      });
      const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      let valid = false;
      try {
        valid = typeof (JSON.parse(text) as { answer?: unknown }).answer === "string";
      } catch {
        valid = false;
      }
      console.log(`${first}: structured output (output_config.format) ${valid ? "WORKS" : "returned non-conforming text"}`);
    } catch (err) {
      console.log(`${first}: structured output FAILED (${describeError(err)})`);
    }
  }
}

/**
 * --smoke <model>: one tiny call through the REAL production transport and wrapper (streaming, output_config.format with the real findings
 * schema, effort "high") with a prompt that contains no tax data. Proves the wrapper, the transport and the schema work together.
 */
async function smoke(model: string, apiKey: string): Promise<void> {
  // one task of each output shape: findings (a1), adversarial (f1: findings + challenges), register narration (e2)
  for (const id of ["a1", "f1", "e2"] as const) {
    const task = TASKS.find((t) => t.id === id);
    if (task === undefined) throw new Error("no task");
    const schema: z.ZodType<unknown> = task.kind === "register" ? registerOutputSchema : task.kind === "adversarial" ? adversarialOutputSchema : findingsOutputSchema;
    const empty = task.kind === "register" ? "an empty entries list" : task.kind === "adversarial" ? "an empty findings list and an empty challenges list" : "an empty findings list";
    const r = await runStructured({
      transport: createAnthropicTransport(apiKey),
      request: { model, system: "You return JSON only.", user: `This is a connectivity test and there is no data. Return ${empty}.`, maxTokens: 300, jsonSchema: jsonSchemaFor(task), effort: "high" },
      schema,
      maxAttempts: 2,
      timeoutMs: 120_000,
    });
    if (r.ok) console.log(`${model} ${id}: smoke OK (streaming + structured output + effort high), in ${r.usage.inputTokens}, out ${r.usage.outputTokens}, stop ${String(r.stopReason)}`);
    else console.log(`${model} ${id}: smoke FAILED kind=${r.kind} detail=${r.detail} attempts=${r.attempts}`);
  }
}

if (process.argv.includes("--smoke")) {
  const model = argValue("--smoke") ?? "claude-opus-5-5";
  const envPath = argValue("--env");
  const key = process.env.ANTHROPIC_API_KEY ?? (envPath !== undefined ? loadKeyFromEnvFile(envPath) : undefined);
  if (key === undefined || key === "") {
    console.error("No ANTHROPIC_API_KEY.");
    process.exit(1);
  }
  smoke(model, key).catch((err: unknown) => {
    console.error("smoke failed:", describeError(err));
    process.exit(1);
  });
} else
main().catch((err: unknown) => {
  console.error("probe failed:", describeError(err));
  process.exit(1);
});
