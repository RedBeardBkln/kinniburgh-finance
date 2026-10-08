// Fixed-asset register read for the assistant: a thin wrapper over loadFixedAssetsPage (lib/fixed-assets-build.ts), the read-only assembler of
// the /tax/fixed-assets/[year] page. The view carries notes and document ids; the shaper in tools/list-fixed-assets.ts takes only the fields the
// tool returns. Nothing here computes depreciation, a MACRS class, a Section 179 or bonus figure, or a building basis.

import { loadFixedAssetsPage, type FixedAssetsPageView } from "@/lib/fixed-assets-build";

export type { FixedAssetsPageView };

export async function loadFixedAssets(year: number): Promise<FixedAssetsPageView> {
  return loadFixedAssetsPage(year);
}
