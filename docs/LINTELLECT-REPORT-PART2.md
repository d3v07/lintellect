## 6. System Architecture -- Detailed Component Descriptions

### 6.1 Webhook Lambda

**Purpose and responsibility:** The Webhook Lambda is the entry point of the entire review pipeline. It receives GitHub webhook POST requests via API Gateway, validates the request authenticity, fetches the PR diff from GitHub, constructs the initial ReviewPacket, stores it in S3, creates a DynamoDB job record, and triggers the Step Functions state machine.

**Input/output contract:** Input is an `APIGatewayProxyEventV2` containing the raw GitHub webhook payload in the body, an HMAC signature in the `X-Hub-Signature-256` header, the event type in `X-GitHub-Event`, and a delivery ID in `X-GitHub-Delivery`. Output is an `APIGatewayProxyResultV2` with status 202 (accepted), 200 (ignored event), 400 (bad request), 401 (invalid signature), or 502 (diff fetch failure).

**Key design decisions:** The webhook secret is loaded from Secrets Manager and cached in a module-level `Map` to avoid repeated API calls on warm invocations. HMAC validation uses `crypto.timingSafeEqual` to prevent timing attacks. The diff is fetched using the GitHub API with `Accept: application/vnd.github.v3.diff` rather than the public diff URL, enabling support for private repositories. The ReviewPacket is built with `skipValidation: true` because the JSON schema files are not bundled into Lambda -- validation happens at the schema level via the schema definitions embedded in the types.

**Error handling:** Missing body returns 400. Invalid HMAC returns 401. Non-pull-request events and irrelevant PR actions (closed, edited, labeled) return 200 with an explanatory message. Failed diff fetch returns 502 with the upstream status code. All other errors propagate to Lambda's error handler.

**Code pattern (HMAC validation):**

```typescript
function verifySignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
```

### 6.2 Diff Worker Lambda

**Purpose and responsibility:** The Diff Worker reads the ReviewPacket from S3, parses the raw unified diff into a structured `ParsedDiff` object (files, hunks, changes with line numbers), and writes the result back to S3. This transforms the opaque diff string into a queryable data structure used by downstream workers.

**Input/output contract:** Input is a `StepFunctionPayload` with `artifacts.input` pointing to the ReviewPacket in S3. Output is the same payload with `artifacts.parsedDiff` added, pointing to the new S3 object.

**Key design decisions:** The worker delegates to `parsePatch()` from `@lintellect/core`, which wraps the `parse-diff` library with ESM/CJS interop handling. It updates the job status to `processing` in DynamoDB at entry. The parsed diff is stored as a separate S3 object rather than embedded in the payload to keep Step Functions payloads under the 256KB limit.

**Error handling:** If the S3 read fails (missing or corrupt packet), the error propagates to Step Functions, which applies the configured retry policy (2 retries with exponential backoff). If all retries fail, the catch block routes to the `PipelineFailed` state.

### 6.3 Context Worker Lambda

**Purpose and responsibility:** The Context Worker reads the parsed diff from S3, gathers surrounding context for each file's hunks with character budget enforcement, formats the context into a prompt-ready string, and writes both the raw and formatted context to S3. This step ensures the LLM receives sufficient context to understand code changes without exceeding token limits.

**Input/output contract:** Input is a `StepFunctionPayload` with `artifacts.parsedDiff`. Output adds `artifacts.context`. The context JSON contains both `raw` (structured `FileContext[]`) and `formatted` (prompt-ready string) representations.

**Key design decisions:** The maximum context characters default to 50,000 (approximately 12,500 tokens at 4 characters per token). Files are sorted by number of changes (most changes first) to prioritize high-impact files when the budget is limited. Deleted files are excluded from context (they have no new lines to review). The budget enforcement is greedy: it includes files and hunks in priority order until the budget is exhausted.

**Error handling:** Throws if `artifacts.parsedDiff` is missing, which indicates an orchestration error (the diff worker was skipped). This is caught by Step Functions and routed to the fail state.

### 6.4 Review Worker Lambda

**Purpose and responsibility:** The Review Worker executes a single LLM review pass. It is invoked four times in parallel by the Step Functions Parallel state -- once for each pass type (structural, logic, style, security). It reads the ReviewPacket and context from S3, constructs system and user prompts for the specified pass type, invokes the LLM via the provider abstraction, parses the JSON response, and writes the pass output to S3.

**Input/output contract:** Input is a `StepFunctionPayload` extended with a `passType` field (`'structural' | 'logic' | 'style' | 'security'`). The pass type is injected by the Step Functions Parallel state using `sfn.TaskInput.fromObject` with a static `passType` field alongside dynamic `$` references. Output adds `artifacts.pass{N}` where N is the pass number (1-4).

**Key design decisions:** The Review Worker has elevated resources: 1024MB memory and 300-second timeout (vs 512MB/120s for other workers) to accommodate LLM response latency. The API key is loaded from Secrets Manager via ARN and cached in a module-level variable. The provider is created per invocation using `createProvider()` from `@lintellect/providers`. JSON response parsing handles markdown code fences, extracting JSON even from partially formatted responses. Each comment is mapped to a `ReviewComment` with the pass type injected as the `category`.

**Code pattern (JSON response parsing):**

```typescript
function parseJsonResponse(content: string): { comments?: unknown[]; summary?: string } {
  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }
    return { comments: [], summary: `Failed to parse LLM response as JSON.` };
  }
}
```

### 6.5 Merge Results Lambda

**Purpose and responsibility:** The Merge Results Lambda receives the array of outputs from the Step Functions Parallel state (one per review pass), reads all per-pass outputs from S3, merges their comments into a single array, computes aggregate token usage and duration metrics, and writes the merged review to S3.

**Input/output contract:** Input is an array of `StepFunctionPayload` objects (one from each parallel branch). Output is a single `StepFunctionPayload` with `artifacts.mergedReview` added and all individual pass artifact keys merged.

**Key design decisions:** Artifacts from all parallel branches are merged using `Object.assign()`, which correctly combines the `pass1` through `pass4` keys from each branch's payload. Token usage is summed across all passes. The merged review includes per-pass metadata (pass type, comment count, summary, model ID, tokens, duration) alongside the flat comment array, enabling per-pass analysis in the audit trail.

**Error handling:** If any pass output is missing from S3, the `Promise.all` read will throw. The retry configuration allows 1 retry before failing to the catch state.

### 6.6 Evidence Gate Lambda

**Purpose and responsibility:** The Evidence Gate is the system's hallucination elimination layer. It reads the merged review and parsed diff from S3, runs evidence validation on every comment, splits comments into accepted and rejected arrays, computes evidence metrics (total, accepted count, rejected count, pass rate), writes the validated output to S3, and updates the DynamoDB job record with evidence metrics.

**Input/output contract:** Input is a `StepFunctionPayload` with `artifacts.mergedReview` and `artifacts.parsedDiff`. Output adds `artifacts.output` pointing to the final validated review.

**Key design decisions:** The confidence threshold is configurable via the `CONFIDENCE_THRESHOLD` environment variable (default: 0.3). Evidence validation delegates to `validateEvidence()` from `@lintellect/core`, which performs four checks per comment: confidence threshold, file path existence, line number in hunk range, and whitespace-normalized snippet matching. The output includes both accepted and rejected comments, enabling analysis of what the LLM hallucinated.

**Code pattern (evidence validation invocation):**

```typescript
const evidenceResult = validateEvidence(mergedReview.comments, parsedDiff, {
  confidenceThreshold: getConfidenceThreshold(),
});
```

### 6.7 Comment Poster Lambda

**Purpose and responsibility:** The Comment Poster reads the evidence-validated output from S3 and posts the results to GitHub as an inline PR review. It maps accepted comments to GitHub's review comment format with file paths, line numbers, and formatted bodies. It selects the review event type based on comment severity.

**Input/output contract:** Input is a `StepFunctionPayload` with `artifacts.output`. Output updates the status to `completed`.

**Key design decisions:** If no accepted comments exist, the review is posted as `APPROVE` with a summary indicating no issues found. If any comment has `critical` severity, the review event is `REQUEST_CHANGES`. Otherwise, the event is `COMMENT`. The function handles GitHub's 422 error when requesting changes on your own PR by automatically retrying as `COMMENT`. Comment bodies are formatted with severity emoji indicators, category labels, confidence percentages, and optional `suggestion` blocks using GitHub's suggestion syntax.

**Code pattern (severity-based event selection):**

```typescript
function hasBlockingIssues(comments: ReviewComment[]): boolean {
  return comments.some((c) => c.severity === 'critical');
}
const event = hasBlockingIssues(output.acceptedComments) ? 'REQUEST_CHANGES' : 'COMMENT';
```

### 6.8 Packet Builder (Core)

**Purpose and responsibility:** The Packet Builder constructs `ReviewPacket` objects from raw inputs. It generates a UUID v4 job ID using `crypto.randomUUID()`, assembles repository and pull request metadata, sets timestamps, and optionally validates the result against the JSON schema.

**Input/output contract:** Input is a `PacketBuilderInput` with repository info, pull request metadata, the raw diff, optional commit messages, optional file changes, and optional metadata overrides. Output is a validated `ReviewPacket`.

**Key design decisions:** The job ID uses UUID v4 (via `crypto.randomUUID()`) for global uniqueness. The PR URL is auto-generated from repository metadata if not provided. Schema validation can be skipped via `skipValidation: true` for Lambda environments where the schema files are not available in the bundle. The `detectLanguage()` function maps file extensions to language names for 35+ languages.

### 6.9 Diff Parser (Core)

**Purpose and responsibility:** The Diff Parser wraps the `parse-diff` library, converting raw unified diff strings into structured `ParsedDiff` objects with file paths, statuses, hunks, and individual changes with line numbers.

**Input/output contract:** Input is a raw unified diff string. Output is a `ParsedDiff` containing an array of `ParsedFile` objects, each with path, status (added/modified/deleted/renamed), additions/deletions counts, and an array of `DiffHunk` objects.

**Key design decisions:** File status is resolved by examining `parse-diff`'s `new`, `deleted`, `from`, and `to` fields. The parser provides helper functions for downstream consumers: `getLineContent()` retrieves specific line content, `getLineRange()` retrieves multi-line ranges, `isLineInHunk()` checks if a line falls within any hunk, and `findFile()` looks up files by path (checking both current and previous paths for renames).

### 6.10 Context Gatherer (Core)

**Purpose and responsibility:** The Context Gatherer extracts prompt-ready context from a parsed diff. It builds per-file context with hunk content and surrounding lines, sorts files by change volume (most changes first), and enforces a character budget by truncating lower-priority files and hunks.

**Input/output contract:** Input is a `ParsedDiff` and optional `ContextOptions` (max total chars, context lines). Output is an array of `FileContext` objects and a formatted string for prompt inclusion.

**Key design decisions:** The default budget of 50,000 characters approximates 12,500 tokens at 4 chars/token, leaving ample room for the system prompt, instructions, and evidence gate suffix within a 200K context window. Deleted files are excluded (no new code to review). Budget enforcement is greedy and ordered -- high-change files are included first. The formatted output includes file path headers, language annotations, and line number ranges for each hunk.

### 6.11 Evidence Validator (Core)

**Purpose and responsibility:** The Evidence Validator is the core algorithm behind the Evidence Gate. It checks each `ReviewComment` against a `ParsedDiff` for evidence validity: file path existence, line number in hunk range, end line number validity, and whitespace-normalized code snippet matching.

**Input/output contract:** Input is an array of `ReviewComment` objects, a `ParsedDiff`, and optional validation options (confidence threshold, strict snippet matching). Output is an `EvidenceResult` containing accepted comments, rejected comments with reasons, and aggregate metrics.

**Key design decisions:** Whitespace normalization collapses all whitespace (tabs, multiple spaces, line endings) to single spaces and trims each line before comparison. Snippet matching is bidirectional: either the snippet contains the actual code or the actual code contains the snippet. This handles cases where the LLM quotes a subset or superset of the actual code. A zero-comment input returns a pass rate of 1.0 (no failures).

**Code pattern (whitespace normalization):**

```typescript
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

### 6.12 Schema Validator (Core)

**Purpose and responsibility:** The Schema Validator provides Ajv-based JSON Schema draft-07 validation for all five Lintellect data schemas. It lazily discovers the `schemas/` directory by walking up from the current file, compiles schemas on first use, and caches compiled validators for subsequent calls.

**Input/output contract:** Input is an unknown value to validate and a schema name. Output is a `ValidationResult` with a `valid` boolean and an array of `ValidationError` objects (path, message, keyword).

**Key design decisions:** The schema directory is found using a walk-up pattern (`findSchemasDir()`) that starts from `import.meta.url` and traverses parent directories up to 10 levels. This works regardless of build depth or monorepo structure. Referenced schemas (e.g., `review-output` references `review-comment`) are pre-loaded before compilation. Validators are cached in a `Map<SchemaName, ValidateFunction>` for reuse.

### 6.13 Prompt Runner (Core)

**Purpose and responsibility:** The Prompt Runner orchestrates the complete multi-pass review pipeline for CLI usage. It parses the diff, gathers context, executes all configured passes (in parallel or sequential mode), merges results, and runs evidence validation. This module encapsulates the same logic that the Lambda-based pipeline distributes across 7 functions.

**Input/output contract:** Input is a `ReviewPacket`, an `LLMProvider`, and optional `PromptRunnerOptions` (parallel mode, which passes to run, max output tokens, confidence threshold, max context chars). Output is a `RunResult` containing per-pass outputs, merged evidence-validated comments, total token usage, and total duration.

**Key design decisions:** Parallel execution uses `Promise.all()` for maximum throughput. Sequential mode exists for debugging and rate limit avoidance. The JSON response parser handles three common LLM output formats: clean JSON, markdown-fenced JSON, and JSON embedded in prose. Failed JSON parsing returns an empty comment array with an explanatory summary rather than throwing.

### 6.14 OpenRouter Provider

**Purpose and responsibility:** The OpenRouter Provider implements the `LLMProvider` interface using the OpenAI SDK with a custom base URL pointing to `https://openrouter.ai/api/v1`. This provides access to 200+ models (Claude, GPT-4, Gemini, Llama, Mistral, etc.) through a single adapter.

**Input/output contract:** Input is a prompt string and `ReviewRequestOptions` (temperature, max output tokens, timeout, optional system prompt). Output is an `LLMResponse` with content, model ID, token usage, and duration.

**Key design decisions:** The OpenAI SDK is used because OpenRouter exposes an OpenAI-compatible API. The same code works against any OpenAI-compatible endpoint by changing the base URL. Custom headers (`HTTP-Referer`, `X-Title`) are supported for OpenRouter's attribution system. Token usage is extracted from the response's `usage` field.

### 6.15 Bedrock Provider

**Purpose and responsibility:** The Bedrock Provider implements the `LLMProvider` interface using the AWS Bedrock `InvokeModel` API with the Anthropic Messages API format. This enables Claude model access that stays entirely within the AWS network.

**Input/output contract:** Same as OpenRouter -- prompt string and `ReviewRequestOptions` in, `LLMResponse` out.

**Key design decisions:** The Bedrock SDK is dynamically imported to avoid bundling it when not in use. The request body uses `anthropic_version: 'bedrock-2023-05-31'` and places the system prompt as a top-level `system` field (not a message), following Bedrock's Messages API format. The client is lazily initialized and cached for reuse across invocations.

### 6.16 Base Provider

**Purpose and responsibility:** The Base Provider is an abstract class that implements the retry-with-exponential-backoff pattern shared by all LLM providers. Concrete providers inherit from it and get automatic retry handling for transient failures.

**Input/output contract:** Subclasses call `this.withRetry(async () => { ... })` to wrap their API calls. The retry logic handles retryable errors (rate limits, server errors, timeouts, connection resets) with configurable max retries, base delay, max delay, and optional jitter.

**Key design decisions:** Jitter uses full jitter (random value between 0 and the calculated delay) to prevent thundering herd problems. The `isRetryable()` method checks error messages for patterns like `429`, `500`, `502`, `503`, `timeout`, `econnreset`, and `econnrefused`. Non-retryable errors (e.g., `400 Bad Request`) fail immediately without retry. Default policy: 3 retries, 2s base delay, 16s max delay, jitter enabled.

```typescript
private calculateDelay(attempt: number): number {
  const exponential = Math.min(
    this.retryPolicy.baseDelayMs * Math.pow(2, attempt),
    this.retryPolicy.maxDelayMs
  );
  if (this.retryPolicy.jitter) {
    return Math.random() * exponential;
  }
  return exponential;
}
```

### 6.17 CDK Infrastructure

**Purpose and responsibility:** The CDK infrastructure defines the entire Lintellect deployment as a single `LintellectStack` containing two nested constructs: `ControlPlaneConstruct` (DynamoDB, API Gateway) and `DataPlaneConstruct` (S3, SQS, Lambdas, Step Functions, Secrets Manager references).

**Key design decisions:** A single stack avoids circular cross-stack references (DynamoDB is created in the control plane but needed by data plane Lambdas). Nested constructs provide logical separation without the complexity of multi-stack deployments. All Lambda functions share common props (runtime, architecture, bundling, log retention) via a `commonLambdaProps` object. IAM permissions are granted using CDK's high-level methods (`grantReadWrite`, `grantStartExecution`, `grantRead`) rather than manual policy definitions.

### 6.18 Step Functions State Machine

**Purpose and responsibility:** The state machine orchestrates the review pipeline with a chain of: ParseDiff -> GatherContext -> ParallelReview (4 branches) -> MergeResults -> EvidenceGate -> PostComments. Each step has retry and catch configurations. The overall execution has a 15-minute timeout.

**Key design decisions:** The Parallel state passes each branch a static `passType` field alongside dynamic state references using Step Functions intrinsic functions (`$.jobId`, `$.bucket`, etc.). Retry policies use exponential backoff: 2 retries at 2s/5s base delays for compute tasks, 3 retries at 2s for the comment poster (GitHub API rate limits). All tasks catch errors and route to a central `PipelineFailed` Fail state. Execution logging at the ALL level with execution data included enables complete debugging.

### 6.19 DynamoDB Job Table

**Purpose and responsibility:** The Job Table tracks the lifecycle of every review job with status transitions, timestamps, repository metadata, evidence metrics, token usage, and error information.

**Key design decisions:** Partition key is `jobId` (UUID v4). Two GSIs enable queries by repository name (`repository-index`) and PR URL (`prUrl-index`), both sorted by `createdAt`. TTL attribute enables automatic cleanup. Point-in-time recovery is enabled for data protection. On-demand billing eliminates capacity planning. Conditional writes (`ConditionExpression: 'attribute_not_exists(jobId)'`) prevent duplicate job creation.

### 6.20 S3 Artifact Storage

**Purpose and responsibility:** The S3 bucket stores all review artifacts under job-specific prefixes (`packets/{jobId}/`). Each job produces up to 9 objects (input, parsed diff, context, 4 pass outputs, merged review, final output).

**Key design decisions:** S3-managed encryption (SSE-S3) for at-rest encryption. Block all public access. 90-day lifecycle rule for automatic cleanup. JSON objects are stored with `Content-Type: application/json` and pretty-printed with 2-space indentation for human readability during debugging.

### 6.21 CLI Tool

**Purpose and responsibility:** The CLI provides local code review via the `lintellect review` command. It reads a diff from file or stdin, builds a ReviewPacket, creates an OpenRouter provider, runs the multi-pass pipeline, and outputs results in formatted text or JSON.

**Input/output contract:** Input is a diff file (`--file`), piped stdin, or command flags. Output is formatted review results to stdout or JSON (`--json`).

**Key design decisions:** The CLI uses the same `@lintellect/core` and `@lintellect/providers` packages as the Lambda pipeline, ensuring identical review behavior. It supports `--passes` for selecting which passes to run, `--sequential` for debugging, `--confidence` for threshold tuning, and `--json` for machine-readable output. The API key is read from `OPENROUTER_API_KEY` environment variable or `.env` file via `dotenv`.

### 6.22 JSON Schemas

Five JSON Schema draft-07 files define all data contracts:

1. **review-packet.schema.json:** Defines the ReviewPacket with jobId (UUID pattern), repository (owner/name/fullName), pullRequest (number, title, description, author, baseSha, headSha, url), diff, commitMessages, files (path, language, status enum, previousPath, additions, deletions), createdAt (date-time), and metadata (webhookEventId, installationId).

2. **review-output.schema.json:** Defines per-pass output with jobId, passType (enum), passNumber (1-4), comments (array of review-comment refs), summary, modelId, tokensUsed (input/output/total), durationMs, completedAt.

3. **review-comment.schema.json:** Defines individual comments with filePath, lineNumber, optional endLineNumber, codeSnippet, severity (critical/warning/suggestion/nitpick), category (structural/logic/style/security), message, optional suggestion, confidence (0.0-1.0).

4. **provider-config.schema.json:** Defines provider configuration with provider (openrouter/bedrock), modelId, temperature, maxOutputTokens, timeoutMs, retryPolicy (maxRetries, baseDelayMs, maxDelayMs, jitter), optional fallbackProvider, optional region (required for bedrock), optional apiKeySecretArn.

5. **job-status.schema.json:** Defines DynamoDB job records with jobId, status (11-value enum from PENDING to SKIPPED), prUrl, repoFullName, prNumber, headSha, baseSha, author, createdAt, updatedAt, optional errorMessage, failedStep, reviewUrl, evidenceMetrics, s3Prefix, executionArn, expiresAt (TTL).

### 6.23 Shared Helpers

**S3 Helpers** (`s3-helpers.ts`): Four functions wrapping the S3 SDK -- `readJsonFromS3<T>()`, `writeJsonToS3()`, `readTextFromS3()`, `writeTextToS3()`. All use a module-level `S3Client` instance for connection reuse. JSON writes are pretty-printed with 2-space indentation. Reads throw on empty objects.

**DynamoDB Helpers** (`dynamo-helpers.ts`): Three functions wrapping the DynamoDB Document Client -- `createJobRecord()` with conditional writes, `updateJobStatus()` with dynamic expression building for extra fields, and `failJob()` which is a convenience wrapper. The `updateJobStatus` function dynamically constructs UpdateExpression, ExpressionAttributeNames, and ExpressionAttributeValues from an optional `extraFields` record.

**Type Definitions** (`types.ts`): Defines `JobArtifacts` (S3 key references for all 9 artifact types), `StepFunctionPayload` (the token passed through the state machine), `GitHubWebhookEvent` (subset of GitHub's webhook payload), `LambdaEnv` (expected environment variables), and `JobRecord` (DynamoDB item shape).

---

## 7. Data Flow -- End to End

### 7.1 Step 1: Developer Opens a Pull Request

A developer pushes a branch to GitHub and opens (or updates) a pull request. GitHub's webhook system detects the `pull_request` event with an action of `opened`, `synchronize`, or `reopened`.

### 7.2 Step 2: GitHub Sends Webhook

GitHub sends an HTTP POST request to the Lintellect webhook URL (`https://{api-id}.execute-api.{region}.amazonaws.com/webhook/github`). The request includes the PR metadata in the JSON body, an HMAC-SHA256 signature in the `X-Hub-Signature-256` header, the event type (`pull_request`) in `X-GitHub-Event`, and a unique delivery ID in `X-GitHub-Delivery`.

### 7.3 Step 3: Webhook Lambda Processes the Event

The Webhook Lambda executes 7 operations in sequence:

1. **Validate signature:** Computes HMAC-SHA256 of the request body using the webhook secret from Secrets Manager and compares it with the provided signature using `timingSafeEqual`.
2. **Filter event type:** Only `pull_request` events proceed; all others return 200 (ignored).
3. **Filter action:** Only `opened`, `synchronize`, and `reopened` actions proceed.
4. **Fetch diff:** Calls the GitHub API to retrieve the unified diff using the GitHub token from Secrets Manager.
5. **Build packet:** Calls `buildPacket()` to construct a `ReviewPacket` with a UUID job ID.
6. **Store and record:** Writes the packet to S3 (`packets/{jobId}/input.json`) and creates a DynamoDB job record.
7. **Start execution:** Triggers the Step Functions state machine with a `StepFunctionPayload` containing the job ID, bucket name, artifact keys, repository info, and PR metadata.

**Data stored:** ReviewPacket in S3, JobRecord in DynamoDB.

### 7.4 Step 4: ParseDiff State

The Step Functions state machine invokes the Diff Worker Lambda. It reads the ReviewPacket from S3, extracts the raw diff string, parses it using `parsePatch()` into a structured `ParsedDiff` (files with paths, statuses, hunks, and changes), and writes the result to S3.

**Data stored:** `packets/{jobId}/parsed-diff.json` in S3.

### 7.5 Step 5: GatherContext State

The Context Worker Lambda reads the parsed diff from S3, builds context for each file's hunks with surrounding lines, sorts by change volume, enforces the character budget (default 50,000 chars), formats the context for prompt inclusion, and writes both raw and formatted context to S3.

**Data stored:** `packets/{jobId}/context.json` in S3.

### 7.6 Step 6: ParallelReview State

The Step Functions Parallel state spawns 4 concurrent Lambda invocations, one for each pass type. Each Review Worker Lambda:

1. Reads the ReviewPacket and context from S3.
2. Constructs a system prompt with the pass-specific role and instructions.
3. Constructs a user prompt with the PR title/description, diff, context, evidence gate enforcement suffix, and response schema.
4. Invokes the LLM provider with the pass-specific temperature.
5. Parses the JSON response, extracting comments and summary.
6. Maps comments to `ReviewComment` objects with the pass type as category.
7. Writes the pass output to S3.

**Data stored:** `packets/{jobId}/pass-1.json` through `pass-4.json` in S3.

### 7.7 Step 7: MergeResults State

The Merge Results Lambda receives the array of 4 parallel outputs, reads all pass outputs from S3, flattens all comments into a single array, computes aggregate metrics (total tokens, total duration, per-pass summaries), and writes the merged review to S3.

**Data stored:** `packets/{jobId}/merged-review.json` in S3.

### 7.8 Step 8: EvidenceGate State

The Evidence Gate Lambda reads the merged review and parsed diff from S3, runs evidence validation on every comment, splits them into accepted and rejected arrays, computes evidence metrics, writes the validated output to S3, and updates the DynamoDB job record with metrics.

**Data stored:** `packets/{jobId}/output.json` in S3, evidence metrics in DynamoDB.

### 7.9 Step 9: PostComments State

The Comment Poster Lambda reads the validated output from S3, constructs GitHub PR review comments with formatted bodies (severity emoji, category, message, suggestion blocks, confidence), selects the review event type (APPROVE/COMMENT/REQUEST_CHANGES), and posts the review via the GitHub API.

**Data stored:** Job status updated to `completed` in DynamoDB. Review posted to GitHub.

### 7.10 Step 10: Developer Sees Review

The developer sees Lintellect's review on their pull request with inline comments on specific lines, severity indicators, actionable messages, and optional code suggestions. The review summary includes evidence pass rate, comment counts by severity, token usage, and review duration.

---

## 8. Multi-Pass Review Strategy

### 8.1 Pass 1: Structural Analysis

**What it looks for:** Syntax errors preventing compilation. Import/export correctness and missing dependencies. Type definition accuracy and interface contract violations. Function signature mismatches (parameter types, return types). Dead code and unreachable statements. Unused imports and variables. Module structure and file organization issues.

**System prompt excerpt:**

```
You are a senior code reviewer performing a STRUCTURAL analysis pass.
Focus on:
- Import/export correctness and missing dependencies
- Module structure and file organization
- Type definitions and interface contracts
- Function signatures, parameter types, return types
- Dead code and unused imports
- Naming conventions and consistency
Do NOT comment on logic bugs, style preferences, or security issues in this pass.
Category for all comments: "structural"
```

**Temperature:** 0.1 -- Structural analysis demands precision. A hallucinated syntax error wastes developer attention and erodes trust. Low temperature maximizes determinism and reduces false positives.

**Severity guidelines:** Critical for syntax errors preventing compilation and type errors that would crash at runtime. Warning for missing declarations and circular imports. Suggestion for dead code and unused imports. Nitpick for import ordering preferences.

### 8.2 Pass 2: Logic and Correctness

**What it looks for:** Off-by-one errors and boundary condition failures. Null/undefined handling gaps and type coercion bugs. Race conditions and async/await misuse. Missing error handling or silenced errors (empty catch blocks). Incorrect algorithm implementations. State mutation bugs and shallow copy issues. Resource leaks (unclosed file handles, missing cleanup in finally blocks).

**System prompt excerpt:**

```
You are a senior code reviewer performing a LOGIC and CORRECTNESS pass.
Focus on:
- Off-by-one errors, boundary conditions
- Null/undefined handling, type coercion bugs
- Race conditions, async/await misuse
- Missing error handling or silenced errors
- Incorrect algorithm implementations
- State mutation bugs, shallow copy issues
- Resource leaks (unclosed handles, missing cleanup)
Do NOT comment on naming, formatting, or import structure in this pass.
Category for all comments: "logic"
```

**Temperature:** 0.2 -- Logic analysis requires the LLM to reason about execution paths, which benefits from a small amount of exploration. The temperature is kept low because incorrect logic findings are actively harmful -- a false positive suggesting a bug where none exists can lead to unnecessary code changes.

**Severity guidelines:** Critical for bugs that cause crashes or data corruption. Warning for edge cases that may fail under specific conditions. Suggestion for defensive coding improvements. Nitpick for minor logic simplifications.

### 8.3 Pass 3: Style and Best Practices

**What it looks for:** Code readability and maintainability issues. DRY violations and unnecessary duplication. Overly complex expressions that could be simplified. Missing or misleading comments on non-obvious code. Idiomatic patterns for the language in use. Consistent formatting within changed code.

**System prompt excerpt:**

```
You are a senior code reviewer performing a STYLE and BEST PRACTICES pass.
Focus on:
- Code readability and maintainability
- DRY violations and unnecessary duplication
- Overly complex expressions that could be simplified
- Missing or misleading comments on non-obvious code
- Idiomatic patterns for the language in use
- Consistent formatting within the changed code
Do NOT comment on logic bugs or security issues in this pass.
Category for all comments: "style"
```

**Temperature:** 0.3 -- Style analysis is inherently subjective. Slightly higher temperature allows the LLM to generate more creative refactoring ideas and identify non-obvious DRY violations. False positives here are low-cost: a rejected style suggestion is merely ignored, not harmful.

**Severity guidelines:** Warning for DRY violations and significant readability issues. Suggestion for improved patterns and simplifications. Nitpick for formatting and naming preferences. Critical and warning are rarely used for style.

### 8.4 Pass 4: Security Scan

**What it looks for:** Injection vulnerabilities (SQL, command, XSS, template injection). Authentication and authorization bypasses. Sensitive data exposure (secrets, PII, tokens in log statements). Insecure cryptographic usage. Path traversal, SSRF, and open redirects. Unsafe deserialization. Missing input validation at trust boundaries. Hardcoded credentials or API keys.

**System prompt excerpt:**

```
You are a senior code reviewer performing a SECURITY analysis pass.
Focus on:
- Injection vulnerabilities (SQL, command, XSS, template)
- Authentication and authorization bypasses
- Sensitive data exposure (secrets, PII, tokens in logs)
- Insecure cryptographic usage
- Path traversal, SSRF, open redirects
- Unsafe deserialization
- Missing input validation at trust boundaries
- Hardcoded credentials or API keys
Only flag REAL security concerns with HIGH confidence. Do NOT flag stylistic issues.
Category for all comments: "security"
```

**Temperature:** 0.1 -- Security findings demand the highest precision. A false positive security alert can trigger unnecessary incident response processes. The security pass explicitly instructs the LLM to "Only flag REAL security concerns with HIGH confidence."

**Severity guidelines:** Critical for exploitable vulnerabilities (injection, auth bypass, exposed secrets). Warning for defense-in-depth issues. Suggestion for security hardening improvements. Nitpick is rarely used for security.

### 8.5 Why 4 Passes Instead of 1

Three empirically observed problems with single-pass review justify the multi-pass architecture:

1. **Attention dilution.** When asked to check for structural, logic, style, and security issues simultaneously, the LLM distributes attention across all dimensions and produces shallow analysis in each. Four focused prompts produce deeper analysis per dimension.

2. **Output budget contention.** A single prompt must fit all findings into one output budget (typically 4096 tokens). If the LLM generates many style comments, it may truncate security findings. Four separate passes each get their own budget.

3. **Temperature mismatch.** Structural and security analysis demand low temperature (0.1) for precision. Style analysis benefits from higher temperature (0.3) for creative suggestions. A single pass cannot serve both needs.

### 8.6 How Results Are Merged and Deduplicated

After the four passes complete, the Merge Results Lambda collects all comments into a single array. Currently, deduplication is handled implicitly: each pass produces comments with a distinct `category` field (structural, logic, style, security), so identical issues found by different passes are distinguishable. The Evidence Gate then filters the merged set, removing hallucinated comments. Future work includes cross-pass deduplication using code snippet similarity.
