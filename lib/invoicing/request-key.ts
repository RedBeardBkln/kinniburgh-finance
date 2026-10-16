// A fresh idempotency key (UUID v4 text) for a form submit. Used by the payment form so a double click is recorded once.
//
// The key must NEVER repeat across forms: a constant fallback would make the second payment look like a duplicate of the first and be
// swallowed. `crypto.randomUUID` exists only in secure contexts (HTTPS / localhost), so on a plain-http origin this falls back to
// `crypto.getRandomValues` (available everywhere), and only if even that is missing to a time + counter + Math.random mix, which is
// still unique per call (never a constant).

type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
};

let counter = 0;

function hex(bytes: ArrayLike<number>): string {
  const h: string[] = [];
  for (let i = 0; i < bytes.length; i += 1) h.push((bytes[i]! & 0xff).toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

/** Formats 16 random bytes as a version-4 UUID (variant 10xx). */
export function uuidFromBytes(input: ArrayLike<number>): string {
  const b = Array.from({ length: 16 }, (_, i) => (input[i] ?? 0) & 0xff);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return hex(b);
}

export function newRequestKey(c: CryptoLike | undefined = typeof crypto !== "undefined" ? (crypto as CryptoLike) : undefined): string {
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") return uuidFromBytes(c.getRandomValues(new Uint8Array(16)));
  counter = (counter + 1) % 0x1000000;
  const bytes: number[] = [];
  let t = Date.now();
  for (let i = 0; i < 6; i += 1) {
    bytes.push(t % 256);
    t = Math.floor(t / 256);
  }
  bytes.push((counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff);
  while (bytes.length < 16) bytes.push(Math.floor(Math.random() * 256));
  return uuidFromBytes(bytes);
}
