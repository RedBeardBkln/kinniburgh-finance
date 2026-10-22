import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Source-reading guard for the invoicing feature (plan 01-plan.md sections 8, 12, 13, 17). Pins, by reading the source:
//  1. only the store writes the invoicing tables; only the store + the read-only loaders reference them; nothing deletes or upserts
//     (the single exception: the lines of a DRAFT, after a same-transaction draft check); the timeline is append-only;
//  2. the pure modules stay pure (no DB, no next/*, no clock);
//  3. only lib/invoicing/tin-store.ts selects an encrypted column;
//  4. the tax engine, the AI reviewer, the ledger P&L and the advisor never import invoicing code, and the invoicing code imports
//     almost nothing from the tax side (the owner rule, the PDF text helpers, the ledger P&L);
//  5. the migration is purely additive (new tables only);
//  6. every server action starts with `await requireAuth()`, owner-only ones go through the owner rule;
//  7. the string "income" is never used as a GlCode type in the new code.

const root = process.cwd();
const cache = new Map<string, string>();
const read = (rel: string) => {
  let src = cache.get(rel);
  if (src === undefined) {
    src = readFileSync(join(root, rel), "utf8");
    cache.set(rel, src);
  }
  return src;
};
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(join(root, dir))) return out;
  for (const ent of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".next" || ent.name === "__tests__") continue;
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(rel);
  }
  return out;
}
const SOURCE_FILES = ["app", "lib", "actions", "components"].flatMap((d) => walk(d));
const noComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");

const PURE_FILES = [
  "lib/invoicing/constants.ts",
  "lib/invoicing/money.ts",
  "lib/invoicing/state.ts",
  "lib/invoicing/numbering.ts",
  "lib/invoicing/validate.ts",
  "lib/invoicing/tin.ts",
  "lib/invoicing/ar.ts",
  "lib/invoicing/ledger.ts",
  "lib/invoicing/accrual-pl.ts",
  "lib/invoicing/cash-basis.ts",
  "lib/invoicing/deposit-match.ts",
  "lib/invoicing/owner.ts",
  "lib/invoicing/entity-gate.ts",
  "lib/invoicing/items.ts",
  "lib/invoicing/gl-map.ts",
  "lib/invoicing/events.ts",
  "lib/invoicing/errors.ts",
  "lib/invoicing/cents.ts",
  "lib/invoicing/draft-input.ts",
  "lib/invoicing/pdf/model.ts",
  "lib/invoicing/pdf/filename.ts",
];
const BUILD_FILES = [
  "lib/invoicing/gate-build.ts",
  "lib/invoicing/clients-build.ts",
  "lib/invoicing/catalog-build.ts",
  "lib/invoicing/documents-build.ts",
  "lib/invoicing/payments-build.ts",
  "lib/invoicing/pdf-build.ts",
];
const STORE_FILES = ["lib/invoicing/store.ts", "lib/invoicing/tin-store.ts"];
const ACTION_FILES = [
  "actions/invoicing-setup.ts",
  "actions/clients.ts",
  "actions/reimbursable-items.ts",
  "actions/invoices.ts",
  "actions/billing-payments.ts",
];
const MODEL_ACCESS = /\b(?:db|tx)\.(invoicingProfile|client|clientContact|reimbursableItem|billingDocument|billingLine|billingPayment|billingAllocation|billingEvent)\b/;

describe("the files exist", () => {
  it.each([...PURE_FILES, ...BUILD_FILES, ...STORE_FILES, ...ACTION_FILES, "prisma/migrations/20261014000000_invoicing_core/migration.sql"])("%s", (f) => {
    expect(existsSync(join(root, f))).toBe(true);
  });
});

describe("only the store and the read-only loaders touch the invoicing tables", () => {
  it("db.<model> / tx.<model> appears only in the store, tin-store and the build files", () => {
    const users = SOURCE_FILES.filter((f) => MODEL_ACCESS.test(noComments(read(f)))).sort();
    for (const f of users) expect([...STORE_FILES, ...BUILD_FILES]).toContain(f);
  });
  it("no page, component, action or API route accesses the models directly", () => {
    const outside = SOURCE_FILES.filter((f) => /^(app|components|actions)\//.test(f));
    for (const f of outside) expect(MODEL_ACCESS.test(noComments(read(f))), f).toBe(false);
  });
  it("the loaders are read-only, select explicitly and carry no auth or cache calls", () => {
    for (const f of BUILD_FILES) {
      const src = noComments(read(f));
      expect(src, f).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
      expect(src, f).not.toMatch(/\binclude:/);
      expect(src, f).not.toMatch(/next\/cache|revalidatePath|requireAuth|next-auth/);
      expect(src, f).not.toMatch(/^"use server"/m);
    }
  });
  it("every loader that reads Transaction rows excludes archived ones", () => {
    for (const f of BUILD_FILES) {
      const src = noComments(read(f));
      const reads = [...src.matchAll(/db\.transaction\.findMany\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
      for (const r of reads) expect(r, f).toMatch(/archivedAt:\s*null/);
    }
  });
});

describe("the store keeps its promises", () => {
  const store = () => noComments(read("lib/invoicing/store.ts"));
  it("never upserts or deletes (single-row), and deleteMany is only the draft lines", () => {
    expect(store()).not.toMatch(/\.(delete|upsert)\(/);
    const deletes = [...store().matchAll(/(\w+)\.deleteMany\(/g)].map((m) => m[0]);
    expect(deletes).toEqual(["billingLine.deleteMany("]);
    expect(store()).not.toMatch(/\.billingDocument\.(delete|deleteMany)|\.billingPayment\.(delete|deleteMany)/);
  });
  it("the draft-lines function checks status = draft before it deletes, in the same transaction", () => {
    const src = store();
    const i = src.indexOf("async function replaceDraftLines");
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf("\n}\n", i));
    expect(body.indexOf('status: "draft"')).toBeGreaterThan(-1);
    expect(body.indexOf('status: "draft"')).toBeLessThan(body.indexOf("deleteMany"));
  });
  it("BillingEvent is append-only: only create exists", () => {
    const src = store();
    expect(src).not.toMatch(/billingEvent\.(update|updateMany|delete|deleteMany|upsert)/);
    expect([...src.matchAll(/billingEvent\.create\(/g)]).toHaveLength(1);
  });
  it("the issue number is taken and the status flipped in ONE transaction, under the counter's row lock", () => {
    const src = store();
    const i = src.indexOf("export async function issueInvoice");
    const body = src.slice(i, src.indexOf("\n}\n", i));
    expect(body).toMatch(/\$transaction\(/);
    expect(body).toMatch(/UPDATE "InvoicingProfile" SET "nextInvoiceNumber" = "nextInvoiceNumber" \+ 1/);
    expect(body.indexOf("UPDATE \"InvoicingProfile\"")).toBeLessThan(body.indexOf("billingDocument.updateMany"));
    expect(body).toMatch(/status: "draft"/);
  });
  it("allocation writes lock the invoice (and payment) rows before they compute the sums", () => {
    const src = store();
    for (const fn of ["recordPayment", "allocateExisting", "deallocate", "voidInvoice"]) {
      const i = src.indexOf(`export async function ${fn}`);
      const body = src.slice(i, src.indexOf("\n}\n", i));
      expect(body, fn).toMatch(/FOR UPDATE/);
    }
  });
  it("never writes a bank Transaction (read and lock only)", () => {
    expect(store()).not.toMatch(/\.transaction\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });
  it("all the events pass the safe-payload guard", () => {
    expect(store()).toMatch(/assertSafeEventData\(/);
  });
});

describe("encrypted columns", () => {
  it("only tin-store.ts selects an encrypted column", () => {
    for (const f of SOURCE_FILES) {
      const src = noComments(read(f));
      if (f === "lib/invoicing/tin-store.ts") continue;
      expect(src, f).not.toMatch(/\b(einEncrypted|remitToEncrypted)\s*:\s*true/);
    }
  });
  it("tin-store.ts is the only file that imports decrypt for invoicing columns", () => {
    for (const f of SOURCE_FILES.filter((x) => x.startsWith("lib/invoicing/") || x.startsWith("actions/") || x.startsWith("components/invoicing/"))) {
      if (f === "lib/invoicing/tin-store.ts") continue;
      if (!/invoic|clients\.ts|reimbursable|billing-payments/.test(f)) continue;
      expect(noComments(read(f)), f).not.toMatch(/\bdecrypt\b/);
    }
  });
});

describe("pure modules stay pure", () => {
  it.each(PURE_FILES.filter((f) => existsSync(join(root, f))))("%s has no DB, next/*, auth or clock", (f) => {
    const src = noComments(read(f));
    expect(src).not.toMatch(/from "@\/lib\/db"|from "next\/|from "@\/lib\/auth"|from "@prisma\/client"/);
    expect(src).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    expect(src).not.toMatch(/^"use server"/m);
  });
});

describe("import direction", () => {
  const FORBIDDEN_TARGET = /["']@\/(lib\/invoicing|lib\/contractors|actions\/(invoicing-setup|clients|reimbursable-items|invoices|quotes|billing-payments|public-invoice|contractors)|components\/(invoicing|contractors))/;
  it("the tax engine, the AI reviewer, tax computation, the ledger P&L and the advisor never import invoicing code", () => {
    const guarded = SOURCE_FILES.filter(
      (f) =>
        f.startsWith("lib/tax2025/") ||
        f.startsWith("lib/tax-review/") ||
        f.startsWith("lib/advisor/") ||
        f.startsWith("components/advisor/") ||
        /^lib\/tax-compute/.test(f) ||
        /^lib\/tax2025-/.test(f) ||
        /^actions\/tax-/.test(f) ||
        /^actions\/advisor/.test(f) ||
        f === "lib/reports.ts"
    );
    expect(guarded.length).toBeGreaterThan(20);
    for (const f of guarded) expect(FORBIDDEN_TARGET.test(noComments(read(f))), f).toBe(false);
  });
  it("the invoicing code imports from the tax side only the owner rule, the PDF text helpers and (Phase 1.12) the ledger P&L", () => {
    const mine = SOURCE_FILES.filter((f) => f.startsWith("lib/invoicing/") || f.startsWith("components/invoicing/") || ACTION_FILES.includes(f) || /^app\/business\/\[slug\]\/(invoices|clients|items|invoicing)\//.test(f) || f.startsWith("app/api/invoicing/"));
    expect(mine.length).toBeGreaterThan(10);
    const ALLOWED = new Set(["@/lib/tax-year-close/closer", "@/lib/tax2025/pdf/safe-text", "@/lib/tax2025/pdf/winansi", "@/lib/tax-extraction-schema", "@/lib/reports"]);
    for (const f of mine) {
      const imports = [...noComments(read(f)).matchAll(/from "(@\/lib\/(?:tax[^"]*|reports))"/g)].map((m) => m[1]!);
      for (const imp of imports) expect(ALLOWED.has(imp), `${f} imports ${imp}`).toBe(true);
    }
  });
  it("the advisor tool count test is untouched: no invoicing tool is registered", () => {
    const registry = read("lib/advisor/tools/all-tools.ts");
    expect(registry).not.toMatch(/invoic|billing|contractor/i);
  });
});

describe("migration is additive", () => {
  const sql = () => read("prisma/migrations/20261014000000_invoicing_core/migration.sql");
  // Comments and the referential actions of foreign keys ("ON UPDATE CASCADE") are not statements.
  const code = () =>
    sql()
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .replace(/ON (DELETE|UPDATE) (CASCADE|RESTRICT|SET NULL)/g, "");
  it("contains only CREATE TABLE / CREATE INDEX / ALTER TABLE ADD CONSTRAINT for tables created in the same file", () => {
    expect(code()).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|INSERT)\b/i);
    const created = new Set([...code().matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]));
    expect(created.size).toBe(9);
    for (const m of code().matchAll(/ALTER TABLE "(\w+)" (\w+)/g)) {
      expect(created.has(m[1]!), `ALTER of ${m[1]}`).toBe(true);
      expect(m[2]).toBe("ADD");
    }
    for (const m of code().matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "(\w+)"/g)) expect(created.has(m[1]!)).toBe(true);
  });
  it("has exactly the three hand-written CHECK constraints (positive amounts and a non-negative fee); no credit-memo source check remains", () => {
    expect([...code().matchAll(/ADD CONSTRAINT "(\w+_chk)"/g)].map((m) => m[1]).sort()).toEqual([
      "BillingAllocation_amount_positive_chk",
      "BillingPayment_amount_positive_chk",
      "BillingPayment_fee_nonnegative_chk",
    ]);
    expect(code()).not.toMatch(/one_source/);
  });
  it("has no credit-memo or estimate column, index or key anywhere, and BillingAllocation.paymentId is NOT NULL", () => {
    expect(code()).not.toMatch(/credit.?memo|creditMemo|appliesTo|[Ee]stimate/);
    expect(code()).toMatch(/"quotePrefix" TEXT NOT NULL DEFAULT 'Q-'/);
    expect(code()).toMatch(/"nextQuoteNumber" INTEGER NOT NULL/);
    expect(code()).toMatch(/"sourceQuoteId" TEXT/);
    const alloc = code().match(/CREATE TABLE "BillingAllocation" \(([\s\S]*?)\n\);/)![1]!;
    expect(alloc).toMatch(/"paymentId" TEXT NOT NULL/);
  });
  it("stores no secret column other than the encrypted ones, and nothing Stripe", () => {
    expect(code()).not.toMatch(/stripe/i);
    expect(code()).not.toMatch(/"(password|secret|apiKey)\w*"/i);
  });
});

describe("no credit memos and no estimates (owner decisions 2026-10-16: quotes instead of estimates; credits are deposits applied to open invoices)", () => {
  const mine = () => SOURCE_FILES.filter((f) => f.startsWith("lib/invoicing/") || f.startsWith("components/invoicing/") || ACTION_FILES.includes(f) || /^app\/(business\/\[slug\]\/(invoices|clients|items|invoicing)|api\/invoicing)\//.test(f));
  it("the invoicing code (comments aside) never mentions a credit memo or an estimate", () => {
    expect(mine().length).toBeGreaterThan(20);
    for (const f of mine()) expect(noComments(read(f)), f).not.toMatch(/credit[ _-]?memo|creditMemo|CreditMemo|estimate/i);
  });
  it("the invoicing models in schema.prisma have no credit-memo or estimate field, relation or index, and an allocation belongs to a payment only", () => {
    const schema = read("prisma/schema.prisma");
    const start = schema.indexOf("model InvoicingProfile {");
    const end = schema.indexOf("model BillingEvent {");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const models = schema
      .slice(start, schema.indexOf("\n}", end) + 2)
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(models).not.toMatch(/credit[ _-]?memo|creditMemo|CreditMemo|appliesTo|estimate/i);
    expect(models).toMatch(/quotePrefix\s+String\s+@default\("Q-"\)/);
    expect(models).toMatch(/nextQuoteNumber\s+Int\s/);
    const alloc = /model BillingAllocation \{([\s\S]*?)\r?\n\}/.exec(models)![1]!;
    expect(alloc).toMatch(/paymentId\s+String\s/); // required, not String?
    expect(alloc).not.toMatch(/paymentId\s+String\?/);
  });
  it("the only document kinds are invoice and quote", () => {
    expect(noComments(read("lib/invoicing/constants.ts"))).toMatch(/DOCUMENT_KINDS = \["invoice", "quote"\] as const/);
  });
});

describe("real-PDF-render test files carry an explicit generous timeout (S3: the default 5 s flaked under load)", () => {
  const LISTED = ["lib/__tests__/invoicing-pdf-template.test.ts", "lib/__tests__/invoicing-pdf.test.ts", "lib/__tests__/invoicing-tester-pdf.test.ts", "lib/__tests__/invoicing-tester-r2-pdf.test.ts", "lib/__tests__/invoicing-tester-r3-pdf.test.ts"];
  it.each(LISTED)("%s", (f) => {
    const m = read(f).match(/vi\.setConfig\(\{ testTimeout: ([\d_]+) \}\)/);
    expect(m, `${f} must call vi.setConfig({ testTimeout: ... })`).not.toBeNull();
    expect(Number(m![1]!.replace(/_/g, ""))).toBeGreaterThanOrEqual(30_000);
  });
  it("any other test file that renders a real invoice PDF is on the list above", () => {
    const files = readdirSync(join(root, "lib/__tests__"))
      .filter((n) => /\.test\.tsx?$/.test(n))
      .map((n) => `lib/__tests__/${n}`)
      .filter((f) => /renderInvoicePdf\(/.test(readFileSync(join(root, f), "utf8")));
    expect(files.sort()).toEqual(LISTED);
  });
});

describe("the string income is never a GlCode type in the new code", () => {
  it('no "income" literal in the invoicing files', () => {
    const mine = SOURCE_FILES.filter((f) => f.startsWith("lib/invoicing/") || f.startsWith("components/invoicing/") || ACTION_FILES.includes(f));
    for (const f of mine) expect(noComments(read(f)), f).not.toMatch(/["'`]income["'`]/);
  });
});

describe("middleware", () => {
  it("no invoicing path is public in Phase 1 (the public view link and the Stripe webhook arrive with Phase 2)", () => {
    const mw = read("middleware.ts");
    const list = /const PUBLIC_PATHS = \[([^\]]*)\]/.exec(mw)?.[1] ?? "";
    expect(list).not.toMatch(/invoic|stripe|\/i"/);
  });
});

describe("server actions", () => {
  it.each(ACTION_FILES)("%s: 'use server' and every export starts with await requireAuth()", (f) => {
    const src = read(f);
    expect(src.trimStart().startsWith('"use server"')).toBe(true);
    // The body opens at the first line that ends with "{": signatures are kept on one line.
    const exports = [...src.matchAll(/export async function (\w+)[^\n]*\{\n\s*([^\n]*)/g)];
    expect(exports.length).toBeGreaterThan(0);
    for (const m of exports) expect(m[2], `${f}: ${m[1]}`).toMatch(/await requireAuth\(\)/);
    // No model access in an action; no hard delete anywhere.
    expect(noComments(src)).not.toMatch(MODEL_ACCESS);
    expect(noComments(src)).not.toMatch(/\.(delete|deleteMany|upsert)\(/);
  });
  // Owner decision 2026-10-16: Eva (and any other signed-in non-owner) has READ-ONLY access to the invoicing suite. EVERY exported action
  // must therefore call the owner rule before it does any work. The allow-list of exports that may skip it is deliberately empty today:
  // an entry would have to be a pure read that returns no secret, and adding one is a reviewed change to this test.
  const READ_ONLY_EXPORTS: string[] = [];
  const exportedBodies = (file: string): { name: string; body: string }[] => {
    const src = noComments(read(file));
    const out: { name: string; body: string }[] = [];
    const re = /export async function (\w+)/g;
    for (const m of src.matchAll(re)) {
      const start = m.index!;
      const next = src.indexOf("\nexport ", start + 10);
      out.push({ name: m[1]!, body: src.slice(start, next === -1 ? undefined : next) });
    }
    return out;
  };
  it("the read-only allow-list is tiny", () => {
    expect(READ_ONLY_EXPORTS.length).toBeLessThanOrEqual(2);
  });
  it.each(ACTION_FILES)("%s: EVERY export calls the owner rule before it reads or writes anything (non-owners are read-only)", (f) => {
    const fns = exportedBodies(f);
    expect(fns.length).toBeGreaterThan(0);
    for (const { name, body } of fns) {
      if (READ_ONLY_EXPORTS.includes(`${f}:${name}`)) continue;
      const gate = body.indexOf("requireInvoicingOwner(");
      expect(gate, `${f}: ${name} must call requireInvoicingOwner`).toBeGreaterThan(-1);
      for (const work of [/\bstore\./, /await load\w+\(/, /await read\w+\(/, /await uploadLogoFile\(/, /\.arrayBuffer\(/]) {
        const w = body.search(work);
        if (w !== -1) expect(gate, `${f}: ${name} reaches ${work} before the owner gate`).toBeLessThan(w);
      }
    }
  });
  it("every allow-listed read-only export exists and writes nothing", () => {
    for (const entry of READ_ONLY_EXPORTS) {
      const [f, name] = entry.split(":") as [string, string];
      const fn = exportedBodies(f).find((x) => x.name === name);
      expect(fn, entry).toBeDefined();
      expect(fn!.body, entry).not.toMatch(/\bstore\./);
    }
  });
  it("the owner rule is fail-closed: an unidentifiable owner means nobody, and the refusal text says non-owners can only view", () => {
    const src = noComments(read("lib/invoicing/gate-build.ts"));
    expect(src).toMatch(/throw new InvoicingRefusal\(r\.reason \?\? "Only the owner can do this\."\)/);
    expect(read("lib/invoicing/owner.ts")).toMatch(/can only VIEW/);
  });
  it("every action resolves the entity through the gate (slug allow-list + profile row)", () => {
    for (const f of ACTION_FILES) {
      expect(noComments(read(f)), f).toMatch(/requireInvoicingEntity(?:ForSetup)?\(/);
    }
  });
});

describe("the PDF route", () => {
  it("starts with auth() -> 401 before anything else, is gated and never cached", () => {
    const f = "app/api/invoicing/[id]/pdf/route.ts";
    expect(existsSync(join(root, f))).toBe(true);
    const src = noComments(read(f));
    const g = src.indexOf("export async function GET");
    const body = src.slice(g);
    expect(body.indexOf("await auth()")).toBeGreaterThan(-1);
    expect(body.indexOf("await auth()")).toBeLessThan(body.indexOf("loadInvoicePdfSource"));
    expect(body).toMatch(/401/);
    expect(src).toMatch(/private, no-store/);
  });
});

describe("the scoped text exceptions", () => {
  it("sanitizeWinAnsi (the safeText bypass) is used in exactly one place in the invoicing code: the bank-text line cleaner", () => {
    const mine = SOURCE_FILES.filter((f) => f.startsWith("lib/invoicing/") || ACTION_FILES.includes(f) || f.startsWith("components/invoicing/"));
    const users = mine.filter((f) => /\bsanitizeWinAnsi\(/.test(noComments(read(f))));
    expect(users).toEqual(["lib/invoicing/pdf/render.ts"]);
    const src = noComments(read("lib/invoicing/pdf/render.ts"));
    expect([...src.matchAll(/sanitizeWinAnsi\(/g)]).toHaveLength(1);
    expect(src).toMatch(/function sanitizeBankLine\(raw: string\): string \{\s*return sanitizeWinAnsi\(raw\);/);
    expect(src).toMatch(/bankLines: input\.remit\.bankLines\.map\(sanitizeBankLine\)/);
  });
  it("safeText and the TY2025 PDF helpers are untouched by this feature (still refuse SSN-like text)", () => {
    const src = noComments(read("lib/tax2025/pdf/safe-text.ts"));
    expect(src).toMatch(/containsSsnLikeText\(raw\)/);
    expect(src).not.toMatch(/invoic/i);
  });
});

describe("W-9 documents are never extracted", () => {
  it("the explicit never-extract list contains w9 and isExtractableDocType refuses it", () => {
    const src = read("lib/document-extraction-state.ts");
    expect(src).toMatch(/NEVER_EXTRACT_DOC_TYPES = \["w9"\]/);
    expect(src).toMatch(/NEVER_EXTRACT_DOC_TYPES as readonly string\[\]\)\.includes\(docType\)\) return false/);
    expect(read("actions/documents.ts")).toMatch(/isExtractableDocType\(doc\.docType\)/);
  });
});

describe("client components import only client-safe modules", () => {
  // A "use client" component pulls in everything it imports (except server actions, which become RPC stubs). A value import of the DB,
  // auth, encryption, Prisma or a node built-in anywhere in that graph breaks `next build` for the browser bundle.
  const FORBIDDEN = /^(@\/lib\/db|@\/lib\/auth|@\/lib\/encrypt|@prisma\/client|next\/headers|next\/cache|pdf-lib|node:.*|fs|crypto|path)$/;
  const resolve = (spec: string): string | null => {
    if (!spec.startsWith("@/")) return null;
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const rel = spec.slice(2) + ext;
      if (existsSync(join(root, rel))) return rel;
    }
    return null;
  };
  const valueImports = (src: string): string[] =>
    [...src.matchAll(/^import\s+(?!type\b)([^;]*?)\sfrom\s+"([^"]+)";/gm)].map((m) => m[2]!).concat([...src.matchAll(/^import\s+"([^"]+)";/gm)].map((m) => m[1]!));
  const clientFiles = SOURCE_FILES.filter((f) => f.startsWith("components/invoicing/") && /^["']use client["']/.test(read(f).trimStart()));
  it("there are client components to check", () => expect(clientFiles.length).toBeGreaterThanOrEqual(6));
  it.each(clientFiles)("%s: no server-only module in its value-import graph", (f) => {
    const seen = new Set<string>();
    const walkGraph = (file: string, via: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of valueImports(noComments(read(file)))) {
        expect(FORBIDDEN.test(spec), `${via} -> ${spec}`).toBe(false);
        if (spec.startsWith("@/actions/")) continue; // a server action is an RPC stub on the client
        const next = resolve(spec);
        if (next) walkGraph(next, `${via} -> ${next}`);
      }
    };
    walkGraph(f, f);
  });
});
