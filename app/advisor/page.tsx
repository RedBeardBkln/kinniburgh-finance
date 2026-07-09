import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { listGoals } from "@/actions/goals";
import { GoalsPanel } from "@/components/advisor/goals-panel";
import { AdvisorChat } from "@/components/advisor/advisor-chat";

export default async function AdvisorPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const goals = await listGoals();

  return (
    <AppShell>
      <div className="flex flex-col gap-6 h-[calc(100vh-7rem)]">
        <div>
          <h1 className="text-2xl font-bold">Financial Advisor</h1>
          <p className="text-sm text-muted-foreground mt-1">
            AI-powered guidance grounded in your actual financial data.
            All recommendations should be independently verified before action.
          </p>
        </div>

        <div className="flex gap-6 flex-1 min-h-0">
          {/* Goals sidebar */}
          <div className="w-80 shrink-0 overflow-y-auto rounded-xl border bg-card p-4">
            <GoalsPanel initialGoals={goals} />
          </div>

          {/* Chat */}
          <div className="flex-1 min-w-0 rounded-xl border bg-card overflow-hidden flex flex-col">
            <AdvisorChat />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
