import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AWS SDK module
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(() => ({ send: mockSend })),
  InvokeModelCommand: vi.fn((input: unknown) => input),
}));

import { BedrockProvider } from '../src/bedrock/index.js';

describe('BedrockProvider', () => {
  let provider: BedrockProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new BedrockProvider({
      apiKey: 'not-used-for-bedrock',
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      region: 'us-east-1',
      retryPolicy: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 1000, jitter: false },
    });
  });

  it('has correct provider name and properties', () => {
    expect(provider.name).toBe('bedrock');
    expect(provider.modelId).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(provider.maxContextWindow).toBe(200000);
  });

  it('sends correct request format to Bedrock', async () => {
    const responseBody = {
      content: [{ type: 'text', text: '{"comments": [], "summary": "OK"}' }],
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    };

    mockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify(responseBody)),
    });

    const result = await provider.review('Review this code', {
      temperature: 0.1,
      maxOutputTokens: 4096,
      timeoutMs: 60000,
      systemPrompt: 'You are a code reviewer.',
    });

    expect(result.content).toBe('{"comments": [], "summary": "OK"}');
    expect(result.tokensUsed.input).toBe(100);
    expect(result.tokensUsed.output).toBe(50);
    expect(result.tokensUsed.total).toBe(150);

    // Verify the command was constructed correctly
    const sentCommand = mockSend.mock.calls[0][0];
    expect(sentCommand.modelId).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(sentCommand.contentType).toBe('application/json');

    const requestBody = JSON.parse(sentCommand.body);
    expect(requestBody.anthropic_version).toBe('bedrock-2023-05-31');
    expect(requestBody.max_tokens).toBe(4096);
    expect(requestBody.temperature).toBe(0.1);
    expect(requestBody.system).toBe('You are a code reviewer.');
    expect(requestBody.messages).toEqual([{ role: 'user', content: 'Review this code' }]);
  });

  it('handles response without system prompt', async () => {
    const responseBody = {
      content: [{ type: 'text', text: 'response text' }],
      usage: { input_tokens: 50, output_tokens: 20 },
    };

    mockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify(responseBody)),
    });

    const result = await provider.review('Simple prompt', {
      temperature: 0.2,
      maxOutputTokens: 2048,
      timeoutMs: 30000,
    });

    expect(result.content).toBe('response text');

    const sentCommand = mockSend.mock.calls[0][0];
    const requestBody = JSON.parse(sentCommand.body);
    expect(requestBody.system).toBeUndefined();
  });

  it('throws on empty response', async () => {
    const responseBody = { content: [], usage: {} };

    mockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify(responseBody)),
    });

    await expect(
      provider.review('test', { temperature: 0.1, maxOutputTokens: 100, timeoutMs: 5000 })
    ).rejects.toThrow('Bedrock returned empty response');
  });

  it('throws on response without text content', async () => {
    const responseBody = {
      content: [{ type: 'image', source: {} }],
      usage: {},
    };

    mockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify(responseBody)),
    });

    await expect(
      provider.review('test', { temperature: 0.1, maxOutputTokens: 100, timeoutMs: 5000 })
    ).rejects.toThrow('Bedrock returned no text content');
  });

  it('uses model from response when available', async () => {
    const responseBody = {
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'custom-model-id',
    };

    mockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify(responseBody)),
    });

    const result = await provider.review('test', {
      temperature: 0.1,
      maxOutputTokens: 100,
      timeoutMs: 5000,
    });

    expect(result.modelId).toBe('custom-model-id');
  });

  it('falls back to configured modelId when response model is missing', async () => {
    const responseBody = {
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    mockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify(responseBody)),
    });

    const result = await provider.review('test', {
      temperature: 0.1,
      maxOutputTokens: 100,
      timeoutMs: 5000,
    });

    expect(result.modelId).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
  });
});
