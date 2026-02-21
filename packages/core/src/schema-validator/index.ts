import AjvDefault from 'ajv';
import type { ValidateFunction, ErrorObject } from 'ajv';
import addFormatsDefault from 'ajv-formats';

// Handle ESM/CJS default export differences
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (AjvDefault as any).default ?? AjvDefault;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats = (addFormatsDefault as any).default ?? addFormatsDefault;
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function findSchemasDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, 'schemas');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not find schemas directory');
}

let _schemasDir: string | undefined;
function getSchemasDir(): string {
  if (!_schemasDir) _schemasDir = findSchemasDir();
  return _schemasDir;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
}

type SchemaName =
  | 'review-packet'
  | 'review-output'
  | 'review-comment'
  | 'job-status'
  | 'provider-config';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validators = new Map<SchemaName, ValidateFunction>();

function loadSchema(name: SchemaName): ValidateFunction {
  const cached = validators.get(name);
  if (cached) return cached;

  const schemaPath = resolve(getSchemasDir(), `${name}.schema.json`);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

  // Load referenced schemas if needed
  if (name === 'review-output') {
    const commentSchemaPath = resolve(getSchemasDir(), 'review-comment.schema.json');
    const commentSchema = JSON.parse(readFileSync(commentSchemaPath, 'utf-8'));
    if (!ajv.getSchema(commentSchema.$id)) {
      ajv.addSchema(commentSchema);
    }
  }

  const validate = ajv.compile(schema);
  validators.set(name, validate);
  return validate;
}

function formatErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  if (!errors) return [];
  return errors.map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'unknown error',
    keyword: e.keyword,
  }));
}

export function validateReviewPacket(data: unknown): ValidationResult {
  const validate = loadSchema('review-packet');
  const valid = validate(data) as boolean;
  return { valid, errors: formatErrors(validate.errors) };
}

export function validateReviewOutput(data: unknown): ValidationResult {
  const validate = loadSchema('review-output');
  const valid = validate(data) as boolean;
  return { valid, errors: formatErrors(validate.errors) };
}

export function validateReviewComment(data: unknown): ValidationResult {
  const validate = loadSchema('review-comment');
  const valid = validate(data) as boolean;
  return { valid, errors: formatErrors(validate.errors) };
}

export function validateProviderConfig(data: unknown): ValidationResult {
  const validate = loadSchema('provider-config');
  const valid = validate(data) as boolean;
  return { valid, errors: formatErrors(validate.errors) };
}

export function validateJobStatus(data: unknown): ValidationResult {
  const validate = loadSchema('job-status');
  const valid = validate(data) as boolean;
  return { valid, errors: formatErrors(validate.errors) };
}

export function validateSchema(schemaName: SchemaName, data: unknown): ValidationResult {
  const validate = loadSchema(schemaName);
  const valid = validate(data) as boolean;
  return { valid, errors: formatErrors(validate.errors) };
}
