"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TagPicker } from "@/components/tags/tag-picker";
import { updateTransactionTags } from "@/actions/transactions";

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface Props {
  transactionId: string;
  allTags: Tag[];
  initialTagIds: string[];
}

export function TransactionTagsEditor({ transactionId, allTags, initialTagIds }: Props) {
  const router = useRouter();
  const [tagIds, setTagIds] = useState(initialTagIds);
  const [isPending, startTransition] = useTransition();

  function handleChange(newIds: string[]) {
    setTagIds(newIds);
    startTransition(async () => {
      await updateTransactionTags(transactionId, newIds);
      router.refresh();
    });
  }

  return (
    <div className={isPending ? "opacity-50 pointer-events-none" : ""}>
      <TagPicker tags={allTags} selected={tagIds} onChange={handleChange} />
      {isPending && (
        <p className="mt-2 text-xs text-muted-foreground">Saving…</p>
      )}
    </div>
  );
}
