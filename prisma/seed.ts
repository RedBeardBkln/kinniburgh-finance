/**
 * Seed: entities, institutions, accounts, scheduled transfers, scheduled bills.
 * Tags and budgets are seeded via separate import scripts.
 * Run with: pnpm db:seed
 */

import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

async function main() {
  console.log("Seeding entities…");

  // ── Entities ────────────────────────────────────────────────────────────────

  const personal = await db.entity.upsert({
    where: { name: "Personal" },
    update: {},
    create: { name: "Personal", type: "personal" },
  });

  const suddenValley = await db.entity.upsert({
    where: { name: "Sudden Valley Property Management, LLC" },
    update: {},
    create: {
      name: "Sudden Valley Property Management, LLC",
      type: "business",
      foundedDate: new Date("2026-02-01"), // February 2026; exact day not documented
    },
  });

  const ekConsulting = await db.entity.upsert({
    where: { name: "Eric Kinniburgh Consulting, LLC" },
    update: {},
    create: {
      name: "Eric Kinniburgh Consulting, LLC",
      dbaName: "LaunchTime Solutions",
      type: "business",
      // Founded 2021 — exact date not documented; year only
      taxStatusNotes:
        "Single-member LLC, disregarded entity — Schedule C on Eric's personal Form 1040. " +
        "2025 tax year extension filed and accepted. Extended deadline: October 15, 2026 " +
        "(confirm with CPA before relying on this date).",
    },
  });

  const mezzo = await db.entity.upsert({
    where: { name: "Mezzo" },
    update: {},
    create: {
      name: "Mezzo",
      type: "business",
      taxStatusNotes:
        "Not yet formed/registered as of June 2026. Expense tracking only until formation date/state is recorded.",
    },
  });

  console.log("Seeding institutions…");

  // ── Institutions ─────────────────────────────────────────────────────────────

  const tdBank = await db.institution.upsert({
    where: { name: "TD Bank" },
    update: {},
    create: { name: "TD Bank" },
  });

  const jcsb = await db.institution.upsert({
    where: { name: "Jewett City Savings Bank" },
    update: {},
    create: { name: "Jewett City Savings Bank" },
  });

  const capitalOne = await db.institution.upsert({
    where: { name: "Capital One" },
    update: {},
    create: { name: "Capital One" },
  });

  const barclays = await db.institution.upsert({
    where: { name: "Barclays" },
    update: {},
    create: { name: "Barclays" },
  });

  const pennyMac = await db.institution.upsert({
    where: { name: "PennyMac" },
    update: {},
    create: { name: "PennyMac" },
  });

  // EnerBank USA was acquired by Regions Bank (2021); source doc uses both names.
  const regionsEnerBank = await db.institution.upsert({
    where: { name: "Regions/EnerBank" },
    update: {},
    create: { name: "Regions/EnerBank" },
  });

  const betterment = await db.institution.upsert({
    where: { name: "Betterment" },
    update: {},
    create: { name: "Betterment" },
  });

  const nwm = await db.institution.upsert({
    where: { name: "Northwestern Mutual" },
    update: {},
    create: { name: "Northwestern Mutual" },
  });

  // QuickBooks Checking is issued on Green Dot Bank — verify in Plaid at build time.
  const quickBooks = await db.institution.upsert({
    where: { name: "QuickBooks/Green Dot" },
    update: {},
    create: { name: "QuickBooks/Green Dot" },
  });

  console.log("Seeding accounts…");

  // ── Accounts ─────────────────────────────────────────────────────────────────
  // $250 minimum-balance / $15 fee rule applies to TD Bank accounts ONLY.
  // JCSB x0626 has no such rule (owner-confirmed June 2026).

  const MIN_BAL = new Prisma.Decimal("250.00");
  const MIN_FEE = new Prisma.Decimal("15.00");

  async function upsertAccount(data: Parameters<typeof db.account.create>[0]["data"]) {
    return db.account.upsert({
      where: { entityId_nickname: { entityId: data.entityId as string, nickname: data.nickname as string } },
      update: {},
      create: data,
    });
  }

  const primaryChecking = await upsertAccount({
    institutionId: tdBank.id,
    entityId: personal.id,
    nickname: "Primary Checking",
    mask: "2566",
    accountType: "checking",
    minimumBalance: MIN_BAL,
    minimumBalanceFee: MIN_FEE,
  });

  const creditCards = await upsertAccount({
    institutionId: tdBank.id,
    entityId: personal.id,
    nickname: "Credit Cards",
    mask: "2631",
    accountType: "checking",
    minimumBalance: MIN_BAL,
    minimumBalanceFee: MIN_FEE,
  });

  const heatingElectric = await upsertAccount({
    institutionId: tdBank.id,
    entityId: personal.id,
    nickname: "Heating & Electric",
    mask: "2540",
    accountType: "checking",
    minimumBalance: MIN_BAL,
    minimumBalanceFee: MIN_FEE,
  });

  const mortgageInsurance = await upsertAccount({
    institutionId: tdBank.id,
    entityId: personal.id,
    nickname: "Mortgage & Insurance",
    mask: "2558",
    accountType: "checking",
    minimumBalance: MIN_BAL,
    minimumBalanceFee: MIN_FEE,
  });

  const slushFunds = await upsertAccount({
    institutionId: tdBank.id,
    entityId: personal.id,
    nickname: "Slush Funds",
    mask: "3612",
    accountType: "checking",
    minimumBalance: MIN_BAL,
    minimumBalanceFee: MIN_FEE,
  });

  await upsertAccount({
    institutionId: tdBank.id,
    entityId: personal.id,
    nickname: "The Cottage",
    mask: "8460",
    accountType: "checking",
    minimumBalance: MIN_BAL,
    minimumBalanceFee: MIN_FEE,
  });

  await upsertAccount({
    institutionId: tdBank.id,
    entityId: personal.id,
    nickname: "Savings",
    mask: "3950",
    accountType: "savings",
    minimumBalance: MIN_BAL,
    minimumBalanceFee: MIN_FEE,
  });

  // Credit cards — all autopay from x2631
  await upsertAccount({
    institutionId: capitalOne.id,
    entityId: personal.id,
    nickname: "Capital One card",
    accountType: "credit_card",
  });

  await upsertAccount({
    institutionId: barclays.id,
    entityId: personal.id,
    nickname: "Barclay card",
    accountType: "credit_card",
  });

  // JetBlue card is Barclays-issued — same login as Barclay card (owner-confirmed June 2026).
  await upsertAccount({
    institutionId: barclays.id,
    entityId: personal.id,
    nickname: "JetBlue card",
    accountType: "credit_card",
  });

  await upsertAccount({
    institutionId: pennyMac.id,
    entityId: personal.id,
    nickname: "PennyMac mortgage",
    accountType: "mortgage",
  });

  await upsertAccount({
    institutionId: regionsEnerBank.id,
    entityId: personal.id,
    nickname: "Solar loan",
    accountType: "loan",
  });

  await upsertAccount({
    institutionId: betterment.id,
    entityId: personal.id,
    nickname: "Betterment IRA",
    accountType: "investment",
  });

  await upsertAccount({
    institutionId: nwm.id,
    entityId: personal.id,
    nickname: "NWM life insurance",
    accountType: "insurance",
  });

  const jcsbOperating = await upsertAccount({
    institutionId: jcsb.id,
    entityId: suddenValley.id,
    nickname: "JCSB operating",
    mask: "0626",
    accountType: "checking",
    // No $250 minimum-balance rule (JCSB — owner-confirmed June 2026)
  });

  await upsertAccount({
    institutionId: quickBooks.id,
    entityId: ekConsulting.id,
    nickname: "QuickBooks Checking",
    mask: "2043",
    accountType: "checking",
    // Green Dot Bank underlies QB Checking — verify in Plaid at build time
  });

  console.log("Seeding scheduled transfers…");

  // ── Scheduled transfers (envelope automation) ─────────────────────────────
  // Only the owner-confirmed transfers are seeded here.
  // Slush Funds (~$277/wk) and Savings (app-recommended) are NOT created here —
  // the app must PROPOSE them to the owner for approval at setup.

  async function upsertTransfer(data: Parameters<typeof db.scheduledTransfer.create>[0]["data"]) {
    // Upsert by fromAccount + toAccount + cadence combo for idempotency
    const existing = await db.scheduledTransfer.findFirst({
      where: {
        fromAccountId: data.fromAccountId as string,
        toAccountId: data.toAccountId as string,
        cadence: data.cadence as string,
        purpose: data.purpose as string,
      },
    });
    if (existing) return existing;
    return db.scheduledTransfer.create({ data });
  }

  // x2566 → x2540: $256/wk (Heating & Electric envelope)
  // Day-of-week default = Monday; owner can adjust in the app.
  await upsertTransfer({
    fromAccountId: primaryChecking.id,
    toAccountId: heatingElectric.id,
    amount: new Prisma.Decimal("256.00"),
    cadence: "weekly",
    dayRules: { dayOfWeek: 1 }, // Monday
    purpose: "Heating & Electric envelope",
    // Note: weekly components sum to $255.30; the $0.70/wk pads the envelope (spec 07).
  });

  // x2566 → x2558: $400/wk (Mortgage & Insurance envelope — non-mortgage bills)
  await upsertTransfer({
    fromAccountId: primaryChecking.id,
    toAccountId: mortgageInsurance.id,
    amount: new Prisma.Decimal("400.00"),
    cadence: "weekly",
    dayRules: { dayOfWeek: 1 }, // Monday
    purpose: "Mortgage & Insurance envelope (non-mortgage bills)",
  });

  // x2566 → x2558: $2,350 semi-monthly (PennyMac mortgage funding)
  // Two transfers/month = $4,700/month matching the PennyMac mortgage budget line.
  // Days default to 1st and 15th; owner can adjust in the app.
  await upsertTransfer({
    fromAccountId: primaryChecking.id,
    toAccountId: mortgageInsurance.id,
    amount: new Prisma.Decimal("2350.00"),
    cadence: "semi_monthly",
    dayRules: { daysOfMonth: [1, 15] },
    purpose: "PennyMac mortgage funding",
  });

  console.log("Seeding scheduled bills…");

  // ── Scheduled bills ──────────────────────────────────────────────────────────

  async function upsertBill(data: Parameters<typeof db.scheduledBill.create>[0]["data"]) {
    const existing = await db.scheduledBill.findFirst({
      where: { accountId: data.accountId as string, payee: data.payee as string },
    });
    if (existing) return existing;
    return db.scheduledBill.create({ data });
  }

  // ── Bills from x2540 (Heating & Electric) ──
  await upsertBill({
    accountId: heatingElectric.id,
    entityId: personal.id,
    payee: "Eversource",
    amountType: "fluctuating",
    // Electric utility; solar offsets late spring–early fall; credits drawn down in fall/winter.
    expectedAmount: new Prisma.Decimal("184.00"), // doc accrual figure; budget line is $172
    autopayDay: 20,
  });

  await upsertBill({
    accountId: heatingElectric.id,
    entityId: personal.id,
    payee: "Regions/EnerBank — Solar loan",
    amountType: "static",
    expectedAmount: new Prisma.Decimal("506.00"),
    autopayDay: 20,
    annualBudget: new Prisma.Decimal("6069.00"),
  });

  // McCarthy Oil and Firewood are accrued (seasonal) — handled by AccrualEnvelope records below.
  await upsertBill({
    accountId: heatingElectric.id,
    entityId: personal.id,
    payee: "McCarthy Heating & Oil",
    amountType: "accrued",
    // No fixed autopay day; bills arrive during heating season.
    annualBudget: new Prisma.Decimal("4000.00"),
  });

  await upsertBill({
    accountId: heatingElectric.id,
    entityId: personal.id,
    payee: "Firewood",
    amountType: "accrued",
    annualBudget: new Prisma.Decimal("1000.00"),
  });

  // ── Bills from x2558 (Mortgage & Insurance) ──
  await upsertBill({
    accountId: mortgageInsurance.id,
    entityId: personal.id,
    payee: "Toyota Financial — Eric truck",
    amountType: "static",
    expectedAmount: new Prisma.Decimal("420.00"),
    // annualBudget not documented in source; leave null per spec 07.
  });

  await upsertBill({
    accountId: mortgageInsurance.id,
    entityId: personal.id,
    payee: "Northwestern Mutual",
    amountType: "static",
    expectedAmount: new Prisma.Decimal("755.00"),
    // annualBudget not documented in source; leave null per spec 07.
  });

  await upsertBill({
    accountId: mortgageInsurance.id,
    entityId: personal.id,
    payee: "Amica — Auto insurance",
    amountType: "static",
    expectedAmount: new Prisma.Decimal("206.00"),
    annualBudget: new Prisma.Decimal("2474.00"),
    // NOTE: v2 budget line Insurance/Auto Insurance is $120 — stale.
    // Validated actual is ~$217/mo combined (Amica $206 + Progressive ~$10.58).
    // Validate-imports will surface this for owner confirmation.
  });

  await upsertBill({
    accountId: mortgageInsurance.id,
    entityId: personal.id,
    payee: "Progressive — Motorcycle insurance",
    amountType: "static",
    expectedAmount: new Prisma.Decimal("10.58"), // $127/yr ÷ 12
    annualBudget: new Prisma.Decimal("127.00"),
  });

  // PennyMac mortgage is funded by the semi-monthly transfers above; the actual
  // autopay draws from x2558. We record it as a bill for forecasting purposes.
  await upsertBill({
    accountId: mortgageInsurance.id,
    entityId: personal.id,
    payee: "PennyMac — Mortgage",
    amountType: "static",
    expectedAmount: new Prisma.Decimal("4700.00"),
    // Household intentionally overpays to retire in ~12 years; track payoff projection.
  });

  // ── Bills from x2566 (Primary Checking) — Lexus payment ──
  // Eva's Lexus payment is $250/week from Primary Checking (owner-confirmed June 2026).
  await upsertBill({
    accountId: primaryChecking.id,
    entityId: personal.id,
    payee: "Lexus Financial — Eva Lexus NX 350h",
    amountType: "static",
    expectedAmount: new Prisma.Decimal("250.00"), // per week
    // Weekly cadence; no fixed day documented.
  });

  // ── Bills from JCSB x0626 (Sudden Valley Property Management, LLC) ──
  await upsertBill({
    accountId: jcsbOperating.id,
    entityId: suddenValley.id,
    payee: "Comcast",
    amountType: "static",
    expectedAmount: new Prisma.Decimal("65.95"),
  });

  await upsertBill({
    accountId: jcsbOperating.id,
    entityId: suddenValley.id,
    payee: "Eversource (Arbor Retreat)",
    amountType: "fluctuating",
    expectedAmount: new Prisma.Decimal("83.00"), // ~$83/mo; budget line $100
  });

  await upsertBill({
    accountId: jcsbOperating.id,
    entityId: suddenValley.id,
    payee: "Amica — Home insurance (Arbor Retreat)",
    amountType: "static",
    expectedAmount: new Prisma.Decimal("167.90"),
  });

  await upsertBill({
    accountId: jcsbOperating.id,
    entityId: suddenValley.id,
    payee: "McCarthy Oil (Arbor Retreat)",
    amountType: "accrued",
    annualBudget: new Prisma.Decimal("2868.00"), // $239/mo × 12
  });

  // Property taxes (Arbor Retreat): accrued at $281.67/mo; budget line $275.
  await upsertBill({
    accountId: jcsbOperating.id,
    entityId: suddenValley.id,
    payee: "Property taxes — 56 Arbor Rd",
    amountType: "accrued",
    expectedAmount: new Prisma.Decimal("281.67"), // monthly accrual
    annualBudget: new Prisma.Decimal("3380.04"), // $281.67 × 12
  });

  console.log("Seeding accrual envelopes…");

  // ── Accrual envelopes ────────────────────────────────────────────────────────

  async function upsertAccrual(data: Parameters<typeof db.accrualEnvelope.create>[0]["data"]) {
    const existing = await db.accrualEnvelope.findFirst({
      where: { accountId: data.accountId as string, name: data.name as string },
    });
    if (existing) return existing;
    return db.accrualEnvelope.create({ data });
  }

  // McCarthy Oil (personal): draws heavily Oct–Mar
  await upsertAccrual({
    accountId: heatingElectric.id,
    name: "McCarthy Oil",
    targetAnnualAmount: new Prisma.Decimal("4000.00"),
    expectedDrawMonths: [10, 11, 12, 1, 2, 3],
  });

  // Firewood: typically purchased in fall for winter
  await upsertAccrual({
    accountId: heatingElectric.id,
    name: "Firewood",
    targetAnnualAmount: new Prisma.Decimal("1000.00"),
    expectedDrawMonths: [9, 10, 11],
  });

  // Property taxes (Arbor Retreat): typically billed semi-annually in CT
  await upsertAccrual({
    accountId: jcsbOperating.id,
    name: "Property taxes — 56 Arbor Rd",
    targetAnnualAmount: new Prisma.Decimal("3380.04"),
    expectedDrawMonths: [7, 1], // July and January (typical CT semi-annual cycle — confirm with owner)
  });

  console.log("Seeding users (Eric + Eva)…");

  // ── Users ────────────────────────────────────────────────────────────────────
  // Invite-only; no public registration.
  // Passwords set to a placeholder — owner MUST change via /settings before first use.

  const placeholderHash = await bcrypt.hash("change-me-immediately", 12);

  await db.user.upsert({
    where: { email: "ekinniburgh@gmail.com" },
    update: {},
    create: {
      name: "Eric Kinniburgh",
      email: "ekinniburgh@gmail.com",
      passwordHash: placeholderHash,
      role: "owner",
    },
  });

  await db.user.upsert({
    where: { email: "eva@kinniburgh.local" }, // placeholder — owner should update
    update: {},
    create: {
      name: "Eva-Laura Ramirez-Wisiackas",
      email: "eva@kinniburgh.local",
      passwordHash: placeholderHash,
      role: "owner",
    },
  });

  await seedPhase5(db, { suddenValley, ekConsulting, mezzo });

  console.log(
    "Seed complete.\n" +
    "IMPORTANT: Change placeholder passwords for both users before first use.\n" +
    "Run `pnpm import:tags && pnpm import:budgets && pnpm validate` next."
  );
}

async function seedPhase5(
  db: PrismaClient,
  entities: {
    suddenValley: { id: string };
    ekConsulting: { id: string };
    mezzo: { id: string };
  }
) {
  console.log("Seeding Phase 5: GL codes…");

  async function upsertGlCode(data: { entityId: string; code: string; name: string; type: string }) {
    return db.glCode.upsert({
      where: { entityId_code: { entityId: data.entityId, code: data.code } },
      update: { name: data.name, type: data.type },
      create: data,
    });
  }

  // Sudden Valley PM LLC — rental property chart
  const svCodes: Array<{ code: string; name: string; type: string }> = [
    { code: "4000", name: "Rental Revenue", type: "income" },
    { code: "5010", name: "Property Management Fees", type: "expense" },
    { code: "5020", name: "Repairs & Maintenance", type: "expense" },
    { code: "5030", name: "Insurance", type: "expense" },
    { code: "5040", name: "Property Tax", type: "expense" },
    { code: "5050", name: "Utilities", type: "expense" },
    { code: "5060", name: "Mortgage Interest", type: "expense" },
    { code: "5070", name: "Landscaping", type: "expense" },
    { code: "5080", name: "Supplies", type: "expense" },
    { code: "5090", name: "Professional Services", type: "expense" },
  ];
  for (const c of svCodes) await upsertGlCode({ entityId: entities.suddenValley.id, ...c });

  // EK Consulting LLC — Schedule C
  const ekcCodes: Array<{ code: string; name: string; type: string }> = [
    { code: "4000", name: "Consulting Revenue", type: "income" },
    { code: "5010", name: "Software & Subscriptions", type: "expense" },
    { code: "5020", name: "Professional Development", type: "expense" },
    { code: "5030", name: "Home Office", type: "expense" },
    { code: "5040", name: "Travel", type: "expense" },
    { code: "5050", name: "Professional Services (CPA/Legal)", type: "expense" },
    { code: "5060", name: "Equipment", type: "expense" },
    { code: "5070", name: "Marketing", type: "expense" },
  ];
  for (const c of ekcCodes) await upsertGlCode({ entityId: entities.ekConsulting.id, ...c });

  // Mezzo — expense capture only (not yet formed)
  const mezzoCodes: Array<{ code: string; name: string; type: string }> = [
    { code: "5010", name: "General Expenses", type: "expense" },
    { code: "5020", name: "Supplies", type: "expense" },
    { code: "5030", name: "Professional Services", type: "expense" },
  ];
  for (const c of mezzoCodes) await upsertGlCode({ entityId: entities.mezzo.id, ...c });

  console.log("Seeding Phase 5: tax workspaces…");

  // EK Consulting 2025 — extension filed; Oct 15 2026 deadline (confirm with CPA)
  const ekcWorkspace = await db.taxWorkspace.upsert({
    where: { entityId_taxYear: { entityId: entities.ekConsulting.id, taxYear: 2025 } },
    update: {},
    create: {
      entityId: entities.ekConsulting.id,
      taxYear: 2025,
      status: "extended",
      deadline: new Date("2026-10-15T04:00:00Z"), // midnight ET — confirm with CPA
      notes:
        "Extension filed and accepted. Standard extended deadline is Oct 15 2026 — " +
        "confirm this date with your CPA before relying on it.",
    },
  });

  const ekcItems = [
    "Gather all 1099s and income statements",
    "Reconcile all business bank accounts",
    "Document home office square footage",
    "Compile mileage log",
    "Collect receipts for deductions > $250",
    "Prepare Schedule C draft for CPA",
    "Submit to CPA for review",
    "File with IRS by Oct 15 2026 (confirm deadline with CPA)",
  ];

  const existingEkcItems = await db.taxChecklistItem.count({ where: { workspaceId: ekcWorkspace.id } });
  if (existingEkcItems === 0) {
    await db.taxChecklistItem.createMany({
      data: ekcItems.map((label) => ({ workspaceId: ekcWorkspace.id, label })),
    });
  }

  // Sudden Valley 2026 — first filing (entity founded Feb 2026), due Apr 15 2027
  const svWorkspace = await db.taxWorkspace.upsert({
    where: { entityId_taxYear: { entityId: entities.suddenValley.id, taxYear: 2026 } },
    update: {},
    create: {
      entityId: entities.suddenValley.id,
      taxYear: 2026,
      status: "in_progress",
      deadline: new Date("2027-04-15T04:00:00Z"),
      notes: "First tax year — entity founded February 2026. Schedule E (rental income/expenses).",
    },
  });

  const svItems = [
    "Import all JCSB x0626 transactions (full 2026)",
    "Import all Airbnb payout statements",
    "Assign GL codes to all 2026 transactions",
    "Reconcile mortgage interest (obtain 1098 form)",
    "Collect property tax receipts",
    "Collect insurance premiums",
    "Collect HOA statements (if any)",
    "Attach receipts for all repairs > $500",
    "Prepare Schedule E draft for CPA",
    "File with IRS by Apr 15 2027",
  ];

  const existingSvItems = await db.taxChecklistItem.count({ where: { workspaceId: svWorkspace.id } });
  if (existingSvItems === 0) {
    await db.taxChecklistItem.createMany({
      data: svItems.map((label) => ({ workspaceId: svWorkspace.id, label })),
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
