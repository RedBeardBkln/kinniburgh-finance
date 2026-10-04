// L1.D1 / D2 / D3: process state of the return (plan section 5.3).
//   D1  the return is complete: headline complete, nothing blocking, no money line without an amount on a form that is filed;
//   D2  unresolved choices: decisions still at their default, fact conflicts, unverified documents, derived inputs,
//       header questions answered "not sure";
//   D3  overrides in force: a LINE override keeps approval blocked (owner decision D1), a stale / unreadable override is a
//       blocker, a changed engine version with an unchanged value is information.
// These read the engine's own verdicts (headline, open items, decisions, effective overrides); they add the cross-checks the
// engine does not make about itself (a blocked line on a filed form that no blocking item mentions, for instance).

import type { GateEngineState } from "@/lib/tax-review/gate";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { engineFormOfLine, evidenceOf, formIsFiled, lineTitle, plainText } from "@/lib/tax-review/l1/helpers";
import { isLineKey } from "@/lib/tax-review/types";
import type { LineKey } from "@/lib/tax2025/line-catalog";

const BLOCKED_STATUSES = new Set(["missing_input", "needs_cpa_rule_unverified", "needs_cpa_judgment", "not_yet_computed"]);

export const engineCompleteCheck: L1Check = {
  id: "L1.D1",
  description: "The return is complete: nothing blocking, no money line without an amount on a filed form",
  run(ctx: L1Context): Finding[] {
    const out: Finding[] = [];
    const h = ctx.view.headline;
    if (!h.complete) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D1.incomplete",
          severity: "blocker",
          area: "process",
          message: `The return is not complete: ${h.blockingItemCount} blocking item(s) remain, so the headline figures are not final. Any figure shown while it is incomplete is an estimate, not a result.`,
          evidence: [{ ref: "head:blockingItemCount", amount: h.blockingItemCount, status: "count" }],
          recommendedAction: "Resolve every blocking item (answer the question, verify the document, record the decision) and run the review again.",
          acceptable: false,
        })
      );
    }
    const blocking = ctx.view.openItems.filter((i) => i.severity === "blocking");
    for (const item of blocking) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D1.blocking-item",
          severity: "blocker",
          area: "process",
          ruleTag: item.id,
          message: `Blocking item (${item.formLabel}): ${plainText(item.message)}`,
          evidence: item.lineKeys.filter(isLineKey).slice(0, 8).map((k) => ({ ref: k, amount: null, status: "blocked" })),
          recommendedAction: plainText(item.action, 300),
          acceptable: false,
        })
      );
    }
    // a blocked money line on a form that is filed, that no blocking item names, is a hole the engine did not flag
    const named = new Set(blocking.flatMap((i) => i.lineKeys));
    const holes: LineKey[] = [];
    for (const [key, line] of Object.entries(ctx.view.lines)) {
      if (line === undefined || !isLineKey(key)) continue;
      if (!BLOCKED_STATUSES.has(line.status) || line.informational === true || named.has(key)) continue;
      const engineForm = engineFormOfLine(key);
      if (engineForm !== null && !formIsFiled(ctx, key.split(".")[0] === "f1040" ? "f1040" : mapIdOf(ctx, engineForm), engineForm)) continue;
      holes.push(key);
    }
    if (holes.length > 0) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D1.blocked-lines",
          severity: "blocker",
          area: "process",
          message: `${holes.length} money line(s) on forms that are filed have no amount and no blocking item explains it: ${holes.slice(0, 8).map((k) => lineTitle(k)).join("; ")}${holes.length > 8 ? "; ..." : ""}.`,
          evidence: evidenceOf(ctx, holes.slice(0, 20)),
          recommendedAction: "Find out why each line has no amount. A line with no amount is printed blank, which a reader takes as zero.",
          acceptable: false,
        })
      );
    }
    return out;
  },
};

function mapIdOf(ctx: L1Context, engineForm: string): string {
  return ctx.maps.find((m) => m.engineFormId === engineForm)?.formId ?? engineForm;
}

export const unresolvedChoicesCheck: L1Check = {
  id: "L1.D2",
  description: "Decisions at their default, fact conflicts, unverified documents, derived inputs and 'not sure' answers",
  run(ctx: L1Context): Finding[] {
    const out: Finding[] = [];
    for (const d of ctx.view.decisions) {
      if (d.status !== "default_undecided") continue;
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D2.decision",
          severity: "medium",
          area: "process",
          ruleTag: d.id,
          message: `Decision ${d.id} ("${plainText(d.label, 120)}") is still at its default (${d.chosen}); you have not recorded a choice. ${d.effectNote !== undefined ? plainText(d.effectNote, 400) : ""}`.trim(),
          evidence: [{ ref: `check:decision.${d.id}`, amount: null, status: "default_undecided" }],
          recommendedAction: "Decide on the Forms page and record the choice, or accept this finding with the reason the default is right for you.",
          acceptable: true,
        })
      );
    }
    for (const c of ctx.ret.conflicts) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D2.conflict",
          severity: "medium",
          area: "process",
          ruleTag: c.factKey,
          message: `Two sources disagree for "${c.factKey}": ${c.candidates.length} candidate value(s); the return used ${c.chosen === null ? "none of them" : `"${plainText(c.chosen, 80)}"`}. ${plainText(c.reason, 300)}`,
          evidence: [{ ref: `check:conflict.${c.factKey.slice(0, 80)}`, amount: null, status: "conflict" }],
          recommendedAction: "Look at both sources, decide which is right and fix the other, or accept this finding with the reason.",
          acceptable: true,
        })
      );
    }
    const h = ctx.view.headline;
    if (h.unverifiedDocumentCount > 0) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D2.unverified-docs",
          severity: "medium",
          area: "process",
          message: `${h.unverifiedDocumentCount} document(s) feeding the return are an unverified AI reading: nobody has confirmed the numbers against the paper document.`,
          evidence: [{ ref: "head:unverifiedDocumentCount", amount: h.unverifiedDocumentCount, status: "count" }],
          recommendedAction: "Open each document, compare it with the paper copy and confirm it.",
          acceptable: true,
        })
      );
    }
    if (h.derivedInputCount > 0) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D2.derived-inputs",
          severity: "medium",
          area: "process",
          message: `${h.derivedInputCount} input(s) were inferred rather than stated (for example who owns the consulting business, or which address is the primary residence).`,
          evidence: [{ ref: "head:derivedInputCount", amount: h.derivedInputCount, status: "count" }],
          recommendedAction: "Confirm each inferred input is right, or state it explicitly.",
          acceptable: true,
        })
      );
    }
    const att = ctx.ret.attestations;
    for (const [name, a] of [["digital assets", att.digitalAssets], ["foreign accounts", att.foreignAccounts]] as const) {
      if (a.status === "answered") continue;
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D2.header-answer",
          severity: a.status === "unsure" ? "high" : "medium",
          area: "process",
          ruleTag: name,
          message: `The yes/no question about ${name} on the return is ${a.status === "unsure" ? 'answered "not sure"' : "not answered"}; the box stays unchecked, which a reader takes as no answer.`,
          evidence: [{ ref: `check:answer.${name.replace(" ", "-")}`, amount: null, status: a.status }],
          recommendedAction: "Answer the question yourself before filing.",
          acceptable: true,
        })
      );
    }
    return out;
  },
};

export const overridesInForceCheck: L1Check = {
  id: "L1.D3",
  description: "Overrides in force: line overrides keep approval blocked; stale or unreadable overrides are blockers",
  run(ctx: L1Context): Finding[] {
    const e = ctx.effective;
    if (e === null) return [];
    const out: Finding[] = [];
    for (const o of e.applied.lines) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D3.line-override",
          severity: "high",
          area: "process",
          lineKey: isLineKey(o.targetKey) ? o.targetKey : undefined,
          ruleTag: o.targetKey,
          message: `${o.form} line ${o.formLine} is set by an override. The lines that depend on it are NOT recomputed, so the return can disagree with itself. Approval stays blocked while a line override is in force.`,
          evidence: [{ ref: isLineKey(o.targetKey) ? o.targetKey : `check:override.${o.targetKey}`, amount: o.nowAmount, status: "overridden" }],
          recommendedAction: "Remove the override by fixing the input that made the line wrong, then run the review again.",
          acceptable: false,
        })
      );
    }
    for (const s of e.stale) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D3.stale",
          severity: "blocker",
          area: "process",
          ruleTag: `${s.targetKind}:${s.targetKey}`,
          message: `An override on ${s.targetKind} "${s.targetKey}" is stale: the computed value changed after it was set (${plainText(s.info.message, 200)}).`,
          evidence: [{ ref: `check:override.${s.targetKey.slice(0, 80)}`, amount: null, status: "stale" }],
          recommendedAction: "Re-confirm the override against the current computation, or clear it.",
          acceptable: false,
        })
      );
    }
    for (const o of [...e.orphans, ...e.invalid.map((i) => ({ id: i.id, targetKind: "row", targetKey: i.id, message: i.error }))]) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D3.unusable",
          severity: "blocker",
          area: "process",
          ruleTag: o.id,
          message: `A recorded override could not be applied (${plainText(o.message, 200)}), so the return does not reflect an instruction on file.`,
          evidence: [{ ref: "check:override.unusable", amount: null, status: "unusable" }],
          recommendedAction: "Open the overrides panel and fix or clear it.",
          acceptable: false,
        })
      );
    }
    for (const a of e.anomalies) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D3.anomaly",
          severity: "high",
          area: "process",
          ruleTag: `${a.targetKind}:${a.targetKey}`,
          message: plainText(a.message, 300),
          evidence: [{ ref: "check:override.anomaly", amount: null, status: "anomaly" }],
          recommendedAction: "Re-confirm or clear the override to tidy this up.",
          acceptable: false,
        })
      );
    }
    for (const c of e.engineChanged) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D3.engine-changed",
          severity: "info",
          area: "process",
          ruleTag: `${c.targetKind}:${c.targetKey}`,
          message: plainText(c.message, 300),
          evidence: [{ ref: "check:override.engine-changed", amount: null, status: "engine changed" }],
          recommendedAction: "No action unless you want to re-confirm the override.",
          acceptable: true,
        })
      );
    }
    for (const a of e.applied.acks) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D3.acknowledged",
          severity: "medium",
          area: "process",
          ruleTag: a.ruleId,
          message: `You acknowledged the blocking rule "${a.ruleId}" (${a.items.length} item(s)) without a computed value; the return carries it as accepted.`,
          evidence: [{ ref: "check:override.ack", amount: a.items.length, status: "acknowledged" }],
          recommendedAction: "Make sure the acknowledgement still reflects your situation.",
          acceptable: true,
        })
      );
    }
    return out;
  },
};

/** The engine facts the approval gate needs (gate.ts GateEngineState), read from the effective view: counts only. */
export function engineGateState(ctx: Pick<L1Context, "view" | "effective">): GateEngineState {
  const h = ctx.view.headline;
  return {
    complete: h.complete,
    blockingItemCount: h.blockingItemCount,
    lineOverrideCount: ctx.effective?.applied.lines.length ?? 0,
    staleOverrideCount: ctx.effective?.stale.length ?? 0,
  };
}
