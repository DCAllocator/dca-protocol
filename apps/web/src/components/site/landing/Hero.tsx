import { HeroCopy } from "./HeroCopy";
import { PlansReplica } from "./PlansReplica";

/**
 * The hero: the headline on the left, a working copy of My plans on the right. A server shell, so the copy paints
 * without JavaScript; only the replica is a client island.
 */
export function Hero() {
  return (
    <section aria-labelledby="hero-h1" className="relative overflow-hidden">
      <div className="lp-grid pointer-events-none absolute inset-0" />
      <div className="container-x relative grid gap-12 py-10 sm:py-16 md:py-24 lg:gap-8 xl:gap-12 lg:grid-cols-[1fr_1.12fr] lg:items-center">
        <div className="min-w-0">
          <HeroCopy />
        </div>
        <div className="relative min-w-0">
          <div className="lp-glow pointer-events-none absolute -inset-10" />
          <PlansReplica />
        </div>
      </div>
    </section>
  );
}
