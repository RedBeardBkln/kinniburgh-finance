// Pure logic behind the Final review components (ai-return-reviewer, A6). There is no jsdom in this repo, so everything a component
// decides (what the filters show, whether a button is enabled, what a chip says) lives here and is unit-tested; the components only
// render it. PURE. Nothing in this file is authoritative: the server actions re-check everything.

import { REASON_MAX, REASON_MIN, TYPED_PHRASE } from "@/lib/tax-review/limits";
import { findRedactionIssues } from "@/lib/tax-review/redact";
import type { FindingDto, ReviewStateDto } from "@/lib/tax-review/state";
import type { FindingArea, Severity } from "@/lib/tax-review/types";

// ── Filters ───────────────────────────────────────────────────────────────────

export type StatusFilter = "all" | "open" | "gating" | "accepted";

export interface FindingFilters {
  /** Empty = every severity. */
  severities: readonly Severity[];
  /** "all" or one area. */
  area: "all" | FindingArea;
  status: StatusFilter;
  text: string;
}

export const DEFAULT_FILTERS: FindingFilters = { severities: [], area: "all", status: "all", text: "" };

export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = { blocker: "Blocker", high: "High", medium: "Medium", low: "Low", info: "Information" };

export function toggleSeverity(current: readonly Severity[], s: Severity): Severity[] {
  return current.includes(s) ? current.filter((x) => x !== s) : [...current, s];
}

export function filterFindings(findings: readonly FindingDto[], f: FindingFilters): FindingDto[] {
  const needle = f.text.trim().toLowerCase();
  return findings.filter((x) => {
    if (f.severities.length > 0 && !f.severities.includes(x.severity)) return false;
    if (f.area !== "all" && x.area !== f.area) return false;
    if (f.status === "open" && x.status !== "open") return false;
    if (f.status === "gating" && !x.gating) return false;
    if (f.status === "accepted" && x.status !== "accepted") return false;
    if (needle !== "" && !`${x.message} ${x.check} ${x.formKey ?? ""} ${x.lineKey ?? ""}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** Areas that occur in the findings, in the catalogue order of the model (the area filter only offers what exists). */
export function areasPresent(findings: readonly FindingDto[]): FindingArea[] {
  return [...new Set(findings.map((f) => f.area))].sort();
}

export function severityCountsOf(findings: readonly FindingDto[]): Record<Severity, number> {
  const out: Record<Severity, number> = { blocker: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) out[f.severity] += 1;
  return out;
}

export const SEVERITIES: readonly Severity[] = ["blocker", "high", "medium", "low", "info"];

// ── Reason (accept / withdraw) ────────────────────────────────────────────────

export type ReasonCheck = { ok: true; length: number } | { ok: false; error: string | null; length: number };

/** The same limits the server enforces (3 to 500 characters, nothing that looks like an SSN, an EIN or a long number). */
export function checkReason(text: string): ReasonCheck {
  const t = text.trim();
  if (t.length === 0) return { ok: false, error: null, length: 0 };
  if (t.length < REASON_MIN) return { ok: false, error: `Write at least ${REASON_MIN} characters.`, length: t.length };
  if (t.length > REASON_MAX) return { ok: false, error: `Keep it to ${REASON_MAX} characters or fewer.`, length: t.length };
  if (findRedactionIssues(t).length > 0) return { ok: false, error: "That looks like a Social Security number, an employer ID or a long number; remove it.", length: t.length };
  return { ok: true, length: t.length };
}

export function reasonCounter(text: string): string {
  return `${text.trim().length} / ${REASON_MAX}`;
}

export interface AcceptFormState {
  reason: string;
  busy: boolean;
  acceptable: boolean;
}

/** The Accept button is enabled only for a finding that may be accepted, with a valid reason, while nothing is in flight. */
export function checkAcceptForm(s: AcceptFormState): { canAccept: boolean; reasonError: string | null } {
  const r = checkReason(s.reason);
  return { canAccept: s.acceptable && !s.busy && r.ok, reasonError: r.ok ? null : r.error };
}

// ── Approval card ─────────────────────────────────────────────────────────────

export interface ApprovalFormState {
  checked: boolean;
  typedPhrase: string;
  typedName: string;
  busy: boolean;
  /** state.gate.verdict === "passed" */
  gateGreen: boolean;
  /** state.approver.allowed */
  accountAllowed: boolean;
  /** state.approval.current: already approved in this exact state. */
  alreadyApproved: boolean;
}

export interface ApprovalFormCheck {
  canApprove: boolean;
  /** Why the button is disabled, in plain words (first reason first); empty when it is enabled. */
  blockers: string[];
}

export function checkApprovalForm(s: ApprovalFormState): ApprovalFormCheck {
  const blockers: string[] = [];
  if (s.alreadyApproved) blockers.push("This return is already approved in its current state.");
  if (!s.gateGreen) blockers.push("The review is not passed yet: every check in the list above must be green first.");
  if (!s.accountAllowed) blockers.push("Only the owner's own account can record the approval.");
  if (!s.checked) blockers.push("Tick the box to confirm.");
  if (s.typedPhrase.trim() !== TYPED_PHRASE) blockers.push(`Type exactly: ${TYPED_PHRASE}`);
  if (s.typedName.trim() === "") blockers.push("Type your full name.");
  if (s.busy) blockers.push("Saving...");
  return { canApprove: blockers.length === 0, blockers };
}

// ── Chips ─────────────────────────────────────────────────────────────────────

export type VerdictChip = { tone: "neutral" | "ok" | "bad" | "warn"; label: string };

/** "AI review: PASSED for fingerprint x" / "FLAGGED" / "not run" / "stale": derived from the state, never from a model. */
export function verdictChip(state: Pick<ReviewStateDto, "latestRun" | "runIsStale" | "gate" | "currentFingerprint12">): VerdictChip {
  if (state.latestRun === null) return { tone: "neutral", label: "AI review: not run" };
  if (state.runIsStale) return { tone: "warn", label: "AI review: stale (the return changed after the last run)" };
  if (state.gate.verdict === "passed") return { tone: "ok", label: `AI review: PASSED for ${state.currentFingerprint12}` };
  const open = state.gate.openGating.length;
  return { tone: "bad", label: `AI review: FLAGGED (${open} open blocker/high item${open === 1 ? "" : "s"})` };
}

export function gateStateLabel(state: "pass" | "fail" | "not_run"): string {
  return state === "pass" ? "Passed" : state === "fail" ? "Not passed" : "Not run yet";
}

/** "5 Oct 2026, 6:00 AM" in America/New_York (the repo displays dates in that zone). */
export function formatNewYork(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}
