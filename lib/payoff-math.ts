export interface PayoffScenario {
  extraMonthlyPaymentCents: number;
  monthsRemaining: number;
  totalInterestCents: number;
  payoffDate: string; // YYYY-MM-DD
}

export function computeCCPayoff(
  balanceCents: number,
  annualRate: number,
  monthlyPaymentCents: number
): PayoffScenario[] {
  const extras = [0, 5000, 10000, 25000, 50000];

  return extras.map((extra) => {
    const monthlyRate = annualRate / 12;
    const payment = monthlyPaymentCents + extra;
    let balance = balanceCents;
    let months = 0;
    let totalInterest = 0;

    while (balance > 0 && months < 600) {
      const interestThisMonth = Math.round(balance * monthlyRate);
      totalInterest += interestThisMonth;
      const principal = Math.min(payment - interestThisMonth, balance);
      if (principal <= 0) {
        months = 600;
        break;
      }
      balance -= principal;
      months++;
    }

    const payoffDate = new Date();
    payoffDate.setMonth(payoffDate.getMonth() + months);

    return {
      extraMonthlyPaymentCents: extra,
      monthsRemaining: months,
      totalInterestCents: totalInterest,
      payoffDate: payoffDate.toISOString().slice(0, 10),
    };
  });
}

export function computePayoffScenarios(
  principalCents: number,
  annualRate: number,
  remainingMonths: number,
  currentMonthlyPaymentCents: number
): PayoffScenario[] {
  const extras = [0, 10000, 20000, 50000, 100000];

  return extras.map((extra) => {
    const monthlyRate = annualRate / 12;
    const payment = currentMonthlyPaymentCents + extra;
    let balance = principalCents;
    let months = 0;
    let totalInterest = 0;

    while (balance > 0 && months < 600) {
      const interestThisMonth = Math.round(balance * monthlyRate);
      totalInterest += interestThisMonth;
      const principal = Math.min(payment - interestThisMonth, balance);
      balance -= principal;
      months++;
    }

    const payoffDate = new Date();
    payoffDate.setMonth(payoffDate.getMonth() + months);

    return {
      extraMonthlyPaymentCents: extra,
      monthsRemaining: months,
      totalInterestCents: totalInterest,
      payoffDate: payoffDate.toISOString().slice(0, 10),
    };
  });
}
