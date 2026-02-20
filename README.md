# Lintellect

Automated code review system built on AWS serverless infrastructure. Listens for pull request events via GitHub webhooks, fans out parallel review workers, merges results through an evidence gate, and posts structured feedback as PR comments.

## Architecture

```
GitHub PR → API Gateway → Webhook Lambda
                               │
                    AWS Step Functions
                    ┌────────────────────────────┐
                    │  Parallel Map State        │
                    │  ├── DiffWorker Lambda     │
                    │  ├── ContextWorker Lambda  │
                    │  └── ReviewWorker Lambda   │
                    │          │                 │
                    │  MergeResults Lambda       │
                    │          │                 │
                    │  EvidenceGate Lambda       │
                    └────────────────────────────┘
                               │
                    CommentPoster Lambda → GitHub PR Comment
```

## Services

| Lambda | Responsibility |
|--------|---------------|
| `webhook` | Validates GitHub signatures, starts Step Functions execution |
| `diff-worker` | Extracts and parses PR diff, identifies changed hunks |
| `context-worker` | Fetches surrounding file context from S3 / GitHub |
| `review-worker` | Runs review logic against diff + context |
| `merge-results` | Aggregates findings from parallel workers |
| `evidence-gate` | Filters low-confidence results, enforces quality threshold |
| `comment-poster` | Formats and posts review comments to the PR |
| `dashboard-api` | REST API for review history and metrics |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Infrastructure | AWS CDK (TypeScript) |
| Compute | AWS Lambda, AWS Step Functions |
| Storage | Amazon S3, Amazon DynamoDB |
| API | Amazon API Gateway |
| CI trigger | GitHub Webhooks |
| Language | TypeScript, Node.js |
| Testing | Vitest |

## Packages

```
packages/
├── core/        # Shared types and utilities
├── providers/   # GitHub API client, S3/DynamoDB helpers
├── api/         # Dashboard REST API handlers
├── cli/         # Local development and deploy CLI
├── admin/       # Admin tooling
└── dashboard/   # Dashboard frontend assets
infra/
├── lib/         # CDK stack definitions
├── lambdas/     # Lambda function source code
└── step-functions/ # ASL state machine definitions
```

## Getting Started

### Prerequisites

- Node.js 18+
- AWS CLI configured with appropriate permissions
- GitHub App or webhook secret

### Install

```bash
npm install
```

### Deploy

```bash
cd infra
npm install
npx cdk deploy
```

### Run Tests

```bash
npm test
```

## Environment Variables

```
GITHUB_WEBHOOK_SECRET=...
GITHUB_TOKEN=...
AWS_REGION=us-east-1
DYNAMO_TABLE_NAME=...
S3_BUCKET_NAME=...
```

## License

MIT
