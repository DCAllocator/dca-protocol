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
 */
export type TxErrorDescription = {
  kind: "warn" | "error";
  title: string;
  detail?: string;
  errorName?: string;
  rejected: boolean;
  timedOut: boolean;
};

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

/** Turns whatever a write or receipt wait threw into product copy. Never throws itself. */
export function describeTxError(err: unknown): TxErrorDescription {
  if (isUserRejection(err)) return { kind: "warn", title: REJECTED_COPY, rejected: true, timedOut: false };
  if (isReceiptTimeout(err)) return { kind: "warn", title: STILL_PENDING_COPY, rejected: false, timedOut: true };

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
