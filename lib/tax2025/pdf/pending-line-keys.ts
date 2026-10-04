// Line keys the PDF maps may reference that the engine (lib/tax2025/types.ts
// LINE_KEYS) does not emit yet (plan section 5.4). A map line keyed by one of these
// prints BLANK until the engine emits the key (then it fills automatically with no
// map change); each is listed in the T9 gap report so the engine owners can add it.
//
// Same naming convention as LINE_KEYS. Rules:
//   - a key here must NOT also be in LINE_KEYS (test: "no stale pending": when the
//     engine adds the key, delete it from this list);
//   - lines the owner has stated do not apply (dependents, EV credit, mileage) are
//     NOT pending: they go to a map's `blank` list with `owner_statement_na`.
//
// T1 ships the starter list from the plan; T2a/T2b/T3 append their own blocks.

export const PENDING_LINE_KEYS = [
  // Form 1040
  // Schedule 2
  "sch2.1",
  // Schedule A
  // Schedule SE
  // CT-1040
  "ct1040.2",
  "ct1040.3",
  "ct1040.4",
  "ct1040.5",
  "ct1040.7",
  "ct1040.8",
  "ct1040.12",
  "ct1040.13",
  "ct1040.14",
  "ct1040.16",
  "ct1040.17",
  "ct1040.21",
  "ct1040.22",
] as const;

export type PendingLineKey = (typeof PENDING_LINE_KEYS)[number];
