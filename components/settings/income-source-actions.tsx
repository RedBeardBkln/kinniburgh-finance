"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toggleIncomeSource, deleteIncomeSource } from "@/actions/income-sources";

interface ToggleProps {
  id: string;
  active: boolean;
}

export function ToggleIncomeSourceButton({ id, active }: ToggleProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      await toggleIncomeSource(id, !active);
      router.refresh();
    });
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="text-xs text-primary hover:underline disabled:opacity-50"
    >
      {isPending ? "…" : active ? "Disable" : "Enable"}
    </button>
  );
}

interface DeleteProps {
  id: string;
  description: string;
}

export function DeleteIncomeSourceButton({ id, description }: DeleteProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    if (!confirm(`Delete income source "${description}"?`)) return;
    startTransition(async () => {
      await deleteIncomeSource(id);
      router.refresh();
    });
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="text-xs text-destructive hover:underline disabled:opacity-50"
    >
      {isPending ? "…" : "Delete"}
    </button>
  );
}
