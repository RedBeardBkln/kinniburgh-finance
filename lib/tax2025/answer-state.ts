// Tri-state view of an owner answer for the Phase 1b rules.
//
// A fact leaf (facts.ts) is one of:
//   value !== null                      -> answered
//   value === null, basis "answer_owner" -> the owner chose "Not sure - ask the CPA"
//   value === null, basis null           -> not answered yet
// The rules never guess: "unsure" becomes needs_cpa_judgment, "missing" becomes
// missing_input. Pure; no Decimal here (callers convert cents).

import type { Sourced } from "@/lib/tax2025/types";

export type Ans<T> = { state: "answered"; value: T } | { state: "unsure" } | { state: "missing" };

export function ans<T>(leaf: Sourced<T>): Ans<T> {
  if (leaf.value !== null) return { state: "answered", value: leaf.value };
  return leaf.basis === null ? { state: "missing" } : { state: "unsure" };
}

export function answered<T>(value: T): Ans<T> {
  return { state: "answered", value };
}

export const MISSING: Ans<never> = { state: "missing" };
export const UNSURE: Ans<never> = { state: "unsure" };

/** Maps the value of an answered leaf; unsure / missing pass through. */
export function mapAns<T, U>(a: Ans<T>, f: (v: T) => U): Ans<U> {
  return a.state === "answered" ? { state: "answered", value: f(a.value) } : a;
}

/** A leaf that carries "Not sure - ask the CPA" (no value, but an owner basis). */
export function unsureLeaf<T>(refs: Sourced<T>["refs"], note?: string): Sourced<T> {
  return note === undefined ? { value: null, basis: "answer_owner", refs } : { value: null, basis: "answer_owner", refs, note };
}
