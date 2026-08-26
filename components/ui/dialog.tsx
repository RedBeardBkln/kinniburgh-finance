"use client";

import { Button } from "@/components/ui/button";

interface AlertDialogProps {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
}

/** Minimal alert dialog for blocking, single-acknowledgment messages (e.g. duplicate-name errors). */
export function AlertDialog({ open, title, message, onClose }: AlertDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="alert-dialog-title"
        className="mx-4 w-full max-w-sm rounded-lg border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="alert-dialog-title" className="text-sm font-semibold">
          {title}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={onClose}>
            OK
          </Button>
        </div>
      </div>
    </div>
  );
}
