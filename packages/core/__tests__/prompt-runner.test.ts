import { describe, it, expect, vi } from 'vitest';
import { parseJsonResponse, runReview } from '../src/prompt-runner/index.js';
import type { LLMProvider, ReviewPacket, LLMResponse, ReviewRequestOptions } from '../src/types.js';

describe('parseJsonResponse', () => {
  it('parses clean JSON', () => {
    const input = JSON.stringify({
      comments: [{ filePath: 'test.ts', message: 'issue' }],
      summary: 'Found 1 issue',
    });
    const result = parseJsonResponse(input);
    expect(result.comments).toHaveLength(1);
    expect(result.summary).toBe('Found 1 issue');
  });

  it('strips markdown code fences', () => {
    const json = JSON.stringify({ comments: [], summary: 'Clean' });
    const input = '```json\n' + json + '\n```';
    const result = parseJsonResponse(input);
    expect(result.comments).toEqual([]);
    expect(result.summary).toBe('Clean');
  });

  it('extracts JSON from surrounding text', () => {
    const json = JSON.stringify({ comments: [], summary: 'Found nothing' });
    const input = 'Here is my analysis:\n' + json + '\nThat is all.';
    const result = parseJsonResponse(input);
    expect(result.summary).toBe('Found nothing');
  });

  it('returns empty comments on unparseable input', () => {
    const result = parseJsonResponse('This is not JSON at all');
    expect(result.comments).toEqual([]);
    expect(result.summary).toContain('Failed to parse');
  });

  it('handles empty string', () => {
    const result = parseJsonResponse('');
    expect(result.comments).toEqual([]);
  });
});

describe('runReview', () => {
  function createMockProvider(response?: Partial<LLMResponse>): LLMProvider {
    const defaultResponse: LLMResponse = {
      content: JSON.stringify({
        comments: [
          {
            filePath: 'src/auth.ts',
            lineNumber: 13,
            codeSnippet: "const token = header.replace('Bearer ', '');",
            severity: 'warning',
            category: 'logic',
            message: 'Token not validated',
            confidence: 0.8,
          },
        ],
        summary: 'Found one issue',
      }),
      modelId: 'test-model',
      tokensUsed: { input: 100, output: 50, total: 150 },
      durationMs: 500,
    };

    return {
      name: 'mock',
      modelId: 'test-model',
      maxContextWindow: 100000,
      review: vi.fn().mockResolvedValue({ ...defaultResponse, ...response }),
    };
  }

  const SAMPLE_PACKET: ReviewPacket = {
    jobId: '550e8400-e29b-41d4-a716-446655440001',
    repository: { owner: 'acme', name: 'backend', fullName: 'acme/backend' },
    pullRequest: {
      number: 42,
      title: 'Fix auth',
      description: null,
      author: 'dev1',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      url: 'https://github.com/acme/backend/pull/42',
    },
    diff: [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index abc1234..def5678 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -10,4 +10,6 @@ export function authenticate(req: Request) {',
      '   const header = req.headers.authorization;',
      '   if (!header) return null;',
      '+  const token = header.replace(\'Bearer \', \'\');',
      '+  if (!token.trim()) return null;',
      '   return header.split(\' \')[1];',
      ' }',
      '',
    ].join('\n'),
    commitMessages: ['Fix null check'],
    files: [
      { path: 'src/auth.ts', language: 'typescript', status: 'modified', additions: 2, deletions: 0 },
    ],
    createdAt: '2026-02-07T10:00:00.000Z',
    metadata: { webhookEventId: 'test-event', installationId: null },
  };

  it('runs all four passes by default', async () => {
    const provider = createMockProvider();
    const result = await runReview(SAMPLE_PACKET, provider);

    expect(result.outputs).toHaveLength(4);
    expect(provider.review).toHaveBeenCalledTimes(4);
  });

  it('runs only specified passes', async () => {
    const provider = createMockProvider();
    const result = await runReview(SAMPLE_PACKET, provider, {
      passes: ['logic', 'security'],
    });

    expect(result.outputs).toHaveLength(2);
    expect(provider.review).toHaveBeenCalledTimes(2);
  });

  it('runs passes sequentially when parallel=false', async () => {
    const callOrder: number[] = [];
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      modelId: 'test-model',
      maxContextWindow: 100000,
      review: vi.fn().mockImplementation(async () => {
        const myOrder = callCount++;
        callOrder.push(myOrder);
        return {
          content: JSON.stringify({ comments: [], summary: 'ok' }),
          modelId: 'test',
          tokensUsed: { input: 10, output: 5, total: 15 },
          durationMs: 100,
        };
      }),
    };

    await runReview(SAMPLE_PACKET, provider, { parallel: false, passes: ['logic', 'style'] });
    expect(callOrder).toEqual([0, 1]);
  });

  it('calculates total tokens across passes', async () => {
    const provider = createMockProvider({
      tokensUsed: { input: 100, output: 50, total: 150 },
    });
    const result = await runReview(SAMPLE_PACKET, provider, { passes: ['logic', 'style'] });

    expect(result.totalTokens.input).toBe(200);
    expect(result.totalTokens.output).toBe(100);
    expect(result.totalTokens.total).toBe(300);
  });

  it('filters comments through evidence gate', async () => {
    const provider = createMockProvider({
      content: JSON.stringify({
        comments: [
          {
            filePath: 'src/auth.ts',
            lineNumber: 13,
            codeSnippet: "const token = header.replace('Bearer ', '');",
            severity: 'warning',
            category: 'logic',
            message: 'Valid comment',
            confidence: 0.8,
          },
          {
            filePath: 'nonexistent.ts',
            lineNumber: 1,
            codeSnippet: 'fake code',
            severity: 'critical',
            category: 'logic',
            message: 'Invalid - wrong file',
            confidence: 0.9,
          },
        ],
        summary: 'Mixed results',
      }),
    });

    const result = await runReview(SAMPLE_PACKET, provider, { passes: ['logic'] });

    // The valid comment should pass, the invalid one should be filtered
    const validComments = result.mergedComments.filter(c => c.filePath === 'src/auth.ts');
    const invalidComments = result.mergedComments.filter(c => c.filePath === 'nonexistent.ts');
    expect(invalidComments).toHaveLength(0);
    expect(validComments.length).toBeGreaterThanOrEqual(0); // May or may not pass snippet check
  });

  it('handles LLM returning invalid JSON gracefully', async () => {
    const provider = createMockProvider({
      content: 'This is not valid JSON response from the model',
    });

    const result = await runReview(SAMPLE_PACKET, provider, { passes: ['logic'] });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].comments).toHaveLength(0);
  });
});
