import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { HONESTY_ALLOWLIST } from "@/lib/tax-wording";
import { ASSISTANT_NOTICE, noticeText } from "@/lib/advisor/notice";
import { STARTER_PROMPTS } from "@/lib/advisor/starters";
import { findOwnerBannedWording } from "@/lib/tax-wording";

// The assistant's own equivalent of tax-review-wording-scan: nothing the owner can SEE may say or imply that a CPA reviews, prepares or
// signs the return, and the forms hub is always called "Tax Forms" (advisor-ai-chatbot plan section 11.4).

const ROOT = resolve(__dirname, "../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(,])\/\/[^\n]*/g, "$1");

describe("assistant source: no standalone upper-case CPA outside the honesty statements", () => {
  const files = ["components/advisor", "app/advisor", "lib/advisor"].flatMap((d) => walk(join(ROOT, d))).concat([join(ROOT, "actions/advisor.ts")]);

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("every line is clean once the allow-listed honesty phrases are removed", () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
      src.split("\n").forEach((rawLine, i) => {
        let line = rawLine;
        for (const re of HONESTY_ALLOWLIST) line = line.replace(re, " ");
        if (/(?<![A-Za-z0-9_-])CPA(?![A-Za-z0-9_-])/.test(line)) hits.push(`${f.replace(ROOT, "")}:${i + 1}: ${rawLine.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("never calls the forms hub anything but Tax Forms", () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
      src.split("\n").forEach((line, i) => {
        if (/(?<!Tax )\bForms (?:page|hub)\b/.test(line)) hits.push(`${f.replace(ROOT, "")}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("owner-visible assistant text", () => {
  it("the notice and the starter prompts carry no banned wording", () => {
    expect(findOwnerBannedWording(noticeText())).toEqual([]);
    for (const p of STARTER_PROMPTS) expect(findOwnerBannedWording(p), p).toEqual([]);
    expect(ASSISTANT_NOTICE.length).toBeGreaterThan(3);
  });

  it("a starter prompt names the Tax Forms hub", () => {
    expect(STARTER_PROMPTS.some((p) => /Tax Forms/.test(p))).toBe(true);
  });
});
