import { describe, test, expect, beforeEach } from 'vitest';
import { TokenBucket } from '../../../infra/lambdas/shared/rate-limiter.js';

describe('TokenBucket', () => {
  let bucket: TokenBucket;

  beforeEach(() => {
    bucket = new TokenBucket({ capacity: 5, refillRate: 1 }); // 1 token/s
  });

  test('allows requests up to capacity', () => {
    for (let i = 0; i < 5; i++) {
      expect(bucket.consume()).toBe(true);
    }
  });

  test('rejects once capacity exhausted', () => {
    for (let i = 0; i < 5; i++) bucket.consume();
    expect(bucket.consume()).toBe(false);
  });

  test('available decreases with each consume', () => {
    const before = bucket.available;
    bucket.consume();
    expect(bucket.available).toBeLessThan(before);
  });

  test('cost > 1 consumes multiple tokens', () => {
    expect(bucket.consume(3)).toBe(true);
    expect(bucket.consume(3)).toBe(false); // only 2 left
  });

  test('starts with full capacity', () => {
    expect(Math.floor(bucket.available)).toBe(5);
  });
});
