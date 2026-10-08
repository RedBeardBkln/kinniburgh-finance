// The Phase 2 document-values tool. Registered in all-tools.ts.

import { getDocumentValuesTool } from "@/lib/advisor/tools/get-document-values";
import type { RegisteredTool } from "@/lib/advisor/tools/types";

export const DOCUMENT_TOOLS: readonly RegisteredTool[] = [getDocumentValuesTool];
