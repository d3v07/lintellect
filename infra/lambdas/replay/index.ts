/**
 * Manual job replay Lambda.
 *
 * Allows an operator to re-trigger a failed or stalled review job by
 * providing its jobId. Reads the original input packet from S3 and
 * starts a fresh Step Functions execution with a new execution name.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { readJsonFromS3 } from '../shared/s3-helpers.js';
import { updateJobStatus } from '../shared/dynamo-helpers.js';
import type { StepFunctionPayload } from '../shared/types.js';

const sfn = new SFNClient({});

interface ReplayRequest {
  jobId: string;
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const BUCKET            = process.env.ARTIFACTS_BUCKET!;
  const TABLE             = process.env.JOB_TABLE!;
  const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing request body' }) };
  }

  const { jobId } = JSON.parse(event.body) as ReplayRequest;
  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing jobId' }) };
  }

  // Read original Step Functions payload from S3
  const inputKey = `packets/${jobId}/input.json`;
  let original: StepFunctionPayload;
  try {
    original = await readJsonFromS3<StepFunctionPayload>(BUCKET, inputKey);
  } catch {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: `Job packet not found: ${jobId}` }),
    };
  }

  // Create a fresh execution name to avoid conflicts
  const replayId = `${jobId}-replay-${Date.now()}`;
  const payload: StepFunctionPayload = {
    ...original,
    jobId,
    status: 'pending',
    error: undefined,
  };

  const execution = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: replayId,
      input: JSON.stringify(payload),
    })
  );

  await updateJobStatus(TABLE, jobId, 'pending');

  return {
    statusCode: 202,
    body: JSON.stringify({
      jobId,
      replayExecutionArn: execution.executionArn,
      message: 'Replay started',
    }),
  };
}
