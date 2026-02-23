import express from 'express';
import cors from 'cors';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SignJWT, jwtVerify } from 'jose';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { Request, Response, NextFunction } from 'express';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const region = process.env.AWS_REGION ?? 'us-east-1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region });
const sm = new SecretsManagerClient({ region });

const TABLE = process.env.JOB_TABLE ?? '';
const BUCKET = process.env.ARTIFACTS_BUCKET ?? '';
const USERS_TABLE = process.env.USERS_TABLE ?? '';
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE ?? '';
const GH = 'https://api.github.com';

const GH_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GH_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'lintellect-dev-secret-change-in-prod');
const COOKIE_NAME = 'lintellect_session';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://lintellect.vercel.app';

let ghBotToken: string | null = null;

async function getBotGithubToken(): Promise<string> {
  if (ghBotToken) return ghBotToken;
  if (process.env.GITHUB_TOKEN) { ghBotToken = process.env.GITHUB_TOKEN; return ghBotToken; }
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: 'lintellect/github-token' }));
    ghBotToken = res.SecretString!;
    return ghBotToken;
  } catch { throw new Error('Set GITHUB_TOKEN env var or configure Secrets Manager'); }
}

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
  if (!res.ok) { const body = await res.text(); throw new Error(`GitHub ${res.status}: ${body}`); }
  return res.json();
}

async function readS3Json(key: string): Promise<unknown> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return JSON.parse(await res.Body!.transformToString());
}

interface UserPayload { userId: string; login: string; name: string; avatar: string; }

async function signToken(user: UserPayload): Promise<string> {
  return new SignJWT({ ...user }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('7d').sign(JWT_SECRET);
}

async function verifyToken(token: string): Promise<UserPayload | null> {
  try { const { payload } = await jwtVerify(token, JWT_SECRET); return payload as unknown as UserPayload; }
  catch { return null; }
}

declare global { namespace Express { interface Request { user?: UserPayload; ghToken?: string; } } }

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const cookies = parseCookie(req.headers.cookie ?? '');
  const token = cookies[COOKIE_NAME];
  if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const user = await verifyToken(token);
  if (!user) { res.status(401).json({ error: 'Invalid or expired session' }); return; }
  try {
    const result = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: user.userId } }));
    req.ghToken = (result.Item?.accessToken as string) ?? undefined;
  } catch {}
  req.user = user;
  next();
}

async function getToken(req: Request): Promise<string> {
  if (req.ghToken) return req.ghToken;
  return getBotGithubToken();
}

async function getUserRepos(userId: string): Promise<Set<string>> {
  try {
    const result = await ddb.send(new ScanCommand({
      TableName: CONNECTIONS_TABLE,
      FilterExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    }));
    return new Set((result.Items ?? []).map(i => i.repoFullName as string));
  } catch { return new Set(); }
}

/* ── Public Routes ── */
app.get('/api/health', (_req, res) => { res.json({ status: 'ok', timestamp: new Date().toISOString() }); });

app.get('/api/auth/github', (_req, res) => {
  if (!GH_CLIENT_ID) { res.status(500).json({ error: 'GITHUB_CLIENT_ID not configured' }); return; }
  const params = new URLSearchParams({
    client_id: GH_CLIENT_ID, redirect_uri: `${FRONTEND_URL}/api/auth/callback`,
    scope: 'repo read:user user:email', state: crypto.randomUUID(),
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code || typeof code !== 'string') { res.status(400).json({ error: 'Missing code' }); return; }
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET, code }),
    });
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) { res.status(400).json({ error: tokenData.error ?? 'OAuth failed' }); return; }
    const ghUser = await ghFetch('/user', tokenData.access_token) as { id: number; login: string; name: string | null; avatar_url: string; };
    await ddb.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: { userId: String(ghUser.id), githubLogin: ghUser.login, displayName: ghUser.name ?? ghUser.login, avatarUrl: ghUser.avatar_url, accessToken: tokenData.access_token, lastLoginAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    }));
    const jwt = await signToken({ userId: String(ghUser.id), login: ghUser.login, name: ghUser.name ?? ghUser.login, avatar: ghUser.avatar_url });
    res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, jwt, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60, path: '/' }));
    res.redirect(FRONTEND_URL);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', async (req, res) => {
  const cookies = parseCookie(req.headers.cookie ?? '');
  const token = cookies[COOKIE_NAME];
  if (!token) { res.json({ authenticated: false }); return; }
  const user = await verifyToken(token);
  if (!user) { res.json({ authenticated: false }); return; }
  res.json({ authenticated: true, user });
});

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 0, path: '/' }));
  res.json({ ok: true });
});

/* ── Protected Routes ── */
app.use('/api/stats', authMiddleware);
app.use('/api/jobs', authMiddleware);
app.use('/api/review', authMiddleware);
app.use('/api/github', authMiddleware);
app.use('/api/repos', authMiddleware);

app.get('/api/stats', async (req, res) => {
  try {
    const userRepos = await getUserRepos(req.user!.userId);
    const result = await ddb.send(new ScanCommand({ TableName: TABLE }));
    const allJobs = result.Items ?? [];
    const jobs = userRepos.size > 0 ? allJobs.filter(j => userRepos.has(j.repository as string)) : allJobs;
    const active = ['pending', 'processing', 'reviewing', 'posting'];
    res.json({ totalReviews: jobs.length, completed: jobs.filter(j => j.status === 'completed').length, failed: jobs.filter(j => !active.includes(j.status) && j.status !== 'completed').length, pending: jobs.filter(j => active.includes(j.status)).length, repos: [...new Set(jobs.map(j => j.repository))] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

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
  try { res.json(await readS3Json(`packets/${req.params.jobId}/output.json`)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/review/:owner/:repo/:number', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const fullRepo = `${owner}/${repo}`;
    const prNum = parseInt(number, 10);
    const result = await ddb.send(new ScanCommand({ TableName: TABLE }));
    const jobs = (result.Items ?? []).filter(j => j.repository === fullRepo && j.prNumber === prNum).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    if (jobs.length === 0) { res.json({ found: false }); return; }
    const latest = jobs[0];
    let output = null;
    if (latest.status === 'completed') { try { output = await readS3Json(`packets/${latest.jobId}/output.json`); } catch {} }
    res.json({ found: true, job: latest, output, allJobs: jobs });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/repos', async (req, res) => {
  try { const token = await getToken(req); res.json(await ghFetch('/user/repos?per_page=100&sort=updated&type=all', token)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/repos/:owner/:repo/connect', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo } = req.params;
    const webhookUrl = process.env.WEBHOOK_URL ?? '';
    let webhookSecret: string;
    try { const sec = await sm.send(new GetSecretValueCommand({ SecretId: 'lintellect/webhook-secret' })); webhookSecret = sec.SecretString!; }
    catch { webhookSecret = process.env.WEBHOOK_SECRET ?? ''; }
    const hook = await ghFetch(`/repos/${owner}/${repo}/hooks`, token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'web', active: true, events: ['pull_request'], config: { url: webhookUrl, content_type: 'json', secret: webhookSecret, insecure_ssl: '0' } }),
    });
    await ddb.send(new PutCommand({ TableName: CONNECTIONS_TABLE, Item: { repoFullName: `${owner}/${repo}`, userId: req.user!.userId, webhookId: String(hook.id), connectedAt: new Date().toISOString() } }));
    res.json({ ok: true, webhookId: hook.id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/repos/:owner/:repo/disconnect', async (req, res) => {
  try {
    const token = await getToken(req);
    const { owner, repo } = req.params;
    const result = await ddb.send(new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { repoFullName: `${owner}/${repo}` } }));
    if (result.Item?.webhookId) { try { await ghFetch(`/repos/${owner}/${repo}/hooks/${result.Item.webhookId}`, token, { method: 'DELETE' }); } catch {} }
    await ddb.send(new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { repoFullName: `${owner}/${repo}` } }));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/repos/connected', async (req, res) => {
  try {
    const result = await ddb.send(new ScanCommand({ TableName: CONNECTIONS_TABLE, FilterExpression: 'userId = :uid', ExpressionAttributeValues: { ':uid': req.user!.userId } }));
    res.json({ connected: (result.Items ?? []).map(i => i.repoFullName as string) });
  } catch { res.json({ connected: [] }); }
});

app.get('/api/github/repos', async (req, res) => {
  try {
    const token = await getToken(req);
    const result = await ddb.send(new ScanCommand({ TableName: TABLE }));
    const repoNames = [...new Set((result.Items ?? []).map(j => j.repository as string))];
    const repos = await Promise.all(repoNames.map(async (full_name) => {
      try { return await ghFetch(`/repos/${full_name}`, token); }
      catch { const [o, n] = full_name.split('/'); return { full_name, owner: { login: o, avatar_url: '' }, name: n }; }
    }));
    res.json(repos);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/github/:owner/:repo/pulls', async (req, res) => { try { const token = await getToken(req); const { owner, repo } = req.params; const state = (req.query.state as string) ?? 'all'; res.json(await ghFetch(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=30&sort=updated&direction=desc`, token)); } catch (err: any) { res.status(500).json({ error: err.message }); } });
app.get('/api/github/:owner/:repo/pulls/:number', async (req, res) => { try { const token = await getToken(req); const { owner, repo, number } = req.params; res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}`, token)); } catch (err: any) { res.status(500).json({ error: err.message }); } });
app.get('/api/github/:owner/:repo/pulls/:number/files', async (req, res) => { try { const token = await getToken(req); const { owner, repo, number } = req.params; res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, token)); } catch (err: any) { res.status(500).json({ error: err.message }); } });
app.get('/api/github/:owner/:repo/pulls/:number/comments', async (req, res) => { try { const token = await getToken(req); const { owner, repo, number } = req.params; res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`, token)); } catch (err: any) { res.status(500).json({ error: err.message }); } });
app.post('/api/github/:owner/:repo/pulls/:number/approve', async (req, res) => { try { const token = await getToken(req); const { owner, repo, number } = req.params; res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/reviews`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'APPROVE', body: 'Approved via Lintellect Dashboard' }) })); } catch (err: any) { res.status(500).json({ error: err.message }); } });
app.post('/api/github/:owner/:repo/pulls/:number/merge', async (req, res) => { try { const token = await getToken(req); const { owner, repo, number } = req.params; const { merge_method = 'squash', commit_title } = req.body ?? {}; res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/merge`, token, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merge_method, commit_title }) })); } catch (err: any) { res.status(500).json({ error: err.message }); } });
app.post('/api/github/:owner/:repo/pulls/:number/request-changes', async (req, res) => { try { const token = await getToken(req); const { owner, repo, number } = req.params; const { body: reviewBody } = req.body ?? {}; res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/reviews`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'REQUEST_CHANGES', body: reviewBody ?? 'Changes requested via Lintellect Dashboard' }) })); } catch (err: any) { res.status(500).json({ error: err.message }); } });
app.post('/api/github/:owner/:repo/issues/:number/comments', async (req, res) => { try { const token = await getToken(req); const { owner, repo, number } = req.params; const { body: commentBody } = req.body ?? {}; res.json(await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: commentBody }) })); } catch (err: any) { res.status(500).json({ error: err.message }); } });
app.patch('/api/github/:owner/:repo/pulls/:number', async (req, res) => { try { const token = await getToken(req); const { owner, repo, number } = req.params; res.json(await ghFetch(`/repos/${owner}/${repo}/pulls/${number}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) })); } catch (err: any) { res.status(500).json({ error: err.message }); } });

/* ── Lambda Handler (serverless adapter) ── */
function parseHeaders(event: APIGatewayProxyEventV2): Record<string, string> {
  const h: Record<string, string> = {};
  if (event.headers) { for (const [k, v] of Object.entries(event.headers)) { if (v) h[k.toLowerCase()] = v; } }
  if (event.cookies) h.cookie = event.cookies.join('; ');
  return h;
}

export async function handler(event: APIGatewayProxyEventV2, _context: Context): Promise<APIGatewayProxyResultV2> {
  return new Promise((resolve) => {
    const headers = parseHeaders(event);
    const path = event.rawPath;
    const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
    const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body)) : undefined;

    const req = Object.assign(
      new (require('stream').Readable)({
        read() { if (body) { this.push(body); } this.push(null); },
      }),
      {
        method: event.requestContext.http.method,
        url: `${path}${qs}`,
        headers,
        connection: { remoteAddress: event.requestContext.http.sourceIp },
      }
    );

    const chunks: Buffer[] = [];
    let statusCode = 200;
    const resHeaders: Record<string, string> = {};
    const multiHeaders: Record<string, string[]> = {};

    const res = {
      statusCode: 200,
      writeHead(code: number, h?: Record<string, any>) { statusCode = code; if (h) Object.assign(resHeaders, h); return res; },
      setHeader(key: string, val: string | string[]) {
        if (Array.isArray(val)) { multiHeaders[key.toLowerCase()] = val; }
        else { resHeaders[key.toLowerCase()] = val; }
      },
      getHeader(key: string) { return resHeaders[key.toLowerCase()]; },
      write(chunk: any) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
      end(chunk?: any) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const bodyStr = Buffer.concat(chunks).toString('utf8');
        const cookies = multiHeaders['set-cookie'] ?? (resHeaders['set-cookie'] ? [resHeaders['set-cookie']] : undefined);
        resolve({
          statusCode,
          headers: { ...resHeaders, 'content-type': resHeaders['content-type'] ?? 'application/json' },
          ...(cookies ? { cookies } : {}),
          body: bodyStr,
          isBase64Encoded: false,
        });
      },
      on() { return res; },
      once() { return res; },
      emit() { return false; },
      removeListener() { return res; },
    };

    app(req as any, res as any);
  });
}
