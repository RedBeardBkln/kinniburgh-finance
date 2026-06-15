import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { listProjects, proposedTransferAmount } from "@/actions/projects";
import { ProjectCard } from "@/components/projects/project-card";
import { AddProjectForm } from "@/components/projects/add-project-form";
import { db } from "@/lib/db";
import Link from "next/link";
import type { Route } from "next";

export default async function ProjectsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const projects = await listProjects();

  // Find Slush Funds account (x3612)
  const slushAccount = await db.account.findFirst({ where: { mask: "3612", archivedAt: null } });
  const transferInfo = slushAccount ? await proposedTransferAmount(slushAccount.id) : null;

  const active = projects.filter((p) => p.status === "active");
  const completed = projects.filter((p) => p.status === "completed");

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Project Savings</h1>
          <p className="text-sm text-muted-foreground">
            Named envelopes within Slush Funds (x3612) for one-time saving goals.
          </p>
        </div>

        {/* Transfer suggestion callout */}
        {slushAccount && transferInfo && !transferInfo.hasTransfer && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-medium text-amber-800">No recurring transfer set up for Slush Funds</p>
            <p className="text-sm text-amber-700 mt-0.5">
              A weekly transfer of{" "}
              <span className="font-semibold">
                ${(transferInfo.suggestedWeeklyCents / 100).toFixed(0)}/wk
              </span>{" "}
              (~$1,200/mo) is suggested based on your Home Improvements + Home Repair budget lines.{" "}
              <Link href={"/envelope" as Route} className="font-medium underline hover:no-underline">
                Set up transfer →
              </Link>
            </p>
          </div>
        )}

        <AddProjectForm slushFundsAccountId={slushAccount?.id} />

        {active.length > 0 && (
          <div>
            <h2 className="text-base font-semibold mb-3">Active</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {active.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          </div>
        )}

        {completed.length > 0 && (
          <div>
            <h2 className="text-base font-semibold mb-3 text-muted-foreground">Completed</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {completed.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          </div>
        )}

        {projects.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No projects yet. Create one above to start saving toward a goal.
          </p>
        )}
      </div>
    </AppShell>
  );
}
