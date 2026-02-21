import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ReviewPacket,
  Repository,
  PullRequest,
  FileChange,
  PacketMetadata,
} from '../types.js';
import { validateReviewPacket } from '../schema-validator/index.js';

function randomId(): string {
  return randomBytes(16).toString('hex').replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    '$1-$2-$3-$4-$5'
  );
}

export interface PacketBuilderInput {
  repository: Repository;
  pullRequest: Omit<PullRequest, 'url'> & { url?: string };
  diff: string;
  commitMessages?: string[];
  files?: FileChange[];
  metadata?: Partial<PacketMetadata>;
  /** Skip JSON schema validation (for Lambda where schemas dir is unavailable) */
  skipValidation?: boolean;
}

/**
 * Build a ReviewPacket from raw inputs.
 * Generates a ULID job ID and validates the result against the JSON schema.
 */
export function buildPacket(input: PacketBuilderInput): ReviewPacket {
  const {
    repository,
    pullRequest,
    diff,
    commitMessages = [],
    files = [],
    metadata,
  } = input;

  const prUrl =
    pullRequest.url ??
    `https://github.com/${repository.fullName}/pull/${pullRequest.number}`;

  const packet: ReviewPacket = {
    jobId: randomUUID(),
    repository,
    pullRequest: {
      ...pullRequest,
      url: prUrl,
    },
    diff,
    commitMessages,
    files,
    createdAt: new Date().toISOString(),
    metadata: {
      webhookEventId: metadata?.webhookEventId ?? randomId(),
      installationId: metadata?.installationId ?? null,
    },
  };

  if (!input.skipValidation) {
    const result = validateReviewPacket(packet);
    if (!result.valid) {
      const errorMsg = result.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ');
      throw new Error(`Invalid review packet: ${errorMsg}`);
    }
  }

  return packet;
}

/**
 * Detect file language from extension.
 */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    rb: 'ruby',
    php: 'php',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    swift: 'swift',
    scala: 'scala',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    json: 'json',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    sql: 'sql',
    md: 'markdown',
    tf: 'terraform',
    hcl: 'hcl',
    proto: 'protobuf',
    graphql: 'graphql',
    gql: 'graphql',
    vue: 'vue',
    svelte: 'svelte',
    dart: 'dart',
    r: 'r',
    lua: 'lua',
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    zig: 'zig',
    nim: 'nim',
    toml: 'toml',
  };

  return ext ? (languageMap[ext] ?? null) : null;
}

/**
 * Build FileChange array from a parsed diff result.
 */
export function buildFileChanges(
  files: Array<{
    path: string;
    previousPath?: string;
    status: string;
    additions: number;
    deletions: number;
  }>
): FileChange[] {
  return files.map((f) => ({
    path: f.path,
    language: detectLanguage(f.path),
    status: f.status as FileChange['status'],
    ...(f.previousPath ? { previousPath: f.previousPath } : {}),
    additions: f.additions,
    deletions: f.deletions,
  }));
}
