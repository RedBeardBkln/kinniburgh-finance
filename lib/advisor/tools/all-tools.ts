// The complete, sorted tool list of the assistant: Phase 1 (7 money tools + 6 TY2025 tax tools) and Phase 2 (4 business and planning tools,
// 4 records tools, 2 state and change tools, the document values tool and the memory SUGGESTION tool) = 25. Sorted ONCE at module load so the
// request `tools` array is byte-identical on every request (prompt caching). New tools are added to a group file imported here, never inserted
// at run time.

import { BUSINESS_TOOLS } from "@/lib/advisor/tools/business-tools";
import { DOCUMENT_TOOLS } from "@/lib/advisor/tools/document-tools";
import { MEMORY_TOOLS } from "@/lib/advisor/tools/memory-tools";
import { MONEY_TOOLS } from "@/lib/advisor/tools/money-tools";
import { RECORDS_TOOLS } from "@/lib/advisor/tools/records-tools";
import { sortTools } from "@/lib/advisor/tools/registry";
import { STATE_TOOLS } from "@/lib/advisor/tools/state-tools";
import { TAX_TOOLS } from "@/lib/advisor/tools/tax-tools";
import { toolMap } from "@/lib/advisor/tools/run-tool";
import type { RegisteredTool } from "@/lib/advisor/tools/types";

export const ADVISOR_TOOLS: readonly RegisteredTool[] = sortTools([...MONEY_TOOLS, ...TAX_TOOLS, ...BUSINESS_TOOLS, ...RECORDS_TOOLS, ...STATE_TOOLS, ...DOCUMENT_TOOLS, ...MEMORY_TOOLS]);
export const ADVISOR_TOOL_MAP: ReadonlyMap<string, RegisteredTool> = toolMap(ADVISOR_TOOLS);
