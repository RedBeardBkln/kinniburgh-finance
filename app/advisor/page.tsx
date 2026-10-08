import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { listGoals } from "@/actions/goals";
import { GoalsPanel } from "@/components/advisor/goals-panel";
import { AdvisorWorkspace } from "@/components/advisor/advisor-workspace";
import type { MemoryNoteDto } from "@/components/advisor/memory-panel";
import { toUiMessage, type ConversationView, type UiMessage } from "@/lib/advisor/chat-state";
import { loadAdvisorConfig } from "@/lib/advisor/config";
import { checkLimits, windowStart } from "@/lib/advisor/limits";
import * as store from "@/lib/advisor/store";

interface PageProps {
  searchParams: Promise<{ c?: string | string[] }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdvisorPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;
  const sp = await searchParams;
  const wanted = typeof sp.c === "string" && UUID.test(sp.c) ? sp.c : null;

  const now = new Date();
  const cfg = loadAdvisorConfig();
  // Every read of the assistant's own tables is fail-soft: until the migration is applied the page still loads, and the Goals panel keeps working.
  const [goals, listed, memoryRead, usageRead] = await Promise.all([
    listGoals(),
    store.safeRead(() => store.listConversations(userId)),
    store.safeRead(() => store.listActiveMemory()),
    store.safeRead(() => store.sumUsageSince(userId, windowStart(now))),
  ]);

  let activeId: string | null = null;
  let messages: UiMessage[] = [];
  if (wanted !== null && listed.state === "ok") {
    const active = await store.safeRead(async () => {
      const conv = await store.getOwnConversation(userId, wanted); // the user id is part of the lookup: someone else's id is simply not found
      return conv === null ? null : { conv, messages: await store.loadMessages(userId, wanted) };
    });
    if (active.state === "ok" && active.value !== null) {
      activeId = active.value.conv.id;
      messages = active.value.messages.map(toUiMessage);
    }
  }

  const conversations: ConversationView[] =
    listed.state === "ok" ? listed.value.map((c) => ({ id: c.id, title: c.title, messageCount: c.messageCount, lastMessageAt: c.lastMessageAt.toISOString() })) : [];
  const memory: MemoryNoteDto[] =
    memoryRead.state === "ok" ? memoryRead.value.map((n) => ({ id: n.id, text: n.text, category: n.category, createdByName: n.createdByName, createdAt: n.createdAt.toISOString(), source: n.source })) : [];
  let turnsLeft: number | null = null;
  let tokens24h: number | null = null;
  if (usageRead.state === "ok") {
    const decision = checkLimits(cfg, usageRead.value.user, usageRead.value.household);
    turnsLeft = decision.ok ? decision.turnsLeft : 0;
    tokens24h = usageRead.value.user.freshTokens;
  }
  const storage = listed.state === "ok" ? "ok" : listed.state;

  return (
    <AppShell>
      <div className="flex h-[calc(100vh-7rem)] flex-col gap-4">
        <div>
          <h1 className="text-2xl font-bold">Financial Advisor</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            An AI assistant that looks up your accounts, budgets, transactions and the TY2025 return as you ask. It reads; it never changes anything. All recommendations should be independently verified before action.
          </p>
        </div>
        <AdvisorWorkspace
          initialConversations={conversations}
          initialActiveId={activeId}
          initialMessages={messages}
          initialMemory={memory}
          turnsLeft={turnsLeft}
          tokens24h={tokens24h}
          storage={storage}
          nowIso={now.toISOString()}
          goalsSlot={<GoalsPanel initialGoals={goals} />}
        />
      </div>
    </AppShell>
  );
}
