/**
 * In-process token-bucket rate limiter for webhook Lambda.
 *
 * Lambda instances are single-threaded and can be reused across invocations,
 * so an in-memory bucket provides cheap per-instance rate limiting as a
 * first line of defence before the DynamoDB usage-counter check.
 *
 * Bucket parameters are intentionally generous — this guards against
 * accidental loops or replay attacks, not legitimate traffic spikes.
 */

export interface BucketConfig {
  /** Maximum tokens the bucket can hold (= burst size). */
  capacity: number;
  /** Tokens replenished per second. */
  refillRate: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly cfg: BucketConfig) {
    this.tokens = cfg.capacity;
    this.lastRefill = Date.now();
  }

  /** Returns true if a token was consumed (request is allowed). */
  consume(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    this.tokens = Math.min(
      this.cfg.capacity,
      this.tokens + elapsed * this.cfg.refillRate
    );
    this.lastRefill = now;
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}

// Shared singleton — survives warm Lambda invocations.
// 50 requests per minute burst (≈ 0.83 req/s refill, 50 token capacity).
export const webhookBucket = new TokenBucket({ capacity: 50, refillRate: 50 / 60 });
