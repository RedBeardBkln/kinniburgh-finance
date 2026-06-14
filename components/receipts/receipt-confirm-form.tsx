"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TagPicker } from "@/components/tags/tag-picker";
import { confirmReceipt, deleteReceipt, type MatchCandidate } from "@/actions/receipts";
import { Badge } from "@/components/ui/badge";

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface Props {
  receiptId: string;
  initialVendor: string;
  initialDate: string;
  initialTotal: string;
  initialDescription: string;
  initialGlCode: string;
  ocrStatus: string;
  confirmedAt: string | null;
  matches: MatchCandidate[];
  allTags: Tag[];
}

export function ReceiptConfirmForm({
  receiptId,
  initialVendor,
  initialDate,
  initialTotal,
  initialDescription,
  initialGlCode,
  ocrStatus,
  confirmedAt,
  matches,
  allTags,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isDeleting, startDeleting] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [vendor, setVendor] = useState(initialVendor);
  const [date, setDate] = useState(initialDate);
  const [total, setTotal] = useState(initialTotal);
  const [description, setDescription] = useState(initialDescription);
  const [glCode, setGlCode] = useState(initialGlCode);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [transactionId, setTransactionId] = useState<string | undefined>();

  const isAlreadyConfirmed = confirmedAt != null;

  function handleConfirm() {
    if (!vendor) { setError("Vendor is required"); return; }
    if (!total || !/^\d+(\.\d{1,2})?$/.test(total)) { setError("Enter a valid total (e.g. 42.50)"); return; }
    setError(null);

    startTransition(async () => {
      try {
        await confirmReceipt({
          receiptId,
          vendor,
          receiptDate: date || new Date().toISOString().split("T")[0]!,
          total,
          description: description || undefined,
          glCode: glCode || undefined,
          transactionId: transactionId || undefined,
          tagIds: selectedTagIds,
        });
        router.push("/receipts?tab=confirmed");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Confirm failed");
      }
    });
  }

  function handleDelete() {
    if (!confirm("Delete this receipt? This cannot be undone.")) return;
    startDeleting(async () => {
      await deleteReceipt(receiptId);
      router.push("/receipts");
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>Extracted Data</span>
          {ocrStatus === "failed" && (
            <Badge variant="destructive">Extraction Failed</Badge>
          )}
          {isAlreadyConfirmed && (
            <Badge variant="secondary" className="bg-green-100 text-green-700">
              Confirmed
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <label className="text-sm font-medium">Vendor</label>
          <Input
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="Vendor name"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Total ($)</label>
            <Input
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              placeholder="0.00"
              pattern="\d+(\.\d{1,2})?"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Description</label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What was purchased?"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">GL Code / Category</label>
          <Input
            value={glCode}
            onChange={(e) => setGlCode(e.target.value)}
            placeholder="e.g. Office Supplies"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Tags</label>
          <TagPicker
            tags={allTags}
            selected={selectedTagIds}
            onChange={setSelectedTagIds}
            placeholder="Search tags…"
          />
        </div>

        {/* Transaction match */}
        <div className="space-y-2">
          <label className="text-sm font-medium">
            Match to transaction{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <div className="rounded-md border divide-y text-sm">
            <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/30">
              <input
                type="radio"
                name="txMatch"
                value=""
                checked={!transactionId}
                onChange={() => setTransactionId(undefined)}
              />
              <span className="text-muted-foreground italic">Standalone receipt (no transaction match)</span>
            </label>
            {matches.map((m) => {
              const amt = Number(m.amount);
              const sign = amt < 0 ? "-" : "+";
              const display = `${sign}$${Math.abs(amt).toFixed(2)}`;
              return (
                <label
                  key={m.id}
                  className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/30"
                >
                  <input
                    type="radio"
                    name="txMatch"
                    value={m.id}
                    checked={transactionId === m.id}
                    onChange={() => setTransactionId(m.id)}
                  />
                  <span>
                    <span className="font-medium">{m.payeeRaw ?? "—"}</span>
                    <span className="ml-2 text-muted-foreground text-xs">
                      {new Date(m.postedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      })}{" "}
                      · {m.accountNickname}
                    </span>
                    <span className="ml-2 font-mono">{display}</span>
                  </span>
                </label>
              );
            })}
            {matches.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                No matching transactions found within ±7 days and ±2% amount.
              </p>
            )}
          </div>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isPending || isAlreadyConfirmed}
            className="flex-1 inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground h-10 text-sm font-medium hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isPending ? "Saving…" : isAlreadyConfirmed ? "Already Confirmed" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting}
            className="inline-flex items-center justify-center rounded-md border border-destructive text-destructive px-4 h-10 text-sm font-medium hover:bg-destructive/10 disabled:opacity-60"
          >
            {isDeleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
