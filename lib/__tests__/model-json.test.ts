import { describe, it, expect } from "vitest";
import { extractJsonPayload, parseModelJson } from "@/lib/model-json";

describe("extractJsonPayload", () => {
  it("returns plain JSON unchanged", () => {
    const json = '{"summary":"ok"}';
    expect(extractJsonPayload(json)).toBe(json);
  });

  it("strips ```json fences", () => {
    const text = '```json\n{"summary":"ok"}\n```';
    expect(extractJsonPayload(text)).toBe('{"summary":"ok"}');
  });

  it("strips bare ``` fences", () => {
    const text = '```\n{"summary":"ok"}\n```';
    expect(extractJsonPayload(text)).toBe('{"summary":"ok"}');
  });

  it("handles fences with surrounding preamble text", () => {
    const text = 'Here is the review:\n\n```json\n{"a":1}\n```\n\nHope this helps!';
    expect(extractJsonPayload(text)).toBe('{"a":1}');
  });

  it("extracts the outermost object from unfenced preamble text", () => {
    const text = 'Sure! {"a":{"b":1},"c":[1,2]} — done.';
    expect(extractJsonPayload(text)).toBe('{"a":{"b":1},"c":[1,2]}');
  });

  it("keeps braces inside string values intact", () => {
    const text = '{"note":"use {braces} here"}';
    expect(extractJsonPayload(text)).toBe('{"note":"use {braces} here"}');
    expect(() => JSON.parse(extractJsonPayload(text))).not.toThrow();
  });

  it("throws when no JSON object is present", () => {
    expect(() => extractJsonPayload("no json here at all")).toThrow(/No JSON object found/);
    expect(() => extractJsonPayload("```json\n[]\n```")).toThrow(/No JSON object found/);
  });
});

describe("parseModelJson", () => {
  it("parses a fenced response into a typed object", () => {
    const result = parseModelJson<{ summary: string; count: number }>(
      '```json\n{"summary":"all good","count":3}\n```'
    );
    expect(result).toEqual({ summary: "all good", count: 3 });
  });

  it("throws on invalid JSON content", () => {
    expect(() => parseModelJson('{"broken":')).toThrow();
  });
});