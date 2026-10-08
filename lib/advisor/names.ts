// Display-name helpers. PURE.

/** "Eric Kinniburgh" -> "Eric". Falls back to a neutral word when the name is empty. */
export function firstNameOf(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first === "" ? "there" : first.slice(0, 30);
}
