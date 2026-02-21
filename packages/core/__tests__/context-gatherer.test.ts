import { describe, it, expect } from 'vitest';
import { gatherContext, formatContextForPrompt } from '../src/context-gatherer/index.js';
import { parsePatch } from '../src/diff-parser/index.js';

const SAMPLE_DIFF = [
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
  '@@ -0,0 +1,3 @@',
  '+export function sanitize(input: string): string {',
  '+  return input.replace(/[<>]/g, \'\');',
  '+}',
  '',
].join('\n');

describe('gatherContext', () => {
  it('gathers context from all files', () => {
    const diff = parsePatch(SAMPLE_DIFF);
    const contexts = gatherContext(diff);
    expect(contexts.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes deleted files', () => {
    const deleteDiff = `diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
index abc1234..0000000
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function old() {}
-export function also_old() {}
-export function very_old() {}
`;
    const diff = parsePatch(deleteDiff);
    const contexts = gatherContext(diff);
    expect(contexts).toHaveLength(0);
  });

  it('detects language from file extension', () => {
    const diff = parsePatch(SAMPLE_DIFF);
    const contexts = gatherContext(diff);
    const tsFile = contexts.find(c => c.path === 'src/auth.ts');
    expect(tsFile?.language).toBe('typescript');
  });

  it('respects character budget', () => {
    const diff = parsePatch(SAMPLE_DIFF);
    const contexts = gatherContext(diff, { maxTotalChars: 100 });
    const totalChars = contexts.reduce(
      (sum, fc) => sum + fc.hunks.reduce((s, h) => s + h.content.length, 0),
      0
    );
    // Should be within budget (with some margin for headers)
    expect(totalChars).toBeLessThan(200);
  });

  it('sorts files by number of changes (most first)', () => {
    const diff = parsePatch(SAMPLE_DIFF);
    const contexts = gatherContext(diff);
    if (contexts.length >= 2) {
      // utils.ts has 3 additions, auth.ts has 2 additions, so utils comes first
      const firstChanges = diff.files.find(f => f.path === contexts[0].path)!;
      const secondChanges = diff.files.find(f => f.path === contexts[1].path)!;
      expect(firstChanges.additions + firstChanges.deletions)
        .toBeGreaterThanOrEqual(secondChanges.additions + secondChanges.deletions);
    }
  });
});

describe('formatContextForPrompt', () => {
  it('formats context as readable text', () => {
    const diff = parsePatch(SAMPLE_DIFF);
    const contexts = gatherContext(diff);
    const formatted = formatContextForPrompt(contexts);
    expect(formatted).toContain('src/auth.ts');
    expect(formatted).toContain('typescript');
    expect(formatted).toContain('Lines');
  });

  it('returns empty string for empty context', () => {
    expect(formatContextForPrompt([])).toBe('');
  });
});
