import { describe, it, expect } from 'vitest';
import { createProvider, OpenRouterProvider, BedrockProvider } from '../src/index.js';
import type { ProviderConfig } from '@lintellect/core';

describe('createProvider', () => {
  it('creates OpenRouter provider', () => {
    const config: ProviderConfig = {
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4-20250514',
      temperature: 0.2,
      maxOutputTokens: 4096,
      timeoutMs: 60000,
      retryPolicy: { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 16000, jitter: true },
    };

    const provider = createProvider(config, 'test-key');
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    expect(provider.name).toBe('openrouter');
    expect(provider.modelId).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('creates Bedrock provider with region', () => {
    const config: ProviderConfig = {
      provider: 'bedrock',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      temperature: 0.2,
      maxOutputTokens: 4096,
      timeoutMs: 60000,
      retryPolicy: { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 16000, jitter: true },
      region: 'us-east-1',
    };

    const provider = createProvider(config, 'test-key');
    expect(provider).toBeInstanceOf(BedrockProvider);
    expect(provider.name).toBe('bedrock');
  });

  it('throws for Bedrock without region', () => {
    const config: ProviderConfig = {
      provider: 'bedrock',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      temperature: 0.2,
      maxOutputTokens: 4096,
      timeoutMs: 60000,
      retryPolicy: { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 16000, jitter: true },
    };

    expect(() => createProvider(config, 'key')).toThrow('requires a region');
  });

  it('throws for unknown provider', () => {
    const config = {
      provider: 'unknown',
      modelId: 'model',
      temperature: 0.2,
      maxOutputTokens: 4096,
      timeoutMs: 60000,
      retryPolicy: { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 16000, jitter: true },
    } as unknown as ProviderConfig;

    expect(() => createProvider(config, 'key')).toThrow('Unknown provider');
  });
});
