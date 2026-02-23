import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

// Mock AWS services
vi.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: vi.fn(() => ({ send: vi.fn() })),
  StartExecutionCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ SecretString: 'test-secret' }),
  })),
  GetSecretValueCommand: vi.fn(),
}));

vi.mock('../lambdas/shared/s3-helpers.js', () => ({
  writeJsonToS3: vi.fn().mockResolvedValue(undefined),
  readJsonFromS3: vi.fn(),
}));

vi.mock('../lambdas/shared/dynamo-helpers.js', () => ({
  createJobRecord: vi.fn().mockResolvedValue(undefined),
  updateJobStatus: vi.fn().mockResolvedValue(undefined),
}));

// Mock buildPacket
vi.mock('@lintellect/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lintellect/core')>();
  return {
    ...actual,
    buildPacket: vi.fn().mockReturnValue({
      jobId: '01KGXNNHSAEQ2QXEBFES362MWR',
      repository: { owner: 'testowner', name: 'testrepo', fullName: 'testowner/testrepo' },
      pullRequest: { number: 1, title: 'Test PR', baseSha: 'abc', headSha: 'def', author: 'user', url: 'https://github.com/testowner/testrepo/pull/1' },
      diff: 'diff content',
      commitMessages: [],
      files: [],
      createdAt: '2026-02-07T00:00:00.000Z',
      metadata: { webhookEventId: 'test-delivery-id', installationId: null },
    }),
  };
});

// Mock fetch (for diff retrieval)
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Set environment variables
process.env.ARTIFACTS_BUCKET = 'test-bucket';
process.env.JOB_TABLE = 'test-table';
process.env.STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123:stateMachine:test';
process.env.WEBHOOK_SECRET_NAME = 'lintellect/webhook-secret';
process.env.GITHUB_TOKEN_NAME = 'lintellect/github-token';

describe('Webhook Lambda', () => {
  let handler: typeof import('../lambdas/webhook/index.js').handler;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock SFN to return executionArn
    const sfnModule = await import('@aws-sdk/client-sfn');
    const mockSend = vi.fn().mockResolvedValue({ executionArn: 'arn:aws:states:us-east-1:123:execution:test:exec1' });
    (sfnModule.SFNClient as any).mockImplementation(() => ({ send: mockSend }));

    // Re-import handler with fresh mocks
    const mod = await import('../lambdas/webhook/index.js');
    handler = mod.handler;
  });

  function makeWebhookEvent(options: {
    body: string;
    secret?: string;
    ghEvent?: string;
    deliveryId?: string;
  }) {
    const secret = options.secret ?? 'test-secret';
    const signature = 'sha256=' + createHmac('sha256', secret).update(options.body).digest('hex');

    return {
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': options.ghEvent ?? 'pull_request',
        'x-github-delivery': options.deliveryId ?? 'test-delivery-123',
      },
      body: options.body,
    } as any;
  }

  const validPRPayload = JSON.stringify({
    action: 'opened',
    number: 42,
    pull_request: {
      number: 42,
      title: 'Add feature',
      body: 'Description of the feature',
      user: { login: 'dev' },
      base: { sha: 'abc123', ref: 'main' },
      head: { sha: 'def456', ref: 'feature' },
      html_url: 'https://github.com/owner/repo/pull/42',
      diff_url: 'https://github.com/owner/repo/pull/42.diff',
    },
    repository: {
      full_name: 'owner/repo',
      owner: { login: 'owner' },
      name: 'repo',
    },
    installation: { id: 123 },
  });

  it('rejects requests with missing body', async () => {
    const event = { headers: {}, body: undefined } as any;
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('rejects requests with invalid signature', async () => {
    const event = makeWebhookEvent({
      body: validPRPayload,
      secret: 'wrong-secret',
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  it('ignores non-pull_request events', async () => {
    const event = makeWebhookEvent({
      body: '{}',
      ghEvent: 'push',
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string).message).toBe('Ignored event type');
  });

  it('ignores irrelevant PR actions', async () => {
    const event = makeWebhookEvent({
      body: JSON.stringify({ action: 'closed' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string).message).toBe('Ignored PR action');
  });

  it('processes valid PR webhook and returns 202', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('diff content here'),
    });

    const event = makeWebhookEvent({ body: validPRPayload });
    const result = await handler(event);
    expect(result.statusCode).toBe(202);

    const body = JSON.parse(result.body as string);
    expect(body.jobId).toBeDefined();
    expect(body.message).toBe('Review pipeline started');
  });

  it('returns 502 when diff fetch fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const event = makeWebhookEvent({ body: validPRPayload });
    const result = await handler(event);
    expect(result.statusCode).toBe(502);
  });
});
