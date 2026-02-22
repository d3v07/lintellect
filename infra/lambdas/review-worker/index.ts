import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { ReviewPacket, PassType, ReviewOutput, ReviewComment } from '@lintellect/core';
import { PASS_CONFIG, buildSystemPrompt, buildUserPrompt, parseJsonResponse } from '@lintellect/core';
import { createProvider } from '@lintellect/providers';
import { readJsonFromS3, writeJsonToS3 } from '../shared/s3-helpers.js';
import { updateJobStatus } from '../shared/dynamo-helpers.js';
import type { StepFunctionPayload } from '../shared/types.js';

const secrets = new SecretsManagerClient({});

let cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.OPENROUTER_API_KEY_SECRET_ARN! })
  );
  cachedApiKey = response.SecretString ?? '';
  return cachedApiKey;
}

interface ReviewWorkerInput extends StepFunctionPayload {
  passType: PassType;
}

/**
 * Review Worker Lambda
 *
 * Runs a single LLM review pass. Invoked by Step Functions Parallel
 * state — one invocation per pass type (structural, logic, style, security).
 *
 * Input: StepFunctionPayload + passType
 * Output: StepFunctionPayload with pass artifact key added
 */
export async function handler(input: ReviewWorkerInput): Promise<StepFunctionPayload> {
  const { jobId, bucket, artifacts, passType } = input;
  const passConfig = PASS_CONFIG[passType];

  await updateJobStatus(process.env.JOB_TABLE!, jobId, 'reviewing');

  // Get API key from Secrets Manager
  const apiKey = await getApiKey();

  // Create provider
  const provider = createProvider(
    {
      provider: 'openrouter',
      modelId: input.degradedModel || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4',
      temperature: passConfig.temperature,
      maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS ?? '4096', 10),
      timeoutMs: 120000,
      retryPolicy: { maxRetries: 2, baseDelayMs: 5000, maxDelayMs: 30000, jitter: true },
      baseUrl: process.env.OPENROUTER_BASE_URL,
    },
    apiKey
  );

  // Read packet and context from S3
  const packet = await readJsonFromS3<ReviewPacket>(bucket, artifacts.input);
  const contextObj = await readJsonFromS3<{ formatted: string }>(bucket, artifacts.context!);

  const systemPrompt = buildSystemPrompt(passType);
  const userPrompt = buildUserPrompt(
    passType,
    packet.diff,
    contextObj.formatted,
    packet.pullRequest.title,
    packet.pullRequest.description
  );

  const startTime = Date.now();

  const maxTokens = parseInt(process.env.MAX_OUTPUT_TOKENS ?? '4096', 10);
  const response = await provider.review(userPrompt, {
    temperature: passConfig.temperature,
    maxOutputTokens: maxTokens,
    timeoutMs: 120000,
    systemPrompt,
  });

  const durationMs = Date.now() - startTime;

  // Parse the LLM response
  const parsed = parseJsonResponse(response.content);

  const comments: ReviewComment[] = (parsed.comments ?? []).map((c: unknown) => {
    const obj = c as Record<string, unknown>;
    return {
      filePath: String(obj.filePath ?? ''),
      lineNumber: Number(obj.lineNumber ?? 0),
      ...(obj.endLineNumber != null ? { endLineNumber: Number(obj.endLineNumber) } : {}),
      codeSnippet: String(obj.codeSnippet ?? ''),
      severity: String(obj.severity ?? 'suggestion') as ReviewComment['severity'],
      category: passType,
      message: String(obj.message ?? ''),
      ...(obj.suggestion != null ? { suggestion: String(obj.suggestion) } : {}),
      confidence: Number(obj.confidence ?? 0.5),
    };
  });

  const output: ReviewOutput = {
    jobId,
    passType,
    passNumber: passConfig.passNumber,
    comments,
    summary: String(parsed.summary ?? `${passType} pass completed.`),
    modelId: response.modelId,
    tokensUsed: response.tokensUsed,
    durationMs,
    completedAt: new Date().toISOString(),
  };

  // Write pass output to S3
  const passKey = `packets/${jobId}/pass-${passConfig.passNumber}.json`;
  await writeJsonToS3(bucket, passKey, output);

  // Update artifact reference for this pass
  const passArtifactKey = `pass${passConfig.passNumber}` as keyof typeof artifacts;
  return {
    ...input,
    artifacts: {
      ...artifacts,
      [passArtifactKey]: passKey,
    },
  };
}
