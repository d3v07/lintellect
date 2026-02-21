import { gatherContext, formatContextForPrompt } from '@lintellect/core';
import type { ParsedDiff } from '@lintellect/core';
import { readJsonFromS3, writeJsonToS3 } from '../shared/s3-helpers.js';
import type { StepFunctionPayload } from '../shared/types.js';

/**
 * Context Worker Lambda
 *
 * Reads the ParsedDiff from S3, gathers surrounding context
 * with character budget enforcement, and writes the formatted
 * context back to S3.
 *
 * Input: StepFunctionPayload with artifacts.parsedDiff
 * Output: StepFunctionPayload with artifacts.context added
 */
export async function handler(payload: StepFunctionPayload): Promise<StepFunctionPayload> {
  const { jobId, bucket, artifacts } = payload;

  if (!artifacts.parsedDiff) {
    throw new Error(`Missing parsedDiff artifact for job ${jobId}`);
  }

  // Read parsed diff from S3
  const parsedDiff = await readJsonFromS3<ParsedDiff>(bucket, artifacts.parsedDiff);

  // Gather context with budget
  const maxChars = parseInt(process.env.MAX_CONTEXT_CHARS ?? '50000', 10);
  const contextData = gatherContext(parsedDiff, { maxTotalChars: maxChars });
  const formattedContext = formatContextForPrompt(contextData);

  // Write context to S3
  const contextKey = `packets/${jobId}/context.json`;
  await writeJsonToS3(bucket, contextKey, {
    raw: contextData,
    formatted: formattedContext,
  });

  return {
    ...payload,
    artifacts: {
      ...artifacts,
      context: contextKey,
    },
  };
}
