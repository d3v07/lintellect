import type {
  ReviewPacket,
  ReviewOutput,
  ReviewComment,
  PassType,
  LLMProvider,
  TokensUsed,
  PASS_CONFIG,
} from '../types.js';
import { PASS_TYPES } from '../types.js';
import { PASS_CONFIG as passConfig } from '../types.js';
import { parsePatch } from '../diff-parser/index.js';
import { gatherContext, formatContextForPrompt } from '../context-gatherer/index.js';
import { validateEvidence } from '../evidence-validator/index.js';
import { buildSystemPrompt, buildUserPrompt } from './prompts.js';

export interface PromptRunnerOptions {
  /** Run passes in parallel (default: true) */
  parallel?: boolean;
  /** Which passes to run. Default: all four */
  passes?: PassType[];
  /** Max output tokens per pass. Default: 4096 */
  maxOutputTokens?: number;
  /** Confidence threshold for evidence gate. Default: 0.3 */
  confidenceThreshold?: number;
  /** Max chars for context. Default: 50000 */
  maxContextChars?: number;
}

export interface RunResult {
  outputs: ReviewOutput[];
  mergedComments: ReviewComment[];
  totalTokens: TokensUsed;
  totalDurationMs: number;
}

/**
 * Run the multi-pass review pipeline on a ReviewPacket.
 */
export async function runReview(
  packet: ReviewPacket,
  provider: LLMProvider,
  options?: PromptRunnerOptions
): Promise<RunResult> {
  const opts = {
    parallel: true,
    passes: PASS_TYPES,
    maxOutputTokens: 4096,
    confidenceThreshold: 0.3,
    maxContextChars: 50000,
    ...options,
  };

  // Parse diff and gather context
  const diff = parsePatch(packet.diff);
  const contextData = gatherContext(diff, { maxTotalChars: opts.maxContextChars });
  const contextStr = formatContextForPrompt(contextData);

  // Build and execute passes
  const passRunner = (passType: PassType) =>
    runSinglePass(packet, provider, passType, contextStr, opts.maxOutputTokens);

  let outputs: ReviewOutput[];
  if (opts.parallel) {
    outputs = await Promise.all(opts.passes.map(passRunner));
  } else {
    outputs = [];
    for (const passType of opts.passes) {
      outputs.push(await passRunner(passType));
    }
  }

  // Merge all comments and run evidence gate
  const allComments = outputs.flatMap((o) => o.comments);
  const evidenceResult = validateEvidence(allComments, diff, {
    confidenceThreshold: opts.confidenceThreshold,
  });

  // Calculate totals
  const totalTokens: TokensUsed = {
    input: outputs.reduce((s, o) => s + o.tokensUsed.input, 0),
    output: outputs.reduce((s, o) => s + o.tokensUsed.output, 0),
    total: outputs.reduce((s, o) => s + o.tokensUsed.total, 0),
  };
  const totalDurationMs = outputs.reduce((s, o) => s + o.durationMs, 0);

  return {
    outputs,
    mergedComments: evidenceResult.accepted,
    totalTokens,
    totalDurationMs,
  };
}

async function runSinglePass(
  packet: ReviewPacket,
  provider: LLMProvider,
  passType: PassType,
  contextStr: string,
  maxOutputTokens: number
): Promise<ReviewOutput> {
  const config = passConfig[passType];
  const systemPrompt = buildSystemPrompt(passType);
  const userPrompt = buildUserPrompt(
    passType,
    packet.diff,
    contextStr,
    packet.pullRequest.title,
    packet.pullRequest.description
  );

  const startTime = Date.now();

  const response = await provider.review(
    userPrompt,
    {
      temperature: config.temperature,
      maxOutputTokens,
      timeoutMs: 60000,
      systemPrompt,
    }
  );

  const durationMs = Date.now() - startTime;

  // Parse JSON response from LLM
  const parsed = parseJsonResponse(response.content);

  const comments: ReviewComment[] = (parsed.comments ?? []).map(
    (c: unknown) => {
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
    }
  );

  const output: ReviewOutput = {
    jobId: packet.jobId,
    passType,
    passNumber: config.passNumber,
    comments,
    summary: String(parsed.summary ?? `${passType} pass completed.`),
    modelId: response.modelId,
    tokensUsed: response.tokensUsed,
    durationMs,
    completedAt: new Date().toISOString(),
  };

  return output;
}

/**
 * Parse JSON from LLM response, handling common issues like markdown fencing.
 */
function parseJsonResponse(content: string): { comments?: unknown[]; summary?: string } {
  let cleaned = content.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from the response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // Fall through
      }
    }

    return {
      comments: [],
      summary: `Failed to parse LLM response as JSON. Raw content length: ${content.length}`,
    };
  }
}

export { parseJsonResponse };
