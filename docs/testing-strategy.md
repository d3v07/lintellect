# Lintellect -- Testing Strategy

**Task ID:** T-0.7
**Author:** test-writer-fixer
**Created:** 2026-02-07
**Status:** DRAFT

---

## Table of Contents

1. [Testing Philosophy](#1-testing-philosophy)
2. [Test Categories](#2-test-categories)
   - [2.1 Unit Tests](#21-unit-tests)
   - [2.2 Golden Packet Test Fixtures](#22-golden-packet-test-fixtures)
   - [2.3 Evidence Gate Tests](#23-evidence-gate-tests)
   - [2.4 Schema Validation Tests](#24-schema-validation-tests)
3. [Integration Test Plan](#3-integration-test-plan)
4. [E2E Test Plan](#4-e2e-test-plan)
5. [Coverage Requirements](#5-coverage-requirements)
6. [Test Infrastructure](#6-test-infrastructure)
7. [Test Data Management](#7-test-data-management)
8. [Cross-References](#8-cross-references)

---

## 1. Testing Philosophy

Lintellect's test suite is built on three non-negotiable principles.

### 1.1 Evidence-Driven

Every test assertion maps to a specific requirement from `/docs/RFC.md` or `/docs/architecture.md`. Tests are not written for coverage metrics; they are written because a documented requirement demands verification. Each test file includes a comment block citing the requirement it validates:

```typescript
/**
 * Requirement: RFC-001 Section 5.2, Rule 1 (Line Number Existence)
 * "Every comment must reference at least one specific line number.
 *  That line number must exist within the diff hunks of the referenced file."
 */
describe('EvidenceValidator.validateLineNumber', () => {
  it('rejects a comment citing a line number outside all diff hunk ranges', () => {
    // ...
  });
});
```

When a test has no traceable requirement, the test is either documenting an implicit contract (which should be formalized) or is unnecessary. Both conditions must be resolved before the test is merged.

### 1.2 Determinism

Tests must be reproducible without network access. All external dependencies are mocked at the boundary:

| Boundary | Mock Strategy |
|----------|--------------|
| GitHub API (REST) | MSW (Mock Service Worker) request handlers or nock HTTP interceptors |
| LLM Provider (Anthropic / Bedrock) | Mock `LLMProvider` adapter returning deterministic JSON from fixture files |
| AWS S3 | In-memory Map-based mock implementing `GetObjectCommand` / `PutObjectCommand` |
| AWS DynamoDB | In-memory Map-based mock implementing `PutItemCommand` / `UpdateItemCommand` / `GetItemCommand` |
| AWS SQS | In-memory queue mock |
| AWS Step Functions | Mocked Step Functions client or `stepfunctions-local` Docker container |
| File system (tree-sitter grammars) | Bundled `.wasm` test fixtures in `__tests__/fixtures/grammars/` |

No test may depend on: a running Docker container (except integration tests explicitly marked with `@integration`), an active internet connection, a populated database or S3 bucket, specific environment variables beyond `NODE_ENV=test`, or wall-clock time (use `vi.useFakeTimers()`).

A test that passes on Monday but fails on Tuesday without code changes is a defect in the test, not in the code.

### 1.3 Speed

| Test Category | Time Budget | Runner |
|--------------|-------------|--------|
| Unit tests (all packages) | < 5 seconds total | `vitest run` (parallel) |
| Integration tests | < 30 seconds total | `vitest run --project integration` |
| E2E tests (staging) | < 5 minutes total | `vitest run --project e2e` (sequential) |

These budgets are enforced in CI. A PR that causes the unit test suite to exceed 5 seconds is flagged for review. The primary strategy for maintaining speed is aggressive mocking at boundaries and avoiding any I/O in unit tests.

### 1.4 Test Naming Convention

Test files are co-located with source files using the `.test.ts` suffix:

```
packages/core/src/evidence-validator/
  index.ts
  index.test.ts
  types.ts
```

`describe` blocks name the module or class under test. `it` blocks describe the behavior, not the implementation. The pattern is: `it('does X when Y')` or `it('returns X given Y')`.

```typescript
describe('EvidenceValidator', () => {
  describe('validate', () => {
    it('accepts a comment with a valid line number and exact snippet match', () => { /* ... */ });
    it('rejects a comment when the cited line number is outside all diff hunks', () => { /* ... */ });
  });
});
```

Avoid implementation-leaked names like `it('calls parseHunk internally')`. Test observable behavior.

---

## 2. Test Categories

### 2.1 Unit Tests

Unit tests cover every public function in every core module. Each module section below defines what is tested, the critical edge cases, and the mock boundaries.

#### 2.1.1 packet-builder (`packages/core/src/packet-builder/`)

**Purpose:** Constructs a valid `ReviewPacket` from a GitHub webhook payload and supplementary GitHub API data (full diff, PR description, commit messages).

**Test cases:**

| # | Test Case | Input | Expected Outcome |
|---|-----------|-------|-----------------|
| 1 | Constructs a valid ReviewPacket from a standard PR webhook | Standard `pull_request.opened` webhook payload + mock GitHub API responses | ReviewPacket passes `review-packet.schema.json` validation |
| 2 | Constructs a valid ReviewPacket from a draft PR webhook | `pull_request.opened` with `draft: true` | ReviewPacket passes validation; `isDraft` field set to `true` |
| 3 | Constructs a valid ReviewPacket from a fork PR webhook | `pull_request.opened` with `head.repo.fork: true` | ReviewPacket passes validation; fork metadata preserved |
| 4 | Handles missing PR description gracefully | Webhook payload with `body: null` | ReviewPacket passes validation; `description` field is empty string or null |
| 5 | Handles missing commit messages gracefully | GitHub API returns empty commit list | ReviewPacket passes validation; `commitMessages` is empty array |
| 6 | Rejects a webhook payload missing required fields | Payload missing `pull_request.number` | Throws typed `PacketBuilderError` with field path in error message |
| 7 | Serializes to JSON without circular references | Standard ReviewPacket | `JSON.parse(JSON.stringify(packet))` deep-equals the original |
| 8 | Validates the constructed packet against the schema | ReviewPacket with all fields populated | `schemaValidator.validate('review-packet', packet)` returns `{ valid: true }` |

**Mock boundaries:** GitHub API responses (mocked HTTP), schema validator (real -- not mocked, as it is lightweight and deterministic).

---

#### 2.1.2 diff-parser (`packages/core/src/diff-parser/`)

**Purpose:** Parses unified diffs into structured, AST-annotated representations. Uses `parse-diff` for structural parsing and `web-tree-sitter` for AST node annotation.

**Test cases:**

| # | Test Case | Input | Expected Outcome |
|---|-----------|-------|-----------------|
| 1 | Parses a single-file unified diff correctly | Unified diff with one file, one hunk, 3 additions, 2 deletions | Structured output: 1 file, 1 hunk, correct line numbers, correct `+`/`-` markers |
| 2 | Parses a multi-file unified diff correctly | Unified diff with 3 files, mixed hunks | Structured output: 3 files, each with correct hunk boundaries |
| 3 | Handles binary files gracefully | Diff containing `Binary files a/image.png and b/image.png differ` | File entry with `isBinary: true`, no hunks, no line-level data |
| 4 | Detects file renames | Diff with `rename from src/old.ts` / `rename to src/new.ts` + similarity index | File entry with `oldPath`, `newPath`, `isRename: true` |
| 5 | Detects renames with modifications | Renamed file with content changes in the hunk | File entry with `isRename: true` AND non-empty hunks with line changes |
| 6 | Handles empty diff (no changes) | Empty string or diff with no file entries | Empty array of files; no error thrown |
| 7 | Handles a large diff (>1000 lines) | Synthetically generated diff with 50 files, 1000+ changed lines | Parsed within 500ms; all files and hunks present; no truncation |
| 8 | Annotates AST nodes for TypeScript files | Diff modifying a TypeScript function body | Changed lines annotated with `astNode: "function_declaration"` or appropriate node type |
| 9 | Annotates AST nodes for JavaScript files | Diff modifying a JavaScript class method | Changed lines annotated with correct AST node type |
| 10 | Annotates AST nodes for Python files | Diff modifying a Python function | Changed lines annotated with `astNode: "function_definition"` |
| 11 | Annotates AST nodes for Go files | Diff modifying a Go function | Changed lines annotated with `astNode: "function_declaration"` |
| 12 | Degrades gracefully for unsupported languages | Diff modifying a `.rs` file (if Rust grammar not loaded) | File entry parsed structurally; AST annotations absent (not errored) |
| 13 | Handles diff with no-newline-at-end-of-file marker | Diff containing `\ No newline at end of file` | Parsed correctly without treating the marker as a code line |

**Mock boundaries:** `web-tree-sitter` grammars (real `.wasm` files bundled in test fixtures for JS/TS/Python/Go).

---

#### 2.1.3 context-gatherer (`packages/core/src/context-gatherer/`)

**Purpose:** Fetches surrounding code context from the GitHub API, resolves imports and type definitions, includes PR metadata, and enforces a configurable token budget with priority-based trimming.

**Test cases:**

| # | Test Case | Input | Expected Outcome |
|---|-----------|-------|-----------------|
| 1 | Fetches correct surrounding code (N lines above/below hunk) | Parsed diff with one file, one hunk at lines 40-50; `surroundingLines: 10` | Context includes lines 30-60 from mocked GitHub API |
| 2 | Resolves imported files | Parsed diff for a file containing `import { validate } from './validator'` | Context includes content of `./validator.ts` from mocked GitHub API |
| 3 | Includes PR description in context | Parsed diff + PR metadata with a description | Context object contains `prDescription` field |
| 4 | Includes commit messages in context | Parsed diff + PR metadata with 3 commit messages | Context object contains `commitMessages` array with 3 entries |
| 5 | Enforces token budget (stays within limit) | Parsed diff + context that totals 5000 tokens; budget is 10000 | Context object has `tokenCount <= 10000`; no trimming applied |
| 6 | Trims lowest-priority content when budget exceeded | Parsed diff + context that totals 80000 tokens; budget is 60000 | Trimmed to fit within 60000 tokens; `trimmedSections` array is non-empty |
| 7 | Trimming priority order: related files first, then surrounding context, then commit messages, then PR description | Large context exceeding budget by varying amounts | Each priority tier is trimmed in order; higher-priority content preserved |
| 8 | Handles missing files gracefully (404 from GitHub API) | Parsed diff referencing an import that returns 404 | Context built without that file; no error thrown; `warnings` array includes a missing-file note |
| 9 | Handles GitHub API rate limiting | Mocked GitHub API returning 403 with `X-RateLimit-Remaining: 0` | Throws a typed `RateLimitError` with `retryAfter` timestamp |
| 10 | Returns structured context with source attribution | Standard input | Every section in the context object includes `source` field (e.g., `"surrounding_code"`, `"import"`, `"pr_description"`) |

**Mock boundaries:** GitHub API (MSW or nock), token counter (real implementation for accuracy, or a mock that returns predictable counts).

---

#### 2.1.4 evidence-validator (`packages/core/src/evidence-validator/`)

This is the most critical test surface in the entire system. See **Section 2.3** for the detailed evidence gate test matrix (12+ test cases).

---

#### 2.1.5 schema-validator (`packages/core/src/schema-validator/`)

**Purpose:** Validates data objects against pre-compiled JSON Schemas using Ajv. Provides both `validateOrThrow` (throws on failure) and `validateSafe` (returns result object) methods.

See **Section 2.4** for the detailed schema validation test matrix (5 schemas x 5+ test cases each).

---

#### 2.1.6 prompt-runner (`packages/core/src/prompt-runner/`)

**Purpose:** Assembles prompts from templates + review packet + gathered context, orchestrates 4 parallel LLM passes (structural, logic, style, security), merges results, and validates output.

**Test cases:**

| # | Test Case | Input | Expected Outcome |
|---|-----------|-------|-----------------|
| 1 | Assembles correct prompt for structural pass | ReviewPacket + context for a TS file change | Prompt string contains structural review instructions, the diff content, and the evidence gate suffix |
| 2 | Assembles correct prompt for logic pass | ReviewPacket + context | Prompt string contains logic review instructions |
| 3 | Assembles correct prompt for style pass | ReviewPacket + context | Prompt string contains style review instructions |
| 4 | Assembles correct prompt for security pass | ReviewPacket + context | Prompt string contains security review instructions |
| 5 | Calls provider with correct ReviewOptions | ReviewPacket + context + provider config | Mock provider's `review()` called with correct `modelId`, `temperature`, `maxOutputTokens`, `timeoutMs` |
| 6 | Merges 4 pass results correctly | Mock provider returns deterministic responses for each pass | Merged output contains comments from all 4 passes; no duplicates |
| 7 | Deduplicates comments across passes | Two passes produce comments on the same file/line/issue | Merged output keeps the higher-severity comment; duplicate removed |
| 8 | Handles partial failures (3/4 passes succeed) | Mock provider throws `ProviderError` on pass 3 (style); passes 1, 2, 4 succeed | Merged output contains comments from passes 1, 2, 4; pass 3 marked as failed; no thrown error |
| 9 | Handles complete failure (0/4 passes succeed) | Mock provider throws on all 4 passes | Throws `PromptRunnerError` with details of all 4 failures |
| 10 | Fails fast when token budget exceeded | ReviewPacket + context exceeding model's `maxContextWindow` | Throws `TokenBudgetExceededError` before calling the provider |
| 11 | Appends evidence gate suffix to every prompt | Any pass | Every assembled prompt ends with the evidence gate instruction from `/docs/prompting.md` |
| 12 | Validates each pass output against schema | Mock provider returns valid JSON | Each pass result validated against `review-output.schema.json` (or pass sub-schema) |
| 13 | Supports selective pass execution | `passes: ['structural', 'security']` option | Only structural and security passes executed; logic and style skipped |
| 14 | Uses fallback provider when primary fails | Primary provider throws non-retryable error; fallback configured | Fallback provider called with same prompt and options |

**Mock boundaries:** LLM provider (mock `LLMProvider` adapter returning fixture JSON), evidence validator (real -- called during merge), schema validator (real).

**Snapshot testing:** Prompt assembly is tested with Vitest snapshots. Each pass's assembled prompt is snapshotted to detect template drift. If a prompt template changes, the snapshot test fails, forcing the developer to review the change and update the snapshot explicitly.

```typescript
it('assembles the structural pass prompt matching the snapshot', () => {
  const prompt = promptRunner.assemblePrompt('structural', mockPacket, mockContext);
  expect(prompt).toMatchSnapshot();
});
```

---

#### 2.1.7 claude-direct provider (`packages/providers/src/claude-direct/`)

**Purpose:** Implements the `LLMProvider` interface using `@anthropic-ai/sdk`. Handles streaming, retries, rate limits, and error mapping.

**Test cases:**

| # | Test Case | Input | Expected Outcome |
|---|-----------|-------|-----------------|
| 1 | Sends correct API request format | Review prompt + options | Mocked `@anthropic-ai/sdk` client called with correct `model`, `messages`, `max_tokens`, `temperature`, `system` |
| 2 | Handles streaming response correctly | Mock SDK returns streaming chunks | Async generator yields correct `ReviewChunk` objects; final chunk has `done: true` and `usage` populated |
| 3 | Maps HTTP 429 to RATE_LIMITED error code | Mock SDK throws 429 error | Thrown `ProviderError` has `code: "RATE_LIMITED"`, `retryable: true` |
| 4 | Maps HTTP 500 to SERVER_ERROR error code | Mock SDK throws 500 error | Thrown `ProviderError` has `code: "SERVER_ERROR"`, `retryable: true` |
| 5 | Maps HTTP 401 to AUTH_FAILURE error code | Mock SDK throws 401 error | Thrown `ProviderError` has `code: "AUTH_FAILURE"`, `retryable: false` |
| 6 | Maps context length exceeded error | Mock SDK throws `invalid_request_error` with context length message | Thrown `ProviderError` has `code: "CONTEXT_LENGTH_EXCEEDED"`, `retryable: false` |
| 7 | Retries on transient errors with exponential backoff | Mock SDK throws 500 on first call, succeeds on second | Provider returns successful response; two calls made to SDK; delay between calls follows backoff policy |
| 8 | Exhausts retries and throws | Mock SDK throws 500 on every call; `maxRetries: 3` | Thrown `ProviderError` after 4 total attempts (1 initial + 3 retries) |
| 9 | Respects rate limit headers | Mock SDK succeeds but response includes `x-ratelimit-remaining-requests: 1` | Provider throttles subsequent calls (or emits a warning) |
| 10 | Estimates token count conservatively | Various text inputs of known token length | `estimateTokens()` returns a value >= actual token count (within 20% margin) |

**Mock boundaries:** `@anthropic-ai/sdk` client (mocked at the SDK level, not HTTP level; this ensures we test our SDK usage, not the SDK internals).

---

#### 2.1.8 bedrock provider (`packages/providers/src/bedrock/`)

**Purpose:** Implements the `LLMProvider` interface using `@aws-sdk/client-bedrock-runtime`. Handles IAM auth, streaming, throttling, and error mapping.

**Test cases:**

| # | Test Case | Input | Expected Outcome |
|---|-----------|-------|-----------------|
| 1 | Sends correct Bedrock request format | Review prompt + options | Mocked `BedrockRuntimeClient.send()` called with `InvokeModelWithResponseStreamCommand` containing correct `modelId`, request body shape |
| 2 | Handles streaming response correctly | Mock SDK returns streaming response chunks | Async generator yields correct `ReviewChunk` objects; final chunk has `done: true` |
| 3 | Uses IAM auth from credential chain | No explicit credentials; mock AWS credential provider | Client initialized without explicit credentials; relies on default credential chain |
| 4 | Maps ThrottlingException to RATE_LIMITED | Mock SDK throws `ThrottlingException` | Thrown `ProviderError` has `code: "RATE_LIMITED"`, `retryable: true` |
| 5 | Maps AccessDeniedException to AUTH_FAILURE | Mock SDK throws `AccessDeniedException` | Thrown `ProviderError` has `code: "AUTH_FAILURE"`, `retryable: false` |
| 6 | Maps ModelTimeoutException to TIMEOUT | Mock SDK throws `ModelTimeoutException` | Thrown `ProviderError` has `code: "TIMEOUT"`, `retryable: true` |
| 7 | Maps ResourceNotFoundException to MODEL_NOT_FOUND | Mock SDK throws `ResourceNotFoundException` | Thrown `ProviderError` has `code: "MODEL_NOT_FOUND"`, `retryable: false` |
| 8 | Retries on throttling with exponential backoff | Mock SDK throws `ThrottlingException` twice, succeeds on third | Provider returns successful response; three calls made |
| 9 | Translates prompt format to Bedrock Messages API shape | Standard prompt input | Request body matches Bedrock's expected `anthropic_version`, `messages`, `max_tokens` format |
| 10 | Estimates token count with same approximation as claude-direct | Various text inputs | `estimateTokens()` returns consistent estimates (within 5% of claude-direct provider) |

**Mock boundaries:** `@aws-sdk/client-bedrock-runtime` (mocked at the SDK client level using `vi.mock`).

---

### 2.2 Golden Packet Test Fixtures

Golden packet tests are end-to-end deterministic tests of the core pipeline: given a known input, verify the exact expected output. They run the full pipeline (packet-builder through evidence-gate) using a mock LLM provider that returns canned, deterministic responses.

**Location:** `packages/core/__tests__/golden-packets/`

**Structure:**

```
packages/core/__tests__/golden-packets/
  01-simple-ts-edit/
    input.json              # ReviewPacket (webhook + diff data)
    mock-responses/
      pass-1-structural.json  # Canned LLM response for structural pass
      pass-2-logic.json       # Canned LLM response for logic pass
      pass-3-style.json       # Canned LLM response for style pass
      pass-4-security.json    # Canned LLM response for security pass
    expected-output.json    # Expected merged, evidence-validated review output
    description.md          # Human-readable description of what this fixture tests
  02-multi-file-refactor/
    ...
  03-empty-diff/
    ...
  04-binary-file/
    ...
  05-large-pr/
    ...
  06-security-vulnerability/
    ...
  07-rename-detection/
    ...
```

#### Fixture Catalog

| # | Fixture Name | Description | What It Tests |
|---|-------------|-------------|---------------|
| 01 | `simple-ts-edit` | A single TypeScript file edit: one function body changed, 10 lines added, 3 removed. Simple, clean diff with one hunk. | Happy path. Verifies the pipeline produces a valid review with comments from all 4 passes. All evidence citations are valid. |
| 02 | `multi-file-refactor` | Three files changed: a function moved from `utils.ts` to `helpers.ts`, imports updated in `index.ts`, type definition updated in `types.ts`. | Cross-file analysis. Verifies that the context-gatherer resolves imports, the diff-parser handles multiple files, and the prompt-runner produces coherent cross-file comments. |
| 03 | `empty-diff` | A PR opened with no code changes (description-only update, or a merge commit with no diff). | Edge case: empty input. Verifies the pipeline produces an empty review (no comments) without errors. Output validates against schema with zero comments. |
| 04 | `binary-file` | A PR that adds `logo.png` (binary file) and modifies one `.ts` file. | Binary handling. Verifies the diff-parser marks the binary file as `isBinary: true` and skips it for review. The `.ts` file is reviewed normally. |
| 05 | `large-pr` | A PR with 500+ lines changed across 15 files. Context exceeds the token budget. | Token budget trimming. Verifies the context-gatherer trims low-priority context to stay within budget. The prompt-runner still produces a valid review. The `trimmedSections` array in the context object is non-empty. |
| 06 | `security-vulnerability` | A Node.js handler with a SQL injection vulnerability: string concatenation in a database query. | Security pass. Verifies the security pass identifies the SQL injection. The comment severity is `critical`. The evidence citation points to the exact line with the vulnerable query. |
| 07 | `rename-detection` | A file renamed from `src/old-name.ts` to `src/new-name.ts` with modifications to the file content. | Rename handling. Verifies the diff-parser detects the rename (`isRename: true`, `oldPath`, `newPath`). Comments reference the new file path. |

#### Test Runner

Each golden packet test follows the same pattern:

```typescript
import { readFixture } from '../helpers/read-fixture.js';
import { createMockProvider } from '../helpers/mock-provider.js';
import { runPipeline } from '../../src/pipeline.js';

describe('Golden Packet: 01-simple-ts-edit', () => {
  it('produces the expected review output', async () => {
    const fixture = await readFixture('01-simple-ts-edit');
    const mockProvider = createMockProvider(fixture.mockResponses);

    const output = await runPipeline(fixture.input, { provider: mockProvider });

    // Structural validation: output matches schema
    expect(schemaValidator.validate('review-output', output)).toEqual({ valid: true, errors: [] });

    // Evidence validation: all comments pass evidence gate
    for (const comment of output.validComments) {
      expect(comment.evidenceStatus).toBe('ACCEPTED');
    }

    // Output shape matches expected fixture
    expect(output.validComments.length).toBe(fixture.expectedOutput.validComments.length);
    expect(output.rejectedComments.length).toBe(fixture.expectedOutput.rejectedComments.length);

    // Metrics match
    expect(output.metrics.passRate).toBeCloseTo(fixture.expectedOutput.metrics.passRate, 2);
  });
});
```

Note: Golden packet tests do NOT assert exact string equality on LLM-generated text (since that would break on any prompt template change). They assert on: schema validity, evidence gate pass/fail status, comment count, severity distribution, and metric values.

---

### 2.3 Evidence Gate Tests

The evidence gate is Lintellect's primary defense against LLM hallucination. Its test suite must cover every validation rule from RFC-001 Section 5.2 and every adversarial pattern from Section 5.5.

**Location:** `packages/core/__tests__/evidence-gate/`

**Requirement traceability:** Every test case below cites its RFC requirement.

#### Test Case Matrix

| # | Test Case | RFC Ref | Input | Expected Verdict | Expected Reason |
|---|-----------|---------|-------|-----------------|-----------------|
| 1 | **Valid comment** -- correct line number, exact code snippet, valid file path | 5.2 Rules 1-3 | Comment citing line 45 of `src/auth.ts`, snippet `if (token == null)`, file exists in diff with that content at line 45 | **ACCEPT** | N/A |
| 2 | **Invalid line number** -- line number outside diff hunk range | 5.2 Rule 1 | Comment citing line 200 of `src/auth.ts`; diff hunks only cover lines 40-60 | **REJECT** | `line_not_in_diff` |
| 3 | **Context line citation** -- line exists in full file but not in diff hunks | 5.2 Rule 1; 5.5 "Context line citation" | Comment citing line 10 of `src/auth.ts`; line 10 exists in the file but is not within any hunk range in the diff | **REJECT** | `line_not_in_diff` |
| 4 | **Snippet mismatch** -- code snippet does not match actual content at cited line | 5.2 Rule 2 | Comment citing line 45 of `src/auth.ts` with snippet `if (token === undefined)`, but actual content at line 45 is `if (token == null)` | **REJECT** | `snippet_mismatch` |
| 5 | **Paraphrased code** -- LLM describes code instead of quoting it exactly | 5.2 Rule 2; 5.5 "Paraphrased code" | Comment citing line 45 with snippet `the function checks if the token is null`, which is natural language, not code | **REJECT** | `snippet_mismatch` |
| 6 | **Wrong file path** -- references a file not in the PR | 5.2 Rule 3 | Comment referencing `src/utils/helpers.ts`, but the diff only contains `src/middleware/auth.ts` | **REJECT** | `file_not_in_pr` |
| 7 | **Cross-file snippet** -- snippet from file A attributed to file B | 5.2 Rule 3; 5.5 "Cross-file snippet" | Comment referencing `src/auth.ts` line 45 with snippet `export function formatDate()`, which exists in `src/utils/format.ts` but not in `src/auth.ts` | **REJECT** | `snippet_mismatch` |
| 8 | **Severity overinflation** -- `critical` severity for a style nit | 5.2 Rule 4 | Comment with `severity: "critical"` citing a missing trailing comma | **REJECT** | `severity_unjustified` |
| 9 | **Whitespace normalization (normal mode)** -- snippet matches after whitespace normalization | 5.2 Rule 2 (normal strictness) | Comment citing line 45 with snippet `if ( token == null )` (extra spaces); actual content is `if (token == null)`; strictness mode is `normal` | **ACCEPT** | N/A |
| 10 | **Deleted code reference** -- comment references code that was deleted in the diff | 5.5 "Deleted code reference" | Comment citing a line number that corresponds to a deleted line (present in the "before" state but removed in the "after" state) | **REJECT** | `line_not_in_diff` |
| 11 | **Multi-line comment** -- valid comment spanning multiple contiguous lines | 5.2 Rules 1-3 | Comment citing lines 45-48 of `src/auth.ts` with a multi-line snippet that matches lines 45 through 48 exactly | **ACCEPT** | N/A |
| 12 | **Empty comment array** -- no comments to validate | Implicit (pass-through) | Empty comments array `[]` | **ACCEPT** (pass-through) | Returns `{ validComments: [], rejectedComments: [], metrics: { totalComments: 0, passRate: 1.0 } }` |
| 13 | **Hunk boundary line** -- comment on the exact first line of a hunk | 5.2 Rule 1 (boundary) | Comment citing the exact `startLine` of a hunk with correct snippet | **ACCEPT** | N/A |
| 14 | **Hunk boundary line (last)** -- comment on the exact last line of a hunk | 5.2 Rule 1 (boundary) | Comment citing the exact `endLine` of a hunk with correct snippet | **ACCEPT** | N/A |
| 15 | **Synthetic code** -- LLM generates a "fixed" version and cites it | 5.5 "Synthetic code" | Comment citing line 45 with snippet `if (token === null) { return res.status(401).json({ error: 'Unauthorized' }); }`, which is the LLM's suggested fix, not the actual code | **REJECT** | `snippet_mismatch` |

#### Strictness Mode Coverage

Each applicable test case (tests 1, 4, 5, 9) is run under all three strictness modes:

| Mode | Line Check | Snippet Check | Severity Check |
|------|-----------|--------------|---------------|
| `strict` | Exact line match | Byte-exact match | Enforced |
| `normal` | Exact line match | Whitespace-normalized match | Enforced |
| `lenient` | Within hunk range | Fuzzy substring (Levenshtein threshold) | Warning only |

Test 9 (whitespace normalization) specifically validates the difference between modes: it should **ACCEPT** under `normal` and `lenient` but **REJECT** under `strict`.

#### Test Data Fixtures

Each evidence gate test case has a dedicated fixture directory:

```
packages/core/__tests__/evidence-gate/
  fixtures/
    valid-comment.json
    invalid-line-number.json
    context-line-citation.json
    snippet-mismatch.json
    paraphrased-code.json
    wrong-file-path.json
    cross-file-snippet.json
    severity-overinflation.json
    whitespace-normalization.json
    deleted-code-reference.json
    multi-line-comment.json
    empty-comment-array.json
    hunk-boundary-first.json
    hunk-boundary-last.json
    synthetic-code.json
```

Each fixture is a JSON file containing:

```json
{
  "description": "Valid comment with correct line number and exact snippet match",
  "rfcRef": "RFC-001 Section 5.2 Rules 1-3",
  "comment": {
    "filePath": "src/middleware/auth.ts",
    "lineNumber": 45,
    "codeSnippet": "if (token == null) return res.status(401).send();",
    "severity": "warning",
    "category": "logic",
    "message": "Consider also validating the token format."
  },
  "parsedDiff": {
    "files": [{
      "path": "src/middleware/auth.ts",
      "hunks": [{
        "startLine": 42,
        "endLine": 58,
        "additions": [
          { "line": 45, "content": "if (token == null) return res.status(401).send();" }
        ]
      }]
    }]
  },
  "expectedVerdict": "ACCEPT",
  "expectedReason": null
}
```

---

### 2.4 Schema Validation Tests

**Location:** `packages/core/__tests__/schema-validation/` (or co-located with `packages/core/src/schema-validator/index.test.ts`)

Every JSON Schema in `/schemas/` is tested for both positive (valid data passes) and negative (invalid data fails with clear errors) cases.

#### Schemas Under Test

| Schema File | Purpose |
|------------|---------|
| `review-packet.schema.json` | Input to the review pipeline (PR metadata + raw diff) |
| `review-output.schema.json` | Complete output of all 4 review passes |
| `review-comment.schema.json` | Individual review comment with evidence fields |
| `job-status.schema.json` | DynamoDB job status record |
| `provider-config.schema.json` | LLM provider configuration |

#### Test Matrix (Per Schema)

Each schema has the following test cases:

| # | Test Case | Input | Expected Outcome |
|---|-----------|-------|-----------------|
| 1 | **Valid data passes validation** | A complete, conforming object with all required fields and correct types | `validate()` returns `{ valid: true, errors: [] }` |
| 2 | **Required field missing** | Object with one required field removed (each required field tested individually) | `validate()` returns `{ valid: false }` with error `instancePath` pointing to the missing field and `keyword: "required"` |
| 3 | **Wrong type for field** | Object with a field set to the wrong type (e.g., `number` where `string` is expected) | `validate()` returns `{ valid: false }` with error `keyword: "type"` and clear `instancePath` |
| 4 | **Invalid enum value** | Object with an enum field set to an invalid value (e.g., `severity: "extreme"` when allowed values are `critical`, `high`, `medium`, `low`) | `validate()` returns `{ valid: false }` with error `keyword: "enum"` and the allowed values listed |
| 5 | **Extra properties (additionalProperties)** | Object with an unexpected extra field | Behavior depends on schema's `additionalProperties` setting: if `false`, validation fails; if `true` or unset, validation passes |
| 6 | **Nested object validation** | Object with a required nested object that has its own required fields; one nested field missing | `validate()` returns `{ valid: false }` with `instancePath` pointing to the nested field (e.g., `/pullRequest/number`) |
| 7 | **Array item validation** | Object with an array field containing one valid item and one invalid item | `validate()` returns `{ valid: false }` with `instancePath` pointing to the invalid array index (e.g., `/comments/1/lineNumber`) |

#### Example Test Structure

```typescript
describe('SchemaValidator', () => {
  describe('review-packet schema', () => {
    it('validates a conforming ReviewPacket', () => {
      const packet = createMockReviewPacket();
      const result = schemaValidator.validateSafe('review-packet', packet);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects a ReviewPacket missing pullRequest.number', () => {
      const packet = createMockReviewPacket();
      delete packet.pullRequest.number;
      const result = schemaValidator.validateSafe('review-packet', packet);
      expect(result.valid).toBe(false);
      expect(result.errors[0].instancePath).toContain('pullRequest');
      expect(result.errors[0].keyword).toBe('required');
    });

    it('rejects a ReviewPacket with number type for pullRequest.title', () => {
      const packet = createMockReviewPacket();
      packet.pullRequest.title = 42 as any;
      const result = schemaValidator.validateSafe('review-packet', packet);
      expect(result.valid).toBe(false);
      expect(result.errors[0].keyword).toBe('type');
    });
  });

  // ... repeat for all 5 schemas
});
```

#### Schema Coverage Assertion

A meta-test verifies that every schema file in `/schemas/` has a corresponding test suite:

```typescript
it('has tests for every schema in /schemas/', () => {
  const schemaFiles = globSync('schemas/*.schema.json');
  const testedSchemas = schemaValidator.getRegisteredSchemaNames();
  for (const file of schemaFiles) {
    const name = path.basename(file, '.schema.json');
    expect(testedSchemas).toContain(name);
  }
});
```

---

## 3. Integration Test Plan

Integration tests verify that pipeline components work together correctly with realistic (but mocked) external dependencies. They test the data flow between modules, S3 pass-by-reference patterns, and DynamoDB status updates.

### 3.1 Mock Boundaries

| External Dependency | Mock Implementation | Notes |
|--------------------|---------------------|-------|
| GitHub API | MSW (Mock Service Worker) with handlers for `GET /repos/{owner}/{repo}/pulls/{number}`, `GET /repos/{owner}/{repo}/pulls/{number}/files`, `POST /repos/{owner}/{repo}/pulls/{number}/reviews` | Handlers return fixtures matching real GitHub API response shapes |
| LLM Provider | Mock `LLMProvider` adapter returning deterministic JSON | Same mock used in golden packet tests |
| S3 | In-memory `Map<string, Buffer>` implementing `GetObjectCommand` and `PutObjectCommand` | Verifies correct S3 key patterns without actual S3 |
| DynamoDB | In-memory `Map<string, Record>` implementing `PutItemCommand`, `UpdateItemCommand`, `GetItemCommand`, `QueryCommand` | Verifies correct key schema, status transitions, and TTL |
| SQS | In-memory FIFO array with `sendMessage` and `receiveMessage` | Verifies message format and DLQ redrive policy |
| Step Functions | Mocked Step Functions client OR `stepfunctions-local` Docker container (when available) | Sequential state execution with pass-by-reference enforcement |

### 3.2 Integration Test Scenarios

#### Scenario 1: Full Pipeline Happy Path

**Description:** Trace a PR review from webhook payload to formatted comment output.

**Steps:**

1. Provide a realistic webhook payload (captured from a real GitHub webhook, sanitized).
2. Invoke the webhook handler. Verify it publishes a message to the mock SQS intake queue.
3. Consume the SQS message. Verify it triggers a Step Functions execution with the correct input.
4. Invoke the packet-builder. Verify it writes a valid `ReviewPacket` to mock S3 at `packets/{jobId}/input.json`.
5. Invoke the diff-parser. Verify it reads from S3, writes `parsed-diff.json` to S3, and the output is structurally correct.
6. Invoke the context-gatherer (with mocked GitHub API). Verify it reads `parsed-diff.json` from S3, calls the correct GitHub API endpoints, and writes `context.json` to S3.
7. Invoke the prompt-runner (with mock LLM provider). Verify it reads `parsed-diff.json` and `context.json`, calls the provider 4 times (one per pass), writes `pass-{1-4}.json` and `merged-review.json` to S3.
8. Invoke the evidence-gate. Verify it reads `merged-review.json`, validates all comments, writes `validated.json` with metrics.
9. Invoke the comment-poster (with mocked GitHub API). Verify it reads `validated.json`, formats a PR review, and posts to the correct GitHub API endpoint.
10. Verify DynamoDB job status transitioned through: `PENDING` -> `BUILDING_PACKET` -> `PARSING_DIFF` -> `GATHERING_CONTEXT` -> `RUNNING_REVIEW` -> `EVIDENCE_GATE` -> `POSTING` -> `COMPLETED`.

**Assertions:**

- Every S3 artifact exists at the correct key.
- Every S3 artifact validates against its respective JSON Schema.
- DynamoDB has a complete status history with timestamps.
- The final GitHub API call contains the correct review body and inline comments.

#### Scenario 2: Pipeline Failure at Context-Gathering (GitHub 404)

**Description:** Verify graceful degradation when a file referenced in the diff no longer exists on GitHub.

**Steps:**

1. Start pipeline as in Scenario 1.
2. Configure MSW to return 404 for one of the files referenced by the diff.
3. Verify the context-gatherer handles the 404 gracefully (includes a warning, continues with remaining files).
4. Verify the rest of the pipeline completes successfully.

**Assertions:**

- Context object contains a `warnings` entry for the missing file.
- Review output is valid (the missing file is not referenced in comments).
- Job status reaches `COMPLETED`.

#### Scenario 3: Pipeline Failure at LLM Review (Provider Timeout)

**Description:** Verify partial-success handling when one LLM pass times out.

**Steps:**

1. Start pipeline as in Scenario 1.
2. Configure mock provider to throw `TIMEOUT` on pass 3 (style).
3. Verify passes 1, 2, and 4 complete.
4. Verify the merged output contains comments from passes 1, 2, and 4 only.
5. Verify the evidence gate processes the partial output correctly.

**Assertions:**

- `merged-review.json` does not contain pass-3 comments.
- Job status reaches `COMPLETED` (not `FAILED` -- partial success is acceptable).
- Metrics in `validated.json` reflect the partial execution.

#### Scenario 4: Evidence Gate Full Rejection

**Description:** Verify behavior when all LLM comments fail evidence validation.

**Steps:**

1. Start pipeline with a mock provider that returns comments with hallucinated line numbers and fabricated snippets.
2. Run through evidence gate.

**Assertions:**

- `validated.json` has `validComments: []` and `rejectedComments` containing all comments.
- The comment-poster posts a summary-only review (no inline comments).
- Job status includes `EVIDENCE_GATE_FULL_REJECTION` flag.

#### Scenario 5: S3 Pass-by-Reference Verification

**Description:** Verify that no Step Functions state payload exceeds 256KB.

**Steps:**

1. Run Scenario 1 with a large PR fixture (500+ lines).
2. Instrument the mock Step Functions client to capture every state transition payload.

**Assertions:**

- Every state transition payload is < 256KB.
- Payloads contain only S3 keys and metadata, never raw diff data, context, or LLM responses.

### 3.3 Running Integration Tests

Integration tests are separated from unit tests using Vitest's project configuration:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    projects: [
      {
        name: 'unit',
        include: ['packages/*/src/**/*.test.ts'],
        exclude: ['**/*.integration.test.ts'],
      },
      {
        name: 'integration',
        include: ['packages/*/**/*.integration.test.ts'],
        setupFiles: ['./test-setup/integration.ts'],
      },
    ],
  },
});
```

Run independently:

```bash
# Unit tests only (< 5s)
npx vitest run --project unit

# Integration tests only (< 30s)
npx vitest run --project integration

# All tests
npx vitest run
```

---

## 4. E2E Test Plan

End-to-end tests verify the complete deployed system in a staging AWS environment. These tests exercise real AWS services (API Gateway, Lambda, SQS, Step Functions, S3, DynamoDB) and the real GitHub API.

### 4.1 Prerequisites

| Prerequisite | Details |
|-------------|---------|
| Staging AWS environment | Deployed via `cdk deploy --context env=staging` |
| Test GitHub repository | A dedicated repository (e.g., `lintellect-org/e2e-test-repo`) with a configured webhook pointing to the staging API Gateway endpoint |
| Test GitHub App | A GitHub App installed on the test repository with permission to create PR reviews |
| LLM API access | Either Anthropic API key or Bedrock access configured in staging Secrets Manager |

### 4.2 E2E Test Sequence

```
1. Create a test branch in the test repository with a known code change.
2. Open a PR from the test branch to main.
3. Wait for the webhook to be received (poll DynamoDB for job creation, timeout: 30s).
4. Wait for the Step Functions execution to complete (poll DynamoDB for COMPLETED status, timeout: 5 min).
5. Assert on the results.
6. Clean up: close the PR, delete the test branch.
```

### 4.3 Assertions

| # | Assertion | Method |
|---|-----------|--------|
| 1 | Webhook received and job created in DynamoDB | Query DynamoDB `prUrl-index` for the test PR URL; verify a job record exists with `status` not `null` |
| 2 | Step Functions execution completed successfully | Query DynamoDB for the job; verify `status: "COMPLETED"` |
| 3 | S3 artifacts created at each stage | List objects under `packets/{jobId}/`; verify `input.json`, `parsed-diff.json`, `context.json`, `pass-1.json` through `pass-4.json`, `merged-review.json`, `validated.json` all exist |
| 4 | Evidence gate metrics recorded | Read `validated.json` from S3; verify `metrics` object exists with `totalComments > 0` and `passRate > 0` |
| 5 | Review comment posted to GitHub PR | Use GitHub API to fetch PR reviews for the test PR; verify at least one review exists from the Lintellect GitHub App |
| 6 | DynamoDB job status is COMPLETED | Query DynamoDB; verify final status is `COMPLETED` with `reviewUrl` populated |
| 7 | DynamoDB status history is complete | Query DynamoDB `STATUS#*` records for the job; verify all expected status transitions are present in order |
| 8 | No DLQ messages | Check SQS DLQ `ApproximateNumberOfMessagesVisible`; verify it is 0 |

### 4.4 Run Time Target

| Phase | Expected Duration |
|-------|------------------|
| Branch creation + PR open | 5s (GitHub API) |
| Webhook delivery + job creation | 2-5s |
| Pipeline execution (dominated by LLM inference) | 30s - 3min |
| Comment posting | 2-5s |
| Assertions + cleanup | 5s |
| **Total** | **< 5 minutes** |

### 4.5 Trigger

| Trigger | When | Notes |
|---------|------|-------|
| Manual | Developer runs `npx vitest run --project e2e` locally | Requires staging environment to be deployed and credentials configured |
| CI (merge to main) | GitHub Actions workflow on push to `main` | Runs after staging deployment completes |
| Scheduled | Daily at 06:00 UTC (optional) | Detects regressions from infrastructure drift or provider changes |

### 4.6 E2E Test Isolation

Each E2E test run uses a unique branch name (e.g., `e2e-test-{timestamp}`) and PR to avoid collisions with other test runs or real development activity. The cleanup step always runs, even if assertions fail (using Vitest's `afterAll` hook or a try/finally block).

---

## 5. Coverage Requirements

### 5.1 Coverage Thresholds

| Package | Line Coverage | Branch Coverage | Rationale |
|---------|-------------|----------------|-----------|
| `packages/core/src/` (overall) | >= 80% | >= 80% | Core business logic; must be well-tested |
| `packages/core/src/evidence-validator/` | >= 95% | >= 95% | Critical path: prevents hallucinated comments from reaching users. Every code path must be exercised. |
| `packages/core/src/schema-validator/` | 100% schema coverage | N/A | Every schema file in `/schemas/` must have both positive and negative test cases. |
| `packages/core/src/diff-parser/` | >= 85% | >= 80% | Handles diverse diff formats; edge cases (binary, rename, empty) must be covered |
| `packages/core/src/packet-builder/` | >= 80% | >= 80% | Schema conformance is critical |
| `packages/core/src/context-gatherer/` | >= 80% | >= 75% | Token budget logic and priority trimming must be tested |
| `packages/core/src/prompt-runner/` | >= 80% | >= 80% | Multi-pass orchestration, partial failure, merge logic |
| `packages/providers/src/` (overall) | >= 75% | >= 70% | Provider adapters are thinner; key paths are error mapping and retry logic |
| `packages/cli/src/` | >= 70% | >= 65% | CLI is a thin orchestration layer; core logic is tested through `packages/core` |
| `infra/` | Excluded | Excluded | CDK constructs are tested via `cdk synth` and snapshot tests, not line coverage |

### 5.2 Enforcement

Coverage thresholds are enforced in `vitest.config.ts`:

```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'json', 'html', 'lcov'],
  include: [
    'packages/core/src/**/*.ts',
    'packages/providers/src/**/*.ts',
    'packages/cli/src/**/*.ts',
  ],
  exclude: [
    '**/*.test.ts',
    '**/*.integration.test.ts',
    '**/*.d.ts',
    '**/index.ts',          // Re-export barrel files
    '**/types.ts',           // Pure type definitions
    'infra/**',              // IaC tested separately
  ],
  thresholds: {
    'packages/core/src/**': {
      lines: 80,
      branches: 80,
    },
    'packages/core/src/evidence-validator/**': {
      lines: 95,
      branches: 95,
    },
    'packages/providers/src/**': {
      lines: 75,
      branches: 70,
    },
    'packages/cli/src/**': {
      lines: 70,
      branches: 65,
    },
  },
},
```

CI is configured to **fail the build** if any threshold is not met. Coverage reports are uploaded as workflow artifacts and displayed in PR comments (via a coverage reporter action).

### 5.3 Coverage Exclusion Rules

The following patterns are excluded from coverage measurement with documented rationale:

| Pattern | Rationale |
|---------|-----------|
| `**/*.test.ts` | Test files are not production code |
| `**/*.d.ts` | Type declaration files contain no runtime code |
| `**/index.ts` (barrel re-exports only) | Barrel files that only re-export symbols have no logic to test |
| `**/types.ts` (pure type definitions only) | TypeScript `type` and `interface` definitions generate no runtime code |
| `infra/**` | CDK constructs are validated via `cdk synth`, snapshot tests, and CloudFormation linting; line coverage is not meaningful for declarative IaC |

---

## 6. Test Infrastructure

### 6.1 Vitest Configuration

The root `vitest.config.ts` configures the test runner for the entire monorepo:

```typescript
// vitest.config.ts (project root)
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/*.e2e.test.ts'],
    testTimeout: 5000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: [
        'packages/core/src/**/*.ts',
        'packages/providers/src/**/*.ts',
        'packages/cli/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.integration.test.ts',
        '**/*.e2e.test.ts',
        '**/*.d.ts',
        '**/types.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
      },
    },
    // Use worker threads for parallel test execution
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 4,
        minThreads: 1,
      },
    },
  },
  resolve: {
    alias: {
      '@lintellect/core': path.resolve(__dirname, 'packages/core/src'),
      '@lintellect/providers': path.resolve(__dirname, 'packages/providers/src'),
    },
  },
});
```

### 6.2 Mock Factories

Shared mock factories live in `packages/core/__tests__/helpers/` and provide consistent, minimal test data for all test suites.

#### `createMockReviewPacket(overrides?)`

Creates a valid `ReviewPacket` conforming to `review-packet.schema.json`:

```typescript
// packages/core/__tests__/helpers/mock-factories.ts

export function createMockReviewPacket(overrides?: Partial<ReviewPacket>): ReviewPacket {
  return {
    jobId: 'j-test-001',
    repository: {
      owner: 'test-org',
      name: 'test-repo',
      fullName: 'test-org/test-repo',
    },
    pullRequest: {
      number: 42,
      title: 'Fix null check in auth middleware',
      description: 'This PR fixes the auth middleware to handle null tokens.',
      author: 'test-developer',
      baseSha: 'abc1234567890',
      headSha: 'def9876543210',
    },
    diff: createMockDiff().raw,
    commitMessages: ['Fix null check in auth middleware'],
    createdAt: '2026-02-07T10:00:00Z',
    ...overrides,
  };
}
```

#### `createMockDiff(overrides?)`

Creates a realistic parsed diff structure:

```typescript
export function createMockDiff(overrides?: Partial<ParsedDiff>): ParsedDiff {
  return {
    files: [
      {
        path: 'src/middleware/auth.ts',
        language: 'typescript',
        isBinary: false,
        isRename: false,
        hunks: [
          {
            startLine: 42,
            endLine: 58,
            additions: [
              {
                line: 45,
                content: 'if (token == null) return res.status(401).send();',
                astNode: 'if_statement',
              },
            ],
            deletions: [
              {
                line: 44,
                content: 'if (!token) return;',
                astNode: 'if_statement',
              },
            ],
            context: [
              {
                line: 43,
                content: 'const token = req.headers.authorization;',
                astNode: 'variable_declaration',
              },
            ],
          },
        ],
      },
    ],
    summary: { filesChanged: 1, additions: 1, deletions: 1 },
    ...overrides,
  };
}
```

#### `createMockComment(overrides?)`

Creates a valid review comment:

```typescript
export function createMockComment(overrides?: Partial<ReviewComment>): ReviewComment {
  return {
    filePath: 'src/middleware/auth.ts',
    lineNumber: 45,
    codeSnippet: 'if (token == null) return res.status(401).send();',
    severity: 'warning',
    category: 'logic',
    message: 'Consider validating the token format before proceeding.',
    suggestion: 'Add: if (token == null || !token.startsWith("Bearer ")) ...',
    ...overrides,
  };
}
```

#### `createMockProvider(responses?)`

Creates a mock `LLMProvider` that returns deterministic responses:

```typescript
export function createMockProvider(
  responses?: Record<string, string>,
): LLMProvider {
  return {
    name: 'mock-provider',
    maxContextWindow: 200000,
    async *review(prompt: string, options: ReviewOptions): AsyncGenerator<ReviewChunk> {
      const passType = detectPassType(prompt); // Extract pass type from prompt text
      const responseText = responses?.[passType] ?? defaultMockResponse(passType);
      yield { text: responseText, done: true, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
    },
    estimateTokens(text: string): number {
      return Math.ceil(text.length / 4); // Conservative 4 chars per token
    },
  };
}
```

### 6.3 Snapshot Testing for Prompt Assembly

Prompt templates are tested with Vitest snapshots to detect unintended drift. When a prompt template changes, the snapshot test fails, requiring the developer to explicitly review and approve the change with `vitest -u`.

```typescript
// packages/core/src/prompt-runner/prompt-assembly.test.ts

describe('Prompt Assembly', () => {
  const mockPacket = createMockReviewPacket();
  const mockContext = createMockContext();

  it('structural pass prompt matches snapshot', () => {
    const prompt = assemblePrompt('structural', mockPacket, mockContext);
    expect(prompt).toMatchSnapshot();
  });

  it('logic pass prompt matches snapshot', () => {
    const prompt = assemblePrompt('logic', mockPacket, mockContext);
    expect(prompt).toMatchSnapshot();
  });

  it('style pass prompt matches snapshot', () => {
    const prompt = assemblePrompt('style', mockPacket, mockContext);
    expect(prompt).toMatchSnapshot();
  });

  it('security pass prompt matches snapshot', () => {
    const prompt = assemblePrompt('security', mockPacket, mockContext);
    expect(prompt).toMatchSnapshot();
  });

  it('every prompt ends with the evidence gate suffix', () => {
    for (const passType of ['structural', 'logic', 'style', 'security'] as const) {
      const prompt = assemblePrompt(passType, mockPacket, mockContext);
      expect(prompt).toContain('You MUST cite specific line numbers');
      expect(prompt).toContain('You MUST quote the exact code');
    }
  });
});
```

### 6.4 CI Integration

Tests run on every PR via GitHub Actions:

```yaml
# .github/workflows/test.yml
name: Test
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci

      - name: Type Check
        run: npx tsc --noEmit

      - name: Unit Tests
        run: npx vitest run --project unit --coverage

      - name: Integration Tests
        run: npx vitest run --project integration

      - name: Upload Coverage
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage/

      - name: Coverage Report PR Comment
        uses: davelosert/vitest-coverage-report-action@v2
        if: github.event_name == 'pull_request'
```

**PR merge requirements:**

- All unit tests pass.
- All integration tests pass.
- Coverage thresholds met.
- Type check passes.

Failing any of these blocks the merge.

---

## 7. Test Data Management

### 7.1 Storage and Versioning

| Data Type | Location | Stored In Git | Mutability |
|-----------|----------|---------------|------------|
| Golden packet input fixtures | `packages/core/__tests__/golden-packets/{nn}-{name}/input.json` | Yes | Immutable once created |
| Golden packet mock responses | `packages/core/__tests__/golden-packets/{nn}-{name}/mock-responses/` | Yes | Immutable once created |
| Golden packet expected outputs | `packages/core/__tests__/golden-packets/{nn}-{name}/expected-output.json` | Yes | Immutable once created |
| Evidence gate fixtures | `packages/core/__tests__/evidence-gate/fixtures/` | Yes | Immutable once created |
| Vitest snapshots | `packages/*/src/**/__snapshots__/` | Yes | Updated via `vitest -u` when templates change |
| Mock LLM responses | Alongside golden packets or in `__tests__/fixtures/llm-responses/` | Yes | Immutable once created |

### 7.2 Immutability Policy

Test fixtures are **append-only**. Once a fixture is created and committed, it is never modified. This ensures:

- Historical tests remain valid: a fixture from sprint 1 still passes in sprint 10.
- Regressions are immediately visible: if a code change breaks an existing fixture, the test fails.
- Blame is clear: `git log` on a fixture file shows exactly when it was created and by whom.

If a schema change makes an existing fixture invalid, the correct action is:

1. Create a **new** fixture that conforms to the updated schema.
2. Add a **migration note** in the old fixture's `description.md` explaining why it was superseded.
3. Optionally mark the old fixture's test as `.skip` with a comment explaining the schema change.
4. Never delete the old fixture.

### 7.3 Naming Convention

Golden packet fixtures: `{nn}-{description}/` where `{nn}` is a zero-padded two-digit number and `{description}` is a lowercase-hyphenated description.

```
01-simple-ts-edit/
02-multi-file-refactor/
03-empty-diff/
04-binary-file/
05-large-pr/
06-security-vulnerability/
07-rename-detection/
```

New fixtures are appended with the next available number. Numbers are never reused.

Evidence gate fixtures: `{description}.json` using lowercase-hyphenated names matching the test case name.

```
valid-comment.json
invalid-line-number.json
context-line-citation.json
snippet-mismatch.json
```

### 7.4 Fixture Size Constraints

All fixtures stored in git must be small and deterministic:

| Constraint | Limit | Rationale |
|-----------|-------|-----------|
| Individual fixture file size | < 50KB | Large fixtures slow down `git clone` and CI |
| Total fixtures directory size | < 5MB | Monorepo should remain fast to clone |
| Mock LLM response size | < 10KB per response | Realistic but not bloated; a real LLM review response is typically 2-8KB |
| Diff fixture line count | < 500 lines (except `05-large-pr`) | Keeps fixtures readable and maintainable |

The `05-large-pr` fixture is the only exception, and it should be the minimum size needed to trigger token budget trimming (aim for ~600 lines, not thousands).

---

## 8. Cross-References

This testing strategy is designed to validate the requirements and architecture defined in the following documents:

| Document | Path | What It Provides To Tests |
|----------|------|--------------------------|
| **RFC** | `/docs/RFC.md` | Evidence Gate specification (Section 5); provider contract interface (Section 6); failure modes and retry semantics (Section 8) |
| **Architecture** | `/docs/architecture.md` | Component inventory (Section 8); data flow lifecycle (Section 9); S3 artifact structure; DynamoDB schema |
| **Prompting Strategy** | `/docs/prompting.md` | 4-pass review strategy; prompt template structure; evidence gate prompt suffix; JSON output schemas per pass; token budget allocation |
| **Tooling Evaluation** | `/docs/tooling.md` | Vitest configuration reference (Category 6); Ajv usage patterns (Category 3); mock strategy for LLM SDKs (Category 4) |
| **Sprint Plan** | `/docs/SPRINT-PLAN.md` | Task acceptance criteria for T-1.10 (Golden Packet Test Suite) and T-1.11 (Evidence Gate Test Suite) |

### Schema Cross-References

Tests validate data against these schemas:

| Schema | Path | Tested By |
|--------|------|-----------|
| `review-packet.schema.json` | `/schemas/review-packet.schema.json` | Section 2.4 (schema validation tests); Section 2.1.1 (packet-builder tests); golden packet tests |
| `review-output.schema.json` | `/schemas/review-output.schema.json` | Section 2.4 (schema validation tests); Section 2.1.6 (prompt-runner tests); golden packet tests |
| `review-comment.schema.json` | `/schemas/review-comment.schema.json` | Section 2.4 (schema validation tests); Section 2.3 (evidence gate tests) |
| `job-status.schema.json` | `/schemas/job-status.schema.json` | Section 2.4 (schema validation tests); integration tests (DynamoDB assertions) |
| `provider-config.schema.json` | `/schemas/provider-config.schema.json` | Section 2.4 (schema validation tests); provider unit tests |

### Requirement Traceability

| RFC Requirement | Test Coverage |
|----------------|--------------|
| RFC 5.2 Rule 1 (Line Number Existence) | Evidence gate tests #1, #2, #3, #10, #13, #14 |
| RFC 5.2 Rule 2 (Code Snippet Accuracy) | Evidence gate tests #1, #4, #5, #7, #9, #11, #15 |
| RFC 5.2 Rule 3 (File Path Validity) | Evidence gate tests #1, #6, #7 |
| RFC 5.2 Rule 4 (Evidence-Severity Coherence) | Evidence gate test #8 |
| RFC 5.5 Adversarial: Context line citation | Evidence gate test #3 |
| RFC 5.5 Adversarial: Paraphrased code | Evidence gate test #5 |
| RFC 5.5 Adversarial: Deleted code reference | Evidence gate test #10 |
| RFC 5.5 Adversarial: Cross-file snippet | Evidence gate test #7 |
| RFC 5.5 Adversarial: Synthetic code | Evidence gate test #15 |
| RFC 6.2 LLMProvider contract | Provider unit tests (Sections 2.1.7, 2.1.8) |
| RFC 8.1 Failure taxonomy (transient vs permanent) | Provider retry tests; integration test scenario 3 |
| Architecture Section 4.3 (Pass-by-reference) | Integration test scenario 5 |
| Architecture Section 5 (Step Functions states) | Integration test scenario 1 (full pipeline) |
| Architecture Section 6 (Evidence Gate flow) | Evidence gate tests (all 15 cases); integration test scenario 4 |

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-02-07 | 1.0.0 | test-writer-fixer | Initial testing strategy covering all 8 sections |

---

**End of Testing Strategy.**
