import { createHmac, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { buildPacket, detectLanguage } from '@lintellect/core';
import { writeJsonToS3 } from '../shared/s3-helpers.js';
import { createJobRecord, checkAndIncrementUsage } from '../shared/dynamo-helpers.js';
import type { GitHubWebhookEvent, StepFunctionPayload, JobRecord } from '../shared/types.js';

const sfn = new SFNClient({});
const sm = new SecretsManagerClient({});

const secretCache = new Map<string, string>();
async function getSecret(name: string): Promise<string> {
  const cached = secretCache.get(name);
  if (cached) return cached;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: name }));
  secretCache.set(name, res.SecretString!);
  return res.SecretString!;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const BUCKET = process.env.ARTIFACTS_BUCKET!;
  const TABLE = process.env.JOB_TABLE!;
  const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
  // 1. Validate GitHub webhook signature
  const signature = event.headers['x-hub-signature-256'];
  const body = event.body;

  if (!body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing request body' }) };
  }

  const webhookSecret = await getSecret(process.env.WEBHOOK_SECRET_NAME!);
  if (!verifySignature(body, signature, webhookSecret)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid webhook signature' }) };
  }

  // 2. Parse event and filter to PR actions we care about
  const ghEvent = event.headers['x-github-event'];
  if (ghEvent !== 'pull_request') {
    return { statusCode: 200, body: JSON.stringify({ message: 'Ignored event type', event: ghEvent }) };
  }

  const payload: GitHubWebhookEvent = JSON.parse(body);
  const validActions = ['opened', 'synchronize', 'reopened'];
  if (!validActions.includes(payload.action)) {
    return { statusCode: 200, body: JSON.stringify({ message: 'Ignored PR action', action: payload.action }) };
  }

  // 3. Check usage limits
  const usersTableName = process.env.USERS_TABLE;
  const connectionsTableName = process.env.CONNECTIONS_TABLE;
  if (usersTableName && connectionsTableName) {
    const usage = await checkAndIncrementUsage(usersTableName, connectionsTableName, payload.repository.full_name);
    if (!usage.allowed) {
      return {
        statusCode: 429,
        body: JSON.stringify({ error: 'Monthly review limit reached. Connect your AWS account to remove limits.', count: usage.count, limit: usage.limit }),
      };
    }
    // Store degraded model info for later use in sfPayload
    if (usage.degraded && usage.degradedModel) {
      (payload as any)._degradedModel = usage.degradedModel;
    }
  }

  // 4. Fetch the diff from GitHub API (works for private repos)
  const githubToken = await getSecret(process.env.GITHUB_TOKEN_NAME!);
  const diffApiUrl = `https://api.github.com/repos/${payload.repository.full_name}/pulls/${payload.pull_request.number}`;
  const diffResponse = await fetch(diffApiUrl, {
    headers: {
      Accept: 'application/vnd.github.v3.diff',
      Authorization: `token ${githubToken}`,
    },
  });

  if (!diffResponse.ok) {
    return { statusCode: 502, body: JSON.stringify({ error: `Failed to fetch diff: ${diffResponse.status}` }) };
  }

  const diff = await diffResponse.text();

  // 4. Build the review packet
  const packet = buildPacket({
    repository: {
      owner: payload.repository.owner.login,
      name: payload.repository.name,
      fullName: payload.repository.full_name,
    },
    pullRequest: {
      number: payload.pull_request.number,
      title: payload.pull_request.title,
      description: payload.pull_request.body,
      author: payload.pull_request.user.login,
      baseSha: payload.pull_request.base.sha,
      headSha: payload.pull_request.head.sha,
      url: payload.pull_request.html_url,
    },
    diff,
    commitMessages: [],
    metadata: {
      webhookEventId: event.headers['x-github-delivery'] ?? 'unknown',
      installationId: payload.installation?.id ?? null,
    },
    skipValidation: true,
  });

  // 5. Store packet in S3
  const inputKey = `packets/${packet.jobId}/input.json`;
  await writeJsonToS3(BUCKET, inputKey, packet);

  // 6. Create DynamoDB job record
  const jobRecord: JobRecord = {
    jobId: packet.jobId,
    status: 'pending',
    repository: payload.repository.full_name,
    prNumber: payload.pull_request.number,
    prUrl: payload.pull_request.html_url,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await createJobRecord(TABLE, jobRecord);

  // 7. Start Step Functions execution
  const sfPayload: StepFunctionPayload = {
    jobId: packet.jobId,
    bucket: BUCKET,
    artifacts: { input: inputKey },
    repository: {
      owner: payload.repository.owner.login,
      name: payload.repository.name,
      fullName: payload.repository.full_name,
    },
    pullRequest: {
      number: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
    },
    status: 'pending',
    degradedModel: (payload as any)._degradedModel ?? '',
  };

  const execution = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: packet.jobId,
      input: JSON.stringify(sfPayload),
    })
  );

  return {
    statusCode: 202,
    body: JSON.stringify({
      jobId: packet.jobId,
      executionArn: execution.executionArn,
      message: 'Review pipeline started',
    }),
  };
}

function verifySignature(
  body: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
