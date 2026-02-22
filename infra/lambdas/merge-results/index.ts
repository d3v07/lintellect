import type { ReviewOutput, ReviewComment } from '@lintellect/core';
import { readJsonFromS3, writeJsonToS3 } from '../shared/s3-helpers.js';
import type { StepFunctionPayload } from '../shared/types.js';

/**
 * Merge Results Lambda
 *
 * Reads all individual pass outputs from S3, merges their comments
 * into a single array, and writes the merged review to S3.
 *
 * Step Functions Parallel state produces an array of results.
 * This Lambda merges them into one combined output.
 *
 * Input: Array of StepFunctionPayload (one per parallel branch)
 * Output: StepFunctionPayload with artifacts.mergedReview added
 */
export async function handler(parallelResults: StepFunctionPayload[]): Promise<StepFunctionPayload> {
  // The parallel state returns an array of results from each branch.
  // All should share the same jobId and bucket.
  const first = parallelResults[0];
  const { jobId, bucket } = first;

  // Merge artifacts from all branches
  const mergedArtifacts = { ...first.artifacts };
  for (const result of parallelResults) {
    Object.assign(mergedArtifacts, result.artifacts);
  }

  // Read all pass outputs
  const passKeys = [
    mergedArtifacts.pass1,
    mergedArtifacts.pass2,
    mergedArtifacts.pass3,
    mergedArtifacts.pass4,
  ].filter((k): k is string => !!k);

  const passOutputs = await Promise.all(
    passKeys.map((key) => readJsonFromS3<ReviewOutput>(bucket, key))
  );

  // Merge all comments
  const allComments: ReviewComment[] = passOutputs.flatMap((o) => o.comments);

  // Compute aggregate tokens
  const totalTokens = {
    input: passOutputs.reduce((s, o) => s + o.tokensUsed.input, 0),
    output: passOutputs.reduce((s, o) => s + o.tokensUsed.output, 0),
    total: passOutputs.reduce((s, o) => s + o.tokensUsed.total, 0),
  };

  const totalDurationMs = passOutputs.reduce((s, o) => s + o.durationMs, 0);

  const mergedReview = {
    jobId,
    comments: allComments,
    passOutputs: passOutputs.map((o) => ({
      passType: o.passType,
      passNumber: o.passNumber,
      commentCount: o.comments.length,
      summary: o.summary,
      modelId: o.modelId,
      tokensUsed: o.tokensUsed,
      durationMs: o.durationMs,
    })),
    totalTokens,
    totalDurationMs,
    mergedAt: new Date().toISOString(),
  };

  // Write merged review to S3
  const mergedKey = `packets/${jobId}/merged-review.json`;
  await writeJsonToS3(bucket, mergedKey, mergedReview);

  return {
    ...first,
    artifacts: {
      ...mergedArtifacts,
      mergedReview: mergedKey,
    },
  };
}
