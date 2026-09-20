export default function Loading() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="h-8 w-48 animate-pulse rounded-md bg-surface-2" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-48 animate-pulse rounded-xl bg-surface-1" />
        <div className="h-48 animate-pulse rounded-xl bg-surface-1" />
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-surface-1" />
    </div>
  );
}
