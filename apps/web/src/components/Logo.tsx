/** Split-ring token mark: lime disc, ink gap. Placeholder — not Robinhood's feather. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="DCA" role="img">
      <circle cx="16" cy="16" r="16" fill="#ccff00" />
      <circle
        cx="16"
        cy="16"
        r="9"
        fill="none"
        stroke="#14120d"
        strokeWidth="5"
        strokeDasharray="40 17"
        transform="rotate(-30 16 16)"
      />
    </svg>
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
