import type { LLMProvider, ReviewRequestOptions, LLMResponse, RetryPolicy } from '@lintellect/core';

export interface ProviderOptions {
  apiKey: string;
  modelId: string;
  retryPolicy?: RetryPolicy;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 16000,
  jitter: true,
};

export abstract class BaseProvider implements LLMProvider {
  abstract readonly name: string;
  abstract readonly modelId: string;
  abstract readonly maxContextWindow: number;

  protected readonly apiKey: string;
  protected readonly retryPolicy: RetryPolicy;

  constructor(options: ProviderOptions) {
    this.apiKey = options.apiKey;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  abstract review(prompt: string, options: ReviewRequestOptions): Promise<LLMResponse>;

  /**
   * Execute a function with exponential backoff retry logic.
   */
  protected async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retryPolicy.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === this.retryPolicy.maxRetries) break;
        if (!this.isRetryable(lastError)) break;

        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private isRetryable(error: Error): boolean {
    const message = error.message.toLowerCase();
    // Retry on rate limits, server errors, timeouts
    return (
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused')
    );
  }

  private calculateDelay(attempt: number): number {
    const exponential = Math.min(
      this.retryPolicy.baseDelayMs * Math.pow(2, attempt),
      this.retryPolicy.maxDelayMs
    );
    if (this.retryPolicy.jitter) {
      return Math.random() * exponential;
    }
    return exponential;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
