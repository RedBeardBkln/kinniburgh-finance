"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toggleEntityVisibility, createBusinessEntity } from "@/actions/entities";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface BusinessEntity {
  id: string;
  name: string;
  slug: string | null;
  navLabel: string | null;
  hiddenInNav: boolean;
}

interface Props {
  entities: BusinessEntity[];
}

export function EntitiesClient({ entities }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [navLabel, setNavLabel] = useState("");
  const [slug, setSlug] = useState("");

  function handleNavLabelChange(val: string) {
    setNavLabel(val);
    if (!slug || slug === autoSlug(navLabel)) {
      setSlug(autoSlug(val));
    }
  }

  function autoSlug(label: string) {
    return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function toggle(entityId: string, currentlyHidden: boolean) {
    startTransition(async () => {
      await toggleEntityVisibility(entityId, !currentlyHidden);
      router.refresh();
    });
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    startTransition(async () => {
      try {
        await createBusinessEntity({ fullName, navLabel, slug: slug || undefined });
        setFullName("");
        setNavLabel("");
        setSlug("");
        setShowAdd(false);
        router.refresh();
      } catch (err) {
        setAddError(err instanceof Error ? err.message : "Failed to create entity");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {entities.map((entity) => (
          <div key={entity.id} className="flex items-center justify-between rounded-lg border px-4 py-3">
            <div>
              <p className="text-sm font-medium">{entity.navLabel ?? entity.name}</p>
              <p className="text-xs text-muted-foreground">{entity.name}</p>
              {entity.slug && (
                <code className="text-xs text-muted-foreground/70">/{entity.slug}</code>
              )}
            </div>
            <div className="flex items-center gap-3">
              {entity.hiddenInNav ? (
                <Badge variant="outline" className="text-xs text-muted-foreground">Hidden</Badge>
              ) : (
                <Badge variant="secondary" className="text-xs">Visible</Badge>
              )}
              <button
                onClick={() => toggle(entity.id, entity.hiddenInNav)}
                disabled={isPending}
                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 border border-input rounded-md px-3 py-1.5 hover:bg-accent transition-colors"
              >
                {entity.hiddenInNav ? "Show tab" : "Hide tab"}
              </button>
            </div>
          </div>
        ))}

        {entities.length === 0 && (
          <p className="text-sm text-muted-foreground">No business entities yet.</p>
        )}
      </div>

      {!showAdd ? (
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90"
        >
          + Add business entity
        </button>
      ) : (
        <form onSubmit={handleAdd} className="rounded-lg border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">New business entity</h3>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Full legal name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="My Business, LLC"
              required
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Tab label (short name)</label>
            <input
              type="text"
              value={navLabel}
              onChange={(e) => handleNavLabelChange(e.target.value)}
              placeholder="My Business"
              required
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">URL slug (auto-generated)</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder="my-business"
              required
              pattern="[a-z0-9-]+"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="text-xs text-muted-foreground">Used in URLs: /transactions?bucket={slug || "my-business"}</p>
          </div>

          {addError && (
            <p className="text-sm text-destructive rounded-md bg-destructive/10 px-3 py-2">{addError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isPending || !fullName || !navLabel || !slug}
              className="inline-flex items-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {isPending ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              onClick={() => { setShowAdd(false); setAddError(null); setFullName(""); setNavLabel(""); setSlug(""); }}
              className="inline-flex items-center rounded-md border border-input px-4 py-2 text-sm hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
