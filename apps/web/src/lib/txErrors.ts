import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, WaitForTransactionReceiptTimeoutError } from "viem";

/**
 * One description of a failed (or merely slow) transaction, in the product's voice, for toasts and inline
 * notices alike. `kind` picks the tone: a wallet rejection or a still-pending receipt is a warning (nothing
 * went wrong on chain), everything else is an error.
 *
 * - `title` is the one line a toast shows; it is always safe to render as-is.
 * - `detail` is an optional second line (the raw revert reason when the title is generic).
 * - `errorName` is the decoded custom-error name of a mined or simulated revert ("EpochInProgress"), so
 *   callers can branch on it instead of matching strings in `title`.
 * - `rejected` / `timedOut` flag the two "not a failure" cases.
 * - `conflict` is set when the wallet or node refused the send over its nonce (see `sendConflictOf`).
 */
export type TxErrorDescription = {
  kind: "warn" | "error";
  title: string;
  detail?: string;
  errorName?: string;
  rejected: boolean;
  timedOut: boolean;
  conflict?: SendConflict;
};

/**
 * A send refused over its nonce, before any hash came back:
 * - `stale-nonce`: the nonce was already used ("nonce too low"): the wallet was a step behind. Also what a node says
 *   to a rebroadcast of a transaction that already mined, so on its own it does not prove nothing was sent.
 * - `nonce-in-use`: another pending transaction holds the nonce ("replacement transaction underpriced").
 * - `already-sent`: this very transaction is already in the pool ("already known"): it WAS sent.
 */
export type SendConflict = "stale-nonce" | "nonce-in-use" | "already-sent";

export const REJECTED_COPY = "You rejected this in your wallet.";
export const STILL_PENDING_COPY = "Still pending — check your wallet or the explorer.";
const REVERTED_COPY = "Transaction reverted";

/**
 * Wallet rejections come back as "User rejected the request." (viem) or "MetaMask Tx Signature: User denied
 * transaction signature." (raw injected providers). The regex catches both when only a string is at hand.
 */
const REJECTED_RE = /user (rejected|denied)|rejected the request/i;

/** Wallet rejections come back as "User rejected the request."; say it in the product's voice. */
export function friendly(msg?: string): string {
  if (!msg) return "Failed";
  if (REJECTED_RE.test(msg)) return REJECTED_COPY;
  return msg;
}

/**
 * True when the user declined in their wallet. viem wraps RPC 4001 as `UserRejectedRequestError` inside
 * `TransactionExecutionError` inside `ContractFunctionExecutionError`, so the top-level `name` is never the
 * one to look at: walk the cause chain. Falls back to the message regex for non-viem errors.
 */
export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return true;
    return REJECTED_RE.test(err.shortMessage) || REJECTED_RE.test(err.message);
  }
  if (err instanceof Error) return REJECTED_RE.test(err.message);
  return typeof err === "string" && REJECTED_RE.test(err);
}

/** True when `waitForTransactionReceipt` gave up before the hash was mined; the transaction may still land. */
export function isReceiptTimeout(err: unknown): boolean {
  if (err instanceof BaseError) return !!err.walk((e) => e instanceof WaitForTransactionReceiptTimeoutError);
  return false;
}

// Word boundaries: "unknown transaction type" is not "already sent".
const ALREADY_SENT_RE = /\balready known\b|already imported|\bknown transaction\b/;
const NONCE_IN_USE_RE = /replacement transaction underpriced|replacement fee too low/;
const STALE_NONCE_RE = /nonce too low|nonce has already been used/;

/** Every message along the cause chain, lower-cased: the node's own words sit a few causes down. */
function causeText(err: unknown): string {
  const out: string[] = [];
  let e: unknown = err;
  for (let i = 0; e && i < 12; i++) {
    if (typeof e === "string") {
      out.push(e);
      break;
    }
    if (typeof e !== "object") break;
    const x = e as { cause?: unknown; details?: unknown; shortMessage?: unknown; message?: unknown; data?: { message?: unknown } };
    for (const s of [x.details, x.shortMessage, x.message, x.data?.message]) if (typeof s === "string") out.push(s);
    e = x.cause;
  }
  return out.join("\n").toLowerCase();
}

/**
 * Names a send the wallet or node refused over its nonce, by the node's words anywhere in the cause chain. Not by
 * viem's class: `NonceTooLowError` also covers "already known", which means the opposite (the transaction IS in the
 * pool), and MetaMask's -32603 arrives dressed as a `ContractFunctionRevertedError` whose reason is the raw
 * "RPC 0x7a69 Custom eth_sendRawTransaction: nonce too low". The most careful reading wins when several match.
 */
export function sendConflictOf(err: unknown): SendConflict | undefined {
  const text = causeText(err);
  if (ALREADY_SENT_RE.test(text)) return "already-sent";
  if (NONCE_IN_USE_RE.test(text)) return "nonce-in-use";
  if (STALE_NONCE_RE.test(text)) return "stale-nonce";
  return undefined;
}

/** On its own, a conflict does not say whether anything went out: the copy never claims nothing was sent. */
const CONFLICT_COPY: Record<SendConflict, string> = {
  "stale-nonce": "Your wallet was a step behind the network. Check its activity before trying again.",
  "nonce-in-use": "Another transaction from your wallet is still pending. Check its activity before trying again.",
  "already-sent": "Your wallet says this was already sent. Check its activity before trying again.",
};

/**
 * A conflict's copy once the caller has checked the account's transaction count. `nothingSent` only when the count
 * is unchanged since just before the prompt: nothing from the account landed or queued, so the step can be sent again.
 * Otherwise (or for `already-sent`, which is always sent) it may have gone through.
 */
export function conflictCopy(conflict: SendConflict, nothingSent: boolean): string {
  if (conflict === "already-sent" || !nothingSent) return "Your wallet may already have sent this. Check its activity before trying again.";
  return conflict === "stale-nonce"
    ? "Your wallet was a step behind, so nothing was sent."
    : "Another transaction from your wallet is still pending, so nothing was sent. Try again once it confirms.";
}

/** Turns whatever a write or receipt wait threw into product copy. Never throws itself. */
export function describeTxError(err: unknown): TxErrorDescription {
  if (isUserRejection(err)) return { kind: "warn", title: REJECTED_COPY, rejected: true, timedOut: false };
  if (isReceiptTimeout(err)) return { kind: "warn", title: STILL_PENDING_COPY, rejected: false, timedOut: true };
  // Before the revert branch: MetaMask's "nonce too low" comes back as a ContractFunctionRevertedError.
  const conflict = sendConflictOf(err);
  if (conflict) return { kind: "warn", title: CONFLICT_COPY[conflict], conflict, rejected: false, timedOut: false };

  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert) {
      const errorName = revert.data?.errorName;
      // `reason` is set for Error(string) and Panic reverts; custom errors only carry their decoded name.
      const reason = revert.reason && revert.reason !== "execution reverted" ? revert.reason : undefined;
      const named = errorName && errorName !== "Error" && errorName !== "Panic" ? errorName : undefined;
      const title = reason ?? (named ? `Reverted with ${named}` : REVERTED_COPY);
      // `errorName` is only the custom-error name; Error(string) and Panic reverts are fully described by `title`.
      return { kind: "error", title, errorName: named, rejected: false, timedOut: false };
    }
    const title = err.shortMessage || err.message || REVERTED_COPY;
    return { kind: "error", title: friendly(title), rejected: false, timedOut: false };
  }
  if (err instanceof Error) return { kind: "error", title: friendly(err.message || REVERTED_COPY), rejected: false, timedOut: false };
  return { kind: "error", title: typeof err === "string" && err ? friendly(err) : REVERTED_COPY, rejected: false, timedOut: false };
}
