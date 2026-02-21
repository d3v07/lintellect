import { parsePatch } from '@lintellect/core';
import type { ReviewPacket } from '@lintellect/core';
import { readJsonFromS3, writeJsonToS3 } from '../shared/s3-helpers.js';
import { updateJobStatus } from '../shared/dynamo-helpers.js';
import type { StepFunctionPayload } from '../shared/types.js';

/**
 * Diff Worker Lambda
 *
 * Reads the ReviewPacket from S3, parses the unified diff into
 * structured ParsedDiff, and writes it back to S3.
 *
 * Input: StepFunctionPayload with artifacts.input
 * Output: StepFunctionPayload with artifacts.parsedDiff added
 */
export async function handler(payload: StepFunctionPayload): Promise<StepFunctionPayload> {
  const { jobId, bucket, artifacts } = payload;

  await updateJobStatus(process.env.JOB_TABLE!, jobId, 'processing');

  // Read the review packet from S3
  const packet = await readJsonFromS3<ReviewPacket>(bucket, artifacts.input);

  // Parse the diff
  const parsedDiff = parsePatch(packet.diff);

  // Write parsed diff to S3
  const parsedDiffKey = `packets/${jobId}/parsed-diff.json`;
  await writeJsonToS3(bucket, parsedDiffKey, parsedDiff);

  return {
    ...payload,
    status: 'processing',
    artifacts: {
      ...artifacts,
      parsedDiff: parsedDiffKey,
    },
  };
}
