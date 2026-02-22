import OpenAI from 'openai';
import type { ReviewRequestOptions, LLMResponse, TokensUsed } from '@lintellect/core';
import { BaseProvider, type ProviderOptions } from '../base-provider.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterProviderOptions extends ProviderOptions {
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
}

export class OpenRouterProvider extends BaseProvider {
  readonly name = 'openrouter';
  readonly modelId: string;
  readonly maxContextWindow = 200000; // Claude Sonnet context window via OpenRouter

  private readonly client: OpenAI;
  private readonly siteUrl?: string;
  private readonly siteName?: string;

  constructor(options: OpenRouterProviderOptions) {
    super(options);
    this.modelId = options.modelId;
    this.siteUrl = options.siteUrl;
    this.siteName = options.siteName;

    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl ?? OPENROUTER_BASE_URL,
      defaultHeaders: {
        ...(options.siteUrl ? { 'HTTP-Referer': options.siteUrl } : {}),
        ...(options.siteName ? { 'X-Title': options.siteName } : {}),
      },
    });
  }

  async review(prompt: string, options: ReviewRequestOptions): Promise<LLMResponse> {
    return this.withRetry(async () => {
      const startTime = Date.now();

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      if (options.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }

      messages.push({ role: 'user', content: prompt });

      const response = await this.client.chat.completions.create({
        model: this.modelId,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxOutputTokens,
      });

      const durationMs = Date.now() - startTime;

      if (!response.choices?.length) {
        throw new Error(`LLM returned no choices. Raw response: ${JSON.stringify(response).slice(0, 500)}`);
      }

      const choice = response.choices[0];

      if (!choice?.message?.content) {
        throw new Error('LLM returned empty response content');
      }

      const usage = response.usage;
      const tokensUsed: TokensUsed = {
        input: usage?.prompt_tokens ?? 0,
        output: usage?.completion_tokens ?? 0,
        total: (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
      };

      return {
        content: choice.message.content,
        modelId: response.model ?? this.modelId,
        tokensUsed,
        durationMs,
      };
    });
  }
}
