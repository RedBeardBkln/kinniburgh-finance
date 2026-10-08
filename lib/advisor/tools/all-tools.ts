// The complete, sorted tool list of the assistant (Phase 1: 7 money tools + 6 TY2025 tax tools). Sorted ONCE at module load so the request
// `tools` array is byte-identical on every request (prompt caching). New tools are added to money-tools.ts / tax-tools.ts (or a new group
// file imported here), never inserted at run time.

import { MONEY_TOOLS } from "@/lib/advisor/tools/money-tools";
import { sortTools } from "@/lib/advisor/tools/registry";
import { TAX_TOOLS } from "@/lib/advisor/tools/tax-tools";
import { toolMap } from "@/lib/advisor/tools/run-tool";
import type { RegisteredTool } from "@/lib/advisor/tools/types";

export const ADVISOR_TOOLS: readonly RegisteredTool[] = sortTools([...MONEY_TOOLS, ...TAX_TOOLS]);
export const ADVISOR_TOOL_MAP: ReadonlyMap<string, RegisteredTool> = toolMap(ADVISOR_TOOLS);
