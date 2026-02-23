# RFC-001: Lintellect -- Production-Grade AI-Powered Code Review System

```
RFC:          001
Title:        Lintellect Production Architecture
Author:       Plan Agent
Status:       DRAFT
Created:      2026-02-07
Updated:      2026-02-07
Supersedes:   Baseline Lambda-chained pipeline
```

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Control Plane vs Data Plane Architecture](#2-control-plane-vs-data-plane-architecture)
3. [SQS + Step Functions Orchestration Rationale](#3-sqs--step-functions-orchestration-rationale)
4. [S3 Packet Storage + DynamoDB Metadata Design](#4-s3-packet-storage--dynamodb-metadata-design)
5. [Evidence Gate Validator Specification](#5-evidence-gate-validator-specification)
6. [Provider-Pluggable LLM Contract](#6-provider-pluggable-llm-contract)
7. [Security Model](#7-security-model)
8. [Failure Modes and Retry Semantics](#8-failure-modes-and-retry-semantics)
9. [Migration Path from Baseline](#9-migration-path-from-baseline)
10. [Open Questions](#10-open-questions)
11. [References](#11-references)

---

## 1. Problem Statement

The baseline Lintellect system chains AWS Lambda functions directly via event triggers with no orchestration layer. While this architecture was sufficient for prototyping, it exhibits seven critical deficiencies that prevent production deployment.

### 1.1 No Orchestration

Lambda functions invoke each other directly or through event triggers (S3 put events, DynamoDB streams). There is no centralized view of a review's progress. If the diff-parser Lambda completes but the context-gatherer Lambda fails to trigger, the review silently stalls. Debugging requires correlating CloudWatch logs across multiple Lambda log groups manually, with no guarantee that log entries share a common identifier.

### 1.2 No Durable State

The review pipeline maintains no persistent record of a job's lifecycle. Each Lambda receives its input, processes it, and invokes the next Lambda. If any Lambda fails mid-execution -- due to a timeout, an out-of-memory error, or a transient network failure -- the entire review is lost. There is no mechanism to resume from the point of failure. The only recovery path is to re-trigger the webhook, which re-runs the entire pipeline from scratch.

### 1.3 No Artifact Storage

Diffs, parsed ASTs, gathered context, and review results exist only in Lambda memory and in the event payloads passed between functions. Once a Lambda completes (or fails), its intermediate artifacts vanish. This creates three problems: (a) debugging failures requires reproducing the exact input conditions, (b) there is no audit trail of what the LLM was asked or what it responded, and (c) there is no way to compare review quality over time.

### 1.4 No Evidence Validation

The LLM generates review comments that reference specific line numbers and code snippets. However, the baseline system posts these comments to GitHub without verifying that the cited evidence actually exists in the diff. LLMs routinely hallucinate line numbers, paraphrase code instead of quoting it exactly, and reference files that were not modified. These phantom citations erode developer trust and render the review system unreliable.

### 1.5 No Provider Abstraction

The baseline system is hardcoded to a single LLM provider (Amazon Bedrock with Claude). The API call, prompt format, retry logic, and error handling are all tightly coupled to Bedrock's SDK. Switching to the Anthropic direct API (for lower latency or newer model access), adding OpenAI as a fallback, or testing with a local model requires rewriting the review Lambda.

### 1.6 No Control/Data Plane Separation

The webhook handler, job tracking, diff parsing, LLM invocation, and comment posting all operate at the same privilege level with the same IAM permissions. The webhook-handling Lambda has access to S3, DynamoDB, Bedrock, and the GitHub API. A vulnerability in webhook parsing could expose LLM credentials. There is no security boundary between job management (control plane) and review execution (data plane).

### 1.7 No Retry Semantics

Lambda's built-in retry mechanism re-invokes the entire function from scratch. For the review Lambda -- which may have already consumed LLM tokens and generated partial results -- this means paying for the same tokens twice and potentially producing duplicate review comments. There are no per-step retries, no exponential backoff, no dead-letter queues for poison messages, and no distinction between transient failures (network timeouts) and permanent failures (invalid diff format).

### 1.8 Summary

These deficiencies are not independent. They compound: the lack of orchestration makes failures invisible, the lack of durable state makes failures unrecoverable, the lack of artifact storage makes failures uninvestigable, and the lack of evidence validation makes successful reviews untrustworthy. Lintellect addresses all seven deficiencies as a unified architectural upgrade.

---

## 2. Control Plane vs Data Plane Architecture

Lintellect separates concerns into two distinct planes, each with its own resources, permissions, and scaling characteristics.

### 2.1 Control Plane

The control plane is responsible for job lifecycle management. It receives external events, creates job records, orchestrates the review workflow, and exposes job status for monitoring.

**Components:**

| Component | Service | Responsibility |
|-----------|---------|----------------|
| Webhook Endpoint | API Gateway (HTTP API) | Receives GitHub webhook POST requests, validates signatures |
| Webhook Handler | Lambda | Parses webhook payload, creates job record, enqueues work |
| Intake Queue | SQS (Standard) | Buffers incoming review requests, decouples webhook from processing |
| Dead Letter Queue | SQS | Captures messages that fail processing after max retries |
| Orchestrator | Step Functions (Standard) | Manages the review workflow state machine with retry and error handling |
| Job Table | DynamoDB | Stores job metadata: jobId, status, timestamps, PR metadata, error messages |

**Control plane invariants:**

- The control plane never reads or writes review data (diffs, context, LLM responses) directly. It only reads and writes S3 keys (references) and DynamoDB job metadata.
- The control plane never communicates with the LLM provider.
- The control plane never communicates with the GitHub API for posting comments (only for webhook validation).

### 2.2 Data Plane

The data plane is responsible for review execution. It performs the computationally intensive work of parsing diffs, gathering context, running LLM reviews, and validating evidence.

**Components:**

| Component | Service | Responsibility |
|-----------|---------|----------------|
| Diff Worker | Lambda | Parses unified diffs into structured, AST-aware representations |
| Context Worker | Lambda | Fetches surrounding code, imports, PR description, commit messages |
| Review Worker | Lambda | Assembles prompts, calls LLM provider, collects structured review output |
| Evidence Gate | Lambda | Validates every review comment against the actual diff content |
| Comment Poster | Lambda | Formats validated review as GitHub PR review, posts via GitHub API |
| Artifact Store | S3 | Stores review packets, per-pass results, and final merged output |

**Data plane invariants:**

- Data plane Lambdas are stateless. All state is externalized to S3 (artifacts) and DynamoDB (job status).
- Data plane Lambdas read their input from S3 and write their output to S3. They never pass data through Step Functions state (avoiding the 256KB payload limit).
- Data plane Lambdas update DynamoDB job status at each step transition.

### 2.3 Separation Rationale

**Independent scaling.** The control plane handles bursty webhook traffic (many PRs opened simultaneously). The data plane handles sustained compute load (LLM inference). These scaling profiles are fundamentally different. SQS absorbs control plane spikes. Data plane Lambdas scale based on concurrent Step Functions executions.

**Failure isolation.** A failure in the data plane (e.g., LLM provider outage) does not affect the control plane's ability to accept new webhooks and enqueue work. Jobs queue up and process when the provider recovers. Conversely, a control plane failure (e.g., DynamoDB throttling) does not corrupt in-progress reviews.

**Security boundary.** The control plane requires internet access (to receive webhooks from GitHub). The data plane requires internet access only to reach the LLM provider endpoint. Data plane Lambdas are deployed in a VPC with a NAT Gateway configured to allow egress only to known LLM provider IP ranges. This limits the blast radius of a compromised Lambda.

**Operational clarity.** When an alert fires, the team immediately knows whether it is a control plane issue (webhook failures, queue depth, job table errors) or a data plane issue (LLM timeouts, evidence gate rejections, S3 access errors). This reduces mean time to diagnosis.

---

## 3. SQS + Step Functions Orchestration Rationale

### 3.1 Why Not Direct Lambda Chaining

The baseline system uses direct Lambda invocation: each Lambda calls the next Lambda synchronously or asynchronously. This approach has the following defects:

| Defect | Impact |
|--------|--------|
| No visibility into pipeline progress | Cannot determine which step a review is in without checking all Lambda logs |
| No built-in retry with backoff | Lambda retries re-run from scratch; no per-step retry configuration |
| No parallel execution | Multi-file reviews must be processed sequentially or require custom fan-out logic |
| No timeout handling per step | Lambda timeout applies to the entire function, not to individual operations within it |
| No error routing | A failure in any Lambda crashes the entire pipeline; no catch-and-continue |
| No audit trail | No centralized record of what happened, in what order, or how long each step took |

### 3.2 Why SQS for Intake

SQS sits between the webhook handler and Step Functions for three reasons:

1. **Traffic absorption.** A repository with many contributors may produce dozens of PRs per minute during active development. SQS absorbs this burst and feeds Step Functions at a controlled rate, preventing throttling.

2. **At-least-once delivery.** If the Step Functions API is temporarily unavailable, the message remains in the queue and is retried. Without SQS, the webhook handler would need to implement its own retry logic or risk losing the event.

3. **Dead Letter Queue.** Messages that fail processing after `maxReceiveCount` attempts (default: 3) are automatically moved to a DLQ. This prevents poison messages (malformed webhooks, unsupported event types) from blocking the queue indefinitely. A CloudWatch alarm on DLQ depth alerts the team to investigate.

4. **Decoupling.** The webhook handler's only job is to validate the signature and enqueue the message. It returns HTTP 202 immediately. This keeps webhook response times well under GitHub's 10-second timeout, regardless of how long the review takes.

### 3.3 Step Functions State Machine

The review pipeline is implemented as an AWS Step Functions Standard Workflow with the following states:

```
ValidateWebhook --> BuildPacket --> ParseDiff --> GatherContext --> RunReview --> EvidenceGate --> PostComment
                                                                     |
                                                                     +--> [Parallel: 4 review passes]
                                                                           Pass 1: Structural
                                                                           Pass 2: Logic
                                                                           Pass 3: Style
                                                                           Pass 4: Security
```

**State details:**

| State | Type | Lambda | Timeout | Retry | Purpose |
|-------|------|--------|---------|-------|---------|
| ValidateWebhook | Task | webhook-validator | 10s | 0 (deterministic) | Validate payload structure, check for duplicate jobs |
| BuildPacket | Task | packet-builder | 30s | 2 retries, 2s backoff | Assemble review packet from PR metadata, write to S3 |
| ParseDiff | Task | diff-worker | 60s | 2 retries, 2s backoff | Parse unified diff into structured format, write to S3 |
| GatherContext | Task | context-worker | 60s | 2 retries, 2s backoff | Fetch surrounding code and related files, write to S3 |
| RunReview | Parallel | review-worker (x4) | 300s per branch | 3 retries, 2s/4s/8s backoff | Run 4 review passes concurrently, write per-pass results to S3 |
| EvidenceGate | Task | evidence-gate | 30s | 0 (deterministic) | Validate all comments against diff, strip invalid ones, write to S3 |
| PostComment | Task | comment-poster | 30s | 2 retries, 2s backoff | Format and post validated review to GitHub |

Each state includes a `Catch` block that transitions to a `HandleFailure` state. `HandleFailure` writes the error details to DynamoDB (updating the job status to `FAILED` with `errorMessage` and `failedStep`) and terminates the execution.

### 3.4 Standard vs Express Workflows

Lintellect uses **Standard Workflows**, not Express Workflows, for three reasons:

1. **Execution duration.** Express Workflows have a maximum duration of 5 minutes. A large PR with extensive context gathering and four parallel LLM review passes can exceed this limit. Standard Workflows support up to 1 year of execution (though reviews should complete in minutes).

2. **Audit trail.** Standard Workflows log every state transition to CloudWatch Logs (or optionally to an S3 bucket). This provides a complete, queryable history of every review job. Express Workflows provide only start/end events by default.

3. **Exactly-once execution.** Standard Workflows guarantee exactly-once execution per invocation. Express Workflows provide at-least-once semantics, which could result in duplicate review comments.

The cost difference is marginal for the expected volume (Standard: $0.025 per 1000 state transitions; at an average of 7 states per review, 1000 reviews cost $0.175).

---

## 4. S3 Packet Storage + DynamoDB Metadata Design

### 4.1 S3 Artifact Structure

All review artifacts are stored in a single S3 bucket with environment-parameterized naming:

```
s3://lintellect-{env}/
  packets/
    {jobId}/
      input.json          # Review packet: PR metadata + raw diff
  diffs/
    {jobId}/
      parsed-diff.json    # Structured, AST-aware diff output
  context/
    {jobId}/
      context.json        # Gathered surrounding code, imports, PR description
  reviews/
    {jobId}/
      pass-1.json         # Structural review pass output
      pass-2.json         # Logic review pass output
      pass-3.json         # Style review pass output
      pass-4.json         # Security review pass output
      output.json          # Final merged review (all passes combined)
      validated.json       # Post-evidence-gate review (invalid comments stripped)
```

**Design decisions:**

- **Job ID as prefix.** Using `{jobId}` (a ULID) as the S3 key prefix ensures unique, time-sortable paths with no collision risk. ULIDs are lexicographically sortable by creation time, which aids debugging.
- **Immutable artifacts.** Artifacts are written once and never updated. Each step writes a new object rather than overwriting. This provides a complete audit trail of every intermediate state.
- **Versioning disabled.** Because artifacts are immutable and identified by job ID, S3 versioning would add cost without benefit.

**Lifecycle policies:**

| Prefix | Expiration | Rationale |
|--------|------------|-----------|
| `packets/` | 30 days | Input data can be reconstructed from the PR; retained briefly for debugging |
| `diffs/` | 30 days | Intermediate artifact; same retention as packets |
| `context/` | 30 days | Intermediate artifact; same retention as packets |
| `reviews/` | 90 days | Final output; retained longer for quality analysis and comparison |

### 4.2 DynamoDB Metadata Schema

**Table name:** `lintellect-jobs-{env}`

**Key schema:**

| Attribute | Key Type | Type | Description |
|-----------|----------|------|-------------|
| `jobId` | Partition Key | String (ULID) | Unique identifier for each review job |
| `sk` | Sort Key | String | Record type discriminator (e.g., `META`, `STATUS#1707321600000`) |

**Record types:**

**META record** (`sk = "META"`):

| Attribute | Type | Description |
|-----------|------|-------------|
| `jobId` | String | ULID |
| `sk` | String | `"META"` |
| `prUrl` | String | Full PR URL (e.g., `https://github.com/org/repo/pull/42`) |
| `repoFullName` | String | Repository full name (e.g., `org/repo`) |
| `prNumber` | Number | PR number |
| `headSha` | String | Head commit SHA |
| `baseSha` | String | Base commit SHA |
| `author` | String | PR author login |
| `status` | String | Current status enum (see below) |
| `createdAt` | String | ISO 8601 timestamp |
| `updatedAt` | String | ISO 8601 timestamp |
| `errorMessage` | String | Error details if status is `FAILED` (optional) |
| `failedStep` | String | Step name where failure occurred (optional) |
| `reviewUrl` | String | GitHub URL of posted review (optional, set on completion) |
| `expiresAt` | Number | TTL epoch seconds (createdAt + 90 days) |

**Status enum:**

```
PENDING --> VALIDATING --> BUILDING_PACKET --> PARSING_DIFF --> GATHERING_CONTEXT
  --> RUNNING_REVIEW --> EVIDENCE_GATE --> POSTING --> COMPLETED
                                                  \--> FAILED
                                                  \--> SKIPPED
```

**STATUS history records** (`sk = "STATUS#{timestamp}"`):

Each status transition creates a new record with the sort key `STATUS#{epochMillis}`. This provides a complete timeline of the job's progression through the pipeline, queryable by time range.

| Attribute | Type | Description |
|-----------|------|-------------|
| `jobId` | String | ULID |
| `sk` | String | `STATUS#{epochMillis}` |
| `status` | String | The status being entered |
| `stepDurationMs` | Number | Duration of the previous step in milliseconds |
| `metadata` | Map | Step-specific metadata (e.g., `passCount`, `commentsGenerated`, `commentsRejected`) |

**Global Secondary Indexes:**

| GSI Name | Partition Key | Sort Key | Purpose |
|----------|---------------|----------|---------|
| `prUrl-index` | `prUrl` | `createdAt` | Look up all jobs for a specific PR (e.g., re-reviews after force-push) |
| `repoFullName-index` | `repoFullName` | `createdAt` | Look up all jobs for a repository (e.g., activity dashboard) |

**Capacity mode:** On-demand (PAY_PER_REQUEST). Review volume is unpredictable and bursty. On-demand pricing eliminates capacity planning and auto-scales to any load.

### 4.3 Pass-by-Reference Pattern

Step Functions has a 256KB payload limit per state transition. A single large diff can easily exceed this. Lintellect enforces a strict pass-by-reference pattern:

- Step Functions state contains only S3 keys, job metadata, and status flags.
- Worker Lambdas read their input from S3 using the key provided in the state input.
- Worker Lambdas write their output to S3 and return only the output S3 key.
- The Step Functions state accumulates a map of S3 keys, not data.

**Example state input/output:**

```json
{
  "jobId": "01HQXYZ123456789ABCDEF",
  "artifacts": {
    "packet": "packets/01HQXYZ123456789ABCDEF/input.json",
    "parsedDiff": "diffs/01HQXYZ123456789ABCDEF/parsed-diff.json",
    "context": "context/01HQXYZ123456789ABCDEF/context.json"
  },
  "status": "GATHERING_CONTEXT"
}
```

This pattern ensures that Step Functions state never exceeds a few kilobytes, regardless of PR size.

---

## 5. Evidence Gate Validator Specification

### 5.1 Purpose

The Evidence Gate is the system's primary defense against LLM hallucination. Every review comment generated by the LLM must cite specific, verifiable evidence from the actual diff. The Evidence Gate validates these citations before any comment is posted to GitHub. Its role is binary: a comment either cites real evidence or it does not. There is no subjective judgment.

### 5.2 Validation Rules

The Evidence Gate applies the following rules to each individual review comment:

**Rule 1: Line Number Existence.** Every comment must reference at least one specific line number. That line number must exist within the diff hunks of the referenced file. Line numbers from the surrounding context (lines visible in the full file but not part of the diff) are rejected. The diff defines the boundary of reviewable content.

**Rule 2: Code Snippet Accuracy.** Every code snippet cited in a comment must be an exact substring of the actual content at the cited line numbers. Whitespace normalization is applied (leading/trailing whitespace trimmed, internal whitespace collapsed to single spaces) under `normal` strictness. Under `strict` mode, the match must be byte-exact. Under `lenient` mode, fuzzy substring matching is permitted (Levenshtein distance threshold).

**Rule 3: File Path Validity.** Every file path referenced in a comment must match a file present in the diff. A comment that references `src/utils/helpers.ts` when only `src/utils/format.ts` was modified is rejected.

**Rule 4: Evidence-Severity Coherence.** A `critical` or `high` severity rating must be supported by evidence of a concrete defect (bug, security vulnerability, data loss risk). A comment rated `critical` that cites only a style preference (e.g., "prefer const over let") is rejected. This rule uses a lightweight heuristic, not LLM inference.

### 5.3 Enforcement Policy

The Evidence Gate operates at the comment level, not the review level. Invalid comments are stripped from the review; valid comments proceed to posting. This ensures that a single hallucinated comment does not discard an otherwise useful review.

**Decision matrix:**

| Scenario | Action |
|----------|--------|
| All comments pass validation | Post complete review |
| Some comments fail validation | Strip failing comments, post remaining valid comments |
| All comments fail validation | Post a summary-only review with no inline comments, flag job as `EVIDENCE_GATE_FULL_REJECTION` |
| Evidence gate itself errors | Treat as transient failure; do NOT retry (evidence validation is deterministic). Log error, mark job as `FAILED`. |

### 5.4 Metrics

The Evidence Gate emits the following CloudWatch metrics:

| Metric | Unit | Description |
|--------|------|-------------|
| `EvidenceGate.PassRate` | Percent | Percentage of comments that pass validation per review |
| `EvidenceGate.RejectionsTotal` | Count | Total comments rejected per review |
| `EvidenceGate.RejectionsByReason` | Count (per reason) | Breakdown: `INVALID_LINE`, `SNIPPET_MISMATCH`, `WRONG_FILE`, `MISSING_EVIDENCE`, `SEVERITY_MISMATCH` |
| `EvidenceGate.FullRejectionRate` | Percent | Percentage of reviews where ALL comments were rejected |
| `EvidenceGate.LatencyMs` | Milliseconds | Time to validate all comments in a review |

These metrics feed into operational dashboards and trigger alerts when the full rejection rate exceeds a threshold (default: 20%), which may indicate a degradation in LLM output quality or a prompt regression.

### 5.5 Adversarial Cases

The following adversarial patterns have been identified through testing with LLM outputs:

| Pattern | Description | Detection |
|---------|-------------|-----------|
| Context line citation | LLM cites a line number that exists in the file but is not part of the diff (it is in the surrounding context provided for reference) | Check line number against diff hunk ranges, not full file |
| Paraphrased code | LLM describes what the code does instead of quoting it exactly: "the function returns null" instead of `return null;` | Substring match fails; paraphrased text is not found in source |
| Deleted code reference | LLM comments on code that was deleted in the diff, citing the old line numbers | Validate against the "after" state of the diff, not the "before" state (deleted lines are not reviewable) |
| Off-by-one line numbers | LLM cites a line number that is 1-2 lines away from the actual code | Under `strict` mode, rejected. Under `normal` mode, a configurable tolerance window (default: 0 lines) can be set |
| Cross-file snippet | LLM cites a code snippet that exists in file A but attributes it to file B | File path validation catches this |
| Synthetic code | LLM generates a "fixed" version of the code and cites it as if it were in the diff | Substring match against actual diff content fails |

---

## 6. Provider-Pluggable LLM Contract

### 6.1 Design Goal

The LLM provider must be swappable without modifying any code in the core review pipeline. The prompt runner depends on an abstract interface; concrete providers implement this interface. Adding a new provider (e.g., OpenAI, a local model) requires implementing the interface and registering the provider in configuration.

### 6.2 Base Provider Interface

```typescript
/**
 * Configuration for a review request to an LLM provider.
 */
interface ReviewOptions {
  /** Model identifier (provider-specific, e.g., "claude-sonnet-4-20250514" or "anthropic.claude-3-sonnet-20240229-v1:0") */
  modelId: string;
  /** Sampling temperature (0.0 - 1.0). Lower = more deterministic. */
  temperature: number;
  /** Maximum tokens to generate in the response. */
  maxOutputTokens: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Retry policy for transient failures. */
  retryPolicy: RetryPolicy;
  /** Optional system prompt to prepend. */
  systemPrompt?: string;
}

/**
 * A chunk of streaming review output from the LLM.
 */
interface ReviewChunk {
  /** The text content of this chunk. */
  text: string;
  /** Whether this is the final chunk in the stream. */
  done: boolean;
  /** Token usage statistics (populated only on final chunk). */
  usage?: TokenUsage;
}

/**
 * Token consumption statistics for a single LLM call.
 */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Retry configuration for transient LLM failures.
 */
interface RetryPolicy {
  /** Maximum number of retry attempts. */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff. */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds. */
  maxDelayMs: number;
  /** Whether to add jitter to the delay. */
  jitter: boolean;
}

/**
 * Standardized error types thrown by providers.
 */
type ProviderErrorCode =
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "AUTH_FAILURE"
  | "MODEL_NOT_FOUND"
  | "CONTEXT_LENGTH_EXCEEDED"
  | "SERVER_ERROR"
  | "NETWORK_ERROR"
  | "UNKNOWN";

/**
 * Error thrown by LLM providers, normalized to a standard shape.
 */
interface ProviderError extends Error {
  code: ProviderErrorCode;
  provider: string;
  retryable: boolean;
  rawError?: unknown;
}

/**
 * The contract that every LLM provider must implement.
 *
 * Implementations: Claude Direct (Anthropic SDK), Bedrock (AWS SDK).
 * Future: OpenAI, local models.
 */
interface LLMProvider {
  /** Human-readable provider name (e.g., "claude-direct", "bedrock"). */
  readonly name: string;

  /** Maximum context window size in tokens for the configured model. */
  readonly maxContextWindow: number;

  /**
   * Send a review prompt to the LLM and receive a streaming response.
   *
   * All providers MUST support streaming. For providers that do not natively
   * stream, the adapter must buffer the full response and yield it as a
   * single chunk with `done: true`.
   *
   * @param prompt - The assembled review prompt (system + user messages).
   * @param options - Configuration for this specific request.
   * @returns An async generator yielding response chunks.
   * @throws {ProviderError} On any provider-level failure.
   */
  review(prompt: string, options: ReviewOptions): AsyncGenerator<ReviewChunk>;

  /**
   * Estimate the token count for a given text input.
   *
   * This is used by the prompt runner to enforce token budgets before
   * making an API call. The estimate need not be exact but must be
   * conservative (overestimate rather than underestimate).
   *
   * @param text - The text to estimate tokens for.
   * @returns Estimated token count.
   */
  estimateTokens(text: string): number;
}
```

### 6.3 Provider Implementations

**Claude Direct (Anthropic SDK):**

- Uses `@anthropic-ai/sdk` for direct API access.
- Supports streaming via the `messages.stream()` method.
- Maps Anthropic error codes (`429`, `500`, `529`) to `ProviderErrorCode`.
- Reads rate limit headers (`x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`) and throttles proactively.
- Token estimation uses Anthropic's tokenizer (or a compatible approximation: 1 token ~ 4 characters as fallback).

**Bedrock (AWS SDK):**

- Uses `@aws-sdk/client-bedrock-runtime` with `InvokeModelWithResponseStream`.
- Handles IAM-based authentication via the standard AWS credential chain (environment variables, shared credentials file, instance role, ECS task role).
- Maps Bedrock error codes (`ThrottlingException`, `ModelTimeoutException`, `AccessDeniedException`) to `ProviderErrorCode`.
- Translates the generic prompt format into Bedrock's Messages API request shape.
- Token estimation uses the same approximation as Claude Direct (Bedrock does not expose a tokenizer endpoint).

### 6.4 Provider Configuration Schema

```json
{
  "provider": "claude-direct",
  "modelId": "claude-sonnet-4-20250514",
  "temperature": 0.2,
  "maxOutputTokens": 4096,
  "timeoutMs": 60000,
  "retryPolicy": {
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxDelayMs": 16000,
    "jitter": true
  },
  "fallbackProvider": "bedrock"
}
```

The `fallbackProvider` field is optional. When specified, if the primary provider fails with a non-retryable error (or exhausts all retries), the prompt runner automatically retries the same request using the fallback provider. This provides resilience against provider-specific outages.

### 6.5 Adapter Pattern

The prompt runner selects a provider at startup based on configuration. Each provider adapter translates the generic `LLMProvider.review()` call into the provider-specific API:

```
Prompt Runner
    |
    +--> LLMProvider interface
            |
            +--> ClaudeDirectAdapter --> Anthropic Messages API
            |
            +--> BedrockAdapter --> AWS Bedrock InvokeModel API
            |
            +--> (Future) OpenAIAdapter --> OpenAI Chat Completions API
```

The prompt runner is unaware of which provider it is using. It calls `provider.review(prompt, options)` and consumes the `AsyncGenerator<ReviewChunk>` stream. Provider-specific concerns (authentication, request formatting, error mapping) are fully encapsulated in the adapter.

---

## 7. Security Model

### 7.1 Webhook Validation

All incoming webhook requests from GitHub are validated using HMAC-SHA256:

1. The webhook handler reads the `X-Hub-Signature-256` header from the request.
2. It computes `HMAC-SHA256(webhookSecret, rawRequestBody)`.
3. It compares the computed signature to the header value using a constant-time comparison function (`crypto.timingSafeEqual`).
4. Requests with missing or invalid signatures are rejected with HTTP 401.

The webhook secret is stored in AWS Secrets Manager (see Section 7.3). Optional IP allowlisting can be configured via API Gateway resource policy to accept requests only from GitHub's published webhook IP ranges.

### 7.2 IAM Least Privilege

Each Lambda function has its own IAM execution role with the minimum permissions required for its specific task:

| Lambda | Permissions |
|--------|-------------|
| Webhook Handler | `sqs:SendMessage` (intake queue only), `secretsmanager:GetSecretValue` (webhook secret only) |
| Diff Worker | `s3:GetObject` (packets/ prefix), `s3:PutObject` (diffs/ prefix), `dynamodb:UpdateItem` (job table, status only) |
| Context Worker | `s3:GetObject` (packets/, diffs/ prefixes), `s3:PutObject` (context/ prefix), `dynamodb:UpdateItem` (job table, status only) |
| Review Worker | `s3:GetObject` (packets/, diffs/, context/ prefixes), `s3:PutObject` (reviews/ prefix), `dynamodb:UpdateItem` (job table, status only), `bedrock:InvokeModelWithResponseStream` (if using Bedrock) |
| Evidence Gate | `s3:GetObject` (reviews/ prefix), `s3:PutObject` (reviews/ prefix), `dynamodb:UpdateItem` (job table, status only) |
| Comment Poster | `s3:GetObject` (reviews/ prefix), `dynamodb:UpdateItem` (job table, status only), `secretsmanager:GetSecretValue` (GitHub token only) |

No Lambda has `s3:*`, `dynamodb:*`, or any wildcard permissions. S3 permissions are scoped to specific key prefixes. DynamoDB permissions are scoped to specific table ARNs and attribute conditions.

### 7.3 Secrets Management

All secrets are stored in AWS Secrets Manager:

| Secret | Rotation | Consumers |
|--------|----------|-----------|
| GitHub Webhook Secret | Manual (with dual-secret validation during rotation window) | Webhook Handler |
| GitHub App Private Key / Installation Token | Auto-rotation via Lambda (GitHub Apps support key rotation) | Comment Poster |
| Anthropic API Key | Manual | Review Worker (Claude Direct provider) |

**Critical rule:** Secrets are never stored in Lambda environment variables. They are fetched from Secrets Manager at cold start, cached in memory for the Lambda instance lifetime, and refreshed on the next cold start. This ensures that rotated secrets take effect within the Lambda recycle window (typically minutes).

### 7.4 Network Security

Data plane Lambdas are deployed in a VPC:

- **Private subnets** with no internet gateway. Lambdas cannot receive inbound connections.
- **NAT Gateway** in a public subnet for outbound internet access.
- **Security group** rules restrict egress to:
  - HTTPS (port 443) to Anthropic API endpoints (`api.anthropic.com`)
  - HTTPS (port 443) to AWS service endpoints (S3, DynamoDB, Secrets Manager, Bedrock) via VPC endpoints where possible
  - HTTPS (port 443) to GitHub API (`api.github.com`) for the Comment Poster only
- **VPC endpoints** for S3 (gateway endpoint) and DynamoDB (gateway endpoint) eliminate the need for NAT Gateway traffic to these services, reducing cost and latency.

The Webhook Handler Lambda is NOT in the VPC (it needs to be invoked by API Gateway, which is a public service). Its security boundary is the webhook signature validation.

### 7.5 Data Protection

| Data | At Rest | In Transit | Retention |
|------|---------|------------|-----------|
| S3 artifacts (diffs, reviews) | SSE-S3 encryption | HTTPS (TLS 1.2+) | 30-90 days (lifecycle policy) |
| DynamoDB records | AWS-managed encryption | HTTPS (TLS 1.2+) | 90 days (TTL) |
| CloudWatch Logs | AWS-managed encryption | HTTPS (TLS 1.2+) | 30 days |
| Secrets Manager | AWS KMS encryption | HTTPS (TLS 1.2+) | Until manually deleted |

**PII considerations:** Lintellect processes code diffs and PR metadata. It does not store personally identifiable information beyond GitHub usernames (which are public). Code diffs may contain sensitive data (API keys committed accidentally, proprietary logic). The 30-90 day retention limits and encryption at rest mitigate this risk.

### 7.6 Audit Trail

| Source | Data | Retention |
|--------|------|-----------|
| CloudTrail | All AWS API calls (S3, DynamoDB, Lambda, Step Functions, Secrets Manager) | 90 days (default) or indefinite (with S3 archival) |
| Step Functions Execution History | State transitions, input/output for each step, error details | 90 days (Standard Workflow default) |
| CloudWatch Logs | Structured JSON logs from all Lambdas (request ID, job ID, step, duration, error) | 30 days |
| DynamoDB STATUS records | Job lifecycle timeline with step durations | 90 days (TTL) |

All Lambda functions emit structured JSON logs with a consistent schema: `{ "level": "INFO|WARN|ERROR", "jobId": "...", "step": "...", "message": "...", "durationMs": N, "error": {...} }`. This enables CloudWatch Logs Insights queries across all functions using the `jobId` field as a correlation key.

---

## 8. Failure Modes and Retry Semantics

### 8.1 Failure Taxonomy

Lintellect distinguishes between transient failures (which should be retried) and permanent failures (which should not).

| Category | Examples | Retryable | Strategy |
|----------|----------|-----------|----------|
| Transient network | TCP timeout, DNS resolution failure, TLS handshake error | Yes | Exponential backoff with jitter |
| Provider throttling | HTTP 429 from Anthropic, `ThrottlingException` from Bedrock | Yes | Backoff using `Retry-After` header if present, otherwise exponential |
| Provider server error | HTTP 500/502/503 from LLM provider | Yes | Exponential backoff, up to max retries |
| Provider auth failure | HTTP 401/403 from LLM provider | No | Fail immediately, alert on-call |
| Invalid input | Malformed diff, unsupported file type, schema validation failure | No | Fail immediately, record reason |
| GitHub API failure | HTTP 422 (PR closed/merged), HTTP 403 (insufficient permissions) | No | Mark job as SKIPPED or FAILED |
| AWS service error | S3 503 SlowDown, DynamoDB ProvisionedThroughputExceeded | Yes | AWS SDK built-in retry (3 attempts with jitter) |

### 8.2 Per-Component Failure Handling

**Webhook Lambda failure:**

- Returns HTTP 500 to GitHub.
- GitHub automatically retries webhook delivery up to 3 times with increasing delays.
- The webhook Lambda is idempotent: if the same webhook is delivered twice, the second invocation detects the existing job in DynamoDB and returns 200 without creating a duplicate.

**SQS message processing failure:**

- If the Lambda consuming the SQS message throws an error, the message returns to the queue after the visibility timeout expires (default: 5 minutes).
- The message is retried up to `maxReceiveCount` times (default: 3).
- After `maxReceiveCount` failures, the message is moved to the Dead Letter Queue.
- A CloudWatch alarm fires when the DLQ contains any messages (depth > 0).
- Manual investigation: inspect the DLQ message, fix the issue, then use SQS DLQ redrive to replay the message.

**Step Functions step failure:**

Each step in the state machine has an independent retry configuration:

```json
{
  "Retry": [
    {
      "ErrorEquals": ["States.TaskFailed", "States.Timeout"],
      "IntervalSeconds": 2,
      "MaxAttempts": 3,
      "BackoffRate": 2.0,
      "JitterStrategy": "FULL"
    }
  ],
  "Catch": [
    {
      "ErrorEquals": ["States.ALL"],
      "Next": "HandleFailure",
      "ResultPath": "$.error"
    }
  ]
}
```

The `HandleFailure` state updates DynamoDB with the error details (failed step, error message, timestamp) and terminates the execution. It does not retry the entire pipeline.

**LLM provider timeout:**

- Each review pass has a 60-second timeout at the Lambda level.
- If the primary provider times out after exhausting retries, and a `fallbackProvider` is configured, the prompt runner retries the same request using the fallback provider.
- If no fallback is configured (or the fallback also fails), the pass is marked as failed. The review proceeds with the remaining successful passes (graceful degradation).

**Evidence Gate failure:**

- The Evidence Gate is deterministic: the same input always produces the same output. Therefore, retrying is pointless.
- If the Evidence Gate Lambda itself errors (e.g., out of memory), this is treated as an infrastructure failure: the job is marked as `FAILED` and the error is logged.
- If the Evidence Gate rejects all comments (the review contains only hallucinated citations), the review is posted as a summary-only comment (no inline comments), and the job is marked as `EVIDENCE_GATE_FULL_REJECTION` for investigation.

**S3 / DynamoDB transient failures:**

- The AWS SDK's built-in retry mechanism handles transient service errors (503 SlowDown, ProvisionedThroughputExceededException).
- Default: 3 retry attempts with full jitter.
- If retries are exhausted, the Lambda throws an error, which Step Functions catches and handles per its retry/catch configuration.

### 8.3 Poison Message Handling

A poison message is a webhook payload that consistently causes processing to fail (e.g., a diff that triggers a parser bug, a PR with an encoding issue).

**Detection:** The SQS `ApproximateReceiveCount` attribute tracks how many times a message has been received. After `maxReceiveCount` (3) receives, the message is moved to the DLQ.

**Alerting:** A CloudWatch alarm triggers when the DLQ `ApproximateNumberOfMessagesVisible` metric exceeds 0. The alarm notifies the operations team via SNS (email or PagerDuty integration).

**Resolution workflow:**

1. Inspect the DLQ message to identify the failing webhook payload.
2. Reproduce the failure locally using the CLI tool (`lintellect review --input payload.json`).
3. Fix the root cause (parser bug, schema gap, etc.).
4. Deploy the fix.
5. Use SQS DLQ redrive to replay the message from the DLQ back to the intake queue.

---

## 9. Migration Path from Baseline

### 9.1 Principles

- Zero downtime: at no point should PR reviews stop working.
- Reversible: every phase can be rolled back to the baseline within minutes.
- Evidence-driven: proceed to the next phase only when metrics confirm the new system is performing at least as well as the baseline.

### 9.2 Phase 1: Parallel Run

**Duration:** 1 week

**Setup:** Deploy Lintellect alongside the baseline system. Both systems are triggered by the same GitHub webhooks (GitHub supports multiple webhook endpoints per repository).

**Behavior:** Both systems review the same PRs and post comments. Lintellect comments are visually distinguished with a `[Lintellect]` prefix in the comment body.

**Evaluation:** Manual comparison of review quality, evidence citation accuracy, and comment relevance. Collect metrics: evidence gate pass rate, LLM token usage, end-to-end latency.

**Rollback:** Remove the Lintellect webhook endpoint from GitHub. Instant, no deployment required.

### 9.3 Phase 2: Shadow Mode

**Duration:** 2 weeks

**Setup:** Lintellect processes all PRs but does NOT post comments to GitHub. Instead, review results are stored in S3 for offline comparison.

**Behavior:** Lintellect runs the full pipeline including the Evidence Gate. Validated reviews are written to S3 but the Comment Poster Lambda is replaced with a no-op that logs the review and marks the job as `COMPLETED_SHADOW`.

**Evaluation:** Automated comparison of Lintellect reviews against baseline reviews for the same PRs. Metrics: evidence gate pass rate (target: >90%), end-to-end latency (target: <3 minutes for 95th percentile), full rejection rate (target: <5%).

**Rollback:** Disable the Lintellect webhook. No impact since it was not posting comments.

### 9.4 Phase 3: Canary

**Duration:** 1-2 weeks

**Setup:** Route 10% of PRs to Lintellect (based on a hash of the PR number modulo 10). The remaining 90% continue to use the baseline.

**Behavior:** Lintellect posts real review comments on the 10% of PRs it handles. The baseline handles the other 90%.

**Evaluation:** Monitor developer feedback on Lintellect reviews (thumbs up/down reactions on GitHub comments, if available). Compare evidence gate metrics against shadow mode targets. Watch for false positive complaints.

**Rollback:** Set the canary percentage to 0% via a feature flag in the API Gateway Lambda authorizer. Instant rollback, no deployment.

### 9.5 Phase 4: Full Cutover

**Duration:** Permanent

**Setup:** Route 100% of PRs to Lintellect. Decommission baseline Lambda functions (but retain the code in the repository for 30 days in case of emergency rollback).

**Behavior:** Lintellect is the sole review system.

**Evaluation:** Continuous monitoring of evidence gate pass rate, end-to-end latency, and DLQ depth. Alerting on any metric regression.

**Rollback:** Feature flag at API Gateway level switches routing back to the baseline endpoint. The baseline Lambda functions can be redeployed from the retained code within minutes.

### 9.6 Feature Flag Implementation

Routing decisions are made in the webhook handler Lambda:

```
if (featureFlag("lintellect.enabled") === false) {
  // Forward to baseline system
  return invokeBaseline(event);
}

if (featureFlag("lintellect.canaryPercent") < 100) {
  const bucket = hash(prNumber) % 100;
  if (bucket >= featureFlag("lintellect.canaryPercent")) {
    return invokeBaseline(event);
  }
}

// Process with Lintellect
return enqueueLintellect(event);
```

Feature flags are stored in AWS AppConfig or a DynamoDB configuration table, allowing real-time updates without redeployment.

---

## 10. Open Questions

| ID | Question | Impact | Status |
|----|----------|--------|--------|
| OQ-1 | Should the Evidence Gate allow configurable tolerance for off-by-one line numbers? | Affects false positive rate in reviews. Too strict may reject valid comments on boundary lines; too lenient may accept inaccurate citations. | OPEN |
| OQ-2 | Should the 4 review passes run in parallel or sequentially? | Parallel reduces latency but increases cost (4 concurrent LLM calls). Sequential allows later passes to see earlier pass results. | PROPOSED: Parallel, since passes are independent. |
| OQ-3 | What is the maximum PR size (in lines changed) that Lintellect should support? | Affects token budget, Lambda timeout, and cost. Very large PRs (>5000 lines) may exceed context windows even with trimming. | OPEN |
| OQ-4 | Should the system support reviewing draft PRs? | Draft PRs may change significantly before being marked ready for review, wasting LLM tokens. | PROPOSED: Configurable per-repository, default OFF for drafts. |

---

## 11. References

| Reference | Description |
|-----------|-------------|
| `/docs/SPRINT-PLAN.md` | Master sprint plan with task breakdown and dependency graph |
| `/docs/architecture.md` | C4 diagrams, Mermaid flows, component inventory |
| `/docs/prompting.md` | 4-pass review strategy and prompt templates |
| `/docs/tooling.md` | Tool evaluation matrices |
| `/docs/testing-strategy.md` | Test plan and coverage targets |
| `/schemas/review-packet.schema.json` | Input packet JSON Schema |
| `/schemas/review-output.schema.json` | Review output JSON Schema |
| `/schemas/review-comment.schema.json` | Individual comment JSON Schema |
| `/schemas/job-status.schema.json` | DynamoDB job status JSON Schema |
| `/schemas/provider-config.schema.json` | Provider configuration JSON Schema |

---

*End of RFC-001.*
