export { BaseProvider } from './base-provider.js';
export type { ProviderOptions } from './base-provider.js';

export { OpenRouterProvider } from './openrouter/index.js';
export type { OpenRouterProviderOptions } from './openrouter/index.js';

export { BedrockProvider } from './bedrock/index.js';
export type { BedrockProviderOptions } from './bedrock/index.js';

import type { ProviderConfig, LLMProvider } from '@lintellect/core';
import { OpenRouterProvider } from './openrouter/index.js';
import { BedrockProvider } from './bedrock/index.js';

/**
 * Create an LLM provider from a ProviderConfig.
 * Requires API key to be passed separately (not in config for security).
 */
export function createProvider(config: ProviderConfig, apiKey: string): LLMProvider {
  switch (config.provider) {
    case 'openrouter':
      return new OpenRouterProvider({
        apiKey,
        modelId: config.modelId,
        retryPolicy: config.retryPolicy,
        baseUrl: config.baseUrl,
      });
    case 'bedrock':
      if (!config.region) {
        throw new Error('Bedrock provider requires a region');
      }
      return new BedrockProvider({
        apiKey,
        modelId: config.modelId,
        region: config.region,
        retryPolicy: config.retryPolicy,
      });
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
