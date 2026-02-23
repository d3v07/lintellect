import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepFunctionPayload } from '../lambdas/shared/types.js';

// Mock Secrets Manager
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ SecretString: 'ghp_test_token_123' }),
  })),
  GetSecretValueCommand: vi.fn(),
}));

// Mock S3 helpers
const mockReadJsonFromS3 = vi.fn();

vi.mock('../lambdas/shared/s3-helpers.js', () => ({
  readJsonFromS3: (...args: unknown[]) => mockReadJsonFromS3(...args),
}));

// Mock DynamoDB helpers
const mockUpdateJobStatus = vi.fn().mockResolvedValue(undefined);

vi.mock('../lambdas/shared/dynamo-helpers.js', () => ({
  updateJobStatus: (...args: unknown[]) => mockUpdateJobStatus(...args),
}));

// Mock fetch for GitHub API
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

process.env.JOB_TABLE = 'test-table';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:test';

import { handler } from '../lambdas/comment-poster/index.js';

describe('CommentPoster Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
  });

  const basePayload: StepFunctionPayload = {
    jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
    bucket: 'test-bucket',
    artifacts: {
      input: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/input.json',
      output: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/output.json',
    },
    repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
    pullRequest: { number: 42, headSha: 'abc123' },
    status: 'validating',
  };

  it('posts review with inline comments for accepted comments', async () => {
    mockReadJsonFromS3.mockResolvedValueOnce({
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      acceptedComments: [
        {
          filePath: 'src/app.ts',
          lineNumber: 10,
          codeSnippet: 'const x = 1;',
          severity: 'warning',
          category: 'logic',
          message: 'Unused variable',
          confidence: 0.8,
        },
      ],
      evidenceMetrics: { totalComments: 1, acceptedCount: 1, rejectedCount: 0, passRate: 1 },
      totalTokens: { input: 100, output: 50, total: 150 },
      totalDurationMs: 1000,
    });

    const result = await handler(basePayload);

    expect(result.status).toBe('completed');

    // Verify GitHub API was called
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls/42/reviews',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_test_token_123',
        }),
      })
    );

    // Verify the review body
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.event).toBe('COMMENT');
    expect(callBody.comments).toHaveLength(1);
    expect(callBody.comments[0].path).toBe('src/app.ts');
    expect(callBody.comments[0].line).toBe(10);
  });

  it('posts APPROVE review when no accepted comments', async () => {
    mockReadJsonFromS3.mockResolvedValueOnce({
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      acceptedComments: [],
      evidenceMetrics: { totalComments: 2, acceptedCount: 0, rejectedCount: 2, passRate: 0 },
      totalTokens: { input: 100, output: 50, total: 150 },
      totalDurationMs: 1000,
    });

    const result = await handler(basePayload);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.event).toBe('APPROVE');
    expect(callBody.comments).toHaveLength(0);
  });

  it('posts REQUEST_CHANGES when critical issues found', async () => {
    mockReadJsonFromS3.mockResolvedValueOnce({
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      acceptedComments: [
        {
          filePath: 'src/auth.ts',
          lineNumber: 5,
          codeSnippet: 'password = req.body.password',
          severity: 'critical',
          category: 'security',
          message: 'SQL injection risk',
          confidence: 0.95,
        },
      ],
      evidenceMetrics: { totalComments: 1, acceptedCount: 1, rejectedCount: 0, passRate: 1 },
      totalTokens: { input: 200, output: 100, total: 300 },
      totalDurationMs: 2000,
    });

    await handler(basePayload);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.event).toBe('REQUEST_CHANGES');
  });

  it('handles multi-line comments with start_line', async () => {
    mockReadJsonFromS3.mockResolvedValueOnce({
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      acceptedComments: [
        {
          filePath: 'src/utils.ts',
          lineNumber: 10,
          endLineNumber: 15,
          codeSnippet: 'function helper() {\n  // ...\n}',
          severity: 'suggestion',
          category: 'style',
          message: 'Could be simplified',
          confidence: 0.7,
        },
      ],
      evidenceMetrics: { totalComments: 1, acceptedCount: 1, rejectedCount: 0, passRate: 1 },
      totalTokens: { input: 100, output: 50, total: 150 },
      totalDurationMs: 500,
    });

    await handler(basePayload);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.comments[0].line).toBe(15);
    expect(callBody.comments[0].start_line).toBe(10);
  });

  it('throws when GitHub API returns error', async () => {
    mockReadJsonFromS3.mockResolvedValueOnce({
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      acceptedComments: [],
      evidenceMetrics: { totalComments: 0, acceptedCount: 0, rejectedCount: 0, passRate: 0 },
      totalTokens: { input: 0, output: 0, total: 0 },
      totalDurationMs: 0,
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"message": "Forbidden"}'),
    });

    await expect(handler(basePayload)).rejects.toThrow('GitHub API error 403');
  });

  it('throws when output artifact is missing', async () => {
    const badPayload = { ...basePayload, artifacts: { input: 'x' } };
    await expect(handler(badPayload)).rejects.toThrow('Missing output artifact');
  });

  it('updates job status to posting then completed', async () => {
    mockReadJsonFromS3.mockResolvedValueOnce({
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      acceptedComments: [],
      evidenceMetrics: { totalComments: 0, acceptedCount: 0, rejectedCount: 0, passRate: 0 },
      totalTokens: { input: 0, output: 0, total: 0 },
      totalDurationMs: 0,
    });

    await handler(basePayload);

    expect(mockUpdateJobStatus).toHaveBeenCalledWith('test-table', '01KGXNNHSAEQ2QXEBFES362MWR', 'posting');
    expect(mockUpdateJobStatus).toHaveBeenCalledWith('test-table', '01KGXNNHSAEQ2QXEBFES362MWR', 'completed');
  });
});
