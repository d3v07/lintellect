/**
 * Dead Letter Queue handler for failed Lintellect review jobs.
 *
 * Triggered by SQS when a Step Functions execution fails after all
 * retries. Records the failure in DynamoDB and optionally notifies a
 * Slack channel so the team can investigate or manually replay.
 */

import { SQSHandler, SQSRecord } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});

interface FailedExecutionEvent {
  jobId: string;
  executionArn: string;
  cause?: string;
  error?: string;
  startDate?: string;
  stopDate?: string;
  repository?: string;
  prNumber?: number;
  prUrl?: string;
}

async function markJobFailed(
  table: string,
  jobId: string,
  error: string
): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: table,
      Key: marshall({ jobId }),
      UpdateExpression:
        'SET #s = :s, updatedAt = :now, #err = :err',
      ExpressionAttributeNames: {
        '#s':  'status',
        '#err': 'error',
      },
      ExpressionAttributeValues: marshall({
        ':s':   'failed',
        ':now': new Date().toISOString(),
        ':err': error,
      }),
    })
  );
}

async function notifySlack(
  webhookUrl: string,
  event: FailedExecutionEvent
): Promise<void> {
  const text =
    `🔴 *Lintellect review job failed*\n` +
    `Job: \`${event.jobId}\`\n` +
    `Repo: ${event.repository ?? 'unknown'}\n` +
    `PR: ${event.prUrl ?? `#${event.prNumber}`}\n` +
    `Error: ${event.error ?? 'unknown'}\n` +
    `Cause: ${event.cause?.slice(0, 200) ?? 'n/a'}`;

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {/* swallow — don't let Slack failure cascade */});
}

async function processRecord(record: SQSRecord): Promise<void> {
  const TABLE   = process.env.JOB_TABLE!;
  const SLACK   = process.env.SLACK_DLQ_WEBHOOK_URL;

  const body = JSON.parse(record.body) as FailedExecutionEvent;

  await markJobFailed(
    TABLE,
    body.jobId,
    `Step Functions execution failed: ${body.error ?? 'unknown'} — ${body.cause?.slice(0, 500) ?? ''}`
  );

  if (SLACK) {
    await notifySlack(SLACK, body);
  }

  console.error(JSON.stringify({ level: 'ERROR', ...body }));
}

export const handler: SQSHandler = async (event) => {
  await Promise.allSettled(event.Records.map(processRecord));
};
