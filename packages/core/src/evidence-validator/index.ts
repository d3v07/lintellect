import type {
  ReviewComment,
  ParsedDiff,
  ParsedFile,
  EvidenceResult,
  EvidenceMetrics,
} from '../types.js';
import { findFile, isLineInHunk, getLineContent, getLineRange } from '../diff-parser/index.js';

export interface EvidenceValidatorOptions {
  /** Minimum confidence threshold. Comments below this are rejected. Default: 0.3 */
  confidenceThreshold?: number;
  /** Enable strict snippet matching (exact match after whitespace normalization). Default: true */
  strictSnippetMatch?: boolean;
}

const DEFAULT_OPTIONS: Required<EvidenceValidatorOptions> = {
  confidenceThreshold: 0.3,
  strictSnippetMatch: true,
};

/**
 * Validate an array of ReviewComments against a ParsedDiff.
 * Each comment must cite:
 *   1. A filePath that exists in the diff
 *   2. A lineNumber within a diff hunk range
 *   3. A codeSnippet that matches the actual code at that line (whitespace-normalized)
 *
 * Returns accepted/rejected arrays with rejection reasons and metrics.
 */
export function validateEvidence(
  comments: ReviewComment[],
  diff: ParsedDiff,
  options?: EvidenceValidatorOptions
): EvidenceResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const accepted: ReviewComment[] = [];
  const rejected: Array<{ comment: ReviewComment; reason: string }> = [];

  for (const comment of comments) {
    const reason = checkComment(comment, diff, opts);
    if (reason) {
      rejected.push({ comment, reason });
    } else {
      accepted.push(comment);
    }
  }

  const total = comments.length;
  const metrics: EvidenceMetrics = {
    totalComments: total,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    passRate: total === 0 ? 1.0 : accepted.length / total,
  };

  return { accepted, rejected, metrics };
}

/**
 * Check a single comment against the diff.
 * Returns null if valid, or a rejection reason string.
 */
function checkComment(
  comment: ReviewComment,
  diff: ParsedDiff,
  opts: Required<EvidenceValidatorOptions>
): string | null {
  // Check confidence threshold
  if (comment.confidence < opts.confidenceThreshold) {
    return `Confidence ${comment.confidence} below threshold ${opts.confidenceThreshold}`;
  }

  // Check file exists in diff
  const file = findFile(diff, comment.filePath);
  if (!file) {
    return `File "${comment.filePath}" not found in diff. Available files: ${diff.files.map((f) => f.path).join(', ')}`;
  }

  // Check line number is in a hunk
  if (!isLineInHunk(file, comment.lineNumber)) {
    return `Line ${comment.lineNumber} is not within any diff hunk for "${comment.filePath}"`;
  }

  // Check endLineNumber if present
  if (comment.endLineNumber !== undefined) {
    if (comment.endLineNumber < comment.lineNumber) {
      return `endLineNumber (${comment.endLineNumber}) is less than lineNumber (${comment.lineNumber})`;
    }
    if (!isLineInHunk(file, comment.endLineNumber)) {
      return `End line ${comment.endLineNumber} is not within any diff hunk for "${comment.filePath}"`;
    }
  }

  // Check code snippet matches
  if (opts.strictSnippetMatch) {
    const snippetMatch = matchSnippet(comment, file);
    if (!snippetMatch) {
      return `Code snippet does not match diff content at line ${comment.lineNumber} in "${comment.filePath}"`;
    }
  }

  return null;
}

/**
 * Whitespace-normalized snippet matching.
 * Checks if the cited codeSnippet appears in the diff at the cited line(s).
 */
function matchSnippet(comment: ReviewComment, file: ParsedFile): boolean {
  const normalizedSnippet = normalizeWhitespace(comment.codeSnippet);
  if (!normalizedSnippet) return false;

  const endLine = comment.endLineNumber ?? comment.lineNumber;

  // Get the actual content from the diff for the cited line range
  const actualContent = getLineRange(file, comment.lineNumber, endLine);
  if (actualContent === null) {
    // Try individual line
    const singleLine = getLineContent(file, comment.lineNumber);
    if (singleLine === null) return false;
    return normalizeWhitespace(singleLine).includes(normalizedSnippet) ||
           normalizedSnippet.includes(normalizeWhitespace(singleLine));
  }

  const normalizedActual = normalizeWhitespace(actualContent);

  // Check if snippet is contained in the actual code or vice versa
  return (
    normalizedActual.includes(normalizedSnippet) ||
    normalizedSnippet.includes(normalizedActual)
  );
}

/**
 * Normalize whitespace for comparison:
 * - Trim leading/trailing whitespace
 * - Collapse multiple spaces/tabs to single space
 * - Normalize line endings
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export { normalizeWhitespace };
