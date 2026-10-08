// The Phase 2 records tools (documents list, donations, fixed assets, insurance). Registered in all-tools.ts.

import { listDocumentsTool } from "@/lib/advisor/tools/list-documents";
import { listDonationsTool } from "@/lib/advisor/tools/list-donations";
import { listFixedAssetsTool } from "@/lib/advisor/tools/list-fixed-assets";
import { listInsuranceTool } from "@/lib/advisor/tools/list-insurance";
import type { RegisteredTool } from "@/lib/advisor/tools/types";

export const RECORDS_TOOLS: readonly RegisteredTool[] = [listDocumentsTool, listDonationsTool, listFixedAssetsTool, listInsuranceTool];
