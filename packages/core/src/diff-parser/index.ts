import parseDiffModule from 'parse-diff';
import type { ParsedDiff, ParsedFile, DiffHunk, DiffChange, FileStatus } from '../types.js';

const parseDiff = (parseDiffModule as unknown as { default: typeof parseDiffModule }).default ?? parseDiffModule;

export function parsePatch(rawDiff: string): ParsedDiff {
  if (!rawDiff.trim()) {
    return { files: [] };
  }

  const parsed = parseDiff(rawDiff);

  const files: ParsedFile[] = parsed.map((file) => {
    const path = file.to === '/dev/null' ? (file.from ?? '') : (file.to ?? '');
    const previousPath = (file.from && file.from !== file.to && file.from !== '/dev/null') ? file.from : undefined;
    const status = resolveStatus(file);

    const hunks: DiffHunk[] = file.chunks.map((chunk) => {
      const changes: DiffChange[] = chunk.changes.map((change) => {
        if (change.type === 'add') {
          return {
            type: 'add' as const,
            content: change.content,
            lineNumber: change.ln,
          };
        } else if (change.type === 'del') {
          return {
            type: 'del' as const,
            content: change.content,
            lineNumber: change.ln,
          };
        } else {
          // normal
          return {
            type: 'normal' as const,
            content: change.content,
            lineNumber: change.ln2!,
            oldLineNumber: change.ln1,
          };
        }
      });

      return {
        oldStart: chunk.oldStart,
        oldLines: chunk.oldLines,
        newStart: chunk.newStart,
        newLines: chunk.newLines,
        changes,
      };
    });

    return {
      path,
      previousPath,
      status,
      additions: file.additions,
      deletions: file.deletions,
      hunks,
    };
  });

  return { files };
}

function resolveStatus(file: ReturnType<typeof parseDiff>[number]): FileStatus {
  if (file.new) return 'added';
  if (file.deleted) return 'deleted';
  // Detect rename: from and to are both present and different
  if (file.from && file.to && file.from !== '/dev/null' && file.to !== '/dev/null' && file.from !== file.to) {
    return 'renamed';
  }
  return 'modified';
}

/**
 * Get the content of a specific line in the new version of a file from the diff.
 * Returns null if the line is not present in the diff hunks.
 */
export function getLineContent(file: ParsedFile, lineNumber: number): string | null {
  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== 'del' && change.lineNumber === lineNumber) {
        // Strip the leading +/- / space prefix from content
        return change.content.replace(/^[+ ]/, '');
      }
    }
  }
  return null;
}

/**
 * Get a range of line contents from the diff (inclusive).
 * Returns the concatenated content of lines in [startLine, endLine].
 */
export function getLineRange(file: ParsedFile, startLine: number, endLine: number): string | null {
  const lines: string[] = [];
  for (let ln = startLine; ln <= endLine; ln++) {
    const content = getLineContent(file, ln);
    if (content !== null) {
      lines.push(content);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Check if a given line number falls within any hunk range for the new file version.
 */
export function isLineInHunk(file: ParsedFile, lineNumber: number): boolean {
  for (const hunk of file.hunks) {
    const hunkEnd = hunk.newStart + hunk.newLines - 1;
    if (lineNumber >= hunk.newStart && lineNumber <= hunkEnd) {
      return true;
    }
  }
  return false;
}

/**
 * Find a ParsedFile by path in a ParsedDiff.
 */
export function findFile(diff: ParsedDiff, filePath: string): ParsedFile | undefined {
  return diff.files.find(
    (f) => f.path === filePath || f.previousPath === filePath
  );
}
