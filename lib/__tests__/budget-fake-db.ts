// In-memory stand-in for the parts of Prisma the Budget write path uses (test helper, not a test file).
//
// What it emulates faithfully enough to prove the design:
//   - the Budget table with its UNIQUE (tagId, entityId, period) index (create throws, createMany skipDuplicates skips);
//   - interactive transactions: writes go to a working copy and become visible only on commit, a throw rolls back;
//   - `pg_advisory_xact_lock`: a single mutex taken by `$executeRaw` and released when the transaction ends, and the
//     working copy is taken AT lock time (READ COMMITTED: a later transaction sees what an earlier one committed);
//   - AuditLog / ScheduledBill / Tag / Entity delegates the actions touch.
// It is NOT a SQL engine: `select` is ignored (rows come back whole) and `where` supports only what the code uses.
import { Decimal } from "@prisma/client/runtime/library";

export interface FakeBudgetRow {
  id: string;
  tagId: string;
  entityId: string;
  accountId: string;
  period: string;
  budgeted: Decimal | null;
  additionalAmountCents: Decimal;
  payDay: number | null;
  frequency: string;
  payDayOfWeek: number | null;
  biweeklyAnchorDate: Date | null;
  payMonth: number | null;
  annualAmountDue: Decimal | null;
  rolloverEnabled: boolean;
  rolloverAmount: Decimal | null;
}

export interface FakeTag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}
export interface FakeEntity {
  id: string;
  name: string;
  slug: string;
}
export interface FakeAccount {
  id: string;
  nickname: string;
  entityId: string;
}
export interface FakeBill {
  id: string;
  budgetTagId: string;
  budgetEntityId: string;
  active: boolean;
  [k: string]: unknown;
}
export interface AuditEntry {
  changedBy: string;
  changeType: string;
  before?: unknown;
  after?: unknown;
}

export const D = (v: string | number): Decimal => new Decimal(v);

let seq = 0;
export function budgetRow(over: Partial<FakeBudgetRow> & Pick<FakeBudgetRow, "entityId" | "tagId" | "period">): FakeBudgetRow {
  seq += 1;
  return {
    id: over.id ?? `row-${seq}`,
    accountId: "acct-1",
    budgeted: D("100"),
    additionalAmountCents: D(0),
    payDay: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    rolloverEnabled: false,
    rolloverAmount: null,
    ...over,
  };
}

function cloneRow(r: FakeBudgetRow): FakeBudgetRow {
  return { ...r };
}

type Where = Record<string, unknown>;

function matchPeriod(p: string, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (typeof cond === "string") return p === cond;
  const c = cond as { gt?: string; gte?: string; lt?: string; lte?: string; in?: string[] };
  if (c.gt !== undefined && !(p > c.gt)) return false;
  if (c.gte !== undefined && !(p >= c.gte)) return false;
  if (c.lt !== undefined && !(p < c.lt)) return false;
  if (c.lte !== undefined && !(p <= c.lte)) return false;
  if (c.in !== undefined && !c.in.includes(p)) return false;
  return true;
}

function matches(r: FakeBudgetRow, where: Where | undefined): boolean {
  if (!where) return true;
  if (where.entityId !== undefined && r.entityId !== where.entityId) return false;
  if (where.tagId !== undefined && r.tagId !== where.tagId) return false;
  if (where.id !== undefined && r.id !== where.id) return false;
  if (!matchPeriod(r.period, where.period)) return false;
  return true;
}

export interface FakeDbOptions {
  rows?: FakeBudgetRow[];
  tags?: FakeTag[];
  entities?: FakeEntity[];
  accounts?: FakeAccount[];
  bills?: FakeBill[];
  /** Called before every write/read on a transaction client: throw to inject a failure. */
  beforeOp?: (op: string) => void;
}

export function createFakeBudgetDb(opts: FakeDbOptions = {}) {
  const state = {
    committed: (opts.rows ?? []).map(cloneRow),
    audit: [] as AuditEntry[],
    bills: (opts.bills ?? []).map((b) => ({ ...b })),
    tags: opts.tags ?? [],
    entities: opts.entities ?? [],
    accounts: opts.accounts ?? [],
    locks: 0,
    transactions: 0,
    commits: 0,
    rollbacks: 0,
    log: [] as string[],
    appSetting: new Map<string, string>(),
  };

  // The mutex behind pg_advisory_xact_lock.
  let held = false;
  const waiters: Array<() => void> = [];
  async function acquire(): Promise<void> {
    if (!held) {
      held = true;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  function release(): void {
    const next = waiters.shift();
    if (next) next();
    else held = false;
  }

  let idCounter = 0;
  const newId = () => `gen-${(idCounter += 1)}`;

  function decorate(r: FakeBudgetRow) {
    const tag = state.tags.find((t) => t.id === r.tagId);
    const entity = state.entities.find((e) => e.id === r.entityId);
    const account = state.accounts.find((a) => a.id === r.accountId);
    const accountEntity = state.entities.find((e) => e.id === account?.entityId);
    return {
      ...r,
      tag: tag ?? { id: r.tagId, name: r.tagId, shortName: r.tagId, parentId: null },
      entity: entity ?? { id: r.entityId, name: r.entityId, slug: r.entityId },
      account: { nickname: account?.nickname ?? r.accountId, entity: { name: accountEntity?.name ?? "Personal" } },
    };
  }

  function budgetDelegate(getRows: () => FakeBudgetRow[], setRows: (rows: FakeBudgetRow[]) => void, op: (name: string) => void) {
    return {
      findMany: async (args: { where?: Where; orderBy?: unknown; take?: number; select?: unknown } = {}) => {
        op("budget.findMany");
        let rows = getRows().filter((r) => matches(r, args.where)).map(cloneRow);
        // every caller here orders by period desc (or does not care); keep the order deterministic
        rows.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : a.id < b.id ? -1 : 1));
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        return rows.map(decorate);
      },
      findUnique: async (args: { where: { id?: string; tagId_entityId_period?: { tagId: string; entityId: string; period: string } } }) => {
        op("budget.findUnique");
        const k = args.where.tagId_entityId_period;
        const row = getRows().find((r) => (k ? r.tagId === k.tagId && r.entityId === k.entityId && r.period === k.period : r.id === args.where.id));
        return row ? cloneRow(row) : null;
      },
      create: async (args: { data: Partial<FakeBudgetRow> & { tagId: string; entityId: string; period: string } }) => {
        op("budget.create");
        const d = args.data;
        if (getRows().some((r) => r.tagId === d.tagId && r.entityId === d.entityId && r.period === d.period)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = budgetRow({ ...d, id: newId() });
        setRows([...getRows(), row]);
        return cloneRow(row);
      },
      createMany: async (args: { data: Array<Partial<FakeBudgetRow> & { tagId: string; entityId: string; period: string }>; skipDuplicates?: boolean }) => {
        op("budget.createMany");
        const rows = getRows().slice();
        let count = 0;
        for (const d of args.data) {
          if (rows.some((r) => r.tagId === d.tagId && r.entityId === d.entityId && r.period === d.period)) {
            if (args.skipDuplicates) continue;
            throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          }
          rows.push(budgetRow({ ...d, id: newId() }));
          count += 1;
        }
        setRows(rows);
        return { count };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        op("budget.update");
        const rows = getRows().slice();
        const i = rows.findIndex((r) => r.id === args.where.id);
        if (i < 0) throw Object.assign(new Error("Record not found"), { code: "P2025" });
        const next = { ...(rows[i] as FakeBudgetRow) } as Record<string, unknown>;
        for (const [k, v] of Object.entries(args.data)) {
          if (k === "account") next.accountId = (v as { connect: { id: string } }).connect.id;
          else next[k] = v;
        }
        rows[i] = next as unknown as FakeBudgetRow;
        setRows(rows);
        return cloneRow(rows[i] as FakeBudgetRow);
      },
      deleteMany: async (args: { where?: Where }) => {
        op("budget.deleteMany");
        const rows = getRows();
        const keep = rows.filter((r) => !matches(r, args.where));
        setRows(keep);
        return { count: rows.length - keep.length };
      },
    };
  }

  function sideDelegates(getBills: () => FakeBill[], setBills: (b: FakeBill[]) => void, getAudit: () => AuditEntry[], op: (name: string) => void) {
    return {
      auditLog: {
        create: async (args: { data: AuditEntry }) => {
          op("auditLog.create");
          getAudit().push(JSON.parse(JSON.stringify(args.data)) as AuditEntry);
          return args.data;
        },
      },
      scheduledBill: {
        upsert: async (args: { where: { budgetTagId_budgetEntityId: { budgetTagId: string; budgetEntityId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          op("scheduledBill.upsert");
          const k = args.where.budgetTagId_budgetEntityId;
          const bills = getBills().slice();
          const i = bills.findIndex((b) => b.budgetTagId === k.budgetTagId && b.budgetEntityId === k.budgetEntityId);
          if (i >= 0) bills[i] = { ...(bills[i] as FakeBill), ...args.update } as FakeBill;
          else bills.push({ id: newId(), ...args.create } as unknown as FakeBill);
          setBills(bills);
          return {};
        },
        updateMany: async (args: { where: { budgetTagId: string; budgetEntityId: string }; data: Record<string, unknown> }) => {
          op("scheduledBill.updateMany");
          let count = 0;
          setBills(
            getBills().map((b) => {
              if (b.budgetTagId === args.where.budgetTagId && b.budgetEntityId === args.where.budgetEntityId) {
                count += 1;
                return { ...b, ...args.data };
              }
              return b;
            })
          );
          return { count };
        },
      },
      tag: { findUnique: async (args: { where: { id: string } }) => state.tags.find((t) => t.id === args.where.id) ?? null },
      entity: { findUnique: async (args: { where: { id: string } }) => state.entities.find((e) => e.id === args.where.id) ?? null },
    };
  }

  const noop = () => {};
  const root = {
    budget: budgetDelegate(
      () => state.committed,
      (rows) => {
        state.committed = rows;
      },
      noop
    ),
    ...sideDelegates(
      () => state.bills,
      (b) => {
        state.bills = b;
      },
      () => state.audit,
      noop
    ),
    appSetting: {
      findUnique: async (args: { where: { key: string } }) => {
        const v = state.appSetting.get(args.where.key);
        return v === undefined ? null : { value: v };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      state.transactions += 1;
      let working = null as FakeBudgetRow[] | null;
      let workingBills = null as FakeBill[] | null;
      let workingAudit = null as AuditEntry[] | null;
      let locked = false;
      const ensure = () => {
        if (working === null) {
          working = state.committed.map(cloneRow);
          workingBills = state.bills.map((b) => ({ ...b }));
          workingAudit = [];
        }
      };
      const op = (name: string) => {
        state.log.push(name);
        opts.beforeOp?.(name);
        ensure();
      };
      const tx = {
        $executeRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join("?");
          if (/pg_advisory_xact_lock/.test(sql)) {
            state.log.push("lock");
            await acquire();
            locked = true;
            state.locks += 1;
            // READ COMMITTED: what is visible is whatever was committed by the time the lock was granted
            working = null;
            ensure();
          }
          return 1;
        },
        budget: budgetDelegate(
          () => (ensure(), working as FakeBudgetRow[]),
          (rows) => {
            working = rows;
          },
          op
        ),
        ...sideDelegates(
          () => (ensure(), workingBills as FakeBill[]),
          (b) => {
            workingBills = b;
          },
          () => (ensure(), workingAudit as AuditEntry[]),
          op
        ),
      };
      try {
        const result = await fn(tx);
        if (working !== null) {
          state.committed = working;
          state.bills = workingBills as FakeBill[];
          state.audit.push(...(workingAudit as AuditEntry[]));
        }
        state.commits += 1;
        return result;
      } catch (err) {
        state.rollbacks += 1;
        throw err;
      } finally {
        if (locked) release();
      }
    },
  };

  return { db: root, state };
}

/** A sorted, comparable snapshot of the committed rows: "entity|tag|period|budgeted|payDay|..." (ids excluded). */
export function snapshot(rows: readonly FakeBudgetRow[]): string[] {
  return rows
    .map((r) =>
      [r.entityId, r.tagId, r.period, r.accountId, r.budgeted?.toString() ?? "null", r.additionalAmountCents.toString(), r.payDay, r.frequency, r.payDayOfWeek, r.payMonth, r.annualAmountDue?.toString() ?? "null", r.rolloverEnabled, r.rolloverAmount?.toString() ?? "null"].join("|")
    )
    .sort();
}
