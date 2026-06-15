"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTaxDeadline } from "@/actions/tax-deadlines";

export function MarkFiledButton({ id }: { id: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function markFiled() {
    startTransition(async () => {
      await updateTaxDeadline(id, { status: "filed" });
      router.refresh();
    });
  }

  return (
    <button
      onClick={markFiled}
      disabled={isPending}
      className="text-xs text-primary hover:underline disabled:opacity-50"
    >
      {isPending ? "Saving…" : "Mark filed"}
    </button>
  );
}
