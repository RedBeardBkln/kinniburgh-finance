export default function Loading() {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="h-14 border-b bg-background/95" />
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <div className="h-7 w-52 animate-pulse rounded-lg bg-muted" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl border bg-card" />
          ))}
        </div>
        <div className="h-72 animate-pulse rounded-2xl border bg-card" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="h-48 animate-pulse rounded-2xl border bg-card" />
          <div className="h-48 animate-pulse rounded-2xl border bg-card" />
        </div>
      </div>
    </div>
  );
}
