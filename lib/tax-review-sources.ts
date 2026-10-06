import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SourcePack } from "@/lib/tax-review/llm/sources";

// Reads the committed source pack (data/tax-sources/2025/: manifest.json, topics.json and one <id>.txt per source) into the
// in-memory shape lib/tax-review/llm/sources.ts works on. Local files only: nothing is fetched at review time (the pack is
// refreshed by scripts/tax-sources/fetch.ts, a deliberate, reviewed change). Server-side only; no DB, no auth.

const manifestSchema = z.object({
  version: z.literal(1),
  taxYear: z.literal(2025),
  sources: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), retrievedOn: z.string(), textSha256: z.string(), pages: z.number().int() }).passthrough()),
});

const topicsSchema = z.object({
  version: z.literal(1),
  topics: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      tasks: z.array(z.string()),
      ranges: z.array(z.object({ source: z.string(), pages: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional() })),
    })
  ),
});

let cache: SourcePack | null = null;

export function sourcePackDir(): string {
  return path.join(process.cwd(), "data", "tax-sources", "2025");
}

/** A text file of the pack does not hash to the value the manifest pins: it was edited (or re-issued) without re-pinning. */
export class SourcePackIntegrityError extends Error {
  readonly sourceIds: readonly string[];
  constructor(sourceIds: readonly string[]) {
    super(`source pack text differs from the manifest: ${sourceIds.join(", ")}`);
    this.name = "SourcePackIntegrityError";
    this.sourceIds = sourceIds;
  }
}

/**
 * The committed source pack (read once per process). Throws if a file is missing or malformed, or if a text file does not hash to the
 * sha256 the manifest pins (same formula as scripts/tax-sources/fetch.ts: the text without carriage returns): the review must not run
 * without the pinned law text, and the reuse of an earlier review's results identifies the pack by the manifest hashes, so a hand-edited
 * text with an unchanged manifest must never be accepted as that pack.
 */
export function loadSourcePack(dir: string = sourcePackDir()): SourcePack {
  if (cache !== null && dir === sourcePackDir()) return cache;
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")));
  const topics = topicsSchema.parse(JSON.parse(readFileSync(path.join(dir, "topics.json"), "utf8")));
  const texts: Record<string, string> = {};
  const mismatched: string[] = [];
  for (const s of manifest.sources) {
    const text = readFileSync(path.join(dir, `${s.id}.txt`), "utf8").replace(/\r/g, "");
    if (createHash("sha256").update(text, "utf8").digest("hex") !== s.textSha256) mismatched.push(s.id);
    texts[s.id] = text;
  }
  if (mismatched.length > 0) throw new SourcePackIntegrityError(mismatched);
  const pack: SourcePack = {
    version: 1,
    taxYear: 2025,
    manifest: manifest.sources.map((s) => ({ id: s.id, title: s.title, url: s.url, retrievedOn: s.retrievedOn, textSha256: s.textSha256, pages: s.pages })),
    texts,
    topics: topics.topics,
  };
  if (dir === sourcePackDir()) cache = pack;
  return pack;
}
