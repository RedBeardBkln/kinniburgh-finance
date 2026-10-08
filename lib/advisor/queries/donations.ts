// Donation log read for the assistant: a thin wrapper over loadDonationsPage (lib/donations-build.ts), the read-only assembler of the
// /tax/donations/[year] page (no create / update / delete in it). The view it returns carries notes, document ids and linked-receipt readings;
// the shaper in tools/list-donations.ts takes only the fields the tool returns. No deduction amount is computed by it or by the tool.

import { loadDonationsPage, type DonationsPageView } from "@/lib/donations-build";

export type { DonationsPageView };

export async function loadDonations(year: number): Promise<DonationsPageView> {
  return loadDonationsPage(year);
}
