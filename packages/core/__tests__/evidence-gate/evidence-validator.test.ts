import { describe, it, expect } from 'vitest';
import { validateEvidence, normalizeWhitespace } from '../../src/evidence-validator/index.js';
import { parsePatch } from '../../src/diff-parser/index.js';
import type { ReviewComment } from '../../src/types.js';

const SAMPLE_DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index abc1234..def5678 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,4 +10,7 @@ export function authenticate(req: Request) {',
  '   const header = req.headers.authorization;',
  '   if (!header) return null;',
  '+  const token = header.replace(\'Bearer \', \'\');',
  '+  if (!token.trim()) return null;',
  '+  if (token.length > 10000) throw new Error(\'Token too long\');',
  '   return header.split(\' \')[1];',
  ' }',
  'diff --git a/src/utils.ts b/src/utils.ts',
  'new file mode 100644',
  'index 0000000..abc1234',
  '--- /dev/null',
  '+++ b/src/utils.ts',
  '@@ -0,0 +1,3 @@',
  '+export function sanitize(input: string): string {',
  '+  return input.replace(/[<>]/g, \'\');',
  '+}',
  '',
].join('\n');

const diff = parsePatch(SAMPLE_DIFF);

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  // Find the first added line to use as defaults
  const file = diff.files[0];
  const addedChange = file.hunks[0].changes.find(c => c.type === 'add')!;

  return {
    filePath: 'src/auth.ts',
    lineNumber: addedChange.lineNumber,
    codeSnippet: addedChange.content.replace(/^[+]/, ''),
    severity: 'warning',
    category: 'logic',
    message: 'Test comment',
    confidence: 0.85,
    ...overrides,
  };
}

describe('validateEvidence', () => {
  it('accepts a valid comment with correct file, line, and snippet', () => {
    const comment = makeComment();
    const result = validateEvidence([comment], diff);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.metrics.passRate).toBe(1.0);
  });

  it('rejects comment with non-existent file', () => {
    const comment = makeComment({ filePath: 'nonexistent.ts' });
    const result = validateEvidence([comment], diff);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('not found in diff');
  });

  it('rejects comment with line outside hunk range', () => {
    const comment = makeComment({ lineNumber: 999 });
    const result = validateEvidence([comment], diff);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('not within any diff hunk');
  });

  it('rejects comment with non-matching snippet', () => {
    const comment = makeComment({
      codeSnippet: 'this code does not exist in the diff at all xyz123',
    });
    const result = validateEvidence([comment], diff);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('does not match');
  });

  it('rejects comment with confidence below threshold', () => {
    const comment = makeComment({ confidence: 0.1 });
    const result = validateEvidence([comment], diff, { confidenceThreshold: 0.3 });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('Confidence');
  });

  it('accepts comment at confidence threshold', () => {
    const comment = makeComment({ confidence: 0.3 });
    const result = validateEvidence([comment], diff, { confidenceThreshold: 0.3 });
    expect(result.accepted).toHaveLength(1);
  });

  it('handles empty comments array', () => {
    const result = validateEvidence([], diff);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.metrics.passRate).toBe(1.0);
    expect(result.metrics.totalComments).toBe(0);
  });

  it('accepts comments from newly added files', () => {
    const utilsFile = diff.files.find(f => f.path === 'src/utils.ts');
    expect(utilsFile).toBeDefined();
    const firstChange = utilsFile!.hunks[0].changes[0];
    const comment = makeComment({
      filePath: 'src/utils.ts',
      lineNumber: firstChange.lineNumber,
      codeSnippet: firstChange.content.replace(/^\+/, ''),
    });
    const result = validateEvidence([comment], diff);
    expect(result.accepted).toHaveLength(1);
  });

  it('calculates metrics correctly with mixed results', () => {
    const valid = makeComment();
    const invalid = makeComment({ filePath: 'nonexistent.ts' });
    const result = validateEvidence([valid, invalid], diff);

    expect(result.metrics.totalComments).toBe(2);
    expect(result.metrics.acceptedCount).toBe(1);
    expect(result.metrics.rejectedCount).toBe(1);
    expect(result.metrics.passRate).toBe(0.5);
  });

  it('validates endLineNumber is in hunk range', () => {
    const comment = makeComment({ endLineNumber: 999 });
    const result = validateEvidence([comment], diff);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('End line');
  });

  it('rejects endLineNumber less than lineNumber', () => {
    const addedChanges = diff.files[0].hunks[0].changes.filter(c => c.type === 'add');
    const comment = makeComment({
      lineNumber: addedChanges[1].lineNumber,
      endLineNumber: addedChanges[0].lineNumber,
    });
    const result = validateEvidence([comment], diff);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('less than lineNumber');
  });

  it('allows disabling strict snippet matching', () => {
    const comment = makeComment({ codeSnippet: 'any random content' });
    const result = validateEvidence([comment], diff, { strictSnippetMatch: false });
    expect(result.accepted).toHaveLength(1);
  });
});

describe('normalizeWhitespace', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeWhitespace('  hello   world  ')).toBe('hello world');
  });

  it('normalizes line endings', () => {
    expect(normalizeWhitespace('line1\r\nline2')).toBe('line1 line2');
  });

  it('handles empty string', () => {
    expect(normalizeWhitespace('')).toBe('');
  });

  it('handles tabs and mixed whitespace', () => {
    expect(normalizeWhitespace('\t  foo\t\tbar  ')).toBe('foo bar');
  });
});
