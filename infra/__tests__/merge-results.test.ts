import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepFunctionPayload } from '../lambdas/shared/types.js';
import type { ReviewOutput } from '@lintellect/core';

// Mock S3 helpers
const mockReadJsonFromS3 = vi.fn();
const mockWriteJsonToS3 = vi.fn().mockResolvedValue(undefined);

vi.mock('../lambdas/shared/s3-helpers.js', () => ({
  readJsonFromS3: (...args: unknown[]) => mockReadJsonFromS3(...args),
  writeJsonToS3: (...args: unknown[]) => mockWriteJsonToS3(...args),
}));

import { handler } from '../lambdas/merge-results/index.js';

describe('MergeResults Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges all pass outputs into a single review', async () => {
    const pass1: ReviewOutput = {
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      passType: 'structural',
      passNumber: 1,
      comments: [
        { filePath: 'a.ts', lineNumber: 1, codeSnippet: 'x', severity: 'warning', category: 'structural', message: 'issue 1', confidence: 0.8 },
      ],
      summary: 'Structural pass done',
      modelId: 'test-model',
      tokensUsed: { input: 100, output: 50, total: 150 },
      durationMs: 500,
      completedAt: '2026-02-07T00:00:00Z',
    };

    const pass2: ReviewOutput = {
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      passType: 'logic',
      passNumber: 2,
      comments: [
        { filePath: 'b.ts', lineNumber: 5, codeSnippet: 'y', severity: 'critical', category: 'logic', message: 'issue 2', confidence: 0.9 },
        { filePath: 'b.ts', lineNumber: 10, codeSnippet: 'z', severity: 'suggestion', category: 'logic', message: 'issue 3', confidence: 0.6 },
      ],
      summary: 'Logic pass done',
      modelId: 'test-model',
      tokensUsed: { input: 200, output: 100, total: 300 },
      durationMs: 1000,
      completedAt: '2026-02-07T00:00:01Z',
    };

    // Setup: two parallel branch results, each with different pass artifact keys
    const branch1: StepFunctionPayload = {
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      bucket: 'test-bucket',
      artifacts: {
        input: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/input.json',
        pass1: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/pass-1.json',
      },
      repository: { owner: 'o', name: 'r', fullName: 'o/r' },
      pullRequest: { number: 1, headSha: 'abc' },
      status: 'reviewing',
    };

    const branch2: StepFunctionPayload = {
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      bucket: 'test-bucket',
      artifacts: {
        input: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/input.json',
        pass2: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/pass-2.json',
      },
      repository: { owner: 'o', name: 'r', fullName: 'o/r' },
      pullRequest: { number: 1, headSha: 'abc' },
      status: 'reviewing',
    };

    mockReadJsonFromS3
      .mockResolvedValueOnce(pass1) // pass-1.json
      .mockResolvedValueOnce(pass2); // pass-2.json

    const result = await handler([branch1, branch2]);

    // Merged artifacts should include both pass keys
    expect(result.artifacts.pass1).toBe('packets/01KGXNNHSAEQ2QXEBFES362MWR/pass-1.json');
    expect(result.artifacts.pass2).toBe('packets/01KGXNNHSAEQ2QXEBFES362MWR/pass-2.json');
    expect(result.artifacts.mergedReview).toBe('packets/01KGXNNHSAEQ2QXEBFES362MWR/merged-review.json');

    // Check written merged review
    const writtenData = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenData.comments).toHaveLength(3);
    expect(writtenData.totalTokens).toEqual({ input: 300, output: 150, total: 450 });
    expect(writtenData.totalDurationMs).toBe(1500);
    expect(writtenData.passOutputs).toHaveLength(2);
  });

  it('handles empty comments from all passes', async () => {
    const emptyPass: ReviewOutput = {
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      passType: 'structural',
      passNumber: 1,
      comments: [],
      summary: 'No issues',
      modelId: 'test',
      tokensUsed: { input: 50, output: 10, total: 60 },
      durationMs: 200,
      completedAt: '2026-02-07T00:00:00Z',
    };

    const branch: StepFunctionPayload = {
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      bucket: 'test-bucket',
      artifacts: {
        input: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/input.json',
        pass1: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/pass-1.json',
      },
      repository: { owner: 'o', name: 'r', fullName: 'o/r' },
      pullRequest: { number: 1, headSha: 'abc' },
      status: 'reviewing',
    };

    mockReadJsonFromS3.mockResolvedValueOnce(emptyPass);

    const result = await handler([branch]);

    const writtenData = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenData.comments).toHaveLength(0);
  });
});
