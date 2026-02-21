// Core types derived from JSON schemas in /schemas/

export type Severity = 'critical' | 'warning' | 'suggestion' | 'nitpick';
export type PassType = 'structural' | 'logic' | 'style' | 'security';
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type ProviderType = 'openrouter' | 'bedrock';

export interface Repository {
  owner: string;
  name: string;
  fullName: string;
}

export interface PullRequest {
  number: number;
  title: string;
  description?: string | null;
  author: string;
  baseSha: string;
  headSha: string;
  url: string;
}

export interface FileChange {
  path: string;
  language: string | null;
  status: FileStatus;
  previousPath?: string;
  additions?: number;
  deletions?: number;
}

export interface PacketMetadata {
  webhookEventId: string;
  installationId: number | null;
}

export interface ReviewPacket {
  jobId: string;
  repository: Repository;
  pullRequest: PullRequest;
  diff: string;
  commitMessages: string[];
  files: FileChange[];
  createdAt: string;
  metadata: PacketMetadata;
}

export interface ReviewComment {
  filePath: string;
  lineNumber: number;
  endLineNumber?: number;
  codeSnippet: string;
  severity: Severity;
  category: PassType;
  message: string;
  suggestion?: string;
  confidence: number;
}

export interface TokensUsed {
  input: number;
  output: number;
  total: number;
}

export interface ReviewOutput {
  jobId: string;
  passType: PassType;
  passNumber: number;
  comments: ReviewComment[];
  summary: string;
  modelId: string;
  tokensUsed: TokensUsed;
  durationMs: number;
  completedAt: string;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export interface ProviderConfig {
  provider: ProviderType;
  modelId: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  fallbackProvider?: ProviderType;
  region?: string;
  apiKeySecretArn?: string;
  baseUrl?: string;
}

export interface EvidenceMetrics {
  totalComments: number;
  acceptedCount: number;
  rejectedCount: number;
  passRate: number;
}

export interface EvidenceResult {
  accepted: ReviewComment[];
  rejected: Array<{ comment: ReviewComment; reason: string }>;
  metrics: EvidenceMetrics;
}

// Diff parser types
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changes: DiffChange[];
}

export interface DiffChange {
  type: 'add' | 'del' | 'normal';
  content: string;
  lineNumber: number;
  oldLineNumber?: number;
}

export interface ParsedFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: ParsedFile[];
}

// LLM Provider interface
export interface LLMProvider {
  readonly name: string;
  readonly modelId: string;
  readonly maxContextWindow: number;

  review(prompt: string, options: ReviewRequestOptions): Promise<LLMResponse>;
}

export interface ReviewRequestOptions {
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  systemPrompt?: string;
}

export interface LLMResponse {
  content: string;
  modelId: string;
  tokensUsed: TokensUsed;
  durationMs: number;
}

// Pass configuration
export const PASS_CONFIG: Record<PassType, { passNumber: number; temperature: number }> = {
  structural: { passNumber: 1, temperature: 0.1 },
  logic: { passNumber: 2, temperature: 0.2 },
  style: { passNumber: 3, temperature: 0.3 },
  security: { passNumber: 4, temperature: 0.1 },
};

export const PASS_TYPES: PassType[] = ['structural', 'logic', 'style', 'security'];
