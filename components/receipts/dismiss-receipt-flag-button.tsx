"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissReceiptRequirement } from "@/actions/receipts";

export function DismissReceiptFlagButton({ transactionId }: { transactionId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    if (!confirm("Mark this transaction as not needing a receipt? It will no longer show up in this queue.")) return;
    startTransition(async () => {
      await dismissReceiptRequirement(transactionId);
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      className="text-xs text-muted-foreground hover:text-destructive hover:underline disabled:opacity-60"
    >
      {isPending ? "Dismissing…" : "Not needed"}
    </button>
  );
}
