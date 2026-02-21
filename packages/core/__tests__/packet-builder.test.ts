import { describe, it, expect } from 'vitest';
import { buildPacket, detectLanguage, buildFileChanges } from '../src/packet-builder/index.js';

describe('buildPacket', () => {
  it('builds a valid review packet with UUID job ID', () => {
    const packet = buildPacket({
      repository: {
        owner: 'acme',
        name: 'backend',
        fullName: 'acme/backend',
      },
      pullRequest: {
        number: 42,
        title: 'Fix auth bug',
        description: 'Fixes null token handling',
        author: 'dev1',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
      },
      diff: 'diff --git a/file.ts b/file.ts\n',
      commitMessages: ['Fix null check'],
      files: [
        { path: 'src/auth.ts', language: 'typescript', status: 'modified', additions: 5, deletions: 2 },
      ],
    });

    expect(packet.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(packet.repository.owner).toBe('acme');
    expect(packet.pullRequest.number).toBe(42);
    expect(packet.pullRequest.url).toBe('https://github.com/acme/backend/pull/42');
    expect(packet.createdAt).toBeDefined();
    expect(packet.metadata.webhookEventId).toBeDefined();
  });

  it('uses provided URL if given', () => {
    const packet = buildPacket({
      repository: { owner: 'o', name: 'r', fullName: 'o/r' },
      pullRequest: {
        number: 1,
        title: 'Test',
        author: 'a',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        url: 'https://github.com/custom/url/pull/99',
      },
      diff: 'diff',
    });
    expect(packet.pullRequest.url).toBe('https://github.com/custom/url/pull/99');
  });

  it('uses provided metadata', () => {
    const packet = buildPacket({
      repository: { owner: 'o', name: 'r', fullName: 'o/r' },
      pullRequest: {
        number: 1,
        title: 'Test',
        author: 'a',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
      },
      diff: 'diff',
      metadata: {
        webhookEventId: 'custom-id-123',
        installationId: 42,
      },
    });
    expect(packet.metadata.webhookEventId).toBe('custom-id-123');
    expect(packet.metadata.installationId).toBe(42);
  });

  it('defaults commitMessages to empty array', () => {
    const packet = buildPacket({
      repository: { owner: 'o', name: 'r', fullName: 'o/r' },
      pullRequest: {
        number: 1,
        title: 'Test',
        author: 'a',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
      },
      diff: 'diff',
    });
    expect(packet.commitMessages).toEqual([]);
  });

  it('generates unique job IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const packet = buildPacket({
        repository: { owner: 'o', name: 'r', fullName: 'o/r' },
        pullRequest: {
          number: 1,
          title: 'Test',
          author: 'a',
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
        },
        diff: 'diff',
      });
      ids.add(packet.jobId);
    }
    expect(ids.size).toBe(100);
  });
});

describe('detectLanguage', () => {
  it('detects TypeScript', () => {
    expect(detectLanguage('src/auth.ts')).toBe('typescript');
    expect(detectLanguage('component.tsx')).toBe('typescript');
  });

  it('detects JavaScript', () => {
    expect(detectLanguage('index.js')).toBe('javascript');
    expect(detectLanguage('config.mjs')).toBe('javascript');
  });

  it('detects Python', () => {
    expect(detectLanguage('main.py')).toBe('python');
  });

  it('detects Go', () => {
    expect(detectLanguage('handler.go')).toBe('go');
  });

  it('returns null for unknown extensions', () => {
    expect(detectLanguage('file.xyz')).toBeNull();
  });

  it('returns null for files without extension', () => {
    expect(detectLanguage('Makefile')).toBeNull();
  });

  it('detects common config formats', () => {
    expect(detectLanguage('config.yaml')).toBe('yaml');
    expect(detectLanguage('data.json')).toBe('json');
    expect(detectLanguage('main.tf')).toBe('terraform');
  });
});

describe('buildFileChanges', () => {
  it('builds file changes with language detection', () => {
    const result = buildFileChanges([
      { path: 'src/auth.ts', status: 'modified', additions: 5, deletions: 2 },
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].language).toBe('typescript');
    expect(result[1].language).toBe('markdown');
  });

  it('includes previousPath for renamed files', () => {
    const result = buildFileChanges([
      { path: 'new-name.ts', previousPath: 'old-name.ts', status: 'renamed', additions: 0, deletions: 0 },
    ]);
    expect(result[0].previousPath).toBe('old-name.ts');
  });

  it('omits previousPath for non-renamed files', () => {
    const result = buildFileChanges([
      { path: 'file.ts', status: 'modified', additions: 1, deletions: 0 },
    ]);
    expect(result[0].previousPath).toBeUndefined();
  });
});
