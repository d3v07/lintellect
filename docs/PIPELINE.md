# Lintellect Review Pipeline

## Overview

Lintellect is an AI-powered code review system that runs as a serverless
pipeline on AWS. When a pull request is opened or updated, a GitHub webhook
triggers a Step Functions state machine that orchestrates multi-pass review,
evidence validation, and inline comment posting.

## Architecture

```
GitHub PR Event
      │
      ▼
┌─────────────┐     ┌──────────────────────┐
│   Webhook   │────▶│  Step Functions SM   │
│   Lambda    │     └──────────────────────┘
└─────────────┘              │
      │                      ▼
 S3 packet            ┌─────────────┐
 DynamoDB job         │ diff-worker │  Parse unified diff
                      └──────┬──────┘
                             ▼
                      ┌─────────────┐
                      │context-worker│ Gather repo context via GitHub API
                      └──────┬──────┘
                             ▼
                      ┌──────────────┐
                      │review-worker │ 4 parallel AI review passes
                      └──────┬───────┘
                             ▼
                      ┌──────────────┐
                      │merge-results │ Deduplicate and rank comments
                      └──────┬───────┘
                             ▼
                      ┌──────────────┐
                      │evidence-gate │ Validate each comment against diff
                      └──────┬───────┘
                             ▼
                      ┌───────────────┐
                      │comment-poster │ Post inline PR review to GitHub
                      └───────────────┘
```

## Lambda Functions

| Function | Trigger | Purpose |
|---|---|---|
| `webhook` | API Gateway | Validate HMAC, parse PR event, start execution |
| `diff-worker` | Step Functions | Parse unified diff into structured chunks |
| `context-worker` | Step Functions | Fetch file context and PR metadata from GitHub |
| `review-worker` | Step Functions (×4) | Run AI review pass for a chunk category |
| `merge-results` | Step Functions | Merge and deduplicate comments across passes |
| `evidence-gate` | Step Functions | Reject hallucinated comments not grounded in diff |
| `comment-poster` | Step Functions | Post final review to GitHub PR |
| `dlq-handler` | SQS DLQ | Mark failed jobs, alert on-call via Slack |
| `replay` | API Gateway (admin) | Re-trigger a failed job by jobId |

## Shared Utilities

- **`s3-helpers.ts`** — typed S3 read/write wrappers
- **`dynamo-helpers.ts`** — DynamoDB job CRUD helpers
- **`types.ts`** — shared TypeScript interfaces (StepFunctionPayload, JobRecord, etc.)
- **`rate-limiter.ts`** — in-process token-bucket for the webhook Lambda
- **`job-metrics.ts`** — EMF metric emitter for CloudWatch custom namespace

## Monitoring

CloudWatch Logs Insights queries live in `infra/monitoring/cloudwatch-queries.ts`.
Metrics are published via EMF to the `LintellectPipeline` namespace:

- `DurationMs` — end-to-end review time
- `TotalTokens` — LLM tokens consumed per job
- `CommentCount` — raw AI comments before evidence gate
- `AcceptedCount` — comments that passed the evidence gate
- `PassRate` — `AcceptedCount / CommentCount`

## Local Development

```bash
npm ci
npm run build
npm run test
```

Deploy to AWS with CDK:

```bash
cd infra
npx cdk deploy --all
```
