export function PageSkeleton() {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="h-14 border-b bg-background/95" />
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <div className="h-7 w-48 animate-pulse rounded-lg bg-muted" />
        <div className="h-64 animate-pulse rounded-2xl border bg-card" />
        <div className="h-48 animate-pulse rounded-2xl border bg-card" />
      </div>
    </div>
  );
}
