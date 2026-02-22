import { describe, it, expect, vi } from 'vitest';
import type { ReviewRequestOptions, LLMResponse } from '@lintellect/core';
import { BaseProvider } from '../src/base-provider.js';

class TestProvider extends BaseProvider {
  readonly name = 'test';
  readonly modelId = 'test-model';
  readonly maxContextWindow = 100000;

  public mockReviewFn = vi.fn<() => Promise<LLMResponse>>();

  async review(_prompt: string, _options: ReviewRequestOptions): Promise<LLMResponse> {
    return this.withRetry(() => this.mockReviewFn());
  }
}

describe('BaseProvider retry logic', () => {
  it('succeeds on first try without retry', async () => {
    const provider = new TestProvider({
      apiKey: 'test',
      modelId: 'test',
      retryPolicy: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
    });

    const response: LLMResponse = {
      content: 'ok',
      modelId: 'test',
      tokensUsed: { input: 10, output: 5, total: 15 },
      durationMs: 100,
    };
    provider.mockReviewFn.mockResolvedValueOnce(response);

    const result = await provider.review('test', {
      temperature: 0.1,
      maxOutputTokens: 1024,
      timeoutMs: 30000,
    });

    expect(result.content).toBe('ok');
    expect(provider.mockReviewFn).toHaveBeenCalledTimes(1);
  });

  it('retries on rate limit error and eventually succeeds', async () => {
    const provider = new TestProvider({
      apiKey: 'test',
      modelId: 'test',
      retryPolicy: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
    });

    const response: LLMResponse = {
      content: 'ok',
      modelId: 'test',
      tokensUsed: { input: 10, output: 5, total: 15 },
      durationMs: 100,
    };

    provider.mockReviewFn
      .mockRejectedValueOnce(new Error('429 rate limit exceeded'))
      .mockRejectedValueOnce(new Error('429 rate limit exceeded'))
      .mockResolvedValueOnce(response);

    const result = await provider.review('test', {
      temperature: 0.1,
      maxOutputTokens: 1024,
      timeoutMs: 30000,
    });

    expect(result.content).toBe('ok');
    expect(provider.mockReviewFn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all retries', async () => {
    const provider = new TestProvider({
      apiKey: 'test',
      modelId: 'test',
      retryPolicy: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
    });

    provider.mockReviewFn
      .mockRejectedValue(new Error('500 internal server error'));

    await expect(
      provider.review('test', { temperature: 0.1, maxOutputTokens: 1024, timeoutMs: 30000 })
    ).rejects.toThrow('500');

    expect(provider.mockReviewFn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('does not retry on non-retryable errors', async () => {
    const provider = new TestProvider({
      apiKey: 'test',
      modelId: 'test',
      retryPolicy: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
    });

    provider.mockReviewFn
      .mockRejectedValue(new Error('Invalid API key'));

    await expect(
      provider.review('test', { temperature: 0.1, maxOutputTokens: 1024, timeoutMs: 30000 })
    ).rejects.toThrow('Invalid API key');

    expect(provider.mockReviewFn).toHaveBeenCalledTimes(1); // No retries
  });

  it('retries on timeout errors', async () => {
    const provider = new TestProvider({
      apiKey: 'test',
      modelId: 'test',
      retryPolicy: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
    });

    const response: LLMResponse = {
      content: 'ok',
      modelId: 'test',
      tokensUsed: { input: 10, output: 5, total: 15 },
      durationMs: 100,
    };

    provider.mockReviewFn
      .mockRejectedValueOnce(new Error('Request timeout'))
      .mockResolvedValueOnce(response);

    const result = await provider.review('test', {
      temperature: 0.1,
      maxOutputTokens: 1024,
      timeoutMs: 30000,
    });

    expect(result.content).toBe('ok');
    expect(provider.mockReviewFn).toHaveBeenCalledTimes(2);
  });

  it('uses jitter when enabled', async () => {
    const provider = new TestProvider({
      apiKey: 'test',
      modelId: 'test',
      retryPolicy: { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 500, jitter: true },
    });

    const response: LLMResponse = {
      content: 'ok',
      modelId: 'test',
      tokensUsed: { input: 10, output: 5, total: 15 },
      durationMs: 100,
    };

    provider.mockReviewFn
      .mockRejectedValueOnce(new Error('503 service unavailable'))
      .mockResolvedValueOnce(response);

    const start = Date.now();
    await provider.review('test', {
      temperature: 0.1,
      maxOutputTokens: 1024,
      timeoutMs: 30000,
    });
    const elapsed = Date.now() - start;

    // With jitter, delay should be between 0 and baseDelayMs (100ms)
    // Allow some tolerance for test execution
    expect(elapsed).toBeLessThan(500);
    expect(provider.mockReviewFn).toHaveBeenCalledTimes(2);
  });

  it('handles maxRetries=0 (no retries)', async () => {
    const provider = new TestProvider({
      apiKey: 'test',
      modelId: 'test',
      retryPolicy: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50, jitter: false },
    });

    provider.mockReviewFn
      .mockRejectedValue(new Error('500 server error'));

    await expect(
      provider.review('test', { temperature: 0.1, maxOutputTokens: 1024, timeoutMs: 30000 })
    ).rejects.toThrow('500');

    expect(provider.mockReviewFn).toHaveBeenCalledTimes(1);
  });
});
