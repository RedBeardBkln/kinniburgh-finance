// Tool: get_recent_changes. Shaper is PURE and unit-tested; reads are in queries/recent-changes.ts (metadata only) and the year-close summary.
//
// Every `summary` is a FIXED TEMPLATE filled only from the enumerated metadata fields (a key, a kind, a year, a first name and a time). No
// value, reason, note, fingerprint, hash, verdict, message or free-text label is ever read, so none can be returned.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { firstNameOf } from "@/lib/advisor/names";
import { loadRecentChanges, type RecentChangeRows } from "@/lib/advisor/queries/recent-changes";
import { loadYearCloseSummary, type YearCloseSummary } from "@/lib/advisor/queries/tax-calendar";
import { safeField } from "@/lib/advisor/scrub";
import { isoDateTime } from "@/lib/advisor/tools/format";
import { optional, parseInput } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

export const DEFAULT_CHANGE_DAYS = 14;
export const MAX_CHANGE_DAYS = 90;
const MAX_EVENTS = 60;
const MAX_AUDIT_TYPES = 15;
const DAY_MS = 86_400_000;

const schema = z.object({ days: optional(z.number().int().min(1).max(365)) }).strict();
type Input = z.output<typeof schema>;

export function clampChangeDays(days: number | undefined): number {
  return Math.min(MAX_CHANGE_DAYS, Math.max(1, days ?? DEFAULT_CHANGE_DAYS));
}

const FACT_CHANGE: Readonly<Record<string, string>> = {
  established: "established",
  changed: "changed",
  reconfirmed: "reconfirmed",
  policy_changed: "carry policy changed",
  retired: "retired",
  resolved: "open item resolved",
};

const KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
const DOC_TYPE = /^[a-z0-9_]{1,40}$/;

const key = (k: string): string => (KEY.test(k) ? k : "(key withheld)");
const who = (name: string): string => firstNameOf(name);

interface TimelineEvent {
  at: Date;
  area: string;
  summary: string;
}

export function shapeRecentChanges(rows: RecentChangeRows, yearClose: YearCloseSummary, now: Date, days: number): ToolOutput {
  const horizon = clampChangeDays(days);
  const since = new Date(now.getTime() - horizon * DAY_MS);
  const events: TimelineEvent[] = [];
  const unavailable: string[] = [];

  if (rows.taxFacts === null) unavailable.push("tax_facts");
  for (const f of rows.taxFacts ?? []) {
    events.push({ at: f.setAt, area: "tax_facts", summary: `Tax fact ${FACT_CHANGE[f.changeKind] ?? "updated"} (${key(f.factKey)}) by ${who(f.setByName)}` });
  }

  if (rows.overrides === null) unavailable.push("overrides");
  for (const o of rows.overrides ?? []) {
    const kind = ["line", "decision", "rule_ack"].includes(o.targetKind) ? o.targetKind : "item";
    const authority = o.authority === "owner" ? "owner" : "advisor, recorded earlier";
    events.push({ at: o.setAt, area: "overrides", summary: `Override recorded for ${kind} ${key(o.targetKey)} (version ${o.version}, ${authority}) by ${who(o.setByName)}` });
  }

  if (rows.reviewRuns === null) unavailable.push("ai_review");
  for (const r of rows.reviewRuns ?? []) {
    events.push({ at: r.startedAt, area: "ai_review", summary: `AI review run started for TY${r.taxYear} by ${who(r.startedByName)}` });
  }

  let closeCount = 0;
  if (!yearClose.available) unavailable.push("tax_year_state");
  else {
    for (const e of yearClose.events) {
      if (e.at.getTime() < since.getTime()) continue;
      closeCount += 1;
      const what = e.kind === "closed" ? `Tax year ${e.taxYear} marked filed` : e.kind === "reopened" ? `Tax year ${e.taxYear} reopened for revision` : `Tax year ${e.taxYear} state changed`;
      events.push({ at: e.at, area: "tax_year_state", summary: `${what} by ${who(e.byName)}` });
    }
  }

  if (rows.documents === null) unavailable.push("documents");
  for (const d of rows.documents ?? []) {
    const type = DOC_TYPE.test(d.docType) ? d.docType : "other";
    events.push({ at: d.createdAt, area: "documents", summary: `Document added (${type}${d.taxYear !== null ? `, tax year ${d.taxYear}` : ""})` });
  }

  const inWindow = events.filter((e) => e.at.getTime() >= since.getTime()).sort((a, b) => b.at.getTime() - a.at.getTime());
  const shown = inWindow.slice(0, MAX_EVENTS).map((e) => ({ at: isoDateTime(e.at), area: e.area, summary: safeField(e.summary, 200) }));
  const countOf = (area: string): number => inWindow.filter((e) => e.area === area).length;

  if (rows.auditCounts === null) unavailable.push("audit_log");
  if (rows.transactionsAdded === null) unavailable.push("transactions");

  return {
    data: {
      days: horizon,
      since: isoDateTime(since),
      events: shown,
      ...(inWindow.length > shown.length ? { events_truncated: true, event_count: inWindow.length } : {}),
      counts: {
        tax_fact_changes: countOf("tax_facts"),
        overrides: countOf("overrides"),
        ai_review_runs: countOf("ai_review"),
        tax_year_state_changes: closeCount,
        documents_added: countOf("documents"),
      },
      audit_log_entries_by_type: [...(rows.auditCounts ?? [])]
        .sort((a, b) => b.count - a.count || (a.changeType < b.changeType ? -1 : 1))
        .slice(0, MAX_AUDIT_TYPES)
        .map((c) => ({ change_type: safeField(c.changeType, 60), count: c.count })),
      transactions_added_by_entity: [...(rows.transactionsAdded ?? [])].sort((a, b) => b.count - a.count).slice(0, 10).map((t) => ({ entity: safeField(t.entity, 80), transactions: t.count })),
      ...(unavailable.length > 0 ? { areas_unavailable: unavailable } : {}),
      notes: [
        "A timeline of what was recorded and by whom, not of what the values were: reasons, notes and amounts are not part of it. Tax records are append-only, so an earlier version stays on file when something is changed.",
      ],
    },
    rows: shown.length,
    links: [links.taxForms(2025), links.documents()],
  };
}

export const getRecentChangesTool = defineTool<Input>({
  name: "get_recent_changes",
  description:
    "What changed lately, as a newest-first timeline: tax fact changes, return overrides, AI review runs, tax-year filed or reopened events and documents added, each with who and when, plus counts, a count of audit-log entries by type and the number of transactions added per entity. days is 1 to 90, default 14. It shows that something changed and who did it, never the values, reasons or notes.",
  inputJsonSchema: {
    type: "object",
    properties: { days: { type: "integer", description: "Optional. Look back this many days, 1 to 90. Default 14." } },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up recent changes",
  summarizeArgs: (i) => `days=${clampChangeDays(i.days)}`,
  run: async (ctx, i) => {
    const days = clampChangeDays(i.days);
    const [rows, yearClose] = await Promise.all([loadRecentChanges(new Date(ctx.now.getTime() - days * DAY_MS)), loadYearCloseSummary()]);
    return shapeRecentChanges(rows, yearClose, ctx.now, days);
  },
  maxChars: LIMITS.toolResultChars,
  phase: 2,
});
