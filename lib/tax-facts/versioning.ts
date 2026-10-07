// Append-only versioning for the tax facts store (tax-facts-carry-forward-store).
//
// `planNextVersion` decides, for one key, whether a requested change is allowed and what the new row is. It never
// edits an existing version: the caller archives the current latest row(s) (`toArchiveIds`) and inserts `newRow`.
// Nothing is ever deleted: retiring a fact and resolving an open item are versions too.
//
// PURE: no DB, no network, no clock (the caller supplies `confirmedAt`).

import {
  validateFactDraft,
  validateReason,
  type Checked,
} from "@/lib/tax-facts/validate";
import type {
  CarryPolicy,
  ChangeKind,
  FactCategory,
  FactValueKind,
  NewFactVersion,
  SourceKind,
  TaxFactRow,
} from "@/lib/tax-facts/types";

/** The fields of an existing version the planner reads. */
export type ExistingVersion = Pick<
  TaxFactRow,
  | "id"
  | "version"
  | "category"
  | "label"
  | "taxYear"
  | "valueKind"
  | "valueCents"
  | "valueText"
  | "carryPolicy"
  | "changeKind"
  | "sourceKind"
  | "sourceRef"
  | "confirmedAt"
  | "archivedAt"
>;

export interface VersionRequest {
  factKey: string;
  changeKind: ChangeKind;
  /** The tax year this version is established / changed / reconfirmed / resolved / retired FOR. Ignored by policy_changed. */
  taxYear: number;
  confirmedAt: Date;
  reason?: string | null;
  // established only
  category?: FactCategory;
  label?: string;
  valueKind?: FactValueKind;
  carryPolicy?: CarryPolicy;
  sourceKind?: SourceKind;
  sourceRef?: string | null;
  // established and changed
  valueCents?: number | null;
  valueText?: string | null;
  // changed may also retitle; policy_changed carries the new policy
  newLabel?: string;
  newCarryPolicy?: CarryPolicy;
}

export type VersionPlan =
  | { ok: true; toArchiveIds: string[]; newRow: NewFactVersion }
  | { ok: false; error: string };

function latestOf(existing: readonly ExistingVersion[]): ExistingVersion | null {
  let best: ExistingVersion | null = null;
  for (const row of existing) if (best === null || row.version > best.version) best = row;
  return best;
}

function sameValue(
  a: { valueCents: number | null; valueText: string | null },
  b: { valueCents: number | null; valueText: string | null }
): boolean {
  return a.valueCents === b.valueCents && a.valueText === b.valueText;
}

function fail(error: string): VersionPlan {
  return { ok: false, error };
}

/**
 * Plan the next version of one key. `existing` is every stored version of the key (any order, archived included).
 * `toArchiveIds` is always the ids of the rows that are still un-archived (the prior latest).
 */
export function planNextVersion(existing: readonly ExistingVersion[], req: VersionRequest): VersionPlan {
  const latest = latestOf(existing);
  const toArchiveIds = existing.filter((r) => r.archivedAt === null).map((r) => r.id);
  const needsReason = req.changeKind === "changed" || req.changeKind === "retired" || req.changeKind === "resolved";
  const reason = validateReason(req.reason, needsReason);
  if (!reason.ok) return fail(reason.error);

  const finish = (
    draft: {
      category: FactCategory;
      label: string;
      valueKind: FactValueKind;
      valueCents: number | null;
      valueText: string | null;
      carryPolicy: CarryPolicy;
      sourceKind: SourceKind;
      sourceRef: string | null;
    },
    taxYear: number,
    confirmedAt: Date,
    reasonText: Checked<string | null>
  ): VersionPlan => {
    const checked = validateFactDraft({ factKey: req.factKey, taxYear, ...draft });
    if (!checked.ok) return fail(checked.error);
    if (!reasonText.ok) return fail(reasonText.error);
    const c = checked.value;
    return {
      ok: true,
      toArchiveIds,
      newRow: {
        factKey: c.factKey,
        version: (latest?.version ?? 0) + 1,
        category: c.category,
        label: c.label,
        taxYear: c.taxYear,
        valueKind: c.valueKind,
        valueCents: c.valueCents,
        valueText: c.valueText,
        carryPolicy: c.carryPolicy,
        changeKind: req.changeKind,
        sourceKind: c.sourceKind,
        sourceRef: c.sourceRef,
        reason: reasonText.value,
        confirmedAt,
      },
    };
  };

  // First version of a key, or re-introduction of a retired / resolved one.
  if (req.changeKind === "established") {
    if (latest !== null && latest.changeKind !== "retired" && latest.changeKind !== "resolved") {
      return fail("That fact already exists; change it instead.");
    }
    if (latest !== null && req.taxYear < latest.taxYear) {
      return fail("A fact cannot be re-established for a year before it was retired.");
    }
    if (!req.category || req.label === undefined || !req.valueKind || !req.carryPolicy || !req.sourceKind) {
      return fail("A new fact needs a category, label, value type, carry-forward policy and source.");
    }
    return finish(
      {
        category: req.category,
        label: req.label,
        valueKind: req.valueKind,
        valueCents: req.valueCents ?? null,
        valueText: req.valueText ?? null,
        carryPolicy: req.carryPolicy,
        sourceKind: req.sourceKind,
        sourceRef: req.sourceRef ?? null,
      },
      req.taxYear,
      req.confirmedAt,
      reason
    );
  }

  if (latest === null) return fail("That fact was not found.");
  if (latest.changeKind === "retired" || latest.changeKind === "resolved") {
    return fail("That fact is retired; only re-establishing it is possible.");
  }
  if (req.changeKind !== "policy_changed" && req.taxYear < latest.taxYear) {
    return fail(`The fact was already recorded for TY${latest.taxYear}; a lower tax year cannot be recorded.`);
  }

  const base = {
    category: latest.category,
    label: latest.label,
    valueKind: latest.valueKind,
    valueCents: latest.valueCents,
    valueText: latest.valueText,
    carryPolicy: latest.carryPolicy,
    sourceKind: latest.sourceKind,
    sourceRef: latest.sourceRef,
  };

  switch (req.changeKind) {
    case "changed": {
      const nextValue = { valueCents: req.valueCents ?? null, valueText: req.valueText ?? null };
      if (sameValue(nextValue, latest) && (req.newLabel === undefined || req.newLabel === latest.label)) {
        return fail("Nothing changed; to confirm it again for a new year, use the re-confirm action.");
      }
      return finish(
        {
          ...base,
          label: req.newLabel ?? latest.label,
          valueCents: nextValue.valueCents,
          valueText: nextValue.valueText,
          // An edit is the owner's own statement.
          sourceKind: "owner_statement",
          sourceRef: req.sourceRef === undefined ? latest.sourceRef : req.sourceRef,
        },
        req.taxYear,
        req.confirmedAt,
        reason
      );
    }
    case "reconfirmed": {
      if (latest.valueKind === "open_item") return fail("An open item is resolved, not re-confirmed.");
      if (req.taxYear <= latest.taxYear) {
        return fail(`It was already recorded for TY${latest.taxYear}; re-confirm it for a later tax year.`);
      }
      return finish(base, req.taxYear, req.confirmedAt, reason);
    }
    case "policy_changed": {
      if (latest.valueKind === "open_item") return fail("An open item has no carry-forward policy.");
      if (!req.newCarryPolicy) return fail("A carry-forward policy is required.");
      if (req.newCarryPolicy === latest.carryPolicy) return fail("That is already the policy.");
      // The value was not re-confirmed: the tax year and the confirmation date stay as they were.
      return finish({ ...base, carryPolicy: req.newCarryPolicy }, latest.taxYear, latest.confirmedAt, reason);
    }
    case "retired": {
      if (latest.valueKind === "open_item") return fail("An open item is resolved, not retired.");
      return finish(base, req.taxYear, req.confirmedAt, reason);
    }
    case "resolved": {
      if (latest.valueKind !== "open_item") return fail("Only an open item can be resolved.");
      return finish(base, req.taxYear, req.confirmedAt, reason);
    }
    default:
      return fail("Unknown change.");
  }
}
