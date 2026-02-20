import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { JobRecord } from './types.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Create a new job record in DynamoDB.
 */
export async function createJobRecord(
  tableName: string,
  record: JobRecord
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: record,
      ConditionExpression: 'attribute_not_exists(jobId)',
    })
  );
}

/**
 * Update job status in DynamoDB.
 */
export async function updateJobStatus(
  tableName: string,
  jobId: string,
  status: string,
  extraFields?: Record<string, unknown>
): Promise<void> {
  const expressionParts = ['#status = :status', '#updatedAt = :updatedAt'];
  const names: Record<string, string> = {
    '#status': 'status',
    '#updatedAt': 'updatedAt',
  };
  const values: Record<string, unknown> = {
    ':status': status,
    ':updatedAt': new Date().toISOString(),
  };

  if (extraFields) {
    let i = 0;
    for (const [key, value] of Object.entries(extraFields)) {
      const nameKey = `#f${i}`;
      const valueKey = `:f${i}`;
      expressionParts.push(`${nameKey} = ${valueKey}`);
      names[nameKey] = key;
      values[valueKey] = value;
      i++;
    }
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { jobId },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

/**
 * Mark a job as failed in DynamoDB.
 */
export async function failJob(
  tableName: string,
  jobId: string,
  errorMessage: string
): Promise<void> {
  await updateJobStatus(tableName, jobId, 'failed', { error: errorMessage });
}

/**
 * Usage limit result from checkAndIncrementUsage.
 */
export interface UsageCheckResult {
  allowed: boolean;
  degraded: boolean;
  degradedModel?: string;
  count: number;
  limit: number;
}

/**
 * Check and increment usage for a repo's owner.
 * Free tier (awsConfigured === false): 5 normal, 6-7 degraded, 8+ blocked.
 * Pro tier (awsConfigured === true): no limits.
 */
export async function checkAndIncrementUsage(
  usersTable: string,
  connectionsTable: string,
  repoFullName: string,
): Promise<UsageCheckResult> {
  const FREE_LIMIT = 5;
  const DEGRADED_LIMIT = 7;
  const DEGRADED_MODEL = 'anthropic/claude-haiku-4';

  // 1. Find owner of the repo
  const connResult = await ddb.send(new ScanCommand({
    TableName: connectionsTable,
    FilterExpression: 'repoFullName = :repo',
    ExpressionAttributeValues: { ':repo': repoFullName },
    Limit: 1,
  }));

  if (!connResult.Items || connResult.Items.length === 0) {
    // No owner found — backward compat, allow without limits
    return { allowed: true, degraded: false, count: 0, limit: FREE_LIMIT };
  }

  const userId = connResult.Items[0].userId as string;

  // 2. Read user record
  const userResult = await ddb.send(new GetCommand({
    TableName: usersTable,
    Key: { userId },
  }));

  if (!userResult.Item) {
    return { allowed: true, degraded: false, count: 0, limit: FREE_LIMIT };
  }

  const user = userResult.Item;

  // 3. Pro tier has no limits
  if (user.awsConfigured === true) {
    return { allowed: true, degraded: false, count: 0, limit: Infinity };
  }

  // 4. Check usage period — reset on new month
  const currentPeriod = new Date().toISOString().slice(0, 7); // YYYY-MM
  const userPeriod = user.usagePeriod as string | undefined;
  const customLimit = (user.customLimit as number | undefined) ?? FREE_LIMIT;

  let currentCount = 0;
  if (userPeriod === currentPeriod) {
    currentCount = (user.usageCount as number) ?? 0;
  }

  // 5. Check limits before incrementing
  if (currentCount >= DEGRADED_LIMIT) {
    // Hard block
    return { allowed: false, degraded: false, count: currentCount, limit: customLimit };
  }

  // 6. Atomic increment
  if (userPeriod === currentPeriod) {
    await ddb.send(new UpdateCommand({
      TableName: usersTable,
      Key: { userId },
      UpdateExpression: 'ADD usageCount :inc SET updatedAt = :now',
      ExpressionAttributeValues: { ':inc': 1, ':now': new Date().toISOString() },
    }));
  } else {
    // New period — reset count to 1
    await ddb.send(new UpdateCommand({
      TableName: usersTable,
      Key: { userId },
      UpdateExpression: 'SET usageCount = :one, usagePeriod = :period, updatedAt = :now',
      ExpressionAttributeValues: { ':one': 1, ':period': currentPeriod, ':now': new Date().toISOString() },
    }));
  }

  const newCount = currentCount + 1;

  if (newCount > customLimit && newCount <= DEGRADED_LIMIT) {
    return { allowed: true, degraded: true, degradedModel: DEGRADED_MODEL, count: newCount, limit: customLimit };
  }

  return { allowed: true, degraded: false, count: newCount, limit: customLimit };
}
