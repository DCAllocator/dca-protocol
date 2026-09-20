import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  formatEther,
  formatUnits,
  http,
  parseAbi,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AggregatorRouterAbi, EpochKeeperAbi, PlanVaultAbi, StockRegistryAbi } from "./abi/index.js";
import { REPO_ROOT, type Config } from "./config.js";
import { log } from "./log.js";

type Job = { vault: Address; stock: Address; active: boolean };

/** Per-vault immutables + display name, read once. */
type VaultMeta = { address: Address; kind: string; origin: number; epochLength: number };

const ExtraAbi = parseAbi([
  "function vaultKind() view returns (string)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const EMPTY: Hex = "0x";

export class Scheduler {
  private pub!: PublicClient;
  private wallet?: WalletClient;
  private account?: Account;
  private chain!: Chain;
  private keeper!: Address;
  private usdgDecimals = 6;

  private vaults = new Map<string, VaultMeta>();
  private stocks = new Map<string, { symbol: string; decimals: number }>();

  /**
   * Latest block we have seen and when (wall clock) we first saw it. `chainNow()` extrapolates from it, so
   * scheduling keeps working on chains that only mine on demand (anvil, quiet rollups), where `eth_call`
   * — and therefore `dueJobs()` — is evaluated at the *last block's* timestamp, not the wall clock.
   */
  private seen?: { ts: number; seenAtMs: number };
  private announcedBoundary?: number;
  private stopping = false;

  constructor(private readonly cfg: Config) {}

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------

  async init(): Promise<void> {
    const transport = http(this.cfg.rpcUrl, { retryCount: 3, timeout: 30_000 });
    const chainId = await createPublicClient({ transport }).getChainId();
    this.chain = defineChain({
      id: chainId,
      name: chainId === 31337 ? "anvil" : chainId === 4663 ? "Robinhood Chain" : `chain-${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.cfg.rpcUrl] } },
    });
    this.pub = createPublicClient({ chain: this.chain, transport });

    if (this.cfg.privateKey) {
      this.account = privateKeyToAccount(this.cfg.privateKey);
      this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport });
    } else if (!this.cfg.dryRun) {
      throw new Error("PRIVATE_KEY is required unless running with --dry-run");
    }

    this.keeper = this.cfg.keeper ?? this.keeperFromDeployments(chainId);
    const code = await this.pub.getCode({ address: this.keeper });
    if (!code || code === "0x") throw new Error(`no contract at KEEPER_ADDRESS ${this.keeper} on chain ${chainId} — is the fork still running / redeployed?`);

    const usdg = await this.pub.readContract({ address: this.keeper, abi: EpochKeeperAbi, functionName: "usdg" });
    this.usdgDecimals = await this.pub.readContract({ address: usdg, abi: ExtraAbi, functionName: "decimals" }).catch(() => 6);

    const balance = this.account ? await this.pub.getBalance({ address: this.account.address }) : undefined;
    log.info("scheduler starting", {
      chain: `${this.chain.name}(${chainId})`,
      keeper: this.keeper,
      account: this.account?.address ?? "(none, dry-run)",
      balance: balance !== undefined ? `${formatEther(balance)} ETH` : undefined,
      poll: `${this.cfg.pollIntervalMs / 1000}s`,
      dryRun: this.cfg.dryRun || undefined,
    });
    if (balance !== undefined && balance === 0n) log.warn("account has no ETH for gas");

    const block = await this.pub.getBlock();
    this.observeBlock(Number(block.timestamp));
    const jobs = await this.readJobs();
    const active = jobs.filter((j) => j.active);
    for (const j of active) await this.vaultMeta(j.vault);
    log.info(`jobs: ${jobs.length} (${active.length} active) across ${this.vaults.size} vault(s)`);
    const now = this.chainNow();
    for (const m of this.vaults.values()) {
      log.info(`vault ${m.kind.padEnd(7)} ${m.address}`, {
        epoch: fmtDur(m.epochLength),
        nextBoundary: `${fmtDur(nextBoundary(m, now) - now)} (${iso(nextBoundary(m, now))})`,
      });
    }
  }

  /** `KEEPER_ADDRESS` fallback: contracts/deployments/<chainId>.json written by the deploy scripts. */
  private keeperFromDeployments(chainId: number): Address {
    const file = join(REPO_ROOT, "contracts", "deployments", `${chainId}.json`);
    if (!existsSync(file)) throw new Error(`KEEPER_ADDRESS is not set and ${file} does not exist`);
    const d = JSON.parse(readFileSync(file, "utf8")) as { keeper?: Address };
    if (!d.keeper) throw new Error(`${file} has no "keeper" entry`);
    log.info(`keeper address read from ${file}`);
    return d.keeper;
  }

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  private wake?: () => void;

  async run(): Promise<void> {
    while (!this.stopping) {
      let delay = this.cfg.pollIntervalMs;
      try {
        delay = await this.tick();
      } catch (e) {
        log.error("tick failed", { error: describeError(e) });
      }
      if (this.cfg.once || this.stopping) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = undefined;
    }
    log.info("scheduler stopped");
  }

  /** One pass: run every due job to completion (paginated), then return how long to sleep. */
  async tick(): Promise<number> {
    let [jobs, due, block] = await Promise.all([this.readJobs(), this.readDue(), this.pub.getBlock()]);
    this.observeBlock(Number(block.timestamp));
    for (const j of jobs) if (j.active) await this.vaultMeta(j.vault); // cached; picks up jobs added since start

    // The chain's last block is in an older epoch than "now" for some vault: eth_call cannot see the new
    // epoch yet. Mine a block with a 0-value self-transfer so `dueJobs()` / simulation catch up.
    if (due.length === 0 && this.boundaryPassedSinceBlock(jobs, Number(block.timestamp))) {
      if (await this.nudge()) {
        [due, block] = await Promise.all([this.readDue(), this.pub.getBlock()]);
        this.observeBlock(Number(block.timestamp));
      }
    }

    if (due.length > 0) {
      log.info(`${due.length} job(s) due`, { epochTime: iso(Number(block.timestamp)) });
      for (const idx of due) {
        if (this.stopping) break;
        const job = jobs[Number(idx)];
        if (!job) continue;
        await this.runJob(idx, job);
      }
    }
    return this.nextDelay(jobs);
  }

  // ------------------------------------------------------------------
  // Jobs
  // ------------------------------------------------------------------

  private async runJob(index: bigint, job: Job): Promise<void> {
    const label = await this.label(job);
    for (let page = 1; page <= this.cfg.maxPagesPerJob; page++) {
      let request;
      try {
        ({ request } = await this.pub.simulateContract({
          address: this.keeper,
          abi: EpochKeeperAbi,
          functionName: "run",
          args: [index, this.cfg.pageLimit, EMPTY],
          account: this.account,
        }));
      } catch (e) {
        // A revert here costs no gas: EpochNotDue (raced by another keeper), router/liquidity errors, etc.
        log.warn(`${label}: skipped`, { job: index, reason: describeError(e) });
        return;
      }
      if (this.cfg.dryRun || !this.wallet) {
        log.info(`${label}: would run (dry-run)`, { job: index, page });
        return;
      }

      const hash = await this.wallet.writeContract(request);
      log.debug(`${label}: sent`, { hash });
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: this.cfg.txTimeoutMs });
      if (receipt.status !== "success") {
        log.error(`${label}: transaction reverted`, { job: index, hash });
        return;
      }
      const s = this.summarize(receipt, job);
      const stock = this.stocks.get(job.stock.toLowerCase());
      log.info(`${label}: ${s.completed ? "epoch complete" : `page ${page} done, more plans pending`}`, {
        job: index,
        epoch: s.epochId,
        plans: s.plansFilled,
        range: s.range,
        spent: `${formatUnits(s.netUsdg, this.usdgDecimals)} USDG`,
        bought: `${formatUnits(s.stockOut, stock?.decimals ?? 18)} ${stock?.symbol ?? ""}`.trim(),
        skipped: s.skipped || undefined,
        tips: s.tips > 0n ? `${formatUnits(s.tips, this.usdgDecimals)} USDG` : undefined,
        gas: receipt.gasUsed,
        block: receipt.blockNumber,
        tx: hash,
      });
      if (s.completed) return;
    }
    log.warn(`${label}: reached MAX_PAGES_PER_JOB=${this.cfg.maxPagesPerJob}; continuing next tick`, { job: index });
  }

  private summarize(receipt: TransactionReceipt, job: Job) {
    const vaultLogs = parseEventLogs({
      abi: PlanVaultAbi,
      logs: receipt.logs.filter((l) => l.address.toLowerCase() === job.vault.toLowerCase()),
    });
    let netUsdg = 0n;
    let stockOut = 0n;
    let plansFilled = 0;
    let epochId: number | undefined;
    let from: bigint | undefined;
    let to: bigint | undefined;
    let skipped = 0;
    let completed = false;
    for (const e of vaultLogs) {
      if (e.eventName === "EpochPageExecuted") {
        netUsdg += e.args.netUsdg;
        stockOut += e.args.stockOut;
        plansFilled += e.args.plansFilled;
        epochId = e.args.epochId;
        from = from === undefined ? e.args.fromIndex : from < e.args.fromIndex ? from : e.args.fromIndex;
        to = to === undefined || e.args.toIndex > to ? e.args.toIndex : to;
      } else if (e.eventName === "EpochExecuted") completed = true;
      else if (e.eventName === "PlanSkippedSlippage" || e.eventName === "PlanSkippedNoRoute") skipped++;
    }
    const keeperLogs = parseEventLogs({ abi: EpochKeeperAbi, logs: receipt.logs, eventName: ["JobRun", "TipsForwarded"] });
    let tips = 0n;
    for (const e of keeperLogs) {
      if (e.eventName === "JobRun") completed = completed || e.args.completed;
      else if (e.eventName === "TipsForwarded") tips += e.args.amount;
    }
    return { netUsdg, stockOut, plansFilled, epochId, range: from !== undefined ? `${from}-${to}` : undefined, skipped, completed, tips };
  }

  // ------------------------------------------------------------------
  // Chain time and scheduling
  // ------------------------------------------------------------------

  private observeBlock(ts: number) {
    if (!this.seen || this.seen.ts !== ts) this.seen = { ts, seenAtMs: Date.now() };
  }

  /**
   * Best estimate of `block.timestamp` a transaction sent right now would see: the latest block's timestamp
   * plus the time since we first saw it, but never behind the wall clock. A chain can be *ahead* of the wall
   * clock (anvil after `evm_increaseTime`) and its last block can be *stale* (idle chain); it is never behind.
   */
  private chainNow(): number {
    const wall = Math.floor(Date.now() / 1000);
    if (!this.seen) return wall;
    return Math.max(wall, this.seen.ts + Math.floor((Date.now() - this.seen.seenAtMs) / 1000));
  }

  private boundaryPassedSinceBlock(jobs: Job[], blockTs: number): boolean {
    const now = this.chainNow();
    for (const j of jobs) {
      if (!j.active) continue;
      const m = this.vaults.get(j.vault.toLowerCase());
      if (m && epochAt(m, now) > epochAt(m, blockTs)) return true;
    }
    return false;
  }

  private async nudge(): Promise<boolean> {
    if (!this.wallet || !this.account || this.cfg.dryRun) {
      log.warn("chain has not mined a block since the last epoch boundary; dueJobs() is stale (no wallet to nudge it)");
      return false;
    }
    log.info("chain idle across an epoch boundary — mining a block with a 0-value self-transfer");
    try {
      const hash = await this.wallet.sendTransaction({ account: this.account, chain: this.chain, to: this.account.address, value: 0n });
      await this.pub.waitForTransactionReceipt({ hash, timeout: this.cfg.txTimeoutMs });
      return true;
    } catch (e) {
      log.warn("nudge failed", { error: describeError(e) });
      return false;
    }
  }

  private nextDelay(jobs: Job[]): number {
    const now = this.chainNow();
    let soonest = Number.POSITIVE_INFINITY;
    let soonestKind = "";
    const seen = new Set<string>();
    for (const j of jobs) {
      if (!j.active || seen.has(j.vault.toLowerCase())) continue;
      seen.add(j.vault.toLowerCase());
      const m = this.vaults.get(j.vault.toLowerCase());
      if (!m) continue;
      const nb = nextBoundary(m, now);
      if (nb < soonest) (soonest = nb), (soonestKind = m.kind);
    }
    if (!Number.isFinite(soonest)) {
      log.debug("no active jobs; polling");
      return this.cfg.pollIntervalMs;
    }
    const untilMs = (soonest - now) * 1000 + this.cfg.boundaryGraceMs;
    const delay = Math.min(this.cfg.pollIntervalMs, Math.max(1000, untilMs));
    const msg = `idle — next boundary: ${soonestKind} in ${fmtDur(soonest - now)} (${iso(soonest)})`;
    if (this.announcedBoundary !== soonest) log.info(msg, { sleep: fmtDur(delay / 1000) });
    else log.debug(msg, { sleep: fmtDur(delay / 1000) });
    this.announcedBoundary = soonest;
    return delay;
  }

  // ------------------------------------------------------------------
  // Reads + caches
  // ------------------------------------------------------------------

  private async readJobs(): Promise<Job[]> {
    const raw = await this.pub.readContract({ address: this.keeper, abi: EpochKeeperAbi, functionName: "jobs" });
    return raw.map((j) => ({ vault: j.vault, stock: j.stock, active: j.active }));
  }

  private async readDue(): Promise<bigint[]> {
    return [...(await this.pub.readContract({ address: this.keeper, abi: EpochKeeperAbi, functionName: "dueJobs" }))];
  }

  private async vaultMeta(vault: Address): Promise<VaultMeta> {
    const key = vault.toLowerCase();
    let m = this.vaults.get(key);
    if (m) return m;
    const [origin, epochLength, kind] = await Promise.all([
      this.pub.readContract({ address: vault, abi: PlanVaultAbi, functionName: "origin" }),
      this.pub.readContract({ address: vault, abi: PlanVaultAbi, functionName: "epochLength" }),
      this.pub.readContract({ address: vault, abi: ExtraAbi, functionName: "vaultKind" }).catch(() => short(vault)),
    ]);
    m = { address: vault, kind, origin: Number(origin), epochLength: Number(epochLength) };
    this.vaults.set(key, m);
    return m;
  }

  private async stockMeta(vault: Address, stock: Address) {
    const key = stock.toLowerCase();
    let s = this.stocks.get(key);
    if (s) return s;
    const registry = await this.pub.readContract({ address: vault, abi: PlanVaultAbi, functionName: "registry" });
    const [info, decimals] = await Promise.all([
      this.pub.readContract({ address: registry, abi: StockRegistryAbi, functionName: "info", args: [stock] }).catch(() => undefined),
      this.pub.readContract({ address: stock, abi: ExtraAbi, functionName: "decimals" }).catch(() => 18),
    ]);
    const symbol = info?.symbol || (await this.pub.readContract({ address: stock, abi: ExtraAbi, functionName: "symbol" }).catch(() => short(stock)));
    s = { symbol, decimals };
    this.stocks.set(key, s);
    return s;
  }

  private async label(job: Job): Promise<string> {
    const [v, s] = await Promise.all([this.vaultMeta(job.vault), this.stockMeta(job.vault, job.stock)]);
    return `${v.kind}/${s.symbol}`;
  }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

const epochAt = (m: VaultMeta, t: number) => Math.floor((t - m.origin) / m.epochLength);
const nextBoundary = (m: VaultMeta, t: number) => m.origin + (epochAt(m, t) + 1) * m.epochLength;
const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

export function fmtDur(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d${h > 0 ? ` ${h}h` : ""}`;
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ""}`;
  if (m > 0) return `${m}m${sec > 0 ? ` ${sec}s` : ""}`;
  return `${sec}s`;
}

/** Human-readable revert: keeper errors are decoded by viem; vault/router/registry errors bubble up raw. */
export function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | undefined;
    if (revert) {
      if (revert.data) return sig(revert.data.errorName, revert.data.args);
      if (revert.raw) {
        for (const abi of [PlanVaultAbi, AggregatorRouterAbi, StockRegistryAbi]) {
          try {
            const d = decodeErrorResult({ abi, data: revert.raw });
            return sig(d.errorName, d.args);
          } catch {
            /* not this contract's error */
          }
        }
        return `revert ${revert.raw}`;
      }
      return revert.reason ?? revert.shortMessage;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

const sig = (name: string, args?: readonly unknown[]) => `${name}(${(args ?? []).map(String).join(", ")})`;
