import type { ReviewPacket } from '../../src/types.js';

/**
 * Golden packet: Simple TypeScript null-check fix.
 * Expected: Logic pass should flag the == vs === issue.
 */
export const NULL_CHECK_PACKET: ReviewPacket = {
  jobId: '550e8400-e29b-41d4-a716-446655440001',
  repository: { owner: 'acme', name: 'api', fullName: 'acme/api' },
  pullRequest: {
    number: 101,
    title: 'Fix null check in auth middleware',
    description: 'Fixes loose equality check for null tokens',
    author: 'dev1',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    url: 'https://github.com/acme/api/pull/101',
  },
  diff: [
    'diff --git a/src/auth.ts b/src/auth.ts',
    'index abc1234..def5678 100644',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -10,6 +10,6 @@ export function authenticate(req: Request) {',
    '   const header = req.headers.authorization;',
    '   if (!header) return null;',
    '-  const token = header.split(\' \')[1];',
    '+  const token = header.replace(\'Bearer \', \'\').trim();',
    '   if (token == null) {',
    '     return null;',
    '   }',
    '',
  ].join('\n'),
  commitMessages: ['Fix null check in auth middleware'],
  files: [
    { path: 'src/auth.ts', language: 'typescript', status: 'modified', additions: 1, deletions: 1 },
  ],
  createdAt: '2026-02-07T10:00:00.000Z',
  metadata: { webhookEventId: 'golden-null-check', installationId: null },
};

/**
 * Golden packet: SQL injection vulnerability in query builder.
 * Expected: Security pass should flag the string interpolation.
 */
export const SQL_INJECTION_PACKET: ReviewPacket = {
  jobId: '550e8400-e29b-41d4-a716-446655440002',
  repository: { owner: 'acme', name: 'api', fullName: 'acme/api' },
  pullRequest: {
    number: 102,
    title: 'Add user search endpoint',
    description: 'Adds ability to search users by name',
    author: 'dev2',
    baseSha: 'c'.repeat(40),
    headSha: 'd'.repeat(40),
    url: 'https://github.com/acme/api/pull/102',
  },
  diff: [
    'diff --git a/src/routes/users.ts b/src/routes/users.ts',
    'new file mode 100644',
    'index 0000000..abc1234',
    '--- /dev/null',
    '+++ b/src/routes/users.ts',
    '@@ -0,0 +1,11 @@',
    '+import { db } from \'../db\';',
    '+',
    '+export async function searchUsers(name: string) {',
    '+  const query = `SELECT * FROM users WHERE name LIKE \'%${name}%\'`;',
    '+  return db.query(query);',
    '+}',
    '+',
    '+export async function getUser(id: string) {',
    '+  const query = `SELECT * FROM users WHERE id = \'${id}\'`;',
    '+  return db.query(query);',
    '+}',
    '',
  ].join('\n'),
  commitMessages: ['Add user search endpoint'],
  files: [
    { path: 'src/routes/users.ts', language: 'typescript', status: 'added', additions: 11, deletions: 0 },
  ],
  createdAt: '2026-02-07T10:00:00.000Z',
  metadata: { webhookEventId: 'golden-sql-injection', installationId: null },
};

/**
 * Golden packet: Missing error handling in async function.
 * Expected: Logic pass should flag the missing try-catch.
 */
export const MISSING_ERROR_HANDLING_PACKET: ReviewPacket = {
  jobId: '550e8400-e29b-41d4-a716-446655440003',
  repository: { owner: 'acme', name: 'api', fullName: 'acme/api' },
  pullRequest: {
    number: 103,
    title: 'Add payment processing',
    description: null,
    author: 'dev3',
    baseSha: 'e'.repeat(40),
    headSha: 'f'.repeat(40),
    url: 'https://github.com/acme/api/pull/103',
  },
  diff: [
    'diff --git a/src/payment.ts b/src/payment.ts',
    'new file mode 100644',
    'index 0000000..abc1234',
    '--- /dev/null',
    '+++ b/src/payment.ts',
    '@@ -0,0 +1,13 @@',
    '+import { stripe } from \'./stripe-client\';',
    '+',
    '+export async function processPayment(amount: number, token: string) {',
    '+  const charge = await stripe.charges.create({',
    '+    amount,',
    '+    currency: \'usd\',',
    '+    source: token,',
    '+  });',
    '+  return charge;',
    '+}',
    '+',
    '+export async function refundPayment(chargeId: string) {',
    '+  const refund = await stripe.refunds.create({ charge: chargeId });',
    '',
  ].join('\n'),
  commitMessages: ['Add payment processing'],
  files: [
    { path: 'src/payment.ts', language: 'typescript', status: 'added', additions: 13, deletions: 0 },
  ],
  createdAt: '2026-02-07T10:00:00.000Z',
  metadata: { webhookEventId: 'golden-error-handling', installationId: null },
};

/**
 * Golden packet: Empty diff (no changes).
 * Expected: All passes should return zero comments.
 */
export const EMPTY_DIFF_PACKET: ReviewPacket = {
  jobId: '550e8400-e29b-41d4-a716-446655440004',
  repository: { owner: 'acme', name: 'api', fullName: 'acme/api' },
  pullRequest: {
    number: 104,
    title: 'Empty PR',
    description: null,
    author: 'dev1',
    baseSha: 'a'.repeat(40),
    headSha: 'a'.repeat(40),
    url: 'https://github.com/acme/api/pull/104',
  },
  diff: '',
  commitMessages: [],
  files: [],
  createdAt: '2026-02-07T10:00:00.000Z',
  metadata: { webhookEventId: 'golden-empty', installationId: null },
};

export const ALL_GOLDEN_PACKETS = [
  { name: 'null-check', packet: NULL_CHECK_PACKET },
  { name: 'sql-injection', packet: SQL_INJECTION_PACKET },
  { name: 'missing-error-handling', packet: MISSING_ERROR_HANDLING_PACKET },
  { name: 'empty-diff', packet: EMPTY_DIFF_PACKET },
];
