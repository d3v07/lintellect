import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepFunctionPayload } from '../lambdas/shared/types.js';
import type { ReviewComment, ParsedDiff } from '@lintellect/core';

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

process.env.JOB_TABLE = 'test-table';
process.env.CONFIDENCE_THRESHOLD = '0.3';

import { handler } from '../lambdas/evidence-gate/index.js';

describe('EvidenceGate Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const basePayload: StepFunctionPayload = {
    jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
    bucket: 'test-bucket',
    artifacts: {
      input: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/input.json',
      parsedDiff: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/parsed-diff.json',
      mergedReview: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/merged-review.json',
    },
    repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
    pullRequest: { number: 1, headSha: 'abc123' },
    status: 'reviewing',
  };

  const parsedDiff: ParsedDiff = {
    files: [
      {
        path: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 4,
            changes: [
              { type: 'normal', content: 'import express from "express";', lineNumber: 1 },
              { type: 'add', content: 'import cors from "cors";', lineNumber: 2 },
              { type: 'normal', content: 'const app = express();', lineNumber: 3 },
              { type: 'normal', content: 'app.listen(3000);', lineNumber: 4 },
            ],
          },
        ],
      },
    ],
  };

  it('accepts comments with valid evidence', async () => {
    const comment: ReviewComment = {
      filePath: 'src/app.ts',
      lineNumber: 2,
      codeSnippet: 'import cors from "cors";',
      severity: 'suggestion',
      category: 'style',
      message: 'Consider using helmet too',
      confidence: 0.8,
    };

    mockReadJsonFromS3
      .mockResolvedValueOnce({ jobId: '01KGXNNHSAEQ2QXEBFES362MWR', comments: [comment], totalTokens: { input: 100, output: 50, total: 150 }, totalDurationMs: 1000 })
      .mockResolvedValueOnce(parsedDiff);

    const result = await handler(basePayload);

    expect(result.artifacts.output).toBe('packets/01KGXNNHSAEQ2QXEBFES362MWR/output.json');

    const writtenOutput = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenOutput.acceptedComments).toHaveLength(1);
    expect(writtenOutput.rejectedComments).toHaveLength(0);
    expect(writtenOutput.evidenceMetrics.passRate).toBe(1);
  });

  it('rejects comments with invalid file path', async () => {
    const comment: ReviewComment = {
      filePath: 'nonexistent.ts',
      lineNumber: 1,
      codeSnippet: 'some code',
      severity: 'warning',
      category: 'logic',
      message: 'Issue here',
      confidence: 0.9,
    };

    mockReadJsonFromS3
      .mockResolvedValueOnce({ jobId: '01KGXNNHSAEQ2QXEBFES362MWR', comments: [comment], totalTokens: { input: 100, output: 50, total: 150 }, totalDurationMs: 1000 })
      .mockResolvedValueOnce(parsedDiff);

    const result = await handler(basePayload);

    const writtenOutput = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenOutput.acceptedComments).toHaveLength(0);
    expect(writtenOutput.rejectedComments).toHaveLength(1);
    expect(writtenOutput.evidenceMetrics.passRate).toBe(0);
  });

  it('filters low-confidence comments', async () => {
    const comment: ReviewComment = {
      filePath: 'src/app.ts',
      lineNumber: 2,
      codeSnippet: 'import cors from "cors";',
      severity: 'nitpick',
      category: 'style',
      message: 'Maybe not',
      confidence: 0.1, // Below threshold
    };

    mockReadJsonFromS3
      .mockResolvedValueOnce({ jobId: '01KGXNNHSAEQ2QXEBFES362MWR', comments: [comment], totalTokens: { input: 100, output: 50, total: 150 }, totalDurationMs: 1000 })
      .mockResolvedValueOnce(parsedDiff);

    const result = await handler(basePayload);

    const writtenOutput = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenOutput.acceptedComments).toHaveLength(0);
    expect(writtenOutput.rejectedComments).toHaveLength(1);
  });

  it('throws when mergedReview artifact is missing', async () => {
    const badPayload = {
      ...basePayload,
      artifacts: { input: 'x' },
    };

    await expect(handler(badPayload)).rejects.toThrow('Missing mergedReview artifact');
  });

  it('throws when parsedDiff artifact is missing', async () => {
    const badPayload = {
      ...basePayload,
      artifacts: { input: 'x', mergedReview: 'y' },
    };

    await expect(handler(badPayload)).rejects.toThrow('Missing parsedDiff artifact');
  });

  it('updates DynamoDB with evidence metrics', async () => {
    const comment: ReviewComment = {
      filePath: 'src/app.ts',
      lineNumber: 2,
      codeSnippet: 'import cors from "cors";',
      severity: 'suggestion',
      category: 'structural',
      message: 'Good import',
      confidence: 0.7,
    };

    mockReadJsonFromS3
      .mockResolvedValueOnce({ jobId: '01KGXNNHSAEQ2QXEBFES362MWR', comments: [comment], totalTokens: { input: 200, output: 100, total: 300 }, totalDurationMs: 2000 })
      .mockResolvedValueOnce(parsedDiff);

    await handler(basePayload);

    // First call: status update to 'validating'
    expect(mockUpdateJobStatus).toHaveBeenCalledWith(
      'test-table',
      '01KGXNNHSAEQ2QXEBFES362MWR',
      'validating'
    );

    // Second call: status update with evidence metrics
    expect(mockUpdateJobStatus).toHaveBeenCalledWith(
      'test-table',
      '01KGXNNHSAEQ2QXEBFES362MWR',
      'validating',
      expect.objectContaining({
        evidenceMetrics: expect.objectContaining({ totalComments: 1, acceptedCount: 1 }),
        tokensUsed: { input: 200, output: 100, total: 300 },
        durationMs: 2000,
      })
    );
  });
});
