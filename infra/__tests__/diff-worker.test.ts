import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepFunctionPayload } from '../lambdas/shared/types.js';

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

import { handler } from '../lambdas/diff-worker/index.js';

describe('DiffWorker Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const basePayload: StepFunctionPayload = {
    jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
    bucket: 'test-bucket',
    artifacts: { input: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/input.json' },
    repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
    pullRequest: { number: 1, headSha: 'abc123' },
    status: 'pending',
  };

  it('parses diff from S3 packet and writes parsed diff back', async () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index abc..def 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,4 @@',
      ' import express from "express";',
      '+import cors from "cors";',
      ' const app = express();',
      ' app.listen(3000);',
    ].join('\n');

    mockReadJsonFromS3.mockResolvedValueOnce({
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      diff,
      repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
      pullRequest: { number: 1, title: 'Test', baseSha: 'x', headSha: 'y', author: 'dev', url: 'url' },
      commitMessages: [],
      files: [],
      createdAt: '2026-02-07T00:00:00Z',
      metadata: { webhookEventId: 'e1', installationId: null },
    });

    const result = await handler(basePayload);

    // Check status update was called
    expect(mockUpdateJobStatus).toHaveBeenCalledWith('test-table', '01KGXNNHSAEQ2QXEBFES362MWR', 'processing');

    // Check parsed diff was written to S3
    expect(mockWriteJsonToS3).toHaveBeenCalledWith(
      'test-bucket',
      'packets/01KGXNNHSAEQ2QXEBFES362MWR/parsed-diff.json',
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            path: 'src/app.ts',
            additions: 1,
          }),
        ]),
      })
    );

    // Check returned payload includes the artifact key
    expect(result.artifacts.parsedDiff).toBe('packets/01KGXNNHSAEQ2QXEBFES362MWR/parsed-diff.json');
    expect(result.status).toBe('processing');
  });

  it('handles empty diff gracefully', async () => {
    mockReadJsonFromS3.mockResolvedValueOnce({
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      diff: '',
      repository: { owner: 'o', name: 'r', fullName: 'o/r' },
      pullRequest: { number: 1, title: 'T', baseSha: 'a', headSha: 'b', author: 'u', url: 'u' },
      commitMessages: [],
      files: [],
      createdAt: '2026-02-07T00:00:00Z',
      metadata: { webhookEventId: 'e1', installationId: null },
    });

    const result = await handler(basePayload);
    expect(result.artifacts.parsedDiff).toBeDefined();

    // Should write parsed diff with empty files array
    const writtenData = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenData.files).toEqual([]);
  });
});
