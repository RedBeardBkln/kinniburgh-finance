import { describe, it, expect } from "vitest";
import { resolveGlCodeForTags } from "@/lib/gl-code-resolver";

describe("resolveGlCodeForTags", () => {
  it("returns no_mapping when none of the transaction's tags have a mapping", () => {
    const mapping = new Map<string, string>([["tag-unrelated", "gl-1"]]);
    const result = resolveGlCodeForTags(["tag-a", "tag-b"], mapping);
    expect(result).toEqual({ status: "no_mapping" });
  });

  it("returns no_mapping for an empty tagIds array", () => {
    const mapping = new Map<string, string>([["tag-a", "gl-1"]]);
    const result = resolveGlCodeForTags([], mapping);
    expect(result).toEqual({ status: "no_mapping" });
  });

  it("returns resolved with the single mapped GL code", () => {
    const mapping = new Map<string, string>([["tag-a", "gl-1"]]);
    const result = resolveGlCodeForTags(["tag-a"], mapping);
    expect(result).toEqual({ status: "resolved", glCodeId: "gl-1" });
  });

  it("dedups two tags that map to the same GL code (not a false conflict)", () => {
    const mapping = new Map<string, string>([
      ["tag-a", "gl-1"],
      ["tag-b", "gl-1"],
    ]);
    const result = resolveGlCodeForTags(["tag-a", "tag-b"], mapping);
    expect(result).toEqual({ status: "resolved", glCodeId: "gl-1" });
  });

  it("returns conflict when two tags map to different GL codes", () => {
    const mapping = new Map<string, string>([
      ["tag-a", "gl-1"],
      ["tag-b", "gl-2"],
    ]);
    const result = resolveGlCodeForTags(["tag-a", "tag-b"], mapping);
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.glCodeIds.sort()).toEqual(["gl-1", "gl-2"]);
    }
  });

  it("ignores an unmapped tag alongside a mapped one (resolves, doesn't force a conflict)", () => {
    const mapping = new Map<string, string>([["tag-a", "gl-1"]]);
    const result = resolveGlCodeForTags(["tag-a", "tag-unmapped"], mapping);
    expect(result).toEqual({ status: "resolved", glCodeId: "gl-1" });
  });

  it("resolves correctly with duplicate tag ids in the input array", () => {
    const mapping = new Map<string, string>([["tag-a", "gl-1"]]);
    const result = resolveGlCodeForTags(["tag-a", "tag-a", "tag-a"], mapping);
    expect(result).toEqual({ status: "resolved", glCodeId: "gl-1" });
  });
});
