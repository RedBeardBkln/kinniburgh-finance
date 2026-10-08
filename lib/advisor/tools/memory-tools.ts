// The Phase 2 memory suggestion tool. Registered in all-tools.ts. It never writes (see propose-memory-note.ts).

import { proposeMemoryNoteTool } from "@/lib/advisor/tools/propose-memory-note";
import type { RegisteredTool } from "@/lib/advisor/tools/types";

export const MEMORY_TOOLS: readonly RegisteredTool[] = [proposeMemoryNoteTool];
