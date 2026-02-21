import { describe, it, expect } from 'vitest';
import {
  validateReviewPacket,
  validateReviewComment,
  validateReviewOutput,
  validateProviderConfig,
  validateJobStatus,
} from '../src/schema-validator/index.js';

const VALID_REVIEW_COMMENT = {
  filePath: 'src/auth.ts',
  lineNumber: 42,
  codeSnippet: 'if (token == null) return;',
  severity: 'warning',
  category: 'logic',
  message: 'Use === instead of == for null check.',
  confidence: 0.85,
};

const VALID_REVIEW_PACKET = {
  jobId: '550e8400-e29b-41d4-a716-446655440001',
  repository: {
    owner: 'acme',
    name: 'backend',
    fullName: 'acme/backend',
  },
  pullRequest: {
    number: 42,
    title: 'Fix auth bug',
    description: null,
    author: 'dev1',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    url: 'https://github.com/acme/backend/pull/42',
  },
  diff: 'diff --git a/src/auth.ts b/src/auth.ts\n',
  commitMessages: ['Fix null check'],
  files: [
    {
      path: 'src/auth.ts',
      language: 'typescript',
      status: 'modified',
      additions: 5,
      deletions: 2,
    },
  ],
  createdAt: '2026-02-07T10:00:00.000Z',
  metadata: {
    webhookEventId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
    installationId: null,
  },
};

const VALID_REVIEW_OUTPUT = {
  jobId: '550e8400-e29b-41d4-a716-446655440001',
  passType: 'logic',
  passNumber: 2,
  comments: [VALID_REVIEW_COMMENT],
  summary: 'Found one potential null reference issue.',
  modelId: 'claude-sonnet-4-20250514',
  tokensUsed: { input: 3800, output: 420, total: 4220 },
  durationMs: 4500,
  completedAt: '2026-02-07T10:05:30.000Z',
};

const VALID_PROVIDER_CONFIG = {
  provider: 'openrouter',
  modelId: 'anthropic/claude-sonnet-4-20250514',
  temperature: 0.2,
  maxOutputTokens: 4096,
  timeoutMs: 60000,
  retryPolicy: {
    maxRetries: 3,
    baseDelayMs: 2000,
    maxDelayMs: 16000,
    jitter: true,
  },
};

const VALID_JOB_STATUS = {
  jobId: '550e8400-e29b-41d4-a716-446655440001',
  status: 'RUNNING_REVIEW',
  prUrl: 'https://github.com/acme/backend/pull/42',
  repoFullName: 'acme/backend',
  prNumber: 42,
  headSha: 'b'.repeat(40),
  baseSha: 'a'.repeat(40),
  author: 'dev1',
  createdAt: '2026-02-07T10:00:00.000Z',
  updatedAt: '2026-02-07T10:03:00.000Z',
};

describe('validateReviewComment', () => {
  it('validates a correct review comment', () => {
    const result = validateReviewComment(VALID_REVIEW_COMMENT);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing required fields', () => {
    const result = validateReviewComment({ filePath: 'test.ts' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid severity', () => {
    const result = validateReviewComment({
      ...VALID_REVIEW_COMMENT,
      severity: 'invalid',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects confidence out of range', () => {
    const result = validateReviewComment({
      ...VALID_REVIEW_COMMENT,
      confidence: 1.5,
    });
    expect(result.valid).toBe(false);
  });

  it('allows optional endLineNumber', () => {
    const result = validateReviewComment({
      ...VALID_REVIEW_COMMENT,
      endLineNumber: 45,
    });
    expect(result.valid).toBe(true);
  });

  it('allows optional suggestion', () => {
    const result = validateReviewComment({
      ...VALID_REVIEW_COMMENT,
      suggestion: 'Use === null instead',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects additional properties', () => {
    const result = validateReviewComment({
      ...VALID_REVIEW_COMMENT,
      extraField: 'not allowed',
    });
    expect(result.valid).toBe(false);
  });
});

describe('validateReviewPacket', () => {
  it('validates a correct review packet', () => {
    const result = validateReviewPacket(VALID_REVIEW_PACKET);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid jobId format', () => {
    const result = validateReviewPacket({
      ...VALID_REVIEW_PACKET,
      jobId: 'not-a-uuid',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid SHA format', () => {
    const result = validateReviewPacket({
      ...VALID_REVIEW_PACKET,
      pullRequest: { ...VALID_REVIEW_PACKET.pullRequest, baseSha: 'short' },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = validateReviewPacket({ jobId: '550e8400-e29b-41d4-a716-446655440001' });
    expect(result.valid).toBe(false);
  });

  it('validates file status enum', () => {
    const result = validateReviewPacket({
      ...VALID_REVIEW_PACKET,
      files: [{ ...VALID_REVIEW_PACKET.files[0], status: 'invalid' }],
    });
    expect(result.valid).toBe(false);
  });
});

describe('validateReviewOutput', () => {
  it('validates a correct review output', () => {
    const result = validateReviewOutput(VALID_REVIEW_OUTPUT);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid passType', () => {
    const result = validateReviewOutput({
      ...VALID_REVIEW_OUTPUT,
      passType: 'unknown',
    });
    expect(result.valid).toBe(false);
  });

  it('accepts empty comments array', () => {
    const result = validateReviewOutput({
      ...VALID_REVIEW_OUTPUT,
      comments: [],
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateProviderConfig', () => {
  it('validates a correct provider config', () => {
    const result = validateProviderConfig(VALID_PROVIDER_CONFIG);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid provider', () => {
    const result = validateProviderConfig({
      ...VALID_PROVIDER_CONFIG,
      provider: 'unknown-provider',
    });
    expect(result.valid).toBe(false);
  });

  it('requires region for bedrock provider', () => {
    const result = validateProviderConfig({
      ...VALID_PROVIDER_CONFIG,
      provider: 'bedrock',
    });
    expect(result.valid).toBe(false);
  });

  it('validates bedrock with region', () => {
    const result = validateProviderConfig({
      ...VALID_PROVIDER_CONFIG,
      provider: 'bedrock',
      region: 'us-east-1',
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateJobStatus', () => {
  it('validates a correct job status', () => {
    const result = validateJobStatus(VALID_JOB_STATUS);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid status enum', () => {
    const result = validateJobStatus({
      ...VALID_JOB_STATUS,
      status: 'INVALID_STATUS',
    });
    expect(result.valid).toBe(false);
  });

  it('accepts optional evidence metrics', () => {
    const result = validateJobStatus({
      ...VALID_JOB_STATUS,
      evidenceMetrics: {
        totalComments: 12,
        acceptedCount: 10,
        rejectedCount: 2,
        passRate: 0.833,
      },
    });
    expect(result.valid).toBe(true);
  });
});
