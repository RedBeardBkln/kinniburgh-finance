// In-memory stand-in for the parts of Prisma that lib/invoicing/store.ts uses (test helper, not a test file).
//
// Faithful enough to prove the design:
//   - interactive transactions run one at a time (a mutex, like the row locks the real code takes) on a working copy that is
//     committed on success and RESTORED when the callback throws, so "a failed issue burns no number" is genuinely exercised;
//   - the profile counter UPDATE ... RETURNING, other raw SELECT ... FOR UPDATE statements are no-ops;
//   - unique indexes that matter (BillingPayment.requestKey, BillingDocument entityId+kind+number) throw P2002;
//   - nested `allocations` relations on documents and payments.
// It is NOT a SQL engine: `select` is ignored (rows come back whole) and `where` supports only what the store uses.

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

type Row = Record<string, unknown>;

class P2002 extends Error {
  code = "P2002";
  constructor() {
    super("Unique constraint failed");
    this.name = "PrismaClientKnownRequestError";
  }
}

const isDate = (v: unknown): v is Date => v instanceof Date;

function eq(a: unknown, b: unknown): boolean {
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  return a === b;
}

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v !== null && typeof v === "object" && !isDate(v)) {
      const o = v as Record<string, unknown>;
      if ("in" in o) {
        if (!(o.in as unknown[]).some((x) => eq(x, row[k]))) return false;
        continue;
      }
      if ("not" in o) {
        if (eq(o.not, row[k])) return false;
        continue;
      }
      if ("lt" in o || "gt" in o || "gte" in o || "lte" in o) {
        const x = isDate(row[k]) ? (row[k] as Date).getTime() : Number(row[k]);
        const val = (n: unknown) => (isDate(n) ? n.getTime() : Number(n));
        if ("lt" in o && !(x < val(o.lt))) return false;
        if ("gt" in o && !(x > val(o.gt))) return false;
        if ("gte" in o && !(x >= val(o.gte))) return false;
        if ("lte" in o && !(x <= val(o.lte))) return false;
        continue;
      }
      continue; // relation filters are not modelled
    }
    if (!eq(row[k], v)) return false;
  }
  return true;
}

export class FakeTable {
  rows: Row[] = [];
  constructor(
    private readonly db: FakeDb,
    public readonly name: string,
    private readonly defaults: () => Row = () => ({}),
    private readonly uniques: string[][] = []
  ) {}

  private checkUnique(candidate: Row, ignoreId?: unknown) {
    for (const cols of this.uniques) {
      if (cols.some((c) => candidate[c] === null || candidate[c] === undefined)) continue;
      const clash = this.rows.find((r) => r.id !== ignoreId && cols.every((c) => eq(r[c], candidate[c])));
      if (clash) throw new P2002();
    }
  }

  async create(args: { data: Row; select?: unknown }): Promise<Row> {
    await Promise.resolve();
    const now = this.db.tick();
    const row: Row = { id: randomUUID(), createdAt: now, updatedAt: now, ...this.defaults(), ...args.data };
    this.checkUnique(row);
    this.rows.push(row);
    return { ...row };
  }

  async createMany(args: { data: Row[] }): Promise<{ count: number }> {
    for (const d of args.data) await this.create({ data: d });
    return { count: args.data.length };
  }

  private withRelations(row: Row): Row {
    const out: Row = { ...row };
    if (this.name === "billingDocument") {
      out.allocations = this.db.allocationsWhere((a) => a.invoiceId === row.id).map((a) => ({ ...a, payment: this.db.billingPayment.rows.find((p) => p.id === a.paymentId) ?? null }));
      out.client = this.db.client.rows.find((c) => c.id === row.clientId) ?? null;
      out.lines = this.db.billingLine.rows
        .filter((l) => l.documentId === row.id)
        .sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number))
        .map((l) => ({ ...l, quantity: new Prisma.Decimal(String(l.quantity)) }));
      out.events = this.db.billingEvent.rows.filter((e) => e.documentId === row.id).map((e) => ({ ...e }));
    }
    if (this.name === "billingPayment") {
      out.allocations = this.db.allocationsWhere((a) => a.paymentId === row.id);
      out.client = this.db.client.rows.find((c) => c.id === row.clientId) ?? null;
    }
    return out;
  }

  /** Applies the `where` of a nested `allocations` select (only voidedAt: null is modelled). */
  private shape(row: Row, select: unknown): Row {
    const full = this.withRelations(row);
    const sel = select as { allocations?: { where?: Record<string, unknown> } } | undefined;
    if (sel?.allocations?.where && Array.isArray(full.allocations)) {
      full.allocations = (full.allocations as Row[]).filter((a) => matches(a, sel.allocations!.where));
    }
    return full;
  }

  async findFirst(args: { where?: Record<string, unknown>; select?: unknown }): Promise<Row | null> {
    await Promise.resolve();
    const r = this.rows.find((x) => matches(x, args.where));
    return r ? this.shape(r, args.select) : null;
  }

  async findUnique(args: { where: Record<string, unknown>; select?: unknown }): Promise<Row | null> {
    return this.findFirst(args);
  }

  async findMany(args: { where?: Record<string, unknown>; select?: unknown } = {}): Promise<Row[]> {
    await Promise.resolve();
    return this.rows.filter((x) => matches(x, args.where)).map((r) => this.shape(r, args.select));
  }

  async count(args: { where?: Record<string, unknown> } = {}): Promise<number> {
    await Promise.resolve();
    return this.rows.filter((x) => matches(x, args.where)).length;
  }

  async aggregate(args: { where?: Record<string, unknown>; _max: Record<string, boolean> }): Promise<{ _max: Record<string, number | null> }> {
    await Promise.resolve();
    const rows = this.rows.filter((x) => matches(x, args.where));
    const out: Record<string, number | null> = {};
    for (const k of Object.keys(args._max)) {
      const vals = rows.map((r) => r[k]).filter((v): v is number => typeof v === "number");
      out[k] = vals.length ? Math.max(...vals) : null;
    }
    return { _max: out };
  }

  async updateMany(args: { where?: Record<string, unknown>; data: Row }): Promise<{ count: number }> {
    await Promise.resolve();
    const targets = this.rows.filter((x) => matches(x, args.where));
    for (const t of targets) {
      const next = { ...t, ...args.data, updatedAt: this.db.tick() };
      this.checkUnique(next, t.id);
      Object.assign(t, next);
    }
    return { count: targets.length };
  }

  async update(args: { where: Record<string, unknown>; data: Row }): Promise<Row> {
    const r = await this.updateMany(args);
    if (r.count !== 1) throw new Error("record not found");
    return (await this.findFirst({ where: args.where }))!;
  }

  async deleteMany(args: { where?: Record<string, unknown> }): Promise<{ count: number }> {
    await Promise.resolve();
    const before = this.rows.length;
    this.rows = this.rows.filter((x) => !matches(x, args.where));
    return { count: before - this.rows.length };
  }
}

export class FakeDb {
  private clock = Date.UTC(2026, 9, 15, 12, 0, 0);
  private lock: Promise<void> = Promise.resolve();
  tick(): Date {
    this.clock += 1;
    return new Date(this.clock);
  }

  invoicingProfile = new FakeTable(this, "invoicingProfile", () => ({}), [["entityId"]]);
  client = new FakeTable(this, "client", () => ({ archivedAt: null, w9: null, contacts: [] }), [["entityId", "name"]]);
  clientContact = new FakeTable(this, "clientContact");
  reimbursableItem = new FakeTable(this, "reimbursableItem", () => ({ archivedAt: null }), [["entityId", "name"]]);
  billingDocument = new FakeTable(this, "billingDocument", () => ({ number: null, displayNumber: null, status: "draft", archivedAt: null, sendCount: 0, voidedAt: null }), [["entityId", "kind", "number"]]);
  billingLine = new FakeTable(this, "billingLine");
  billingPayment = new FakeTable(this, "billingPayment", () => ({ status: "recorded", feeCents: 0, depositTransactionId: null }), [["requestKey"]]);
  billingAllocation = new FakeTable(this, "billingAllocation", () => ({ voidedAt: null }));
  billingEvent = new FakeTable(this, "billingEvent", () => ({}), [["eventKey"]]);
  glCode = new FakeTable(this, "glCode");
  transaction = new FakeTable(this, "transaction");
  receipt = new FakeTable(this, "receipt");
  document = new FakeTable(this, "document");
  auditLog = new FakeTable(this, "auditLog");
  entity = new FakeTable(this, "entity");
  user = new FakeTable(this, "user");

  private tables(): FakeTable[] {
    return [this.invoicingProfile, this.client, this.clientContact, this.reimbursableItem, this.billingDocument, this.billingLine, this.billingPayment, this.billingAllocation, this.billingEvent, this.glCode, this.transaction, this.receipt, this.document, this.auditLog, this.entity, this.user];
  }

  allocationsWhere(pred: (a: Row) => boolean): Row[] {
    return this.billingAllocation.rows.filter(pred).map((r) => ({ ...r }));
  }

  /** Tagged-template raw query: only the issue counter statement returns rows; FOR UPDATE selects are no-ops. */
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    await Promise.resolve();
    const text = strings.join("?");
    if (text.includes('UPDATE "InvoicingProfile" SET "nextInvoiceNumber"')) {
      const entityId = values[0];
      const p = this.invoicingProfile.rows.find((r) => r.entityId === entityId);
      if (!p) return [];
      const n = p.nextInvoiceNumber as number;
      p.nextInvoiceNumber = n + 1;
      return [{ n, prefix: p.invoicePrefix as string, pad: p.numberPad as number }];
    }
    return [];
  }

  async $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    await previous;
    const snapshot = this.tables().map((t) => t.rows.map((r) => ({ ...r })));
    try {
      return await fn(this);
    } catch (err) {
      this.tables().forEach((t, i) => {
        t.rows = snapshot[i]!;
      });
      throw err;
    } finally {
      release();
    }
  }
}

export function createFakeDb(): FakeDb {
  return new FakeDb();
}
