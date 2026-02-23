import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepFunctionPayload } from '../lambdas/shared/types.js';
import type { ParsedDiff } from '@lintellect/core';

// Mock S3 helpers
const mockReadJsonFromS3 = vi.fn();
const mockWriteJsonToS3 = vi.fn().mockResolvedValue(undefined);

vi.mock('../lambdas/shared/s3-helpers.js', () => ({
  readJsonFromS3: (...args: unknown[]) => mockReadJsonFromS3(...args),
  writeJsonToS3: (...args: unknown[]) => mockWriteJsonToS3(...args),
}));

import { handler } from '../lambdas/context-worker/index.js';

describe('ContextWorker Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const basePayload: StepFunctionPayload = {
    jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
    bucket: 'test-bucket',
    artifacts: {
      input: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/input.json',
      parsedDiff: 'packets/01KGXNNHSAEQ2QXEBFES362MWR/parsed-diff.json',
    },
    repository: { owner: 'owner', name: 'repo', fullName: 'owner/repo' },
    pullRequest: { number: 1, headSha: 'abc123' },
    status: 'processing',
  };

  it('gathers context from parsed diff and writes to S3', async () => {
    const parsedDiff: ParsedDiff = {
      files: [
        {
          path: 'src/app.ts',
          status: 'modified',
          additions: 2,
          deletions: 0,
          hunks: [
            {
              oldStart: 1,
              oldLines: 3,
              newStart: 1,
              newLines: 5,
              changes: [
                { type: 'normal', content: 'import express from "express";', lineNumber: 1 },
                { type: 'add', content: 'import cors from "cors";', lineNumber: 2 },
                { type: 'add', content: 'import helmet from "helmet";', lineNumber: 3 },
                { type: 'normal', content: 'const app = express();', lineNumber: 4 },
                { type: 'normal', content: 'app.listen(3000);', lineNumber: 5 },
              ],
            },
          ],
        },
      ],
    };

    mockReadJsonFromS3.mockResolvedValueOnce(parsedDiff);

    const result = await handler(basePayload);

    // Check context was written to S3
    expect(mockWriteJsonToS3).toHaveBeenCalledWith(
      'test-bucket',
      'packets/01KGXNNHSAEQ2QXEBFES362MWR/context.json',
      expect.objectContaining({
        raw: expect.any(Array),
        formatted: expect.any(String),
      })
    );

    // Check the formatted context contains file info
    const writtenData = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenData.formatted).toContain('src/app.ts');

    // Check returned payload
    expect(result.artifacts.context).toBe('packets/01KGXNNHSAEQ2QXEBFES362MWR/context.json');
  });

  it('handles empty diff (no files)', async () => {
    const emptyDiff: ParsedDiff = { files: [] };
    mockReadJsonFromS3.mockResolvedValueOnce(emptyDiff);

    const result = await handler(basePayload);

    expect(result.artifacts.context).toBeDefined();
    const writtenData = mockWriteJsonToS3.mock.calls[0][2];
    expect(writtenData.raw).toEqual([]);
  });

  it('throws when parsedDiff artifact is missing', async () => {
    const badPayload: StepFunctionPayload = {
      ...basePayload,
      artifacts: { input: 'x' },
    };

    await expect(handler(badPayload)).rejects.toThrow('Missing parsedDiff artifact');
  });

  it('excludes deleted files from context', async () => {
    const diffWithDelete: ParsedDiff = {
      files: [
        {
          path: 'src/old.ts',
          status: 'deleted',
          additions: 0,
          deletions: 10,
          hunks: [
            {
              oldStart: 1,
              oldLines: 10,
              newStart: 0,
              newLines: 0,
              changes: Array.from({ length: 10 }, (_, i) => ({
                type: 'del' as const,
                content: `line ${i + 1}`,
                lineNumber: i + 1,
              })),
            },
          ],
        },
        {
          path: 'src/new.ts',
          status: 'added',
          additions: 3,
          deletions: 0,
          hunks: [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 3,
              changes: [
                { type: 'add', content: 'const x = 1;', lineNumber: 1 },
                { type: 'add', content: 'const y = 2;', lineNumber: 2 },
                { type: 'add', content: 'export { x, y };', lineNumber: 3 },
              ],
            },
          ],
        },
      ],
    };

    mockReadJsonFromS3.mockResolvedValueOnce(diffWithDelete);

    const result = await handler(basePayload);

    const writtenData = mockWriteJsonToS3.mock.calls[0][2];
    // Deleted files should be excluded from context
    expect(writtenData.formatted).not.toContain('src/old.ts');
    expect(writtenData.formatted).toContain('src/new.ts');
  });
});
