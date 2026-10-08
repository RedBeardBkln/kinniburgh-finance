// Runs ONE tool call (plan section 5.1): lookup, server-side input validation, timeout, wording + scrubber, size caps, error mapping.
// PURE except for the tool's own `run` and console.error (err.name only, never content).

import { LIMITS } from "@/lib/advisor/config";
import { safeLink, type AppLink } from "@/lib/advisor/links";
import { redactText, scrubDeep } from "@/lib/advisor/scrub";
import type { RegisteredTool, ToolContext, ToolOutput } from "@/lib/advisor/tools/types";
import { ownerWordingDeep } from "@/lib/tax-wording";

/** Per-turn byte budget shared by all tool calls of one turn. Mutated by runTool. */
export interface TurnBudget {
  charsLeft: number;
}

export function newTurnBudget(): TurnBudget {
  return { charsLeft: LIMITS.turnToolChars };
}

export interface ToolRunResult {
  name: string;
  ok: boolean;
  /** The tool_result content string (a JSON envelope; on failure a JSON error envelope). */
  content: string;
  rows: number | null;
  argSummary: string;
  resultChars: number;
  ms: number;
  links: AppLink[];
  /** A scrubbed memory-note suggestion for the loop to turn into a `memory_proposal` event (never stored here). */
  proposal: { text: string; category: string } | null;
}

export const BUDGET_USED_MESSAGE = "Data budget for this turn is used; answer with what you have.";
const LOOKUP_FAILED = "That lookup failed.";
const LOOKUP_TIMEOUT = "That lookup took too long.";

function failure(name: string, message: string, argSummary: string, started: number): ToolRunResult {
  const content = JSON.stringify({ ok: false, error: message });
  return { name, ok: false, content, rows: null, argSummary, resultChars: content.length, ms: Date.now() - started, links: [], proposal: null };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error("tool failed"));
      },
    );
  });
}

class ToolTimeoutError extends Error {
  constructor() {
    super("tool timeout");
    this.name = "ToolTimeoutError";
  }
}

interface Envelope {
  ok: true;
  asOf: string;
  rows: number | null;
  total: number | null;
  truncated: boolean;
  data: unknown;
  links: AppLink[];
}

const size = (e: Envelope): number => JSON.stringify(e).length;

/** Trim the envelope to `cap` characters: shrink the largest array in `data` (item by item), else truncate text, else withhold. */
export function fitToCap(envelope: Envelope, cap: number): Envelope {
  if (size(envelope) <= cap) return envelope;
  const e: Envelope = { ...envelope, truncated: true };
  if (typeof e.data === "string") {
    const overhead = size({ ...e, data: "" });
    e.data = `${e.data.slice(0, Math.max(0, cap - overhead - 40))}\n[truncated]`;
    return size(e) <= cap ? e : { ...e, data: "[truncated]" };
  }
  if (e.data !== null && typeof e.data === "object" && !Array.isArray(e.data)) {
    const data = { ...(e.data as Record<string, unknown>) };
    let biggest: string | null = null;
    let biggestLen = -1;
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v) && JSON.stringify(v).length > biggestLen) {
        biggest = k;
        biggestLen = JSON.stringify(v).length;
      }
    }
    if (biggest !== null) {
      const arr = [...(data[biggest] as unknown[])];
      const total = arr.length;
      data.totalRows = total;
      e.data = data;
      while (arr.length > 0) {
        data[biggest] = arr;
        if (size(e) <= cap) break;
        // Drop in proportion to the overshoot so a 10x oversized result does not loop item by item.
        const over = size(e) - cap;
        const avg = Math.max(1, Math.floor(JSON.stringify(arr).length / arr.length));
        arr.length = Math.max(0, arr.length - Math.max(1, Math.ceil(over / avg)));
      }
      data[biggest] = arr;
      data.shownRows = arr.length;
      if (size(e) <= cap) return e;
    }
  }
  return { ...e, data: { note: "The result was too large and was withheld; narrow the request." } };
}

export async function runTool(
  tools: ReadonlyMap<string, RegisteredTool>,
  ctx: ToolContext,
  budget: TurnBudget,
  name: string,
  rawInput: unknown,
): Promise<ToolRunResult> {
  const started = Date.now();
  const tool = tools.get(name);
  if (tool === undefined) return failure(name.slice(0, 64), "Unknown tool.", "", started);

  const prepared = tool.prepare(rawInput);
  if (!prepared.ok) return failure(name, prepared.error, "", started);
  // The persisted argument summary is enum / date / limit text by construction; it goes through the scrubber like every stored string anyway.
  const argSummary = redactText(prepared.argSummary).slice(0, 120);

  if (budget.charsLeft <= 0) return failure(name, BUDGET_USED_MESSAGE, argSummary, started);

  let output: ToolOutput;
  try {
    output = await withTimeout(prepared.run(ctx), LIMITS.perToolTimeoutMs);
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error("advisor tool error:", name, errName);
    return failure(name, errName === "ToolTimeoutError" ? LOOKUP_TIMEOUT : LOOKUP_FAILED, argSummary, started);
  }

  try {
    const data = scrubDeep(ownerWordingDeep(output.data));
    const links = (output.links ?? []).map(safeLink).filter((l): l is AppLink => l !== null);
    const proposal = output.proposal === undefined ? null : scrubDeep({ text: output.proposal.text, category: output.proposal.category });
    const cap = Math.min(tool.maxChars, budget.charsLeft);
    const envelope = fitToCap(
      {
        ok: true,
        asOf: output.asOf ?? ctx.now.toISOString().slice(0, 10),
        rows: output.rows ?? null,
        total: output.total ?? null,
        truncated: false,
        data,
        links,
      },
      cap,
    );
    const content = JSON.stringify(envelope);
    budget.charsLeft -= content.length;
    return { name, ok: true, content, rows: output.rows ?? null, argSummary, resultChars: content.length, ms: Date.now() - started, links, proposal };
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error("advisor tool error:", name, errName);
    return failure(name, LOOKUP_FAILED, argSummary, started);
  }
}

export function toolMap(tools: readonly RegisteredTool[]): Map<string, RegisteredTool> {
  return new Map(tools.map((t) => [t.name, t]));
}
