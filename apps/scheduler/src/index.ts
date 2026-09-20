// DCA epoch scheduler: watches EpochKeeper's job list and calls `run(job)` as vault epochs come due.
//
//   pnpm --filter @dca/scheduler dev            # loop forever (RPC_URL / PRIVATE_KEY from .env.local)
//   pnpm --filter @dca/scheduler once           # one pass, then exit (cron / systemd timer)
//   pnpm --filter @dca/scheduler dry-run        # simulate only, never send
//
// See ../README.md for the environment variables.
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { Scheduler } from "./scheduler.js";

async function main() {
  const cfg = loadConfig();
  const scheduler = new Scheduler(cfg);
  await scheduler.init();

  let signalled = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (signalled) process.exit(130);
      signalled = true;
      log.info(`${sig} received — finishing the current job, then exiting (again to force)`);
      scheduler.stop();
    });
  }

  await scheduler.run();
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
