import type { ParsedDiff, ParsedFile, DiffHunk } from '../types.js';

export interface ContextOptions {
  /** Max total characters for context output. Default: 50000 (~12.5k tokens at 4 chars/token) */
  maxTotalChars?: number;
  /** Number of context lines around each hunk to include. Default: 5 */
  contextLines?: number;
}

export interface FileContext {
  path: string;
  language: string | null;
  hunks: HunkContext[];
}

export interface HunkContext {
  startLine: number;
  endLine: number;
  content: string;
}

const DEFAULT_OPTIONS: Required<ContextOptions> = {
  maxTotalChars: 50000,
  contextLines: 5,
};

/**
 * Gather context from a parsed diff for prompt construction.
 * Extracts hunk content with surrounding context lines.
 * Enforces token budget by trimming lower-priority files.
 */
export function gatherContext(
  diff: ParsedDiff,
  options?: ContextOptions
): FileContext[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Build context for each file, sorted by number of changes (most changes first)
  const fileContexts = diff.files
    .filter((f) => f.status !== 'deleted')
    .sort((a, b) => {
      const aChanges = a.additions + a.deletions;
      const bChanges = b.additions + b.deletions;
      return bChanges - aChanges;
    })
    .map((file) => buildFileContext(file, opts.contextLines));

  // Enforce budget
  return enforceCharBudget(fileContexts, opts.maxTotalChars);
}

function buildFileContext(file: ParsedFile, contextLines: number): FileContext {
  const hunks: HunkContext[] = file.hunks.map((hunk) => {
    const content = formatHunk(hunk, contextLines);
    return {
      startLine: Math.max(1, hunk.newStart - contextLines),
      endLine: hunk.newStart + hunk.newLines - 1 + contextLines,
      content,
    };
  });

  return {
    path: file.path,
    language: detectLanguageFromPath(file.path),
    hunks,
  };
}

function formatHunk(hunk: DiffHunk, _contextLines: number): string {
  const lines: string[] = [];
  for (const change of hunk.changes) {
    const prefix = change.type === 'add' ? '+' : change.type === 'del' ? '-' : ' ';
    const ln = change.type === 'del'
      ? `${change.oldLineNumber ?? '?'}`
      : `${change.lineNumber}`;
    lines.push(`${prefix}${ln.padStart(4)}| ${change.content.replace(/^[+ -]/, '')}`);
  }
  return lines.join('\n');
}

/**
 * Enforce character budget by truncating lower-priority files/hunks.
 */
function enforceCharBudget(
  contexts: FileContext[],
  maxChars: number
): FileContext[] {
  let totalChars = 0;
  const result: FileContext[] = [];

  for (const fc of contexts) {
    const fileHeader = `--- ${fc.path} (${fc.language ?? 'unknown'}) ---\n`;
    let fileChars = fileHeader.length;
    const includedHunks: HunkContext[] = [];

    for (const hunk of fc.hunks) {
      const hunkChars = hunk.content.length + 2; // +2 for newlines
      if (totalChars + fileChars + hunkChars > maxChars) {
        break;
      }
      fileChars += hunkChars;
      includedHunks.push(hunk);
    }

    if (includedHunks.length > 0) {
      totalChars += fileChars;
      result.push({ ...fc, hunks: includedHunks });
    }

    if (totalChars >= maxChars) break;
  }

  return result;
}

/**
 * Format gathered context into a string block suitable for LLM prompts.
 */
export function formatContextForPrompt(contexts: FileContext[]): string {
  const sections: string[] = [];

  for (const fc of contexts) {
    sections.push(`--- ${fc.path} (${fc.language ?? 'unknown'}) ---`);
    for (const hunk of fc.hunks) {
      sections.push(`[Lines ${hunk.startLine}-${hunk.endLine}]`);
      sections.push(hunk.content);
      sections.push('');
    }
  }

  return sections.join('\n');
}

function detectLanguageFromPath(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    py: 'python', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', rb: 'ruby',
    php: 'php', cs: 'csharp', cpp: 'cpp', c: 'c',
    swift: 'swift', scala: 'scala',
    sh: 'shell', yaml: 'yaml', yml: 'yaml',
    json: 'json', xml: 'xml', html: 'html',
    css: 'css', sql: 'sql', md: 'markdown',
    tf: 'terraform', proto: 'protobuf',
    vue: 'vue', svelte: 'svelte', dart: 'dart',
  };
  return ext ? (map[ext] ?? null) : null;
}
