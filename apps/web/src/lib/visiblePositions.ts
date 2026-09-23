/**
 * Which plans "My plans" lists. Kept free of React and wagmi so the rule can be read (and one day unit-tested)
 * on its own: a plan disappears only when it holds NOTHING and the vault has unindexed it (or this session
 * just removed it and the log scan has not caught up). A plan with any USDG — idle or boosted — or any
 * accrued stock is always shown, whatever the index says: "empty" here is the UI's view (ClaimHelper's
 * `Position` has no `boostShares`), so the only safe direction is to over-show, never to hide value.
 */

/** The balance fields the visibility rule needs; `Position` from useProtocol satisfies it. */
export type BalanceLike = { usdgIdle: bigint; boostValue: bigint; stockAccrued: bigint };

/** True when the UI can see no value in the plan (idle USDG, boosted USDG and accrued stock all zero). */
export const looksEmpty = (p: BalanceLike): boolean => p.usdgIdle + p.boostValue === 0n && p.stockAccrued === 0n;

/**
 * True when the row should be hidden: nothing in it AND (the vault unindexed it OR it was removed this
 * session). `unindexed` is the `PlanIndexed` log state for the key (`undefined` while the scan is loading,
 * which counts as "still indexed"). A later deposit re-indexes the plan, so it reappears on its own.
 */
export const isHiddenPlan = (p: BalanceLike, unindexed: boolean | undefined, removedThisSession: boolean): boolean =>
  looksEmpty(p) && (unindexed === false || removedThisSession);

/** Filters a positions list with `isHiddenPlan`; `keyOf` must match the keys used in `index` and `hidden`. */
export function visiblePositions<P extends BalanceLike>(all: readonly P[], index: Record<string, boolean> | undefined, hidden: ReadonlySet<string>, keyOf: (p: P) => string): P[] {
  return all.filter((p) => {
    const key = keyOf(p);
    return !isHiddenPlan(p, index?.[key], hidden.has(key));
  });
}
