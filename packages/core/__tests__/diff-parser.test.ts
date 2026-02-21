import { describe, it, expect } from 'vitest';
import { parsePatch, getLineContent, getLineRange, isLineInHunk, findFile } from '../src/diff-parser/index.js';

// Use string concatenation to ensure precise control of leading spaces on empty context lines
const SAMPLE_DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index abc1234..def5678 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,5 +10,7 @@ export function authenticate(req: Request) {',
  '   const header = req.headers.authorization;',
  '   if (!header) return null;',
  '+  const token = header.replace(\'Bearer \', \'\');',
  '+  if (!token.trim()) return null;',
  '   return header.split(\' \')[1];',
  ' }',
  '',
].join('\n');

const MULTI_FILE_DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index abc1234..def5678 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,4 +10,6 @@ export function authenticate(req: Request) {',
  '   const header = req.headers.authorization;',
  '   if (!header) return null;',
  '+  const token = header.replace(\'Bearer \', \'\');',
  '+  if (!token.trim()) return null;',
  '   return header.split(\' \')[1];',
  ' }',
  'diff --git a/src/utils.ts b/src/utils.ts',
  'new file mode 100644',
  'index 0000000..abc1234',
  '--- /dev/null',
  '+++ b/src/utils.ts',
  '@@ -0,0 +1,4 @@',
  '+export function isValidToken(token: string): boolean {',
  '+  if (!token) return false;',
  '+  return token.length > 10;',
  '+}',
  '',
].join('\n');

const DELETE_DIFF = [
  'diff --git a/src/old-file.ts b/src/old-file.ts',
  'deleted file mode 100644',
  'index abc1234..0000000',
  '--- a/src/old-file.ts',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-export function oldFunction() {',
  '-  return \'deprecated\';',
  '-}',
  '',
].join('\n');

describe('parsePatch', () => {
  it('parses a simple diff with additions', () => {
    const result = parsePatch(SAMPLE_DIFF);
    expect(result.files).toHaveLength(1);

    const file = result.files[0];
    expect(file.path).toBe('src/auth.ts');
    expect(file.status).toBe('modified');
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
    expect(file.hunks).toHaveLength(1);
  });

  it('parses multiple files', () => {
    const result = parsePatch(MULTI_FILE_DIFF);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].path).toBe('src/auth.ts');
    expect(result.files[1].path).toBe('src/utils.ts');
  });

  it('detects new files', () => {
    const result = parsePatch(MULTI_FILE_DIFF);
    const newFile = result.files.find(f => f.path === 'src/utils.ts');
    expect(newFile).toBeDefined();
    expect(newFile!.status).toBe('added');
  });

  it('detects deleted files', () => {
    const result = parsePatch(DELETE_DIFF);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe('deleted');
  });

  it('returns empty for empty diff', () => {
    expect(parsePatch('').files).toHaveLength(0);
    expect(parsePatch('   ').files).toHaveLength(0);
  });

  it('parses hunk line ranges correctly', () => {
    const result = parsePatch(SAMPLE_DIFF);
    const hunk = result.files[0].hunks[0];
    expect(hunk.newStart).toBe(10);
    expect(hunk.changes.length).toBeGreaterThan(0);
  });

  it('classifies change types correctly', () => {
    const result = parsePatch(SAMPLE_DIFF);
    const changes = result.files[0].hunks[0].changes;
    const addChanges = changes.filter(c => c.type === 'add');
    const normalChanges = changes.filter(c => c.type === 'normal');
    expect(addChanges.length).toBe(2);
    expect(normalChanges.length).toBeGreaterThan(0);
  });
});

describe('getLineContent', () => {
  it('returns content for an added line in the diff', () => {
    const result = parsePatch(SAMPLE_DIFF);
    const file = result.files[0];
    const addedChanges = file.hunks[0].changes.filter(c => c.type === 'add');
    const firstAddedLine = addedChanges[0].lineNumber;
    const content = getLineContent(file, firstAddedLine);
    expect(content).toBeDefined();
    expect(content).toContain('token');
  });

  it('returns null for lines not in diff', () => {
    const result = parsePatch(SAMPLE_DIFF);
    const file = result.files[0];
    expect(getLineContent(file, 999)).toBeNull();
  });
});

describe('getLineRange', () => {
  it('returns concatenated content for a range', () => {
    const result = parsePatch(MULTI_FILE_DIFF);
    const newFile = result.files.find(f => f.path === 'src/utils.ts');
    expect(newFile).toBeDefined();
    const content = getLineRange(newFile!, 1, 3);
    expect(content).toBeDefined();
    expect(content).toContain('isValidToken');
  });

  it('returns null for out-of-range lines', () => {
    const result = parsePatch(SAMPLE_DIFF);
    expect(getLineRange(result.files[0], 500, 510)).toBeNull();
  });
});

describe('isLineInHunk', () => {
  it('returns true for lines within hunk range', () => {
    const result = parsePatch(SAMPLE_DIFF);
    const file = result.files[0];
    const hunk = file.hunks[0];
    expect(isLineInHunk(file, hunk.newStart)).toBe(true);
  });

  it('returns false for lines outside hunk range', () => {
    const result = parsePatch(SAMPLE_DIFF);
    expect(isLineInHunk(result.files[0], 999)).toBe(false);
  });
});

describe('findFile', () => {
  it('finds a file by path', () => {
    const result = parsePatch(MULTI_FILE_DIFF);
    const file = findFile(result, 'src/auth.ts');
    expect(file).toBeDefined();
    expect(file!.path).toBe('src/auth.ts');
  });

  it('returns undefined for missing file', () => {
    const result = parsePatch(MULTI_FILE_DIFF);
    expect(findFile(result, 'nonexistent.ts')).toBeUndefined();
  });
});
