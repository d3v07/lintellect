/**
 * Shared types for Lambda handlers.
 * All state transitions use pass-by-reference (S3 keys), not inline data.
 */

/** S3 artifact key references for a job */
export interface JobArtifacts {
  input: string;       // packets/{jobId}/input.json
  parsedDiff?: string;  // packets/{jobId}/parsed-diff.json
  context?: string;     // packets/{jobId}/context.json
  pass1?: string;       // packets/{jobId}/pass-1.json
  pass2?: string;       // packets/{jobId}/pass-2.json
  pass3?: string;       // packets/{jobId}/pass-3.json
  pass4?: string;       // packets/{jobId}/pass-4.json
  mergedReview?: string; // packets/{jobId}/merged-review.json
  output?: string;      // packets/{jobId}/output.json
}

/** Step Functions state machine payload - kept small for 256KB limit */
export interface StepFunctionPayload {
  jobId: string;
  bucket: string;
  artifacts: JobArtifacts;
  repository: {
    owner: string;
    name: string;
    fullName: string;
  };
  pullRequest: {
    number: number;
    headSha: string;
  };
  degradedModel?: string;
  status: 'pending' | 'processing' | 'reviewing' | 'validating' | 'posting' | 'completed' | 'failed';
  error?: {
    type: string;
    message: string;
    state: string;
  };
}

/** GitHub webhook PR event (subset of fields we use) */
export interface GitHubWebhookEvent {
  action: string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    base: { sha: string; ref: string };
    head: { sha: string; ref: string };
    html_url: string;
    diff_url: string;
  };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
  installation?: {
    id: number;
  };
}

/** Environment variables expected by Lambda handlers */
export interface LambdaEnv {
  ARTIFACTS_BUCKET: string;
  JOB_TABLE: string;
  OPENROUTER_API_KEY_SECRET_ARN?: string;
  GITHUB_TOKEN_SECRET_ARN?: string;
  OPENROUTER_MODEL?: string;
}

/** DynamoDB job record */
export interface JobRecord {
  jobId: string;
  status: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  createdAt: string;
  updatedAt: string;
  executionArn?: string;
  error?: string;
  evidenceMetrics?: {
    totalComments: number;
    acceptedCount: number;
    rejectedCount: number;
    passRate: number;
  };
  tokensUsed?: {
    input: number;
    output: number;
    total: number;
  };
  durationMs?: number;
}
