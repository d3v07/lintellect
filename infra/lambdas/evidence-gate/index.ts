import { validateEvidence, parsePatch } from '@lintellect/core';
import type { ReviewComment, ParsedDiff, ReviewPacket } from '@lintellect/core';
import { readJsonFromS3, writeJsonToS3 } from '../shared/s3-helpers.js';
import { updateJobStatus } from '../shared/dynamo-helpers.js';
import type { StepFunctionPayload } from '../shared/types.js';

function getTable(): string { return process.env.JOB_TABLE!; }
function getConfidenceThreshold(): number { return parseFloat(process.env.CONFIDENCE_THRESHOLD ?? '0.3'); }

interface MergedReview {
  jobId: string;
  comments: ReviewComment[];
  totalTokens: { input: number; output: number; total: number };
  totalDurationMs: number;
}

/**
 * Evidence Gate Lambda
 *
 * Reads merged review comments + parsed diff from S3,
 * validates every comment citation against the actual diff,
 * and writes the filtered output to S3.
 *
 * Input: StepFunctionPayload with artifacts.mergedReview + artifacts.parsedDiff
 * Output: StepFunctionPayload with artifacts.output added
 */
export async function handler(payload: StepFunctionPayload): Promise<StepFunctionPayload> {
  const { jobId, bucket, artifacts } = payload;

  if (!artifacts.mergedReview) {
    throw new Error(`Missing mergedReview artifact for job ${jobId}`);
  }
  if (!artifacts.parsedDiff) {
    throw new Error(`Missing parsedDiff artifact for job ${jobId}`);
  }

  await updateJobStatus(getTable(), jobId, 'validating');

  // Read merged review and parsed diff from S3
  const [mergedReview, parsedDiff] = await Promise.all([
    readJsonFromS3<MergedReview>(bucket, artifacts.mergedReview),
    readJsonFromS3<ParsedDiff>(bucket, artifacts.parsedDiff),
  ]);

  // Run evidence validation
  const evidenceResult = validateEvidence(mergedReview.comments, parsedDiff, {
    confidenceThreshold: getConfidenceThreshold(),
  });

  // Build final output
  const output = {
    jobId,
    acceptedComments: evidenceResult.accepted,
    rejectedComments: evidenceResult.rejected,
    evidenceMetrics: evidenceResult.metrics,
    totalTokens: mergedReview.totalTokens,
    totalDurationMs: mergedReview.totalDurationMs,
    completedAt: new Date().toISOString(),
  };

  // Write output to S3
  const outputKey = `packets/${jobId}/output.json`;
  await writeJsonToS3(bucket, outputKey, output);

  // Update job record with evidence metrics
  await updateJobStatus(getTable(), jobId, 'validating', {
    evidenceMetrics: evidenceResult.metrics,
    tokensUsed: mergedReview.totalTokens,
    durationMs: mergedReview.totalDurationMs,
  });

  return {
    ...payload,
    artifacts: {
      ...artifacts,
      output: outputKey,
    },
  };
}
