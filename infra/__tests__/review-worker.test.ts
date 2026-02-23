import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepFunctionPayload } from '../lambdas/shared/types.js';

// Mock Secrets Manager
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ SecretString: 'sk-or-test-key' }),
  })),
  GetSecretValueCommand: vi.fn(),
}));

// Mock S3 helpers
const mockReadJsonFromS3 = vi.fn();
const mockWriteJsonToS3 = vi.fn().mockResolvedValue(undefined);

vi.mock('../lambdas/shared/s3-helpers.js', () => ({
  readJsonFromS3: (...args: unknown[]) => mockReadJsonFromS3(...args),
  writeJsonToS3: (...args: unknown[]) => mockWriteJsonToS3(...args),
}));

// Mock DynamoDB helpers
const mockUpdateJobStatus = vi.fn().mockResolvedValue(undefined);

vi.mock('../lambdas/shared/dynamo-helpers.js', () => ({
  updateJobStatus: (...args: unknown[]) => mockUpdateJobStatus(...args),
}));

// Mock the provider's review method
const mockReview = vi.fn().mockResolvedValue({
  content: JSON.stringify({
    comments: [
      {
        filePath: 'src/app.ts',
        lineNumber: 2,
        codeSnippet: 'import cors from "cors";',
        severity: 'suggestion',
        message: 'Consider adding CORS options',
        confidence: 0.7,
      },
    ],
    summary: 'Structural review complete',
  }),
  modelId: 'anthropic/claude-sonnet-4',
  tokensUsed: { input: 500, output: 200, total: 700 },
  durationMs: 1500,
});

vi.mock('@lintellect/providers', () => ({
  createProvider: vi.fn(() => ({
    review: mockReview,
    name: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4',
    maxContextWindow: 200000,
  })),
}));

process.env.JOB_TABLE = 'test-table';
process.env.OPENROUTER_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:test';
process.env.OPENROUTER_MODEL = 'anthropic/claude-sonnet-4';

import { handler } from '../lambdas/review-worker/index.js';

describe('ReviewWorker Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-mock review for each test
    mockReview.mockResolvedValue({
      content: JSON.stringify({
        comments: [
          {
            filePath: 'src/app.ts',
            lineNumber: 2,
            codeSnippet: 'import cors from "cors";',
            severity: 'suggestion',
            message: 'Consider adding CORS options',
            confidence: 0.7,
          },
        ],
        summary: 'Review complete',
      }),
      modelId: 'anthropic/claude-sonnet-4',
      tokensUsed: { input: 500, output: 200, total: 700 },
      durationMs: 1500,
    });
  });

  const basePayload: StepFunctionPayload & { passType: string } = {
    jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
    bucket: 'test-bucket',
    artifacts: {
      input: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/input.json',
      parsedDiff: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/parsed-diff.json',
      context: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/context.json',
    },
    repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
    pullRequest: { number: 1, headSha: 'abc123' },
    status: 'processing',
    passType: 'structural',
  };

  const mockPacket = {
    jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
    diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n import express from "express";\n+import cors from "cors";\n const app = express();',
    repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
    pullRequest: { number: 1, title: 'Add cors', description: 'Add CORS support', baseSha: 'a', headSha: 'b', author: 'dev', url: 'url' },
    commitMessages: [],
    files: [],
    createdAt: '2026-02-07T00:00:00Z',
    metadata: { webhookEventId: 'e1', installationId: null },
  };

  const mockContext = { formatted: 'src/app.ts:\n  import express...' };

  it('runs a single review pass and writes output to S3', async () => {
    mockReadJsonFromS3
      .mockResolvedValueOnce(mockPacket)
      .mockResolvedValueOnce(mockContext);

    const result = await handler(basePayload as any);

    // Should update status
    expect(mockUpdateJobStatus).toHaveBeenCalledWith('test-table', '01KGXNNHSAEQ2QXEBFES362MWR', 'reviewing');

    // Should call provider.review
    expect(mockReview).toHaveBeenCalledOnce();

    // Should write pass output to S3
    expect(mockWriteJsonToS3).toHaveBeenCalledWith(
      'test-bucket',
      'packets/01KGXNNHSAEQ2QXEBFES362MWR/pass-1.json',
      expect.objectContaining({
        jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
        passType: 'structural',
        passNumber: 1,
        comments: expect.arrayContaining([
          expect.objectContaining({
            filePath: 'src/app.ts',
            lineNumber: 2,
            category: 'structural',
          }),
        ]),
      })
    );

    // Should return updated payload with pass artifact
    expect(result.artifacts.pass1).toBe('packets/01KGXNNHSAEQ2QXEBFES362MWR/pass-1.json');
  });

  it('handles empty LLM response (no comments)', async () => {
    mockReview.mockResolvedValueOnce({
      content: JSON.stringify({ comments: [], summary: 'No issues' }),
      modelId: 'anthropic/claude-sonnet-4',
      tokensUsed: { input: 300, output: 50, total: 350 },
      durationMs: 800,
    });

    mockReadJsonFromS3
      .mockResolvedValueOnce(mockPacket)
      .mockResolvedValueOnce(mockContext);

    const result = await handler(basePayload as any);

    const writtenOutput = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenOutput.comments).toHaveLength(0);
    expect(writtenOutput.summary).toBe('No issues');
  });

  it('handles malformed LLM JSON response gracefully', async () => {
    mockReview.mockResolvedValueOnce({
      content: 'This is not JSON at all',
      modelId: 'anthropic/claude-sonnet-4',
      tokensUsed: { input: 300, output: 50, total: 350 },
      durationMs: 800,
    });

    mockReadJsonFromS3
      .mockResolvedValueOnce(mockPacket)
      .mockResolvedValueOnce(mockContext);

    const result = await handler(basePayload as any);

    const writtenOutput = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenOutput.comments).toHaveLength(0);
    // parseJsonResponse falls back to empty comments on parse failure
  });

  it('handles JSON wrapped in markdown fences', async () => {
    mockReview.mockResolvedValueOnce({
      content: '```json\n{"comments": [{"filePath": "a.ts", "lineNumber": 1, "codeSnippet": "x", "severity": "warning", "message": "test", "confidence": 0.5}], "summary": "Done"}\n```',
      modelId: 'anthropic/claude-sonnet-4',
      tokensUsed: { input: 300, output: 100, total: 400 },
      durationMs: 900,
    });

    mockReadJsonFromS3
      .mockResolvedValueOnce(mockPacket)
      .mockResolvedValueOnce(mockContext);

    const result = await handler(basePayload as any);

    const writtenOutput = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenOutput.comments).toHaveLength(1);
    expect(writtenOutput.comments[0].filePath).toBe('a.ts');
  });

  it('uses correct pass number for security pass', async () => {
    const securityPayload = { ...basePayload, passType: 'security' };

    mockReadJsonFromS3
      .mockResolvedValueOnce(mockPacket)
      .mockResolvedValueOnce(mockContext);

    const result = await handler(securityPayload as any);

    // Security is pass 4
    expect(mockWriteJsonToS3).toHaveBeenCalledWith(
      'test-bucket',
      'packets/01KGXNNHSAEQ2QXEBFES362MWR/pass-4.json',
      expect.objectContaining({ passNumber: 4, passType: 'security' })
    );
    expect(result.artifacts.pass4).toBe('packets/01KGXNNHSAEQ2QXEBFES362MWR/pass-4.json');
  });
});
