import { NextRequest, NextResponse } from "next/server";
import {
  checkBudgetOverspend,
  checkLowBalance,
  checkAccrualShortfall,
  checkBillReminders,
  checkAnomalies,
  checkDocumentExpiry,
  checkLargeSpend,
  checkCardPaymentsDue,
  dispatchPending,
} from "@/lib/notifications";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  try {
    const [overspend, lowBal, accrual, bills, anomalies, policyExpiry, largeSpend, cardsDue] = await Promise.all([
      checkBudgetOverspend(period),
      checkLowBalance(),
      checkAccrualShortfall(),
      checkBillReminders(),
      checkAnomalies(period),
      checkDocumentExpiry(),
      checkLargeSpend(),
      checkCardPaymentsDue(),
    ]);

    await dispatchPending();

    const generated = overspend + lowBal + accrual + bills + anomalies + policyExpiry + largeSpend + cardsDue;
    return NextResponse.json({ generated, overspend, lowBal, accrual, bills, anomalies, policyExpiry, largeSpend, cardsDue });
  } catch (err) {
    console.error("[cron/notifications]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
