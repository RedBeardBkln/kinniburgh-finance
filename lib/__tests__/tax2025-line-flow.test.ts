import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { downstreamOf, LINE_FLOW, type LineFlow } from "@/lib/tax2025/line-flow";
import { LINE_KEYS, type LineKey } from "@/lib/tax2025/types";

// LINE_FLOW self-checks (plan S2). The table is hand-maintained, so three things are pinned:
//   (a) every key it names is a real LineKey (the failure message lists the offenders);
//   (b) the graph is acyclic (no line feeds itself, even through others);
//   (c) every explicit A.sum / A.copy / A.derive edge of the 1040 spine in return.ts is in the
//       transitive closure of the table (DRIFT GUARD: a new spine edge added to the engine
//       without a flow entry fails here).
// Limits of (c): it is a regex scan of return.ts. It sees `A.sum("dest", [..])`,
// `A.derive("dest", [..], fn)` and `A.copy("dest", "src")` written on ONE call with string-literal
// keys; edges inside rule modules (Schedule C, SE, QBI, Schedule A, D, CT ...) and values handed
// to a rule through A.num(...) are NOT scanned (the table's header says how those were derived).
// If return.ts changes how it writes these calls, update SPINE_CALL below.

const KNOWN = new Set<string>(LINE_KEYS);

function allKeysNamed(flow: LineFlow): string[] {
  const out = new Set<string>();
  for (const [from, tos] of Object.entries(flow)) {
    out.add(from);
    for (const t of tos ?? []) out.add(t);
  }
  return [...out];
}

describe("LINE_FLOW names only real line keys", () => {
  it("fails with the list of offenders when a key is not in LINE_KEYS", () => {
    const offenders = allKeysNamed(LINE_FLOW).filter((k) => !KNOWN.has(k));
    expect(offenders, `LINE_FLOW names keys that are not LineKeys: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the check itself catches a stale key (guards the guard)", () => {
    const stale: LineFlow = { ["f1040.12" as LineKey]: ["f1040.14"] };
    expect(allKeysNamed(stale).filter((k) => !KNOWN.has(k))).toEqual(["f1040.12"]);
  });

  it("covers the blocks added since the core branch was written", () => {
    const keys = new Set(allKeysNamed(LINE_FLOW));
    for (const k of [
      "schd.16", "schd.7", "schd.15", "schd.21", "qdcg.3", "qdcg.25", "sch1a.38", "sch1a.13", "ct1040.s1.42", "ct1040.s1.36", "ct1040.additions",
      "ct1040.subtractions", "f1040.7a", "f1040.12e", "f1040.13b", "sch2.2", "scha.8a", "std.total", "f8889a.13", "ira.a.7", "f8880.12", "f2210.19",
    ]) {
      expect(keys.has(k), `${k} is part of the flow`).toBe(true);
    }
  });
});

describe("LINE_FLOW is acyclic", () => {
  it("a topological sort of the edges succeeds (no edge points upstream)", () => {
    const nodes = allKeysNamed(LINE_FLOW) as LineKey[];
    const indegree = new Map<LineKey, number>(nodes.map((n) => [n, 0]));
    for (const tos of Object.values(LINE_FLOW)) for (const t of tos ?? []) indegree.set(t, (indegree.get(t) ?? 0) + 1);
    const queue = nodes.filter((n) => indegree.get(n) === 0);
    const order: LineKey[] = [];
    while (queue.length > 0) {
      const n = queue.shift() as LineKey;
      order.push(n);
      for (const t of LINE_FLOW[n] ?? []) {
        const d = (indegree.get(t) ?? 0) - 1;
        indegree.set(t, d);
        if (d === 0) queue.push(t);
      }
    }
    const stuck = nodes.filter((n) => !order.includes(n));
    expect(stuck, `lines on a cycle: ${stuck.join(", ")}`).toEqual([]);
  });

  it("no self edges and no duplicate destinations", () => {
    for (const [from, tos] of Object.entries(LINE_FLOW)) {
      const list = tos ?? [];
      expect(list, `${from} -> itself`).not.toContain(from as LineKey);
      expect(new Set(list).size, `${from} has a duplicate destination`).toBe(list.length);
    }
  });
});

describe("LINE_FLOW covers every spine edge in return.ts (drift guard)", () => {
  const src = readFileSync(resolve(__dirname, "../tax2025/return.ts"), "utf8");
  // A.sum("dest", ["a", "b"]) | A.derive("dest", ["a", "b"], fn) | A.copy("dest", "src")
  const SPINE_CALL = /A\.(sum|derive|copy)\(\s*"([^"]+)"\s*,\s*(\[[^\]]*\]|"[^"]+")/g;

  function spineEdges(): { dest: string; src: string; call: string }[] {
    const edges: { dest: string; src: string; call: string }[] = [];
    for (const m of src.matchAll(SPINE_CALL)) {
      const [, call, dest, deps] = m;
      if (call === undefined || dest === undefined || deps === undefined) continue;
      for (const d of deps.match(/"([^"]+)"/g) ?? []) edges.push({ dest, src: d.slice(1, -1), call });
    }
    return edges;
  }

  it("the scan finds the spine (sanity: dozens of edges, all with real keys)", () => {
    const edges = spineEdges();
    expect(edges.length).toBeGreaterThan(60);
    for (const e of edges) {
      expect(KNOWN.has(e.dest), `return.ts ${e.call} dest ${e.dest}`).toBe(true);
      expect(KNOWN.has(e.src), `return.ts ${e.call} source ${e.src}`).toBe(true);
    }
  });

  it("every spine edge (src -> dest) is reachable in LINE_FLOW", () => {
    const missing = spineEdges()
      .filter((e) => !downstreamOf(e.src as LineKey).includes(e.dest as LineKey))
      .map((e) => `${e.src} -> ${e.dest} (A.${e.call})`);
    expect(missing, `edges in return.ts missing from LINE_FLOW:\n${missing.join("\n")}`).toEqual([]);
  });
});

describe("downstreamOf", () => {
  it("excludes the source line and is cycle-safe", () => {
    const cyclic: LineFlow = { "f1040.8": ["f1040.9"], "f1040.9": ["f1040.8", "f1040.11a"] };
    expect(downstreamOf("f1040.8", cyclic).sort()).toEqual(["f1040.11a", "f1040.9"]);
    expect(downstreamOf("sch1.3")).not.toContain("sch1.3");
  });

  it("follows the 2025 chains the pins care about", () => {
    expect(downstreamOf("scha.17")).toEqual(expect.arrayContaining(["f1040.12e", "f1040.14", "f1040.15", "f1040.16", "f1040.24", "f1040.37"]));
    expect(downstreamOf("schd.16")).toEqual(expect.arrayContaining(["schd.21", "f1040.7a", "qdcg.3", "f1040.9", "f1040.11a", "f1040.16"]));
    expect(downstreamOf("sch1a.38")).toEqual(expect.arrayContaining(["f1040.13b", "f1040.14", "f1040.15", "f8995.11"]));
    expect(downstreamOf("ct1040.s1.42")).toEqual(expect.arrayContaining(["ct1040.subtractions", "ct1040.ctAgi", "ct1040.6", "ct1040.balance"]));
    expect(downstreamOf("sch1.5")).toEqual(expect.arrayContaining(["ct1040.s1.34", "ct1040.s1.36", "f1040.8"]));
    expect(downstreamOf("std.total")).toEqual(expect.arrayContaining(["f1040.12e", "f1040.14", "f8995.11", "f6251.amti"]));
    expect(downstreamOf("f8889a.13")).toEqual(expect.arrayContaining(["sch1.13", "sch1.26", "f1040.10", "f1040.11a"]));
  });

  it("never flags upstream lines", () => {
    expect(downstreamOf("f1040.16")).not.toContain("f1040.15");
    expect(downstreamOf("sch1.3")).not.toContain("schc.31");
    expect(downstreamOf("se.13")).not.toContain("se.12");
    expect(downstreamOf("f1040.9")).not.toContain("sch1.3");
    expect(downstreamOf("ct1040.balance")).toEqual([]);
  });
});
