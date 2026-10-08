// Production wiring of the chat turn's collaborators (plan section 14 step 4): the real store, the real tools, the Anthropic adapter.
// The route imports this and run-turn only. Server only.

import { loadAdvisorConfig } from "@/lib/advisor/config";
import { createAnthropicLlm } from "@/lib/advisor/anthropic";
import { getPerson } from "@/lib/advisor/queries/people";
import type { TurnDeps } from "@/lib/advisor/run-turn";
import * as store from "@/lib/advisor/store";
import { ADVISOR_TOOLS, ADVISOR_TOOL_MAP } from "@/lib/advisor/tools/all-tools";

export function productionDeps(): TurnDeps {
  const cfg = loadAdvisorConfig();
  return {
    cfg,
    now: () => new Date(),
    clock: () => Date.now(),
    tools: ADVISOR_TOOLS,
    toolMap: ADVISOR_TOOL_MAP,
    store,
    getPersonName: async (userId) => (await getPerson(userId))?.name ?? null,
    createLlm: (userId) => createAnthropicLlm({ cfg, tools: ADVISOR_TOOLS, userId }),
    isMissingTable: store.isMissingTableError,
  };
}
