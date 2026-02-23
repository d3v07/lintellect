#!/usr/bin/env node
import { Command } from 'commander';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildPacket,
  buildFileChanges,
  parsePatch,
  runReview,
  type ReviewComment,
} from '@lintellect/core';
import { OpenRouterProvider } from '@lintellect/providers';

// Load .env from project root
config({ path: resolve(process.cwd(), '.env') });

const program = new Command();

program
  .name('lintellect')
  .description('AI-powered code review')
  .version('0.1.0');

program
  .command('review')
  .description('Review a diff file or stdin')
  .option('-f, --file <path>', 'Path to diff file')
  .option('-t, --title <title>', 'PR title', 'Code Review')
  .option('-a, --author <author>', 'PR author', 'unknown')
  .option('-o, --owner <owner>', 'Repository owner', 'local')
  .option('-r, --repo <repo>', 'Repository name', 'repo')
  .option('--passes <passes>', 'Comma-separated pass types (structural,logic,style,security)', 'structural,logic,style,security')
  .option('--sequential', 'Run passes sequentially instead of parallel')
  .option('--json', 'Output raw JSON instead of formatted text')
  .option('--confidence <threshold>', 'Minimum confidence threshold', '0.3')
  .action(async (opts) => {
    try {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        console.error('Error: OPENROUTER_API_KEY environment variable is required.');
        console.error('Set it in .env or export it in your shell.');
        process.exit(1);
      }

      const modelId = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4-20250514';

      // Read diff
      let diff: string;
      if (opts.file) {
        diff = readFileSync(resolve(opts.file), 'utf-8');
      } else if (!process.stdin.isTTY) {
        diff = await readStdin();
      } else {
        console.error('Error: Provide a diff via --file or pipe to stdin.');
        console.error('Example: git diff | lintellect review');
        console.error('Example: lintellect review --file changes.diff');
        process.exit(1);
      }

      if (!diff.trim()) {
        console.log('No changes to review.');
        process.exit(0);
      }

      // Parse diff to extract files
      const parsed = parsePatch(diff);
      const files = buildFileChanges(parsed.files);

      // Build packet
      const packet = buildPacket({
        repository: {
          owner: opts.owner,
          name: opts.repo,
          fullName: `${opts.owner}/${opts.repo}`,
        },
        pullRequest: {
          number: 1,
          title: opts.title,
          description: null,
          author: opts.author,
          baseSha: '0'.repeat(40),
          headSha: 'f'.repeat(40),
        },
        diff,
        files,
      });

      // Create provider
      const provider = new OpenRouterProvider({
        apiKey,
        modelId,
      });

      const passes = opts.passes.split(',').map((p: string) => p.trim());

      console.error(`Reviewing with ${modelId} (${passes.length} passes)...`);
      const startTime = Date.now();

      // Run review
      const result = await runReview(packet, provider, {
        parallel: !opts.sequential,
        passes,
        confidenceThreshold: parseFloat(opts.confidence),
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printFormattedResult(result.mergedComments, result.outputs, elapsed);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

function printFormattedResult(
  comments: ReviewComment[],
  outputs: Array<{ passType: string; summary: string; tokensUsed: { total: number } }>,
  elapsed: string
): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Lintellect Review Complete (${elapsed}s)`);
  console.log(`${'='.repeat(60)}\n`);

  // Pass summaries
  for (const output of outputs) {
    console.log(`[${output.passType.toUpperCase()}] ${output.summary}`);
    console.log(`  Tokens used: ${output.tokensUsed.total}`);
    console.log();
  }

  if (comments.length === 0) {
    console.log('No issues found. Looks good!');
    return;
  }

  console.log(`${'─'.repeat(60)}`);
  console.log(`  ${comments.length} comment(s) after evidence validation`);
  console.log(`${'─'.repeat(60)}\n`);

  // Group by file
  const byFile = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const existing = byFile.get(comment.filePath) ?? [];
    existing.push(comment);
    byFile.set(comment.filePath, existing);
  }

  for (const [filePath, fileComments] of byFile) {
    console.log(`  ${filePath}`);
    console.log(`  ${'─'.repeat(filePath.length)}`);

    for (const c of fileComments.sort((a, b) => a.lineNumber - b.lineNumber)) {
      const severityIcon =
        c.severity === 'critical' ? '!!' :
        c.severity === 'warning' ? '! ' :
        c.severity === 'suggestion' ? '? ' : '  ';

      console.log(`  ${severityIcon} L${c.lineNumber} [${c.severity}] [${c.category}] (${(c.confidence * 100).toFixed(0)}%)`);
      console.log(`     ${c.message}`);
      if (c.suggestion) {
        console.log(`     Suggestion: ${c.suggestion}`);
      }
      console.log();
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

program.parse();
