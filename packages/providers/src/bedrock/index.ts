import type { ReviewRequestOptions, LLMResponse, TokensUsed } from '@lintellect/core';
import { BaseProvider, type ProviderOptions } from '../base-provider.js';

export interface BedrockProviderOptions extends ProviderOptions {
  region: string;
}

/**
 * AWS Bedrock provider for Claude models.
 *
 * Uses the Bedrock InvokeModel API with the Messages API format
 * for Anthropic Claude models hosted on Bedrock.
 */
export class BedrockProvider extends BaseProvider {
  readonly name = 'bedrock';
  readonly modelId: string;
  readonly maxContextWindow = 200000;
  readonly region: string;

  private client: unknown = null;

  constructor(options: BedrockProviderOptions) {
    super(options);
    this.modelId = options.modelId;
    this.region = options.region;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;

    // Dynamic import to avoid requiring @aws-sdk/client-bedrock-runtime
    // when only using OpenRouter provider
    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
    this.client = new BedrockRuntimeClient({ region: this.region });
    return this.client;
  }

  async review(prompt: string, options: ReviewRequestOptions): Promise<LLMResponse> {
    return this.withRetry(async () => {
      const startTime = Date.now();

      const client = await this.getClient();
      const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');

      // Build Messages API request body for Claude on Bedrock
      const messages: Array<{ role: string; content: string }> = [];

      if (options.systemPrompt) {
        // Bedrock Messages API uses system as a top-level field, not a message
      }

      messages.push({ role: 'user', content: prompt });

      const requestBody = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: options.maxOutputTokens,
        temperature: options.temperature,
        messages,
        ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
      };

      const command = new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(requestBody),
      });

      const response = await client.send(command);
      const durationMs = Date.now() - startTime;

      // Parse response
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      if (!responseBody.content || responseBody.content.length === 0) {
        throw new Error('Bedrock returned empty response');
      }

      const textContent = responseBody.content.find(
        (block: { type: string; text?: string }) => block.type === 'text'
      );

      if (!textContent?.text) {
        throw new Error('Bedrock returned no text content');
      }

      const tokensUsed: TokensUsed = {
        input: responseBody.usage?.input_tokens ?? 0,
        output: responseBody.usage?.output_tokens ?? 0,
        total:
          (responseBody.usage?.input_tokens ?? 0) + (responseBody.usage?.output_tokens ?? 0),
      };

      return {
        content: textContent.text,
        modelId: responseBody.model ?? this.modelId,
        tokensUsed,
        durationMs,
      };
    });
  }
}
