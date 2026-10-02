import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import {
  checkBudgetOverspend,
  checkBudgetPace,
  checkLowBalance,
  checkAccrualShortfall,
  checkBillReminders,
  checkAnomalies,
  checkDocumentExpiry,
  checkLargeSpend,
  checkCardPaymentsDue,
  checkCcFundingShortfall,
  dispatchPending,
} from "@/lib/notifications";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  try {
    const [overspend, budgetPace, lowBal, accrual, bills, anomalies, policyExpiry, largeSpend, cardsDue, ccFunding] = await Promise.all([
      checkBudgetOverspend(period),
      checkBudgetPace(period),
      checkLowBalance(),
      checkAccrualShortfall(),
      checkBillReminders(),
      checkAnomalies(period),
      checkDocumentExpiry(),
      checkLargeSpend(),
      checkCardPaymentsDue(),
      checkCcFundingShortfall(),
    ]);

    await dispatchPending();

    const generated = overspend + budgetPace + lowBal + accrual + bills + anomalies + policyExpiry + largeSpend + cardsDue + ccFunding;
    return NextResponse.json({ generated, overspend, budgetPace, lowBal, accrual, bills, anomalies, policyExpiry, largeSpend, cardsDue, ccFunding });
  } catch (err) {
    console.error("[cron/notifications]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
