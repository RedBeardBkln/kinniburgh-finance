import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hostAllowed, SOURCES } from "../../scripts/tax-sources/fetch";
import { loadSourcePack, sourcePackDir } from "@/lib/tax-review-sources";
import { excerptForTopics, hasSource, MIN_QUOTE_CHARS, normalizeForQuote, pageText, sourcePackDigestInput, topicsForTask, verifyQuote, type SourcePack } from "@/lib/tax-review/llm/sources";
import { TASK_IDS } from "@/lib/tax-review/llm/tasks";
import { INFO_CARDS, verifyCard, verifyCards } from "@/lib/tax-review/info-cards";

// The pinned source pack (ai-return-reviewer, B2): manifest hashes, size, network allow-list, quote verifier, topics, info cards.

const pack = loadSourcePack();
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

describe("source pack files", () => {
  it("every source's text file hashes to the manifest value (a hand edit or a silent re-issue fails here)", () => {
    for (const s of pack.manifest) {
      const text = readFileSync(path.join(sourcePackDir(), `${s.id}.txt`), "utf8").replace(/\r/g, "");
      expect(sha(text), s.id).toBe(s.textSha256);
    }
  });
  it("the manifest lists exactly the sources the fetch script pins, with their urls", () => {
    expect(pack.manifest.map((s) => s.id).sort()).toEqual(SOURCES.map((s) => s.id).sort());
    for (const spec of SOURCES) expect(pack.manifest.find((m) => m.id === spec.id)?.url).toBe(spec.url);
  });
  it("the pack is small: under 10 MB in total, and every file is a pinned one", () => {
    let total = 0;
    for (const f of readdirSync(sourcePackDir())) total += statSync(path.join(sourcePackDir(), f)).size;
    expect(total).toBeLessThan(10 * 1024 * 1024);
    const names = readdirSync(sourcePackDir()).sort();
    expect(names).toEqual([...pack.manifest.map((s) => `${s.id}.txt`), "manifest.json", "topics.json"].sort());
  });
  it("every pinned url is https on irs.gov or portal.ct.gov and nothing else is allowed", () => {
    for (const s of SOURCES) expect(hostAllowed(s.url), s.url).toBe(true);
    expect(hostAllowed("http://www.irs.gov/pub/x.pdf")).toBe(false);
    expect(hostAllowed("https://evil.example.com/irs.gov/x.pdf")).toBe(false);
    expect(hostAllowed("https://www.irs.gov.evil.com/x.pdf")).toBe(false);
    expect(hostAllowed("https://portal.ct.gov/-/media/x.pdf")).toBe(true);
    expect(hostAllowed("not a url")).toBe(false);
  });
  it("the deployed Final review page ships the pack (the file tracer cannot see the dynamic paths)", () => {
    const cfg = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
    expect(cfg).toMatch(/"\/tax\/forms\/\*\*": \[[^\]]*"\.\/data\/tax-sources\/\*\*\/\*"/);
    expect(cfg).toMatch(/"\/api\/tax\/forms\/\*\*": \["\.\/data\/forms\/\*\*\/\*"\]/);
  });
  it("the fetch script only downloads from the allow-list (source scan) and writes nothing outside data/tax-sources", () => {
    const src = readFileSync(path.join(process.cwd(), "scripts", "tax-sources", "fetch.ts"), "utf8");
    expect(src).toContain("ALLOWED_HOSTS");
    expect(src).toMatch(/redirect to a host that is not on the allow-list/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/prisma|@\/lib\/db/);
  });
});

describe("quote verifier", () => {
  const sentence = "If you are filing a joint return, your spouse must also sign.";
  it("accepts a verbatim quote, ignoring whitespace, case and typographic quotes", () => {
    expect(verifyQuote(pack, "i1040gi", sentence)).toBe(true);
    expect(verifyQuote(pack, "i1040gi", "if you are filing a   joint return,\nyour spouse must also sign.")).toBe(true);
    expect(verifyQuote(pack, "i1040gi", "You must send in a paper Form 8453 if you have to attach certain forms or other documents that can’t be electronically filed.")).toBe(true);
  });
  it("accepts a quote that was broken by a line-end hyphen in the source", () => {
    expect(verifyQuote(pack, "i1040gi", "For online transfers directly from your checking or savings account at no cost to you, go to IRS.gov/Payments.")).toBe(true);
  });
  it("rejects a paraphrase, a wrong source, an unknown source and a quote that is too short", () => {
    expect(verifyQuote(pack, "i1040gi", "Both spouses have to sign a joint return, per the IRS.")).toBe(false);
    expect(verifyQuote(pack, "i8960", sentence)).toBe(false);
    expect(verifyQuote(pack, "nope", sentence)).toBe(false);
    expect(verifyQuote(pack, "i1040gi", "your spouse must")).toBe(false);
    expect("your spouse must".length).toBeLessThan(MIN_QUOTE_CHARS);
    expect(verifyQuote(pack, "i1040gi", null)).toBe(false);
    expect(verifyQuote(pack, "i1040gi", undefined)).toBe(false);
    expect(verifyQuote(pack, "i1040gi", "")).toBe(false);
  });
  it("a quote with one word changed does not verify", () => {
    expect(verifyQuote(pack, "i1040gi", sentence.replace("must", "should"))).toBe(false);
  });
  it("normalisation is symmetric (same text in, same text out)", () => {
    expect(normalizeForQuote("  A   “B”  — C ")).toBe(normalizeForQuote('a "b" - c'));
  });
});

describe("topics", () => {
  it("every topic points at a pinned source and pages inside it, and every task has at least one topic or is meant to have none", () => {
    for (const t of pack.topics) {
      for (const r of t.ranges) {
        expect(hasSource(pack, r.source), `${t.id} -> ${r.source}`).toBe(true);
        const pages = pack.manifest.find((m) => m.id === r.source)?.pages ?? 0;
        if (r.pages !== undefined) {
          expect(r.pages[0]).toBeGreaterThanOrEqual(1);
          expect(r.pages[1]).toBeLessThanOrEqual(pages);
          expect(r.pages[0]).toBeLessThanOrEqual(r.pages[1]);
        }
      }
      for (const task of t.tasks) expect(TASK_IDS as readonly string[], `${t.id} -> ${task}`).toContain(task);
    }
    // tasks that cite law need text; the form-text tasks c1, c2 and the register-less ones may have none
    for (const task of ["a1", "a2", "b1", "b2", "b3", "d1", "d2", "e1", "e2"]) expect(topicsForTask(pack, task).length, task).toBeGreaterThan(0);
  });
  it("an excerpt never exceeds the cap and stops on a page boundary", () => {
    for (const task of TASK_IDS) {
      const ex = excerptForTopics(pack, topicsForTask(pack, task), 110_000);
      expect(ex.text.length, task).toBeLessThanOrEqual(110_000);
    }
    const small = excerptForTopics(pack, ["sched_a"], 14_000);
    expect(small.truncated).toBe(true);
    expect(small.text.length).toBeLessThanOrEqual(14_000);
    expect(small.text).toMatch(/^\[\[i1040sa p\.1\]\]/);
  });
  it("pageText marks each page with its source and page number", () => {
    const t = pageText(pack, "i1040gi", 65, 66);
    expect(t).toContain("[[i1040gi p.65]]");
    expect(t).toContain("[[i1040gi p.66]]");
    expect(t).toContain("Sign Your Return");
  });
  it("the pack digest changes if a topic's range changes", () => {
    const other: SourcePack = { ...pack, topics: pack.topics.map((t, i) => (i === 0 ? { ...t, ranges: [{ source: t.ranges[0]?.source ?? "i1040gi", pages: [1, 2] as [number, number] }] } : t)) };
    expect(sourcePackDigestInput(other)).not.toBe(sourcePackDigestInput(pack));
    const repinned: SourcePack = { ...pack, manifest: pack.manifest.map((m, i) => (i === 0 ? { ...m, textSha256: "0".repeat(64) } : m)) };
    expect(sourcePackDigestInput(repinned)).not.toBe(sourcePackDigestInput(pack));
  });
});

describe("info cards: every statement has a source or is absent", () => {
  it("every statement of every card verifies against the pack and its page hint is the page the quote is on", () => {
    for (const card of INFO_CARDS) {
      const v = verifyCard(pack, card);
      expect(v.dropped, `${card.id} dropped`).toEqual([]);
      for (const s of v.statements) {
        const onPage = verifyQuote({ ...pack, texts: { [s.sourceId]: pageText(pack, s.sourceId, s.page, s.page).replace(/^\[\[[^\]]*\]\]\n/, "") } }, s.sourceId, s.quote);
        expect(onPage, `${card.id}/${s.id} p.${s.page}`).toBe(true);
        expect(s.url).toMatch(/^https:\/\/(www\.irs\.gov|portal\.ct\.gov)\//);
      }
    }
  });
  it("a statement whose quote is not in the source is dropped, not shown", () => {
    const bad = { ...INFO_CARDS[0]!, statements: [{ id: "x", text: "Made up.", sourceId: "i1040gi", quote: "This sentence does not appear in the instructions at all, anywhere.", page: 1 }, ...INFO_CARDS[0]!.statements.slice(0, 1)] };
    const v = verifyCard(pack, bad);
    expect(v.dropped).toEqual(["x"]);
    expect(v.statements).toHaveLength(1);
    expect(verifyCards(pack).length).toBe(INFO_CARDS.length);
  });
  it("the cards say they are not verified legal advice and assert none of the unverifiable points", () => {
    for (const card of INFO_CARDS) {
      expect(card.label).toMatch(/Not verified legal advice/);
      const all = card.statements.map((s) => s.text).join(" ");
      expect(all).not.toMatch(/October 15|due date|mail(ed)? (it )?to|Form 8879|myconneCT|e-file (a )?connecticut/i);
    }
  });
});
