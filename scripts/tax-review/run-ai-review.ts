/**
 * READ-ONLY run of the AI review passes on the real TY2025 return (ai-return-reviewer, B6 recipe).
 *
 *   node_modules/.bin/tsx scripts/tax-review/run-ai-review.ts --env <path to .env>                # estimate only: builds the redacted payload, prints the cost estimate, sends NOTHING
 *   node_modules/.bin/tsx scripts/tax-review/run-ai-review.ts --env <path to .env> --yes         # runs the 13 tasks (spends API credit), prints the findings
 *   ... --out <file.json>                                                                         # also writes the result (findings, progress, register) to a local file
 *   ... --payload-out <file.json>                                                                 # writes the exact redacted payload that would be / was sent (inspect it before --yes)
 *
 * STRICTLY NO DATABASE WRITES: it reads the return the same way the Final review page does (lib/tax-review-l3.ts prepareAiReview, which
 * only reads), keeps the run in an in-memory store (MemoryRunStore) and never calls an insert, an action or the audit log. The only
 * network traffic is the model API (and only with --yes). The API key and the database url are read from the env file and are never printed.
 * The model comes from TAX_REVIEW_MODEL (default in lib/tax-review/llm/model.ts); prices for the estimate from TAX_REVIEW_PRICE_*.
 */
import { readFileSync, writeFileSync } from "node:fs";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadEnv(path: string): void {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m === null || process.env[m[1] ?? ""] !== undefined) continue;
    process.env[m[1] ?? ""] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  const envPath = argValue("--env");
  if (envPath !== undefined) loadEnv(envPath);
  const go = process.argv.includes("--yes");
  const outPath = argValue("--out");
  const payloadOut = argValue("--payload-out");

  // imported AFTER the environment is loaded (the database client reads DATABASE_URL when it is first imported)
  const { prepareAiReview } = await import("@/lib/tax-review-l3");
  const { runReviewForYear } = await import("@/lib/tax-review-build");
  const { MemoryRunStore, runAllTasks, startAiRun } = await import("@/lib/tax-review/llm/run");
  const { createAnthropicTransport } = await import("@/lib/tax-review-anthropic");
  const { foldProgress } = await import("@/lib/tax-review/llm/progress");
  const { formatUsd } = await import("@/lib/tax-review/llm/model");

  console.log("Reading the return (read-only) and running the deterministic checks...");
  const l1 = await runReviewForYear(2025, "Review script", "draft");
  if ("error" in l1) {
    console.error(`Could not build the return: ${l1.error}`);
    process.exit(1);
  }
  const prep = await prepareAiReview(2025, "Review script", l1.l1.findings);
  if ("error" in prep) {
    console.error(`Could not prepare the review: ${prep.error}`);
    process.exit(1);
  }
  const e = prep.estimate;
  console.log(`Return fingerprint ${prep.fingerprint.slice(0, 12)}; model ${prep.model}; payload ${(prep.serialized.bytes / 1024).toFixed(0)} KB (redacted).`);
  console.log(`Estimate: ${e.tasks.length} requests, ${e.inputTokens.toLocaleString("en-US")} input and ${e.outputTokens.toLocaleString("en-US")} output tokens, about ${formatUsd(e.expectedUsd)} (up to ${formatUsd(e.worstCaseUsd)}). Price basis: ${e.price.source}.`);
  if (e.warn) console.log(`WARNING: the estimate is above ${formatUsd(e.warnThresholdUsd)}.`);
  if (payloadOut !== undefined) {
    writeFileSync(payloadOut, prep.serialized.json, "utf8");
    console.log(`Wrote the redacted payload to ${payloadOut}.`);
  }
  if (!go) {
    console.log("Nothing was sent. Re-run with --yes to run the AI review.");
    return;
  }

  const store = new MemoryRunStore(() => Date.now());
  const runId = "script-run";
  await startAiRun(store, { runId, payload: prep.serialized, model: prep.model, estimate: prep.estimate, pack: prep.pack, ret: prep.ret, facts: prep.facts });
  const progress = await runAllTasks(runId, {
    store,
    transport: createAnthropicTransport(),
    pack: prep.pack,
    nowMs: () => Date.now(),
    currentFingerprint: prep.fingerprint,
    runFingerprint: prep.fingerprint,
    timeoutMs: 240_000,
  });
  const final = foldProgress(await store.listEvents(runId), Date.now());
  const findings = await store.listL3Findings();
  console.log(`\nStatus: ${final.status}; ${final.completedCount} of ${final.totalCount} tasks; ${final.usage.inputTokens.toLocaleString("en-US")} input and ${final.usage.outputTokens.toLocaleString("en-US")} output tokens; about ${formatUsd(final.costUsdSoFar ?? 0)}.`);
  for (const t of progress.tasks) console.log(`  ${t.id} ${t.title}: ${t.state}, ${t.findingCount} findings, ${t.rejectedCount} set aside, ${t.unverifiedCount} unverified${t.failures > 0 ? `, ${t.failures} failed` : ""}`);
  console.log(`\n${findings.length} L3 findings:`);
  for (const f of findings) console.log(`- [${f.severity}${f.downgradedFrom !== undefined ? ` (was ${f.downgradedFrom})` : ""}] ${f.check} ${f.lineKey ?? ""} (${f.citation.sourceStatus}): ${f.message}`);
  if (final.challenges.length > 0) console.log(`\n${final.challenges.length} challenge(s) from the adversarial pass.`);
  if (outPath !== undefined) {
    writeFileSync(outPath, JSON.stringify({ progress: final, findings, register: final.narratedRegister ?? prep.register }, null, 2), "utf8");
    console.log(`Wrote the result to ${outPath}.`);
  }
}

main().catch((err: unknown) => {
  console.error("run failed:", err instanceof Error ? err.name : "unknown error");
  process.exit(1);
});
