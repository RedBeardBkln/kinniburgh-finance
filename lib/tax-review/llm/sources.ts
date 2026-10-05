// The pinned source pack and the quote verifier (ai-return-reviewer, B2; plan 5.5.4).
//
// The pack is a set of text files extracted from primary sources (irs.gov, portal.ct.gov) by scripts/tax-sources/fetch.ts and
// committed under data/tax-sources/2025/ with a manifest (url, retrievedOn, sha256). NOTHING is fetched while a review runs:
// the review reads local text only, so a quote a finding cites can be checked by code, and a law claim whose quote is not in
// the pack is stored as "unverified" and capped at medium.
//
// PURE: this module works on an in-memory `SourcePack` (lib/tax-review-sources.ts reads the files). No DB, no network, no fs.

export interface SourceManifestEntry {
  id: string;
  title: string;
  url: string;
  retrievedOn: string;
  textSha256: string;
  pages: number;
}

export interface TopicRange {
  source: string;
  /** 1-based inclusive page range; absent = the whole source. */
  pages?: [number, number];
}

export interface Topic {
  id: string;
  title: string;
  /** Review task ids that receive this topic's text. */
  tasks: string[];
  ranges: TopicRange[];
}

export interface SourcePack {
  version: 1;
  taxYear: 2025;
  manifest: SourceManifestEntry[];
  /** id -> text, pages separated by a form feed. */
  texts: Readonly<Record<string, string>>;
  topics: Topic[];
}

/** Shortest quote that counts as a citation: a short phrase would match almost anywhere. */
export const MIN_QUOTE_CHARS = 30;

/** Hyphenation marks, typographic quotes and dashes and runs of whitespace are normalised on BOTH sides before comparing. */
export function normalizeForQuote(text: string, hyphen: "keep" | "drop" = "keep"): string {
  return text
    .normalize("NFKC")
    .replace(/­/g, "")
    .replace(/[‘’‛′`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[•·]/g, " ")
    .replace(/�/g, " ")
    .replace(/-\s*\n\s*/g, hyphen === "keep" ? "-" : "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const normalizedCache = new WeakMap<object, Map<string, [string, string]>>();

/** The source text normalised twice: a line-end hyphen kept ("self-\nselect") and dropped ("re-\nturn"); a quote may match either. */
function normalizedText(pack: SourcePack, sourceId: string): [string, string] | null {
  const text = pack.texts[sourceId];
  if (text === undefined) return null;
  let perPack = normalizedCache.get(pack);
  if (perPack === undefined) {
    perPack = new Map();
    normalizedCache.set(pack, perPack);
  }
  let n = perPack.get(sourceId);
  if (n === undefined) {
    // Join pages with a space so a sentence cut by a page break still reads as one; a quote spanning a page is rare and fine.
    const joined = text.split("\f").join(" ");
    n = [normalizeForQuote(joined, "keep"), normalizeForQuote(joined, "drop")];
    perPack.set(sourceId, n);
  }
  return n;
}

export function hasSource(pack: SourcePack, sourceId: string): boolean {
  return pack.texts[sourceId] !== undefined;
}

export function sourceEntry(pack: SourcePack, sourceId: string): SourceManifestEntry | undefined {
  return pack.manifest.find((s) => s.id === sourceId);
}

/**
 * True when `quote` appears verbatim (after whitespace / typography normalisation) in the source `sourceId`. A quote shorter
 * than MIN_QUOTE_CHARS never verifies. Never throws; an unknown source is simply not verified.
 */
export function verifyQuote(pack: SourcePack, sourceId: string, quote: string | undefined | null): boolean {
  if (quote === undefined || quote === null) return false;
  const q = normalizeForQuote(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  const hay = normalizedText(pack, sourceId);
  return hay !== null && (hay[0].includes(q) || hay[1].includes(q));
}

/** Text of pages `from`..`to` (1-based, inclusive) of a source, each page prefixed with its marker. */
export function pageText(pack: SourcePack, sourceId: string, from?: number, to?: number): string {
  const text = pack.texts[sourceId];
  if (text === undefined) return "";
  const pages = text.split("\f");
  if (pages[pages.length - 1] === "") pages.pop();
  const lo = Math.max(1, from ?? 1);
  const hi = Math.min(pages.length, to ?? pages.length);
  const out: string[] = [];
  for (let p = lo; p <= hi; p += 1) out.push(`[[${sourceId} p.${p}]]\n${(pages[p - 1] ?? "").trim()}`);
  return out.join("\n\n");
}

export interface Excerpt {
  text: string;
  /** Sources and page ranges actually included (after the size cap). */
  included: { source: string; pages: [number, number] | null }[];
  truncated: boolean;
}

/**
 * The text of the topics a task needs, in topic order, cut at `maxChars` (whole ranges are dropped from the end rather than
 * cut mid-page, except a single range that alone exceeds the cap, which is cut at a page boundary).
 */
export function excerptForTopics(pack: SourcePack, topicIds: readonly string[], maxChars: number): Excerpt {
  const included: Excerpt["included"] = [];
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;
  const seen = new Set<string>();
  for (const id of topicIds) {
    const topic = pack.topics.find((t) => t.id === id);
    if (topic === undefined) continue;
    for (const r of topic.ranges) {
      const key = `${r.source}:${r.pages?.join("-") ?? "all"}`;
      if (seen.has(key) || !hasSource(pack, r.source)) continue;
      seen.add(key);
      const from = r.pages?.[0];
      const to = r.pages?.[1];
      const text = pageText(pack, r.source, from, to);
      if (used + text.length <= maxChars) {
        chunks.push(text);
        used += text.length + 2;
        included.push({ source: r.source, pages: r.pages ?? null });
        continue;
      }
      truncated = true;
      // include as many whole pages of this range as still fit
      const lo = from ?? 1;
      const hi = to ?? pack.texts[r.source]?.split("\f").length ?? lo;
      let keepTo = lo - 1;
      let acc = used;
      for (let p = lo; p <= hi; p += 1) {
        const pg = pageText(pack, r.source, p, p);
        if (acc + pg.length > maxChars) break;
        acc += pg.length + 2;
        keepTo = p;
      }
      if (keepTo >= lo) {
        chunks.push(pageText(pack, r.source, lo, keepTo));
        used = acc;
        included.push({ source: r.source, pages: [lo, keepTo] });
      }
    }
  }
  return { text: chunks.join("\n\n"), included, truncated };
}

/** Ids of every topic that feeds a task. */
export function topicsForTask(pack: SourcePack, taskId: string): string[] {
  return pack.topics.filter((t) => t.tasks.includes(taskId)).map((t) => t.id);
}

/** Hash input for the run config: the manifest text hashes (a re-pinned source changes it). */
export function sourcePackDigestInput(pack: SourcePack): string {
  return pack.manifest.map((s) => `${s.id}:${s.textSha256}`).join("|") + "#" + pack.topics.map((t) => `${t.id}:${t.tasks.join(",")}:${t.ranges.map((r) => `${r.source}${r.pages?.join("-") ?? ""}`).join(",")}`).join("|");
}
