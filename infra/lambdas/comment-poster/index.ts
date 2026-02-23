import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { ReviewComment } from '@lintellect/core';
import { readJsonFromS3 } from '../shared/s3-helpers.js';
import { updateJobStatus } from '../shared/dynamo-helpers.js';
import type { StepFunctionPayload } from '../shared/types.js';

const secrets = new SecretsManagerClient({});
function getTable(): string { return process.env.JOB_TABLE!; }
function getSecretArn(): string { return process.env.GITHUB_TOKEN_SECRET_ARN!; }

let cachedGithubToken: string | null = null;

async function getGithubToken(): Promise<string> {
  if (cachedGithubToken) return cachedGithubToken;

  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: getSecretArn() })
  );
  cachedGithubToken = response.SecretString ?? '';
  return cachedGithubToken;
}

interface ReviewOutput {
  jobId: string;
  acceptedComments: ReviewComment[];
  evidenceMetrics: { totalComments: number; acceptedCount: number; rejectedCount: number; passRate: number };
  totalTokens: { input: number; output: number; total: number };
  totalDurationMs: number;
}

/**
 * Comment Poster Lambda
 *
 * Reads the validated review output from S3 and posts inline
 * review comments to the GitHub PR using the GitHub API.
 *
 * Input: StepFunctionPayload with artifacts.output
 * Output: StepFunctionPayload with status: 'completed'
 */
export async function handler(payload: StepFunctionPayload): Promise<StepFunctionPayload> {
  const { jobId, bucket, artifacts, repository, pullRequest } = payload;

  if (!artifacts.output) {
    throw new Error(`Missing output artifact for job ${jobId}`);
  }

  await updateJobStatus(getTable(), jobId, 'posting');

  const token = await getGithubToken();
  const output = await readJsonFromS3<ReviewOutput>(bucket, artifacts.output);

  // If no accepted comments, post a summary-only review
  if (output.acceptedComments.length === 0) {
    await postReview(
      token,
      repository.owner,
      repository.name,
      pullRequest.number,
      pullRequest.headSha,
      'APPROVE',
      formatSummary(output, []),
      []
    );
  } else {
    // Build inline comments for the PR review
    const comments = output.acceptedComments.map((c) => ({
      path: c.filePath,
      line: c.endLineNumber ?? c.lineNumber,
      ...(c.endLineNumber && c.endLineNumber !== c.lineNumber
        ? { start_line: c.lineNumber }
        : {}),
      side: 'RIGHT' as const,
      body: formatCommentBody(c),
    }));

    const event = hasBlockingIssues(output.acceptedComments) ? 'REQUEST_CHANGES' : 'COMMENT';

    await postReview(
      token,
      repository.owner,
      repository.name,
      pullRequest.number,
      pullRequest.headSha,
      event,
      formatSummary(output, output.acceptedComments),
      comments
    );
  }

  await updateJobStatus(getTable(), jobId, 'completed');

  return {
    ...payload,
    status: 'completed',
  };
}

function hasBlockingIssues(comments: ReviewComment[]): boolean {
  return comments.some((c) => c.severity === 'critical');
}

function formatCommentBody(comment: ReviewComment): string {
  const severityEmoji: Record<string, string> = {
    critical: '🔴',
    warning: '🟡',
    suggestion: '🔵',
    nitpick: '⚪',
  };

  const emoji = severityEmoji[comment.severity] ?? '🔵';
  let body = `${emoji} **${comment.severity.toUpperCase()}** (${comment.category})\n\n${comment.message}`;

  if (comment.suggestion) {
    body += `\n\n**Suggestion:**\n\`\`\`suggestion\n${comment.suggestion}\n\`\`\``;
  }

  body += `\n\n<sub>Confidence: ${Math.round(comment.confidence * 100)}%</sub>`;

  return body;
}

function formatSummary(output: ReviewOutput, comments: ReviewComment[]): string {
  const { evidenceMetrics, totalTokens, totalDurationMs } = output;

  const critCount = comments.filter((c) => c.severity === 'critical').length;
  const warnCount = comments.filter((c) => c.severity === 'warning').length;
  const suggCount = comments.filter((c) => c.severity === 'suggestion').length;
  const nitpickCount = comments.filter((c) => c.severity === 'nitpick').length;

  let summary = `## Lintellect AI Review\n\n`;

  if (comments.length === 0) {
    summary += `No issues found. Code looks good!\n\n`;
  } else {
    summary += `Found **${comments.length}** issue(s):\n`;
    if (critCount > 0) summary += `- 🔴 Critical: ${critCount}\n`;
    if (warnCount > 0) summary += `- 🟡 Warning: ${warnCount}\n`;
    if (suggCount > 0) summary += `- 🔵 Suggestion: ${suggCount}\n`;
    if (nitpickCount > 0) summary += `- ⚪ Nitpick: ${nitpickCount}\n`;
    summary += '\n';
  }

  summary += `<details><summary>Review Stats</summary>\n\n`;
  summary += `- Evidence pass rate: ${Math.round(evidenceMetrics.passRate * 100)}%\n`;
  summary += `- Comments validated: ${evidenceMetrics.totalComments} (${evidenceMetrics.acceptedCount} accepted, ${evidenceMetrics.rejectedCount} rejected)\n`;
  summary += `- Tokens used: ${totalTokens.total.toLocaleString()} (in: ${totalTokens.input.toLocaleString()}, out: ${totalTokens.output.toLocaleString()})\n`;
  summary += `- Duration: ${(totalDurationMs / 1000).toFixed(1)}s\n`;
  summary += `</details>`;

  return summary;
}

interface ReviewCommentPayload {
  path: string;
  line: number;
  start_line?: number;
  side: 'RIGHT';
  body: string;
}

async function postReview(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES',
  body: string,
  comments: ReviewCommentPayload[]
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      commit_id: commitSha,
      body,
      event,
      comments,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();

    // GitHub returns 422 when requesting changes on your own PR — retry as COMMENT
    if (response.status === 422 && event === 'REQUEST_CHANGES' && errorBody.includes('Can not request changes')) {
      const retryResponse = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          commit_id: commitSha,
          body,
          event: 'COMMENT',
          comments,
        }),
      });

      if (!retryResponse.ok) {
        const retryBody = await retryResponse.text();
        throw new Error(`GitHub API error ${retryResponse.status}: ${retryBody}`);
      }
      return;
    }

    throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
  }
}
