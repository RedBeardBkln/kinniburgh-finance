// DB-aware, READ-ONLY loader for the upcoming ledger. No writes, no auth: like lib/monthly-review-build.ts
// and lib/tax2025-build.ts, the CALLER (a page that has already run auth()) is responsible for access control.
// The reads live in lib/upcoming-ledger-input.ts (explicit selects); the pure builder is lib/upcoming-ledger.ts.

import {
  buildUpcomingLedger,
  collectModelledRefs,
  todayForNewYork,
  type LearnedSeriesRow,
  type UpcomingLedger,
} from "@/lib/upcoming-ledger";
import { loadUpcomingLedgerInput } from "@/lib/upcoming-ledger-input";
import { expandSeriesDates, type DetectionBundle } from "@/lib/recurring-detect";
import { fetchDetectionData, runDetection } from "@/lib/recurring-detect-build";

export interface LoadedUpcomingLedger {
  ledger: UpcomingLedger;
  /**
   * History-learned recurring patterns, split by the owner's dismissals. null when detection could not run
   * (the ledger itself is still complete): the UI then shows one muted notice.
   */
  detection: DetectionBundle | null;
  entityNameById: Record<string, string>;
  entitySlugById: Record<string, string | null>;
  accountNameById: Record<string, string>;
}

export async function loadUpcomingLedger(args: {
  /** null = every entity (the Taxes / Projects aggregate views). */
  entityId: string | null;
  days: number;
  now: Date;
}): Promise<LoadedUpcomingLedger> {
  const { entityId, days, now } = args;

  // The pattern-detection reads do not depend on the recorded items, so they run alongside the ledger reads
  // (a failure is handled when the result is used; the catch here only prevents an unhandled rejection).
  const detectionData = fetchDetectionData({ entityId, today: todayForNewYork(now) });
  detectionData.catch(() => undefined);

  const { input, from, to, entityNameById, entitySlugById, accountNameById } = await loadUpcomingLedgerInput({
    entityId,
    days,
    now,
  });

  // Recurring-pattern detection is an add-on: any failure leaves the ledger exactly as it was and the UI shows
  // one muted notice. Read-only (one transaction query + the dismissal setting).
  let detection: DetectionBundle | null = null;
  try {
    const loadedDetection = runDetection(await detectionData, collectModelledRefs(input), from);
    detection = loadedDetection.bundle;
    const learned: LearnedSeriesRow[] = loadedDetection.bundle.suggestions
      .filter((s) => s.kind === "outflow")
      .map((s) => ({
        key: s.key,
        entityId: s.entityId,
        accountId: s.accountId,
        payee: s.payee,
        kind: s.kind,
        cadence: s.cadence,
        amount: s.typicalAmount,
        minAmount: s.minAmount,
        maxAmount: s.maxAmount,
        amountMode: s.amountMode,
        confidence: s.confidence,
        why: `${s.why.join(", ")}.`,
        dates: s.confidence === "low" || s.cadence === "annual" ? [] : expandSeriesDates(s, from, to),
      }));
    input.learned = learned;
  } catch (err) {
    console.error("Recurring detection unavailable", err instanceof Error ? err.name : "UnknownError");
  }

  const ledger = buildUpcomingLedger(input);

  return {
    ledger,
    detection,
    entityNameById,
    entitySlugById,
    accountNameById,
  };
}
