import Image from "next/image";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <Image
      src="/logo.png"
      alt="DCA"
      width={size}
      height={size}
      priority
      className="shrink-0"
    />
  );
}

export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <Logo size={size} />
      <span className="text-[15px] font-bold tracking-tight text-ink">DCA</span>
    </span>
  );
}
