/**
 * nonce.ts — Cross-library nonce coordinator.
 *
 * Why this exists
 * ───────────────
 * The SDK submits EVM transactions from THREE places that all share one
 * wallet (`OG_PRIVATE_KEY`):
 *
 *   1. ethers ─ blob upload      (`Indexer.upload`)
 *   2. ethers ─ KV write         (`Batcher.exec`)
 *   3. viem   ─ on-chain anchor  (`writeContract`)
 *
 * None of these libraries know about each other's pending txs, so they all
 * race for the same nonce on the 0G testnet RPC and trigger
 * `NONCE_EXPIRED` / `REPLACEMENT_UNDERPRICED` errors.
 *
 * `TxNonceCoordinator` is a module-level singleton (keyed by private key)
 * that hands out nonces from a single monotonically-increasing counter.
 * Callers pass the explicit nonce to whichever library they're using.
 *
 * Operations are also serialized through an internal promise chain so that
 * even libraries that submit multiple internal txs (e.g. fee + storage)
 * can't interleave with another library's ops.
 */

type NonceFetcher = () => Promise<number>;

const NONCE_ERROR_RE =
  /\bnonce\b|REPLACEMENT_UNDERPRICED|NONCE_EXPIRED|nonce too low|nonce has already been used|replacement fee too low|replacement transaction underpriced/i;

export function isNonceError(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message ?? "";
  return NONCE_ERROR_RE.test(msg);
}

/**
 * Parse the chain's authoritative "next nonce" hint out of an error message.
 * Falls back to `currentNonce + 1` for replacement-underpriced errors.
 */
function nextNonceFromError(
  err: unknown,
  currentNonce: number,
): number | null {
  const msg = (err as Error | undefined)?.message ?? "";

  // "nonce too low: next nonce 131, tx nonce 130" → 131
  const m = msg.match(/next nonce[:\s]+(\d+)/i);
  if (m && m[1]) return parseInt(m[1], 10);

  // Replacement-underpriced means our nonce collided with a mempool entry —
  // skip past it.
  if (/REPLACEMENT_UNDERPRICED|replacement (?:fee|transaction) (?:too low|underpriced)/i.test(msg)) {
    return currentNonce + 1;
  }

  return null;
}

const RETRIES = 8;

export class TxNonceCoordinator {
  private next: number | null = null;
  private mutex: Promise<void> = Promise.resolve();

  /**
   * Atomically run `fn(nonce)`. The retry loop lives INSIDE the mutex so no
   * other coordinator op can race in while we recover from a nonce error.
   *
   * On a nonce error we parse the chain's authoritative "next nonce" from
   * the error message (much more reliable than re-fetching from an RPC that
   * lags behind the mempool) and immediately retry without any delay — that
   * way we don't fall behind any further stuck-tx drains.
   */
  async withNonce<T>(
    fetcher: NonceFetcher,
    fn: (nonce: number) => Promise<T>,
  ): Promise<T> {
    return this.serial(async () => {
      if (this.next === null) {
        this.next = await fetcher();
      }

      let lastErr: unknown;
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        const nonce = this.next!;
        try {
          const result = await fn(nonce);
          this.next = nonce + 1;
          return result;
        } catch (err) {
          lastErr = err;
          if (!isNonceError(err)) {
            // Non-nonce failure — don't advance counter, propagate.
            throw err;
          }
          // Use chain's authoritative next nonce from the error message.
          const hinted = nextNonceFromError(err, nonce);
          if (hinted !== null) {
            this.next = hinted;
          } else {
            // No hint in the error — fall back to RPC re-fetch.
            this.next = await fetcher();
          }
        }
      }
      throw lastErr;
    });
  }

  /** Force a re-sync from the chain on the next withNonce call. */
  invalidate(): void {
    this.next = null;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.mutex.then(fn, fn);
    this.mutex = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}

// ── Shared singletons keyed by wallet ────────────────────────────────────────
const _byKey = new Map<string, TxNonceCoordinator>();

export function getCoordinator(privateKey: string): TxNonceCoordinator {
  const key = privateKey.toLowerCase();
  let c = _byKey.get(key);
  if (!c) {
    c = new TxNonceCoordinator();
    _byKey.set(key, c);
  }
  return c;
}
