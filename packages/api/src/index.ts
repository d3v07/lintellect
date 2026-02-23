import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SignJWT, jwtVerify } from 'jose';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { Request, Response, NextFunction } from 'express';

const app = express();

// Security headers
app.use(helmet());

// CORS lockdown
app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5180',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parser with size limit
app.use(express.json({ limit: '1mb' }));

// Global rate limit: 100 req/min per IP
app.use(rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false }));

// Stricter rate limits for auth/setup endpoints
app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api/setup', rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false }));

const region = process.env.AWS_REGION ?? 'us-east-1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region });
const sm = new SecretsManagerClient({ region });

const TABLE = process.env.JOB_TABLE ?? 'LintellectStack-ControlPlaneJobTableA8CBE31E-1RWSXM7Y3ROUM';
const BUCKET = process.env.ARTIFACTS_BUCKET ?? 'lintellectstack-dataplaneartifactsbucket2abef142-tidkrepb3sn5';
const GH = 'https://api.github.com';

/* ── OAuth + JWT Config ── */
const JWT_SECRET_STR = process.env.JWT_SECRET ?? 'lintellect-dev-secret-change-in-prod';
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_STR);
const COOKIE_NAME = 'lintellect_session';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5180';

/* ── Encryption Helpers (AES-256-GCM) ── */
function deriveKey(secret: string): Buffer {
  return crypto.scryptSync(secret, 'lintellect-salt', 32);
}

function encrypt(text: string): string {
  const key = deriveKey(JWT_SECRET_STR);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(ciphertext: string): string {
  const key = deriveKey(JWT_SECRET_STR);
  const [ivHex, authTagHex, encHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(enc) + decipher.final('utf8');
}

function maskKey(key: string): string {
  if (!key || key.length < 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

/* ── Input Validation ── */
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function validateRepoParam(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && SAFE_NAME_RE.test(value);
}

function validateStringField(value: unknown, maxLen = 500): value is string {
  return typeof value === 'string' && value.length <= maxLen;
}

/* ── AppConfig: DynamoDB-backed app-level config ── */
const APP_CONFIG_KEY = '__APP_CONFIG__';
let cachedAppConfig: Record<string, any> | null = null;

async function getAppConfig(): Promise<{ githubClientId: string; githubClientSecret: string; configured: boolean }> {
  if (cachedAppConfig) {
    return {
      githubClientId: cachedAppConfig.githubClientId ?? '',
      githubClientSecret: cachedAppConfig.githubClientSecretDecrypted ?? '',
      configured: cachedAppConfig.configured === true,
    };
  }

  // Try DynamoDB first
  try {
    const result = await ddb.send(new GetCommand({
      TableName: USERS_TABLE(),
      Key: { userId: APP_CONFIG_KEY },
    }));
    if (result.Item && result.Item.configured === true) {
      let secret = '';
      try { secret = decrypt(result.Item.githubClientSecretEncrypted as string); } catch (e) {
        console.error('[AppConfig] Failed to decrypt secret:', e);
      }
      cachedAppConfig = { ...result.Item, githubClientSecretDecrypted: secret };
      return {
        githubClientId: result.Item.githubClientId as string ?? '',
        githubClientSecret: secret,
        configured: true,
      };
    }
    console.log('[AppConfig] No config record found in DynamoDB table:', USERS_TABLE());
  } catch (err) {
    console.error('[AppConfig] DynamoDB read failed:', err);
  }

  // Fall back to env vars
  const envId = process.env.GITHUB_CLIENT_ID ?? '';
  const envSecret = process.env.GITHUB_CLIENT_SECRET ?? '';
  if (envId) {
    cachedAppConfig = { githubClientId: envId, githubClientSecretDecrypted: envSecret, configured: true };
    return { githubClientId: envId, githubClientSecret: envSecret, configured: true };
  }

  return { githubClientId: '', githubClientSecret: '', configured: false };
}

function reloadAppConfig() { cachedAppConfig = null; }

/* ── LLM Provider Registry ── */
const LLM_PROVIDERS: Record<string, { name: string; baseUrl: string; authHeader: string; authPrefix: string; defaultModel?: string }> = {
  openrouter:  { name: 'OpenRouter',    baseUrl: 'https://openrouter.ai/api/v1',    authHeader: 'Authorization', authPrefix: 'Bearer ', defaultModel: 'anthropic/claude-sonnet-4' },
  openai:      { name: 'OpenAI',        baseUrl: 'https://api.openai.com/v1',       authHeader: 'Authorization', authPrefix: 'Bearer ', defaultModel: 'gpt-4o' },
  anthropic:   { name: 'Anthropic',     baseUrl: 'https://api.anthropic.com/v1',    authHeader: 'x-api-key',     authPrefix: '',        defaultModel: 'claude-sonnet-4-20250514' },
  gemini:      { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', authHeader: 'Authorization', authPrefix: 'Bearer ', defaultModel: 'gemini-2.0-flash' },
  mistral:     { name: 'Mistral',       baseUrl: 'https://api.mistral.ai/v1',       authHeader: 'Authorization', authPrefix: 'Bearer ', defaultModel: 'mistral-small-latest' },
  groq:        { name: 'Groq',          baseUrl: 'https://api.groq.com/openai/v1',  authHeader: 'Authorization', authPrefix: 'Bearer ', defaultModel: 'llama-3.1-70b-versatile' },
  together:    { name: 'Together AI',   baseUrl: 'https://api.together.xyz/v1',     authHeader: 'Authorization', authPrefix: 'Bearer ', defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' },
  fireworks:   { name: 'Fireworks AI',  baseUrl: 'https://api.fireworks.ai/inference/v1', authHeader: 'Authorization', authPrefix: 'Bearer ', defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct' },
  ollama:      { name: 'Ollama (local)',baseUrl: 'http://localhost:11434/v1',        authHeader: '',              authPrefix: '',        defaultModel: 'llama3.1' },
  custom:      { name: 'Custom',        baseUrl: '',                                 authHeader: 'Authorization', authPrefix: 'Bearer ' },
};

const USERS_TABLE = () => process.env.USERS_TABLE ?? 'LintellectUsers';

/* ── GitHub Token (bot fallback for non-user routes) ── */
let ghBotToken: string | null = null;

async function getBotGithubToken(): Promise<string> {
  if (ghBotToken) return ghBotToken;
  if (process.env.GITHUB_TOKEN) { ghBotToken = process.env.GITHUB_TOKEN; return ghBotToken; }
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: 'lintellect/github-token' }));
    ghBotToken = res.SecretString!;
    return ghBotToken;
  } catch {
    throw new Error('Set GITHUB_TOKEN env var or configure Secrets Manager');
  }
}

/* ── User-aware GitHub fetch ── */
async function ghFetch(path: string, token: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers as Record<string, string> ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub ${res.status}: ${body}`);
  }
  return res.json();
}

async function readS3Json(key: string): Promise<unknown> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return JSON.parse(await res.Body!.transformToString());
}

/* ── JWT Helpers ── */
interface UserPayload {
  userId: string;
  login: string;
  name: string;
  avatar: string;
}

async function signToken(user: UserPayload): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(JWT_SECRET);
}

async function verifyToken(token: string): Promise<UserPayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as unknown as UserPayload;
  } catch { return null; }
}

/* ── Auth Middleware ── */
declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
      ghToken?: string;
    }
  }
}

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const cookies = parseCookie(req.headers.cookie ?? '');
  const token = cookies[COOKIE_NAME];
  if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }

  const user = await verifyToken(token);
  if (!user) { res.status(401).json({ error: 'Invalid or expired session' }); return; }

  // Fetch user's GitHub token from DynamoDB
  try {
    const result = await ddb.send(new GetCommand({
      TableName: process.env.USERS_TABLE ?? 'LintellectUsers',
      Key: { userId: user.userId },
    }));
    req.ghToken = (result.Item?.accessToken as string) ?? undefined;
  } catch {
    // Fall back to bot token
  }

  req.user = user;
  next();
}

/* ── Helper: get the best available GH token ── */
async function getToken(req: Request): Promise<string> {
  if (req.ghToken) return req.ghToken;
  return getBotGithubToken();
}

/* ══════════════════════════════════════════════════════
   PUBLIC ROUTES (no auth required)
   ══════════════════════════════════════════════════════ */

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* ── OAuth: Redirect to GitHub ── */
app.get('/api/auth/github', async (_req, res) => {
  const config = await getAppConfig();
  if (!config.configured || !config.githubClientId) {
    // This is a browser navigation (not fetch), redirect to frontend setup
    res.redirect(`${FRONTEND_URL}?setup=required`);
    return;
  }
  const params = new URLSearchParams({
    client_id: config.githubClientId,
    redirect_uri: `${FRONTEND_URL}/api/auth/callback`,
    scope: 'repo read:user user:email',
    state: crypto.randomUUID(),
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

/* ── OAuth: Callback ── */
app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Missing code parameter' });
    return;
  }

  const config = await getAppConfig();
  if (!config.configured || !config.githubClientId) {
    res.redirect(`${FRONTEND_URL}?setup=required`);
    return;
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code,
      }),
    });
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      res.status(400).json({ error: tokenData.error ?? 'OAuth failed' });
      return;
    }

    // Get user info from GitHub
    const ghUser = await ghFetch('/user', tokenData.access_token) as {
      id: number; login: string; name: string | null; avatar_url: string;
    };

    // Check if user already exists (returning user)
    const usersTable = USERS_TABLE();
    let existingUser: Record<string, any> | undefined;
    try {
      const existing = await ddb.send(new GetCommand({
        TableName: usersTable,
        Key: { userId: String(ghUser.id) },
      }));
      existingUser = existing.Item;
    } catch {}

    // Store/update user in DynamoDB (preserve onboarding fields for returning users)
    const userItem: Record<string, any> = {
      userId: String(ghUser.id),
      githubLogin: ghUser.login,
      displayName: ghUser.name ?? ghUser.login,
      avatarUrl: ghUser.avatar_url,
      accessToken: tokenData.access_token,
      lastLoginAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Only set onboarding fields if this is a brand new user
    if (!existingUser) {
      userItem.onboardingCompleted = false;
      userItem.onboardingStep = 1;
    }
    await ddb.send(new PutCommand({
      TableName: usersTable,
      Item: { ...(existingUser ?? {}), ...userItem },
    }));

    const onboardingCompleted = existingUser?.onboardingCompleted === true;

    // Sign JWT and set cookie
    const jwt = await signToken({
      userId: String(ghUser.id),
      login: ghUser.login,
      name: ghUser.name ?? ghUser.login,
      avatar: ghUser.avatar_url,
    });

    res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, jwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60, // 7 days
      path: '/',
    }));

    // Redirect to frontend
    res.redirect(FRONTEND_URL);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Auth: Check session ── */
app.get('/api/auth/me', async (req, res) => {
  const cookies = parseCookie(req.headers.cookie ?? '');
  const token = cookies[COOKIE_NAME];
  if (!token) { res.json({ authenticated: false }); return; }

  const user = await verifyToken(token);
  if (!user) { res.json({ authenticated: false }); return; }

  // Fetch onboarding status
  let onboardingCompleted = false;
  try {
    const result = await ddb.send(new GetCommand({
      TableName: USERS_TABLE(),
      Key: { userId: user.userId },
    }));
    onboardingCompleted = result.Item?.onboardingCompleted === true;
  } catch {}

  res.json({ authenticated: true, user, onboardingCompleted });
});

/* ── Auth: Logout ── */
app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  }));
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════
   SETUP ENDPOINTS (public, no auth)
   ══════════════════════════════════════════════════════ */

/* ── Setup: Check if app is configured ── */
app.get('/api/setup/status', async (_req, res) => {
  try {
    const config = await getAppConfig();
    console.log('[Setup] Status check — configured:', config.configured, '| clientId:', config.githubClientId ? 'present' : 'missing');
    res.json({ configured: config.configured });
  } catch (err) {
    console.error('[Setup] Status check failed:', err);
    res.json({ configured: false });
  }
});

/* ── Setup: Save GitHub OAuth credentials (first-time only) ── */
app.post('/api/setup/github', async (req, res) => {
  try {
    const config = await getAppConfig();
    if (config.configured) {
      res.status(403).json({ error: 'Already configured. Use Settings to update.' });
      return;
    }

    const { clientId, clientSecret } = req.body ?? {};
    if (!clientId || !clientSecret) {
      res.status(400).json({ error: 'Client ID and Client Secret are required' });
      return;
    }
    if (typeof clientId !== 'string' || !clientId.startsWith('Ov')) {
      res.status(400).json({ error: 'Client ID should start with "Ov" (GitHub OAuth App ID format)' });
      return;
    }

    const tableName = USERS_TABLE();
    console.log('[Setup] Writing AppConfig to DynamoDB table:', tableName);
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: {
        userId: APP_CONFIG_KEY,
        githubClientId: clientId,
        githubClientSecretEncrypted: encrypt(clientSecret),
        frontendUrl: FRONTEND_URL,
        configured: true,
        configuredAt: new Date().toISOString(),
        configuredBy: 'setup',
      },
    }));

    // Verify the write actually persisted
    reloadAppConfig();
    const verify = await getAppConfig();
    if (!verify.configured) {
      console.error('[Setup] Write succeeded but read-back failed! Table:', tableName);
      res.status(500).json({ error: 'Config was saved but could not be verified. Check DynamoDB access.' });
      return;
    }
    console.log('[Setup] AppConfig saved and verified successfully');
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[Setup] Failed to write AppConfig:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════
   PROTECTED ROUTES (auth required)
   ══════════════════════════════════════════════════════ */

app.use('/api/stats', authMiddleware);
app.use('/api/jobs', authMiddleware);
app.use('/api/review', authMiddleware);
app.use('/api/github', authMiddleware);
app.use('/api/repos', authMiddleware);
app.use('/api/onboarding', authMiddleware);
app.use('/api/settings', authMiddleware);

/* ══════════════════════════════════════════════════════
   ONBOARDING ENDPOINTS
   ══════════════════════════════════════════════════════ */

/* 1. GET /api/onboarding/status */
app.get('/api/onboarding/status', async (req, res) => {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: USERS_TABLE(),
      Key: { userId: req.user!.userId },
    }));
    const item = result.Item ?? {};
    res.json({
      step: item.onboardingStep ?? 1,
      completed: item.onboardingCompleted === true,
      llmProvider: item.llmProvider ?? null,
      llmModel: item.llmModel ?? null,
      awsConfigured: item.awsConfigured === true,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* 2. POST /api/onboarding/llm - Save LLM config */
app.post('/api/onboarding/llm', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl, model } = req.body ?? {};
    if (!provider || !LLM_PROVIDERS[provider]) {
      res.status(400).json({ error: 'Invalid provider' }); return;
    }
    const providerInfo = LLM_PROVIDERS[provider];
    const updateExpr: string[] = [
      'llmProvider = :provider',
      'llmBaseUrl = :baseUrl',
      'llmModel = :model',
      'llmApiKeySet = :keySet',
      'onboardingStep = :step',
      'updatedAt = :now',
    ];
    const exprValues: Record<string, any> = {
      ':provider': provider,
      ':baseUrl': baseUrl || providerInfo.baseUrl,
      ':model': model || providerInfo.defaultModel || '',
      ':keySet': true,
      ':step': 2,
      ':now': new Date().toISOString(),
    };
    if (apiKey) {
      updateExpr.push('llmApiKeyEncrypted = :encKey');
      exprValues[':encKey'] = encrypt(apiKey);
    }
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE(),
      Key: { userId: req.user!.userId },
      UpdateExpression: 'SET ' + updateExpr.join(', '),
      ExpressionAttributeValues: exprValues,
    }));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* 3. POST /api/onboarding/llm/verify - Test LLM connection */
app.post('/api/onboarding/llm/verify', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl, model } = req.body ?? {};
    if (!provider) { res.status(400).json({ error: 'Missing provider' }); return; }
    const providerInfo = LLM_PROVIDERS[provider];
    if (!providerInfo) { res.status(400).json({ error: 'Unknown provider' }); return; }

    const url = baseUrl || providerInfo.baseUrl;
    const mdl = model || providerInfo.defaultModel || 'gpt-3.5-turbo';
    console.log(`[LLM Verify] provider=${provider} url=${url} model=${mdl} keyPresent=${!!apiKey} keyLen=${apiKey?.length ?? 0}`);

    if (provider === 'anthropic') {
      // Anthropic uses a different API format
      const verifyRes = await fetch(`${url}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: mdl,
          max_tokens: 5,
          messages: [{ role: 'user', content: 'Say ok' }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.text();
        console.error(`[LLM Verify] Anthropic ${verifyRes.status}:`, body);
        res.status(400).json({ error: `Anthropic API error: ${verifyRes.status}`, detail: body }); return;
      }
      res.json({ ok: true, provider: 'anthropic' });
    } else {
      // OpenAI-compatible
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (providerInfo.authHeader && apiKey) {
        headers[providerInfo.authHeader] = `${providerInfo.authPrefix}${apiKey}`;
      }
      console.log(`[LLM Verify] Calling ${url}/chat/completions with model=${mdl}`);
      const verifyRes = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: mdl,
          messages: [{ role: 'user', content: 'Say ok' }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.text();
        console.error(`[LLM Verify] ${provider} ${verifyRes.status}:`, body);
        res.status(400).json({ error: `LLM API error: ${verifyRes.status}`, detail: body }); return;
      }
      res.json({ ok: true, provider });
    }
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Connection failed' });
  }
});

/* 4. POST /api/onboarding/aws - Save AWS creds */
app.post('/api/onboarding/aws', async (req, res) => {
  try {
    const { accessKeyId, secretAccessKey, region: awsRegion } = req.body ?? {};
    if (!accessKeyId || !secretAccessKey) {
      res.status(400).json({ error: 'Missing AWS credentials' }); return;
    }
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE(),
      Key: { userId: req.user!.userId },
      UpdateExpression: 'SET awsConfigured = :yes, awsRegion = :region, awsAccessKeyIdEncrypted = :ak, awsSecretAccessKeyEncrypted = :sk, onboardingStep = :step, updatedAt = :now',
      ExpressionAttributeValues: {
        ':yes': true,
        ':region': awsRegion || 'us-east-1',
        ':ak': encrypt(accessKeyId),
        ':sk': encrypt(secretAccessKey),
        ':step': 3,
        ':now': new Date().toISOString(),
      },
    }));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* 5. POST /api/onboarding/aws/verify - Test AWS creds */
app.post('/api/onboarding/aws/verify', async (req, res) => {
  try {
    const { accessKeyId, secretAccessKey, region: awsRegion } = req.body ?? {};
    if (!accessKeyId || !secretAccessKey) {
      res.status(400).json({ error: 'Missing AWS credentials' }); return;
    }
    const sts = new STSClient({
      region: awsRegion || 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
    });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    res.json({ ok: true, account: identity.Account, arn: identity.Arn });
  } catch (err: any) {
    res.status(400).json({ error: 'Invalid AWS credentials', detail: err.message });
  }
});

/* 6. POST /api/onboarding/aws/skip */
app.post('/api/onboarding/aws/skip', async (req, res) => {
  try {
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE(),
      Key: { userId: req.user!.userId },
      UpdateExpression: 'SET awsConfigured = :no, onboardingStep = :step, updatedAt = :now',
      ExpressionAttributeValues: {
        ':no': false,
        ':step': 3,
        ':now': new Date().toISOString(),
      },
    }));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* 7. POST /api/onboarding/complete */
app.post('/api/onboarding/complete', async (req, res) => {
  try {
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE(),
      Key: { userId: req.user!.userId },
      UpdateExpression: 'SET onboardingCompleted = :yes, onboardingStep = :step, updatedAt = :now',
      ExpressionAttributeValues: {
        ':yes': true,
        ':step': 4,
        ':now': new Date().toISOString(),
      },
    }));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ══════════════════════════════════════════════════════
   SETTINGS ENDPOINTS
   ══════════════════════════════════════════════════════ */

/* 8. GET /api/settings/llm */
app.get('/api/settings/llm', async (req, res) => {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: USERS_TABLE(),
      Key: { userId: req.user!.userId },
    }));
    const item = result.Item ?? {};
    let maskedKey = '';
    if (item.llmApiKeyEncrypted) {
      try { maskedKey = maskKey(decrypt(item.llmApiKeyEncrypted as string)); } catch { maskedKey = '****'; }
    }
    res.json({
      provider: item.llmProvider ?? null,
      baseUrl: item.llmBaseUrl ?? null,
      model: item.llmModel ?? null,
      apiKeySet: item.llmApiKeySet === true,
      apiKeyMasked: maskedKey,
      providers: Object.entries(LLM_PROVIDERS).map(([id, p]) => ({ id, name: p.name, defaultModel: p.defaultModel })),
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* 9. PUT /api/settings/llm */
app.put('/api/settings/llm', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl, model } = req.body ?? {};
    if (!provider || !LLM_PROVIDERS[provider]) {
      res.status(400).json({ error: 'Invalid provider' }); return;
    }
    const providerInfo = LLM_PROVIDERS[provider];
    const updateExpr: string[] = [
      'llmProvider = :provider',
      'llmBaseUrl = :baseUrl',
      'llmModel = :model',
      'updatedAt = :now',
    ];
    const exprValues: Record<string, any> = {
      ':provider': provider,
      ':baseUrl': baseUrl || providerInfo.baseUrl,
      ':model': model || providerInfo.defaultModel || '',
      ':now': new Date().toISOString(),
    };
    if (apiKey) {
      updateExpr.push('llmApiKeySet = :keySet', 'llmApiKeyEncrypted = :encKey');
      exprValues[':keySet'] = true;
      exprValues[':encKey'] = encrypt(apiKey);
    }
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE(),
      Key: { userId: req.user!.userId },
      UpdateExpression: 'SET ' + updateExpr.join(', '),
      ExpressionAttributeValues: exprValues,
    }));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* 10. GET /api/settings/aws */
app.get('/api/settings/aws', async (req, res) => {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: USERS_TABLE(),
      Key: { userId: req.user!.userId },
    }));
    const item = result.Item ?? {};
    let maskedAccessKey = '';
    let maskedSecretKey = '';
    if (item.awsAccessKeyIdEncrypted) {
      try { maskedAccessKey = maskKey(decrypt(item.awsAccessKeyIdEncrypted as string)); } catch { maskedAccessKey = '****'; }
    }
    if (item.awsSecretAccessKeyEncrypted) {
      try { maskedSecretKey = maskKey(decrypt(item.awsSecretAccessKeyEncrypted as string)); } catch { maskedSecretKey = '****'; }
    }
    res.json({
      configured: item.awsConfigured === true,
      region: item.awsRegion ?? null,
      accessKeyIdMasked: maskedAccessKey,
      secretAccessKeyMasked: maskedSecretKey,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* 11. PUT /api/settings/aws */
app.put('/api/settings/aws', async (req, res) => {
  try {
    const { accessKeyId, secretAccessKey, region: awsRegion } = req.body ?? {};
    if (!accessKeyId || !secretAccessKey) {
      res.status(400).json({ error: 'Missing AWS credentials' }); return;
    }
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE(),
      Key: { userId: req.user!.userId },
      UpdateExpression: 'SET awsConfigured = :yes, awsRegion = :region, awsAccessKeyIdEncrypted = :ak, awsSecretAccessKeyEncrypted = :sk, updatedAt = :now',
      ExpressionAttributeValues: {
        ':yes': true,
        ':region': awsRegion || 'us-east-1',
        ':ak': encrypt(accessKeyId),
        ':sk': encrypt(secretAccessKey),
        ':now': new Date().toISOString(),
      },
    }));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* 12. GET /api/settings/github */
app.get('/api/settings/github', async (_req, res) => {
  try {
    const config = await getAppConfig();
    let maskedSecret = '';
    if (config.githubClientSecret) {
      maskedSecret = maskKey(config.githubClientSecret);
    }
    res.json({
      configured: config.configured,
      clientId: config.githubClientId ?? '',
      clientSecretMasked: maskedSecret,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* 13. PUT /api/settings/github */
app.put('/api/settings/github', async (req, res) => {
  try {
    const { clientId, clientSecret } = req.body ?? {};
    if (!clientId || !clientSecret) {
      res.status(400).json({ error: 'Client ID and Client Secret are required' });
      return;
    }
    if (typeof clientId !== 'string' || !clientId.startsWith('Ov')) {
      res.status(400).json({ error: 'Client ID should start with "Ov" (GitHub OAuth App ID format)' });
      return;
    }

    // Read existing record to preserve other fields
    let existing: Record<string, any> = {};
    try {
      const result = await ddb.send(new GetCommand({
        TableName: USERS_TABLE(),
        Key: { userId: APP_CONFIG_KEY },
      }));
      existing = result.Item ?? {};
    } catch {}

    await ddb.send(new PutCommand({
      TableName: USERS_TABLE(),
      Item: {
        ...existing,
        userId: APP_CONFIG_KEY,
        githubClientId: clientId,
        githubClientSecretEncrypted: encrypt(clientSecret),
        configured: true,
        updatedAt: new Date().toISOString(),
      },
    }));
    reloadAppConfig();
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Helper: get user's connected repos ── */
async function getUserRepos(userId: string): Promise<Set<string>> {
  try {
    const connectionsTable = process.env.CONNECTIONS_TABLE ?? 'LintellectConnections';
    const result = await ddb.send(new ScanCommand({
      TableName: connectionsTable,
      FilterExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    }));
    return new Set((result.Items ?? []).map(i => i.repoFullName as string));
  } catch {
    return new Set();
  }
}

/* ── Usage ── */
app.use('/api/usage', authMiddleware);

async function getUserUsage(userId: string) {
  const FREE_LIMIT = 5;
  const DEGRADED_LIMIT = 7;
  const HARD_LIMIT = 8;

  try {
    const result = await ddb.send(new GetCommand({
      TableName: USERS_TABLE(),
      Key: { userId },
    }));
    const item = result.Item ?? {};
    const awsConfigured = item.awsConfigured === true;
    const currentPeriod = new Date().toISOString().slice(0, 7);
    const userPeriod = item.usagePeriod as string | undefined;
    const count = (userPeriod === currentPeriod ? (item.usageCount as number) ?? 0 : 0);
    const customLimit = (item.customLimit as number) ?? FREE_LIMIT;
    const tier = awsConfigured ? 'pro' : 'free';

    let status: 'ok' | 'warning' | 'degraded' | 'blocked' = 'ok';
    if (!awsConfigured) {
      if (count >= HARD_LIMIT) status = 'blocked';
      else if (count > customLimit) status = 'degraded';
      else if (count >= customLimit - 1 && count > 0) status = 'warning';
    }

    return {
      count,
      limit: customLimit,
      degradedLimit: DEGRADED_LIMIT,
      hardLimit: HARD_LIMIT,
      period: currentPeriod,
      tier,
      status,
    };
  } catch {
    return { count: 0, limit: FREE_LIMIT, degradedLimit: DEGRADED_LIMIT, hardLimit: HARD_LIMIT, period: new Date().toISOString().slice(0, 7), tier: 'free' as const, status: 'ok' as const };
  }
}

app.get('/api/usage', async (req, res) => {
  try {
    const usage = await getUserUsage(req.user!.userId);
    res.json(usage);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Stats ── */
app.get('/api/stats', async (req, res) => {
  try {
    const userRepos = await getUserRepos(req.user!.userId);
    const result = await ddb.send(new ScanCommand({ TableName: TABLE }));
    const allJobs = result.Items ?? [];
    // If user has connected repos, scope to those; otherwise show all (backward compat)
    const jobs = userRepos.size > 0 ? allJobs.filter(j => userRepos.has(j.repository as string)) : allJobs;
    const active = ['pending', 'processing', 'reviewing', 'posting'];
    const usage = await getUserUsage(req.user!.userId);
    res.json({
      totalReviews: jobs.length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => !active.includes(j.status) && j.status !== 'completed').length,
      pending: jobs.filter(j => active.includes(j.status)).length,
      repos: [...new Set(jobs.map(j => j.repository))],
      usage,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Jobs (DynamoDB) ── */
app.get('/api/jobs', async (req, res) => {
  try {
    const userRepos = await getUserRepos(req.user!.userId);
    const result = await ddb.send(new ScanCommand({ TableName: TABLE, Limit: 100 }));
    const allJobs = (result.Items ?? []).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    const jobs = userRepos.size > 0 ? allJobs.filter(j => userRepos.has(j.repository as string)) : allJobs;
    res.json({ jobs: jobs.slice(0, 50) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs/:jobId/output', async (req, res) => {
  try {
    res.json(await readS3Json(`packets/${req.params.jobId}/output.json`));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Lintellect review for a specific PR ── */
app.get('/api/review/:owner/:repo/:number', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const fullRepo = `${owner}/${repo}`;
    const prNum = parseInt(number, 10);

    const result = await ddb.send(new ScanCommand({ TableName: TABLE }));
    const jobs = (result.Items ?? [])
      .filter(j => j.repository === fullRepo && j.prNumber === prNum)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

    if (jobs.length === 0) { res.json({ found: false }); return; }

    const latest = jobs[0];
    let output = null;
    if (latest.status === 'completed') {
      try { output = await readS3Json(`packets/${latest.jobId}/output.json`); } catch {}
    }

    res.json({ found: true, job: latest, output, allJobs: jobs });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── GitHub: User's repos ── */
app.get('/api/repos', async (req, res) => {
  try {
    const token = await getToken(req);
    const repos = await ghFetch('/user/repos?per_page=100&sort=updated&type=all', token);
    res.json(repos);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Repo param validation middleware ── */
app.param('owner', (req, res, next, value) => {
  if (!validateRepoParam(value)) { res.status(400).json({ error: 'Invalid owner parameter' }); return; }
  next();
});
app.param('repo', (req, res, next, value) => {
  if (!validateRepoParam(value)) { res.status(400).json({ error: 'Invalid repo parameter' }); return; }
  next();
});

/* ── Repo Connection: Connect (install webhook) ── */
app.post('/api/repos/:owner/:repo/connect', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo } = req.params;
    const webhookUrl = process.env.WEBHOOK_URL ?? 'https://pod8xc2p5j.execute-api.us-east-1.amazonaws.com/webhook/github';
    let webhookSecret: string;
    try {
      const sec = await sm.send(new GetSecretValueCommand({ SecretId: 'lintellect/webhook-secret' }));
      webhookSecret = sec.SecretString!;
    } catch {
      webhookSecret = process.env.WEBHOOK_SECRET ?? '';
    }

    // Create webhook on the repo (or find existing one)
    let webhookId = '';
    try {
      const hook = await ghFetch(`/repos/${owner}/${repo}/hooks`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'web',
          active: true,
          events: ['pull_request'],
          config: { url: webhookUrl, content_type: 'json', secret: webhookSecret, insecure_ssl: '0' },
        }),
      });
      webhookId = String(hook.id);
    } catch (err: any) {
      if (err.message?.includes('422') || err.message?.includes('already exists')) {
        // Webhook already exists - find it
        try {
          const hooks = await ghFetch(`/repos/${owner}/${repo}/hooks`, token) as any[];
          const existing = hooks.find((h: any) => h.config?.url === webhookUrl);
          webhookId = existing ? String(existing.id) : 'existing';
        } catch { webhookId = 'existing'; }
      } else if (err.message?.includes('404') || err.message?.includes('Not Found')) {
        // No admin access - save connection anyway, webhook must be installed manually
        webhookId = 'no-admin';
      } else {
        throw err;
      }
    }

    // Store connection in DynamoDB
    const connectionsTable = process.env.CONNECTIONS_TABLE ?? 'LintellectConnections';
    await ddb.send(new PutCommand({
      TableName: connectionsTable,
      Item: {
        repoFullName: `${owner}/${repo}`,
        userId: req.user!.userId,
        webhookId,
        connectedAt: new Date().toISOString(),
      },
    }));

    res.json({ ok: true, webhookId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Repo Connection: Disconnect (remove webhook) ── */
app.post('/api/repos/:owner/:repo/disconnect', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo } = req.params;
    const connectionsTable = process.env.CONNECTIONS_TABLE ?? 'LintellectConnections';

    // Get stored webhook ID
    const result = await ddb.send(new GetCommand({
      TableName: connectionsTable,
      Key: { repoFullName: `${owner}/${repo}` },
    }));

    if (result.Item?.webhookId) {
      try {
        await ghFetch(`/repos/${owner}/${repo}/hooks/${result.Item.webhookId}`, token, { method: 'DELETE' });
      } catch { /* webhook may already be deleted */ }
    }

    // Remove connection from DynamoDB
    await ddb.send(new DeleteCommand({
      TableName: connectionsTable,
      Key: { repoFullName: `${owner}/${repo}` },
    }));

    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Repo Connection: List connected repos ── */
app.get('/api/repos/connected', async (req, res) => {
  try {
    const connectionsTable = process.env.CONNECTIONS_TABLE ?? 'LintellectConnections';
    const result = await ddb.send(new ScanCommand({
      TableName: connectionsTable,
      FilterExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': req.user!.userId },
    }));
    const connected = (result.Items ?? []).map(i => i.repoFullName as string);
    res.json({ connected });
  } catch {
    // Table may not exist yet in dev - return empty
    res.json({ connected: [] });
  }
});

/* ── GitHub: Repos from DDB ── */
app.get('/api/github/repos', async (req, res) => {
  try {
    const token = await getToken(req);
    const result = await ddb.send(new ScanCommand({ TableName: TABLE }));
    const repoNames = [...new Set((result.Items ?? []).map(j => j.repository as string))];
    const repos = await Promise.all(
      repoNames.map(async (full_name) => {
        try { return await ghFetch(`/repos/${full_name}`, token); }
        catch { const [o, n] = full_name.split('/'); return { full_name, owner: { login: o, avatar_url: '' }, name: n }; }
      })
    );
    res.json(repos);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── GitHub: PRs ── */
app.get('/api/github/:owner/:repo/pulls', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo } = req.params;
    const state = (req.query.state as string) ?? 'all';
    res.json(await ghFetch(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=30&sort=updated&direction=desc`, token));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/github/:owner/:repo/pulls/:number', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo, number } = req.params;
    res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}`, token));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/github/:owner/:repo/pulls/:number/files', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo, number } = req.params;
    res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, token));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/github/:owner/:repo/pulls/:number/comments', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo, number } = req.params;
    res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`, token));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── GitHub: Actions ── */
app.post('/api/github/:owner/:repo/pulls/:number/approve', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo, number } = req.params;
    res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/reviews`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'APPROVE', body: 'Approved via Lintellect Dashboard' }),
    }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/github/:owner/:repo/pulls/:number/merge', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo, number } = req.params;
    const { merge_method = 'squash', commit_title } = req.body ?? {};
    res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/merge`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_method, commit_title }),
    }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/github/:owner/:repo/pulls/:number/request-changes', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo, number } = req.params;
    const { body: reviewBody } = req.body ?? {};
    res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/reviews`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'REQUEST_CHANGES', body: reviewBody ?? 'Changes requested via Lintellect Dashboard' }),
    }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── GitHub: Add comment ── */
app.post('/api/github/:owner/:repo/issues/:number/comments', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo, number } = req.params;
    const { body: commentBody } = req.body ?? {};
    res.json(await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: commentBody }),
    }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── GitHub: Close/reopen PR ── */
app.patch('/api/github/:owner/:repo/pulls/:number', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo, number } = req.params;
    res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    }));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ══════════════════════════════════════════════════════
   ADMIN ENDPOINTS
   ══════════════════════════════════════════════════════ */

async function adminMiddleware(req: Request, res: Response, next: NextFunction) {
  const result = await ddb.send(new GetCommand({
    TableName: USERS_TABLE(),
    Key: { userId: req.user!.userId },
  }));
  if (result.Item?.isAdmin !== true) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

app.use('/api/admin', authMiddleware, adminMiddleware);

/* ── Admin: List all users ── */
app.get('/api/admin/users', async (_req, res) => {
  try {
    const result = await ddb.send(new ScanCommand({ TableName: USERS_TABLE() }));
    const users = (result.Items ?? [])
      .filter(i => i.userId !== APP_CONFIG_KEY)
      .map(i => ({
        userId: i.userId,
        githubLogin: i.githubLogin ?? '',
        avatarUrl: i.avatarUrl ?? '',
        awsConfigured: i.awsConfigured === true,
        usageCount: i.usageCount ?? 0,
        usagePeriod: i.usagePeriod ?? '',
        lastLoginAt: i.lastLoginAt ?? '',
        isAdmin: i.isAdmin === true,
        onboardingCompleted: i.onboardingCompleted === true,
        customLimit: i.customLimit ?? null,
      }));
    res.json({ users });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Admin: System stats ── */
app.get('/api/admin/stats', async (_req, res) => {
  try {
    const usersResult = await ddb.send(new ScanCommand({ TableName: USERS_TABLE() }));
    const allUsers = (usersResult.Items ?? []).filter(i => i.userId !== APP_CONFIG_KEY);
    const currentPeriod = new Date().toISOString().slice(0, 7);

    const freeUsers = allUsers.filter(u => u.awsConfigured !== true);
    const proUsers = allUsers.filter(u => u.awsConfigured === true);

    const totalReviewsThisMonth = allUsers
      .filter(u => u.usagePeriod === currentPeriod)
      .reduce((sum, u) => sum + ((u.usageCount as number) ?? 0), 0);

    const topUsers = allUsers
      .filter(u => u.usagePeriod === currentPeriod && (u.usageCount as number) > 0)
      .sort((a, b) => ((b.usageCount as number) ?? 0) - ((a.usageCount as number) ?? 0))
      .slice(0, 10)
      .map(u => ({ login: u.githubLogin, count: u.usageCount, tier: u.awsConfigured === true ? 'pro' : 'free' }));

    res.json({
      totalUsers: allUsers.length,
      freeUsers: freeUsers.length,
      proUsers: proUsers.length,
      totalReviewsThisMonth,
      topUsers,
      period: currentPeriod,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Admin: Override user limit ── */
app.put('/api/admin/users/:userId/limit', async (req, res) => {
  try {
    const { userId } = req.params;
    const { customLimit } = req.body ?? {};
    if (typeof customLimit !== 'number' || customLimit < 0 || customLimit > 1000) {
      res.status(400).json({ error: 'customLimit must be a number between 0 and 1000' });
      return;
    }
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE(),
      Key: { userId },
      UpdateExpression: 'SET customLimit = :limit, updatedAt = :now',
      ExpressionAttributeValues: { ':limit': customLimit, ':now': new Date().toISOString() },
    }));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Admin: Toggle admin flag ── */
app.put('/api/admin/users/:userId/admin', async (req, res) => {
  try {
    const { userId } = req.params;
    const { isAdmin } = req.body ?? {};
    if (typeof isAdmin !== 'boolean') {
      res.status(400).json({ error: 'isAdmin must be a boolean' });
      return;
    }
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE(),
      Key: { userId },
      UpdateExpression: 'SET isAdmin = :val, updatedAt = :now',
      ExpressionAttributeValues: { ':val': isAdmin, ':now': new Date().toISOString() },
    }));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ── Security Info (public) ── */
app.get('/api/security-info', (_req, res) => {
  res.json({
    encryption: 'AES-256-GCM',
    keyDerivation: 'scrypt',
    apiKeyStorage: 'encrypted-at-rest',
    awsCredStorage: 'encrypted-at-rest',
    sessionType: 'httpOnly-cookie-jwt',
    dataRetention: '90-day-auto-cleanup',
  });
});

const PORT = parseInt(process.env.PORT ?? '3006', 10);
app.listen(PORT, () => console.log(`Lintellect API on http://localhost:${PORT}`));
