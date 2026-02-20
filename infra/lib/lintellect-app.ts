import * as cdk from 'aws-cdk-lib';

/**
 * Lintellect CDK App
 *
 * Deploys two stacks:
 * 1. ControlPlaneStack: API Gateway, DynamoDB, CloudWatch
 * 2. DataPlaneStack: S3, SQS, Lambdas, Step Functions
 *
 * The control plane stack references resources from the data plane.
 */
const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Data plane deploys first — it creates the Lambdas and state machine
// Control plane creates the API Gateway and DynamoDB, then references data plane resources

// We need to create both stacks with cross-references.
// The trick: create DynamoDB in ControlPlane, pass table info to DataPlane.
// DataPlane creates Lambdas + StepFunctions, passes webhook Lambda back to ControlPlane.

// However, CDK doesn't allow circular cross-stack references easily.
// Solution: Create a shared stack that creates DynamoDB + Secrets, then both stacks reference it.
// For simplicity, we create a single combined stack.

class LintellectStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a nested ControlPlane and DataPlane within a single stack
    // to avoid circular cross-stack references.

    // DynamoDB table is created here and shared with both planes.
    const controlPlane = new ControlPlaneConstruct(this, 'ControlPlane');
    const dataPlane = new DataPlaneConstruct(this, 'DataPlane', {
      jobTableName: controlPlane.jobTable.tableName,
      jobTableArn: controlPlane.jobTable.tableArn,
      usersTableName: controlPlane.usersTable.tableName,
      usersTableArn: controlPlane.usersTable.tableArn,
      connectionsTableName: controlPlane.connectionsTable.tableName,
      connectionsTableArn: controlPlane.connectionsTable.tableArn,
    });

    // Wire webhook Lambda to API Gateway
    controlPlane.addWebhookRoute(dataPlane.webhookFunction);
    controlPlane.addDashboardApiRoutes(dataPlane.dashboardApiFunction);

    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${controlPlane.httpApi.url}webhook/github`,
      description: 'GitHub webhook endpoint URL',
    });

    new cdk.CfnOutput(this, 'DashboardApiUrl', {
      value: `${controlPlane.httpApi.url}api/health`,
      description: 'Dashboard API health endpoint',
    });
  }
}

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

class ControlPlaneConstruct extends Construct {
  public readonly jobTable: dynamodb.Table;
  public readonly usersTable: dynamodb.Table;
  public readonly connectionsTable: dynamodb.Table;
  public readonly httpApi: apigateway.HttpApi;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.jobTable = new dynamodb.Table(this, 'JobTable', {
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
    });

    this.jobTable.addGlobalSecondaryIndex({
      indexName: 'repository-index',
      partitionKey: { name: 'repository', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.jobTable.addGlobalSecondaryIndex({
      indexName: 'prUrl-index',
      partitionKey: { name: 'prUrl', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      partitionKey: { name: 'repoFullName', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.connectionsTable.addGlobalSecondaryIndex({
      indexName: 'userId-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.httpApi = new apigateway.HttpApi(this, 'WebhookApi', {
      apiName: 'lintellect-webhook',
      description: 'Lintellect GitHub webhook + Dashboard API',
      corsPreflight: {
        allowOrigins: [process.env.FRONTEND_URL ?? 'https://lintellect.vercel.app'],
        allowMethods: [apigateway.CorsHttpMethod.ANY],
        allowHeaders: ['Content-Type', 'Authorization', 'Cookie'],
        allowCredentials: true,
      },
    });
  }

  addWebhookRoute(webhookFunction: lambda.IFunction): void {
    this.httpApi.addRoutes({
      path: '/webhook/github',
      methods: [apigateway.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'WebhookIntegration',
        webhookFunction
      ),
    });
  }

  addDashboardApiRoutes(dashboardFn: lambda.IFunction): void {
    const dashIntegration = new integrations.HttpLambdaIntegration('DashboardApiIntegration', dashboardFn);
    this.httpApi.addRoutes({ path: '/api/{proxy+}', methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST, apigateway.HttpMethod.PATCH, apigateway.HttpMethod.PUT, apigateway.HttpMethod.DELETE], integration: dashIntegration });
  }
}

interface DataPlaneProps {
  jobTableName: string;
  jobTableArn: string;
  usersTableName: string;
  usersTableArn: string;
  connectionsTableName: string;
  connectionsTableArn: string;
  webhookUrl?: string;
}

class DataPlaneConstruct extends Construct {
  public readonly artifactsBucket: s3.Bucket;
  public readonly webhookFunction: lambdaNode.NodejsFunction;
  public readonly dashboardApiFunction: lambdaNode.NodejsFunction;
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: DataPlaneProps) {
    super(scope, id);

    const lambdasDir = resolve(__dirname, '../lambdas');
    const stack = cdk.Stack.of(this);

    // S3 Artifacts Bucket
    this.artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        { id: 'cleanup-90d', expiration: cdk.Duration.days(90), enabled: true },
      ],
    });

    // DLQ
    const dlq = new sqs.Queue(this, 'ReviewDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    // Secrets Manager references
    const openrouterSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'OpenRouterApiKey', 'lintellect/openrouter-api-key'
    );
    const githubTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'GithubToken', 'lintellect/github-token'
    );
    const webhookSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'WebhookSecret', 'lintellect/webhook-secret'
    );

    const commonEnv: Record<string, string> = {
      ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
      JOB_TABLE: props.jobTableName,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const commonLambdaProps: Partial<lambdaNode.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(120),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        format: lambdaNode.OutputFormat.ESM,
        mainFields: ['module', 'main'],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    };

    // Lambda functions
    const diffWorker = new lambdaNode.NodejsFunction(this, 'DiffWorker', {
      ...commonLambdaProps,
      entry: resolve(lambdasDir, 'diff-worker/index.ts'),
      handler: 'handler',
      environment: commonEnv,
    });

    const contextWorker = new lambdaNode.NodejsFunction(this, 'ContextWorker', {
      ...commonLambdaProps,
      entry: resolve(lambdasDir, 'context-worker/index.ts'),
      handler: 'handler',
      environment: commonEnv,
    });

    const reviewWorker = new lambdaNode.NodejsFunction(this, 'ReviewWorker', {
      ...commonLambdaProps,
      entry: resolve(lambdasDir, 'review-worker/index.ts'),
      handler: 'handler',
      memorySize: 1024,
      timeout: cdk.Duration.seconds(300),
      environment: {
        ...commonEnv,
        OPENROUTER_API_KEY_SECRET_ARN: openrouterSecret.secretArn,
        OPENROUTER_MODEL: 'google/gemini-2.0-flash-001',
        MAX_OUTPUT_TOKENS: '1024',
      },
    });

    const mergeResultsFn = new lambdaNode.NodejsFunction(this, 'MergeResults', {
      ...commonLambdaProps,
      entry: resolve(lambdasDir, 'merge-results/index.ts'),
      handler: 'handler',
      environment: commonEnv,
    });

    const evidenceGate = new lambdaNode.NodejsFunction(this, 'EvidenceGate', {
      ...commonLambdaProps,
      entry: resolve(lambdasDir, 'evidence-gate/index.ts'),
      handler: 'handler',
      environment: commonEnv,
    });

    const commentPoster = new lambdaNode.NodejsFunction(this, 'CommentPoster', {
      ...commonLambdaProps,
      entry: resolve(lambdasDir, 'comment-poster/index.ts'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        GITHUB_TOKEN_SECRET_ARN: githubTokenSecret.secretArn,
      },
    });

    // IAM permissions
    const allWorkers = [diffWorker, contextWorker, reviewWorker, mergeResultsFn, evidenceGate, commentPoster];
    for (const w of allWorkers) {
      this.artifactsBucket.grantReadWrite(w);
    }

    const jobTable = dynamodb.Table.fromTableArn(this, 'JobTable', props.jobTableArn);
    for (const w of [diffWorker, contextWorker, reviewWorker, evidenceGate, commentPoster]) {
      jobTable.grantWriteData(w);
    }

    openrouterSecret.grantRead(reviewWorker);
    githubTokenSecret.grantRead(commentPoster);

    // Step Functions definition
    const parseDiffTask = new sfnTasks.LambdaInvoke(this, 'ParseDiff', {
      lambdaFunction: diffWorker,
      payloadResponseOnly: true,
    });
    parseDiffTask.addRetry({ errors: ['States.TaskFailed', 'States.Timeout'], interval: cdk.Duration.seconds(2), maxAttempts: 2, backoffRate: 2 });

    const gatherContextTask = new sfnTasks.LambdaInvoke(this, 'GatherContext', {
      lambdaFunction: contextWorker,
      payloadResponseOnly: true,
    });
    gatherContextTask.addRetry({ errors: ['States.TaskFailed', 'States.Timeout'], interval: cdk.Duration.seconds(5), maxAttempts: 2, backoffRate: 2 });

    const parallel = new sfn.Parallel(this, 'ParallelReview');
    for (const passType of ['structural', 'logic', 'style', 'security'] as const) {
      const passTask = new sfnTasks.LambdaInvoke(this, `${passType.charAt(0).toUpperCase() + passType.slice(1)}Pass`, {
        lambdaFunction: reviewWorker,
        payloadResponseOnly: true,
        payload: sfn.TaskInput.fromObject({
          'jobId.$': '$.jobId',
          'bucket.$': '$.bucket',
          'artifacts.$': '$.artifacts',
          'repository.$': '$.repository',
          'pullRequest.$': '$.pullRequest',
          'status.$': '$.status',
          'degradedModel.$': '$.degradedModel',
          passType,
        }),
      });
      passTask.addRetry({ errors: ['States.TaskFailed', 'States.Timeout'], interval: cdk.Duration.seconds(5), maxAttempts: 2, backoffRate: 2 });
      parallel.branch(passTask);
    }

    const mergeTask = new sfnTasks.LambdaInvoke(this, 'MergeReviewResults', {
      lambdaFunction: mergeResultsFn,
      payloadResponseOnly: true,
    });
    mergeTask.addRetry({ errors: ['States.TaskFailed'], interval: cdk.Duration.seconds(1), maxAttempts: 1 });

    const evidenceTask = new sfnTasks.LambdaInvoke(this, 'RunEvidenceGate', {
      lambdaFunction: evidenceGate,
      payloadResponseOnly: true,
    });
    evidenceTask.addRetry({ errors: ['States.TaskFailed'], interval: cdk.Duration.seconds(1), maxAttempts: 1 });

    const postTask = new sfnTasks.LambdaInvoke(this, 'PostComments', {
      lambdaFunction: commentPoster,
      payloadResponseOnly: true,
    });
    postTask.addRetry({ errors: ['States.TaskFailed', 'States.Timeout'], interval: cdk.Duration.seconds(2), maxAttempts: 3, backoffRate: 2 });

    const failState = new sfn.Fail(this, 'PipelineFailed', {
      error: 'ReviewPipelineFailed',
      cause: 'Review pipeline encountered an error',
    });

    // Chain with catch blocks
    parseDiffTask.addCatch(failState, { resultPath: '$.error' });
    gatherContextTask.addCatch(failState, { resultPath: '$.error' });
    parallel.addCatch(failState, { resultPath: '$.error' });
    mergeTask.addCatch(failState, { resultPath: '$.error' });
    evidenceTask.addCatch(failState, { resultPath: '$.error' });
    postTask.addCatch(failState, { resultPath: '$.error' });

    const chain = parseDiffTask
      .next(gatherContextTask)
      .next(parallel)
      .next(mergeTask)
      .next(evidenceTask)
      .next(postTask);

    this.stateMachine = new sfn.StateMachine(this, 'ReviewPipeline', {
      stateMachineName: 'lintellect-review-pipeline',
      definitionBody: sfn.DefinitionBody.fromChainable(chain),
      timeout: cdk.Duration.minutes(15),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'StateMachineLogs', {
          logGroupName: '/lintellect/state-machine',
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    // Webhook Lambda (created last because it needs state machine ARN)
    this.webhookFunction = new lambdaNode.NodejsFunction(this, 'WebhookHandler', {
      ...commonLambdaProps,
      entry: resolve(lambdasDir, 'webhook/index.ts'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
        WEBHOOK_SECRET_NAME: 'lintellect/webhook-secret',
        GITHUB_TOKEN_NAME: 'lintellect/github-token',
        USERS_TABLE: props.usersTableName,
        CONNECTIONS_TABLE: props.connectionsTableName,
      },
    });

    this.artifactsBucket.grantReadWrite(this.webhookFunction);
    jobTable.grantWriteData(this.webhookFunction);
    this.stateMachine.grantStartExecution(this.webhookFunction);
    webhookSecret.grantRead(this.webhookFunction);
    githubTokenSecret.grantRead(this.webhookFunction);
    const usersTableRef = dynamodb.Table.fromTableArn(this, 'WebhookUsersTable', props.usersTableArn);
    const connectionsTableRef = dynamodb.Table.fromTableArn(this, 'WebhookConnectionsTable', props.connectionsTableArn);
    usersTableRef.grantReadWriteData(this.webhookFunction);
    connectionsTableRef.grantReadData(this.webhookFunction);

    // Dashboard API Lambda
    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: 'lintellect/jwt-secret',
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });

    const oauthSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'GitHubOAuthSecret', 'lintellect/github-oauth'
    );

    this.dashboardApiFunction = new lambdaNode.NodejsFunction(this, 'DashboardApi', {
      ...commonLambdaProps,
      entry: resolve(lambdasDir, 'dashboard-api/index.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...commonEnv,
        USERS_TABLE: props.usersTableName,
        CONNECTIONS_TABLE: props.connectionsTableName,
        WEBHOOK_URL: props.webhookUrl ?? '',
        FRONTEND_URL: process.env.FRONTEND_URL ?? 'https://lintellect.vercel.app',
        GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? '',
        GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? '',
        JWT_SECRET: process.env.JWT_SECRET ?? 'lintellect-dev-secret-change-in-prod',
      },
    });

    this.artifactsBucket.grantRead(this.dashboardApiFunction);
    jobTable.grantReadData(this.dashboardApiFunction);
    const usersTable = dynamodb.Table.fromTableArn(this, 'UsersTableRef', props.usersTableArn);
    const connectionsTable = dynamodb.Table.fromTableArn(this, 'ConnectionsTableRef', props.connectionsTableArn);
    usersTable.grantReadWriteData(this.dashboardApiFunction);
    connectionsTable.grantReadWriteData(this.dashboardApiFunction);
    githubTokenSecret.grantRead(this.dashboardApiFunction);
    webhookSecret.grantRead(this.dashboardApiFunction);

    // DLQ alarm
    dlq.metricApproximateNumberOfMessagesVisible().createAlarm(this, 'DLQAlarm', {
      alarmName: 'lintellect-dlq-depth',
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.stateMachine.metricFailed().createAlarm(this, 'PipelineFailureAlarm', {
      alarmName: 'lintellect-pipeline-failures',
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}

new LintellectStack(app, 'LintellectStack', { env });

app.synth();
