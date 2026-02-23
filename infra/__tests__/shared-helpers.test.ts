import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('S3 Helpers', () => {
  // Use vi.hoisted to create mock functions that are available during vi.mock hoisting
  const mockSend = vi.hoisted(() => vi.fn());

  vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: vi.fn(() => ({ send: mockSend })),
    GetObjectCommand: vi.fn((params: unknown) => params),
    PutObjectCommand: vi.fn((params: unknown) => params),
  }));

  beforeEach(() => {
    mockSend.mockReset();
  });

  it('readJsonFromS3 parses JSON response', async () => {
    const { readJsonFromS3 } = await import('../lambdas/shared/s3-helpers.js');

    mockSend.mockResolvedValueOnce({
      Body: {
        transformToString: () => Promise.resolve('{"key": "value", "num": 42}'),
      },
    });

    const result = await readJsonFromS3<{ key: string; num: number }>('bucket', 'key.json');
    expect(result).toEqual({ key: 'value', num: 42 });
  });

  it('readJsonFromS3 throws on empty body', async () => {
    const { readJsonFromS3 } = await import('../lambdas/shared/s3-helpers.js');

    mockSend.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve('') },
    });

    await expect(readJsonFromS3('bucket', 'key.json')).rejects.toThrow('Empty S3 object');
  });

  it('writeJsonToS3 sends correct PutObject', async () => {
    const { writeJsonToS3 } = await import('../lambdas/shared/s3-helpers.js');

    mockSend.mockResolvedValueOnce({});

    await writeJsonToS3('my-bucket', 'path/to/file.json', { hello: 'world' });

    expect(mockSend).toHaveBeenCalledOnce();
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.Bucket).toBe('my-bucket');
    expect(cmd.Key).toBe('path/to/file.json');
    expect(cmd.ContentType).toBe('application/json');
    expect(JSON.parse(cmd.Body)).toEqual({ hello: 'world' });
  });

  it('readTextFromS3 returns raw text', async () => {
    const { readTextFromS3 } = await import('../lambdas/shared/s3-helpers.js');

    mockSend.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve('raw diff content here') },
    });

    const result = await readTextFromS3('bucket', 'diff.txt');
    expect(result).toBe('raw diff content here');
  });
});

describe('DynamoDB Helpers', () => {
  const mockDdbSend = vi.hoisted(() => vi.fn());

  vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: vi.fn(() => ({})),
  }));

  vi.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: {
      from: vi.fn(() => ({ send: mockDdbSend })),
    },
    PutCommand: vi.fn((params: unknown) => params),
    UpdateCommand: vi.fn((params: unknown) => params),
  }));

  beforeEach(() => {
    mockDdbSend.mockReset();
    mockDdbSend.mockResolvedValue({});
  });

  it('createJobRecord sends PutCommand with condition', async () => {
    const { createJobRecord } = await import('../lambdas/shared/dynamo-helpers.js');

    const record = {
      jobId: 'test-id',
      status: 'pending',
      repository: 'owner/repo',
      prNumber: 1,
      prUrl: 'https://github.com/owner/repo/pull/1',
      createdAt: '2026-02-07T00:00:00Z',
      updatedAt: '2026-02-07T00:00:00Z',
    };

    await createJobRecord('my-table', record);

    expect(mockDdbSend).toHaveBeenCalledOnce();
    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.TableName).toBe('my-table');
    expect(cmd.Item).toEqual(record);
    expect(cmd.ConditionExpression).toBe('attribute_not_exists(jobId)');
  });

  it('updateJobStatus sends UpdateCommand', async () => {
    const { updateJobStatus } = await import('../lambdas/shared/dynamo-helpers.js');

    await updateJobStatus('my-table', 'job-123', 'processing');

    expect(mockDdbSend).toHaveBeenCalledOnce();
    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.TableName).toBe('my-table');
    expect(cmd.Key).toEqual({ jobId: 'job-123' });
    expect(cmd.ExpressionAttributeValues[':status']).toBe('processing');
  });

  it('updateJobStatus includes extra fields', async () => {
    const { updateJobStatus } = await import('../lambdas/shared/dynamo-helpers.js');

    await updateJobStatus('my-table', 'job-123', 'completed', {
      durationMs: 5000,
      tokensUsed: { input: 100, output: 50, total: 150 },
    });

    const cmd = mockDdbSend.mock.calls[0][0];
    const values = cmd.ExpressionAttributeValues;
    expect(values[':status']).toBe('completed');
    // Extra fields added with :f0, :f1 keys
    const extraValues = Object.entries(values).filter(([k]) => k.startsWith(':f'));
    expect(extraValues.length).toBe(2);
  });

  it('failJob sets status to failed with error', async () => {
    const { failJob } = await import('../lambdas/shared/dynamo-helpers.js');

    await failJob('my-table', 'job-123', 'Something broke');

    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.ExpressionAttributeValues[':status']).toBe('failed');
  });
});
