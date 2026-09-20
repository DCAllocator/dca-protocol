import Link from "next/link";
import { Wordmark } from "@/components/Logo";

export default async function Restricted({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-0 p-6">
      <div className="panel w-full max-w-md">
        <div className="panel-head">
          <span className="normal-case tracking-normal">
            <Wordmark size={16} />
          </span>
        </div>
        <div className="panel-body">
          <h1 className="text-lg font-semibold text-ink">Not available in your region{c ? ` (${c})` : ""}.</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            Robinhood Stock Tokens are not offered to US persons, and this interface is not available in the United States, United Kingdom,
            Canada, Australia or sanctioned regions. The protocol contracts are public; this website is not.
          </p>
          <Link href="/" className="btn-secondary mt-4">
            Back to overview
          </Link>
        </div>
      </div>
    </main>
  );
}
