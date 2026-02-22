import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterProvider } from '../src/openrouter/index.js';

// Mock the openai module
vi.mock('openai', () => {
  const mockCreate = vi.fn();
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } };
      constructor() {}
    },
    __mockCreate: mockCreate,
  };
});

async function getMockCreate() {
  const mod = await import('openai');
  return (mod as unknown as { __mockCreate: ReturnType<typeof vi.fn> }).__mockCreate;
}

describe('OpenRouterProvider', () => {
  let provider: OpenRouterProvider;

  beforeEach(async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockReset();

    provider = new OpenRouterProvider({
      apiKey: 'test-key',
      modelId: 'anthropic/claude-sonnet-4-20250514',
    });
  });

  it('has correct name and modelId', () => {
    expect(provider.name).toBe('openrouter');
    expect(provider.modelId).toBe('anthropic/claude-sonnet-4-20250514');
    expect(provider.maxContextWindow).toBe(200000);
  });

  it('sends correct messages to OpenAI client', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"comments":[],"summary":"clean"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      model: 'anthropic/claude-sonnet-4-20250514',
    });

    const result = await provider.review('Review this code', {
      temperature: 0.2,
      maxOutputTokens: 4096,
      timeoutMs: 60000,
      systemPrompt: 'You are a reviewer',
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: 'anthropic/claude-sonnet-4-20250514',
      messages: [
        { role: 'system', content: 'You are a reviewer' },
        { role: 'user', content: 'Review this code' },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    });

    expect(result.content).toBe('{"comments":[],"summary":"clean"}');
    expect(result.tokensUsed.input).toBe(100);
    expect(result.tokensUsed.output).toBe(50);
    expect(result.tokensUsed.total).toBe(150);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles missing system prompt', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'response' } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
      model: 'test',
    });

    await provider.review('Review this', {
      temperature: 0.1,
      maxOutputTokens: 1024,
      timeoutMs: 30000,
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0].role).toBe('user');
  });

  it('throws on empty response', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
      usage: null,
      model: 'test',
    });

    await expect(
      provider.review('test', { temperature: 0.1, maxOutputTokens: 1024, timeoutMs: 30000 })
    ).rejects.toThrow('empty response');
  });

  it('handles missing usage data gracefully', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok' } }],
      usage: null,
      model: 'test',
    });

    const result = await provider.review('test', {
      temperature: 0.1,
      maxOutputTokens: 1024,
      timeoutMs: 30000,
    });

    expect(result.tokensUsed.input).toBe(0);
    expect(result.tokensUsed.output).toBe(0);
    expect(result.tokensUsed.total).toBe(0);
  });
});
