"use client";

import { useState, useTransition } from "react";
import { createGoal, deleteGoal, updateGoalStatus } from "@/actions/goals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Plus, Trash2, CheckCircle2, PauseCircle, X } from "lucide-react";

type Goal = {
  id: string;
  title: string;
  category: string;
  description: string | null;
  targetAmountCents: number | null;
  currentAmountCents: number | null;
  targetDate: Date | string | null;
  priority: number;
  status: string;
  notes: string | null;
};

const CATEGORIES = [
  { value: "emergency_fund", label: "Emergency Fund" },
  { value: "debt_payoff", label: "Debt Payoff" },
  { value: "savings", label: "Savings" },
  { value: "investment", label: "Investment" },
  { value: "income", label: "Income" },
  { value: "lifestyle", label: "Lifestyle" },
  { value: "other", label: "Other" },
];

const PRIORITY_LABELS: Record<number, string> = { 1: "High", 2: "Medium", 3: "Low" };
const PRIORITY_COLORS: Record<number, string> = {
  1: "bg-red-100 text-red-700",
  2: "bg-yellow-100 text-yellow-700",
  3: "bg-green-100 text-green-700",
};

interface GoalsPanelProps {
  initialGoals: Goal[];
}

export function GoalsPanel({ initialGoals }: GoalsPanelProps) {
  const [goals, setGoals] = useState<Goal[]>(initialGoals);
  const [showForm, setShowForm] = useState(false);
  const [pending, startTransition] = useTransition();

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("savings");
  const [priority, setPriority] = useState("2");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [description, setDescription] = useState("");

  function resetForm() {
    setTitle("");
    setCategory("savings");
    setPriority("2");
    setTargetAmount("");
    setTargetDate("");
    setDescription("");
    setShowForm(false);
  }

  function handleCreate() {
    if (!title || !category) return;
    startTransition(async () => {
      const goal = await createGoal({
        title,
        category,
        priority: parseInt(priority),
        targetAmountCents: targetAmount ? Math.round(parseFloat(targetAmount) * 100) : undefined,
        targetDate: targetDate ? new Date(targetDate) : undefined,
        description: description || undefined,
      });
      setGoals((prev) =>
        [...prev, goal as unknown as Goal].sort((a, b) => a.priority - b.priority)
      );
      resetForm();
    });
  }

  function handleStatusChange(id: string, status: "active" | "achieved" | "paused") {
    startTransition(async () => {
      await updateGoalStatus(id, status);
      setGoals((prev) => prev.map((g) => (g.id === id ? { ...g, status } : g)));
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      await deleteGoal(id);
      setGoals((prev) => prev.filter((g) => g.id !== id));
    });
  }

  const activeGoals = goals.filter((g) => g.status === "active");
  const otherGoals = goals.filter((g) => g.status !== "active");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Financial Goals</h2>
        <Button size="sm" variant="outline" onClick={() => setShowForm((v) => !v)}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add
        </Button>
      </div>

      {showForm && (
        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">New Goal</span>
            <button onClick={resetForm} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div>
            <Label htmlFor="goal-title" className="text-xs">Title</Label>
            <Input
              id="goal-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Build 6-month emergency fund"
              className="mt-1 h-8 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Category</Label>
              <Select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 h-8 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label className="text-xs">Priority</Label>
              <Select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="mt-1 h-8 text-sm"
              >
                <option value="1">High</option>
                <option value="2">Medium</option>
                <option value="3">Low</option>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="goal-amount" className="text-xs">Target ($)</Label>
              <Input
                id="goal-amount"
                type="number"
                min="0"
                step="100"
                value={targetAmount}
                onChange={(e) => setTargetAmount(e.target.value)}
                placeholder="Optional"
                className="mt-1 h-8 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="goal-date" className="text-xs">Target Date</Label>
              <Input
                id="goal-date"
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                className="mt-1 h-8 text-sm"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="goal-desc" className="text-xs">Notes (optional)</Label>
            <Textarea
              id="goal-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Context for the advisor…"
              className="mt-1 text-sm"
            />
          </div>
          <Button
            size="sm"
            className="w-full"
            onClick={handleCreate}
            disabled={!title || !category || pending}
          >
            Add Goal
          </Button>
        </div>
      )}

      {goals.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">
          Add goals so the advisor can tailor its guidance.
        </p>
      )}

      {activeGoals.length > 0 && (
        <ul className="space-y-2">
          {activeGoals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              onStatusChange={handleStatusChange}
              onDelete={handleDelete}
              disabled={pending}
            />
          ))}
        </ul>
      )}

      {otherGoals.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">
            Achieved / Paused
          </p>
          <ul className="space-y-2">
            {otherGoals.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
                disabled={pending}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function GoalCard({
  goal,
  onStatusChange,
  onDelete,
  disabled,
}: {
  goal: Goal;
  onStatusChange: (id: string, status: "active" | "achieved" | "paused") => void;
  onDelete: (id: string) => void;
  disabled: boolean;
}) {
  const isActive = goal.status === "active";
  const progress =
    goal.targetAmountCents && goal.currentAmountCents
      ? Math.min(100, (goal.currentAmountCents / goal.targetAmountCents) * 100)
      : null;
  const categoryLabel = CATEGORIES.find((c) => c.value === goal.category)?.label ?? goal.category;

  return (
    <li className={`rounded-lg border p-3 ${isActive ? "bg-card" : "bg-muted/40 opacity-70"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-sm">{goal.title}</span>
            <span
              className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                PRIORITY_COLORS[goal.priority] ?? "bg-muted text-muted-foreground"
              }`}
            >
              {PRIORITY_LABELS[goal.priority] ?? "—"}
            </span>
            <span className="text-xs bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded">
              {categoryLabel}
            </span>
          </div>
          {goal.targetAmountCents && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Target: ${(goal.targetAmountCents / 100).toLocaleString()}
              {goal.currentAmountCents
                ? ` · ${((goal.currentAmountCents / goal.targetAmountCents) * 100).toFixed(0)}% complete`
                : ""}
              {goal.targetDate
                ? ` · by ${new Date(goal.targetDate).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`
                : ""}
            </p>
          )}
          {progress !== null && (
            <div className="mt-1.5 h-1.5 w-full rounded-full bg-muted">
              <div
                className="h-1.5 rounded-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
          {goal.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{goal.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isActive ? (
            <>
              <button
                onClick={() => onStatusChange(goal.id, "achieved")}
                disabled={disabled}
                title="Mark achieved"
                className="text-muted-foreground hover:text-green-600 transition-colors"
              >
                <CheckCircle2 className="h-4 w-4" />
              </button>
              <button
                onClick={() => onStatusChange(goal.id, "paused")}
                disabled={disabled}
                title="Pause"
                className="text-muted-foreground hover:text-yellow-600 transition-colors"
              >
                <PauseCircle className="h-4 w-4" />
              </button>
            </>
          ) : (
            <button
              onClick={() => onStatusChange(goal.id, "active")}
              disabled={disabled}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Reactivate
            </button>
          )}
          <button
            onClick={() => onDelete(goal.id)}
            disabled={disabled}
            title="Delete"
            className="text-muted-foreground hover:text-destructive transition-colors"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </li>
  );
}
