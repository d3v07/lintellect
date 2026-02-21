// Types
export type {
  Severity,
  PassType,
  FileStatus,
  ProviderType,
  Repository,
  PullRequest,
  FileChange,
  PacketMetadata,
  ReviewPacket,
  ReviewComment,
  TokensUsed,
  ReviewOutput,
  RetryPolicy,
  ProviderConfig,
  EvidenceMetrics,
  EvidenceResult,
  DiffHunk,
  DiffChange,
  ParsedFile,
  ParsedDiff,
  LLMProvider,
  ReviewRequestOptions,
  LLMResponse,
} from './types.js';

export { PASS_CONFIG, PASS_TYPES } from './types.js';

// Schema Validator
export {
  validateReviewPacket,
  validateReviewOutput,
  validateReviewComment,
  validateProviderConfig,
  validateJobStatus,
  validateSchema,
} from './schema-validator/index.js';
export type { ValidationResult, ValidationError } from './schema-validator/index.js';

// Diff Parser
export {
  parsePatch,
  getLineContent,
  getLineRange,
  isLineInHunk,
  findFile,
} from './diff-parser/index.js';

// Packet Builder
export {
  buildPacket,
  detectLanguage,
  buildFileChanges,
} from './packet-builder/index.js';
export type { PacketBuilderInput } from './packet-builder/index.js';

// Evidence Validator
export {
  validateEvidence,
  normalizeWhitespace,
} from './evidence-validator/index.js';
export type { EvidenceValidatorOptions } from './evidence-validator/index.js';

// Context Gatherer
export {
  gatherContext,
  formatContextForPrompt,
} from './context-gatherer/index.js';
export type { ContextOptions, FileContext, HunkContext } from './context-gatherer/index.js';

// Prompt Runner
export { runReview, parseJsonResponse } from './prompt-runner/index.js';
export type { PromptRunnerOptions, RunResult } from './prompt-runner/index.js';

// Prompt Builders (used by Lambda review-worker)
export { buildSystemPrompt, buildUserPrompt } from './prompt-runner/prompts.js';
