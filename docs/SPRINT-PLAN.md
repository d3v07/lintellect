# Lintellect -- Master Sprint Plan

**Project:** Lintellect -- AI-Powered Code Review System
**Version:** 1.0.0
**Author:** sprint-prioritizer
**Created:** 2026-02-07
**Status:** ACTIVE

---

## Executive Summary

Lintellect transforms a fragile Lambda-chained, event-driven code review pipeline into a production-grade system with clear control/data plane separation, SQS + Step Functions orchestration, S3 artifact storage, DynamoDB metadata tracking, evidence-validated LLM reviews, and provider-pluggable LLM support (Claude direct + Bedrock).

This plan is structured in **3 Epics** executed sequentially with explicit approval gates between phases. No code is written until Epic 0 is complete and the user has approved the design. No AWS infrastructure is deployed until Epic 1 is complete and the user has granted `APPROVED_FOR_AWS`.

---

## Phase Gate Protocol

```
Epic 0 (Design)  -->  USER APPROVAL  -->  Epic 1 (Core Engine)  -->  USER APPROVED_FOR_AWS  -->  Epic 2 (AWS Pipeline)
     |                     |                      |                          |                          |
   No code           Gate review            Local-only code           Gate review              Full deployment
```

---

## Epic 0: Design (Phase 0 -- NO CODE)

**Goal:** Produce a complete, internally consistent design that any engineer can implement without ambiguity.

**Exit Criteria:** All documents exist, all cross-references validated, user has reviewed and approved.

**Duration:** Sprint days 1-3

### Task Table

| Task ID | Title | Owner Agent | Dependencies | Risks |
|---------|-------|-------------|--------------|-------|
| T-0.1 | Init project scaffold | Bash | None | None |
| T-0.2 | Sprint plan | sprint-prioritizer | T-0.1 | Scope creep |
| T-0.3 | RFC document | Plan agent | T-0.2 | Over-specification |
| T-0.4 | Architecture + Mermaid diagrams | Plan agent | T-0.2 | Diagrams not rendering |
| T-0.5 | Prompting strategy + JSON schemas | ai-engineer | T-0.4 | Schema too rigid or too loose |
| T-0.6 | Tooling evaluation | tool-evaluator | T-0.2 | Biased evaluation |
| T-0.7 | Testing strategy | test-writer-fixer | T-0.4 | Unrealistic coverage targets |
| T-0.8 | Repo file tree + cross-review | Direct | T-0.3, T-0.4, T-0.5, T-0.6, T-0.7 | Missed cross-references |
| T-0.9 | Ask blocking question | Direct | T-0.8 | Wrong question asked |

---

### T-0.1: Init Project Scaffold

| Field | Value |
|-------|-------|
| **Task ID** | T-0.1 |
| **Title** | Init project scaffold |
| **Owner Agent** | Bash |
| **Dependencies** | None |
| **Risks** | None |

**Acceptance Criteria:**

- `/docs/` directory exists at repository root
- `/schemas/` directory exists at repository root
- `/packages/` directory exists at repository root with subdirectories for `core`, `cli`, and `aws`
- Git repository is initialized with `.gitignore` appropriate for Node.js/TypeScript
- `package.json` exists at root with project name `lintellect` and workspaces configured
- Initial commit is made with scaffold structure

---

### T-0.2: Sprint Plan

| Field | Value |
|-------|-------|
| **Task ID** | T-0.2 |
| **Title** | Sprint plan |
| **Owner Agent** | sprint-prioritizer |
| **Dependencies** | T-0.1 |
| **Risks** | Scope creep -- mitigate by enforcing phase gates and requiring explicit user approval before advancing |

**Acceptance Criteria:**

- `/docs/SPRINT-PLAN.md` exists (this document)
- Contains all 3 Epics (Epic 0: Design, Epic 1: Core Engine, Epic 2: AWS Hosted Pipeline)
- Every task has: Task ID, Title, Owner Agent, Acceptance Criteria (bulleted), Dependencies (task IDs), and Risks
- Phase gate protocol is documented
- Global risk register is included
- Prioritization rationale is stated for each epic

---

### T-0.3: RFC Document

| Field | Value |
|-------|-------|
| **Task ID** | T-0.3 |
| **Title** | RFC document |
| **Owner Agent** | Plan agent |
| **Dependencies** | T-0.2 |
| **Risks** | Over-specification -- the RFC may prescribe implementation details that constrain engineering flexibility; mitigate by keeping the RFC at the "what and why" level, not "how" |

**Acceptance Criteria:**

- `/docs/RFC.md` exists
- Covers the following sections, each with substantive content:
  - Problem statement: why the current Lambda-chained pipeline is fragile
  - Control plane vs data plane separation: what belongs where, why the split matters
  - SQS + Step Functions rationale: why this over direct Lambda invocation, EventBridge, or SNS
  - S3 + DynamoDB design: artifact storage lifecycle, metadata schema, access patterns
  - Evidence gate specification: what constitutes valid evidence, rejection criteria, retry semantics
  - Provider contract: interface definition for LLM providers, required methods, error handling contract
  - Security model: webhook signature validation, IAM least privilege, secrets management, data encryption
  - Failure modes: enumeration of all failure scenarios with expected system behavior
  - Migration path: how to move from the current system to the new architecture without downtime

---

### T-0.4: Architecture + Mermaid Diagrams

| Field | Value |
|-------|-------|
| **Task ID** | T-0.4 |
| **Title** | Architecture + Mermaid diagrams |
| **Owner Agent** | Plan agent |
| **Dependencies** | T-0.2 |
| **Risks** | Diagrams not rendering -- Mermaid syntax errors can silently fail in some renderers; mitigate by validating each diagram with the Mermaid CLI or live editor before committing |

**Acceptance Criteria:**

- `/docs/architecture.md` exists
- Contains the following Mermaid diagrams, each syntactically valid:
  - **C4 Level 1 Context Diagram:** shows Lintellect system boundary, external actors (Developer, GitHub, LLM Provider), and data flows
  - **Control Plane Diagram:** shows API Gateway, webhook handler, SQS queues, DynamoDB job table, and their interactions
  - **Data Plane Diagram:** shows Step Functions state machine, worker Lambdas, S3 bucket, and data flow between them
  - **Step Functions State Machine:** shows each state (Validate, BuildPacket, ParseDiff, GatherContext, RunReview, EvidenceGate, PostComment), transitions, error handlers, and retry policies
  - **End-to-End Flow:** shows the complete lifecycle from PR creation to posted review comment
  - **Evidence Gate Flow:** shows how review comments are validated, which are accepted/rejected, and retry behavior
  - **LLM Adapter Pattern:** shows the provider interface, concrete adapters (Claude Direct, Bedrock), and how the prompt runner selects a provider
- Contains a **component inventory table** listing every deployable unit with its runtime, memory, timeout, and purpose
- Contains a **data flow lifecycle** section describing what happens to data at each stage

---

### T-0.5: Prompting Strategy + JSON Schemas

| Field | Value |
|-------|-------|
| **Task ID** | T-0.5 |
| **Title** | Prompting strategy + JSON schemas |
| **Owner Agent** | ai-engineer |
| **Dependencies** | T-0.4 |
| **Risks** | Schema too rigid -- over-constrained schemas reject valid LLM outputs; Schema too loose -- under-constrained schemas allow garbage through; mitigate by testing schemas against real LLM output samples during design |

**Acceptance Criteria:**

- `/docs/prompting.md` exists and defines:
  - **4-pass review strategy** with clear purpose for each pass:
    - Pass 1 -- Structural: file organization, naming, module boundaries
    - Pass 2 -- Logic: correctness, edge cases, error handling, race conditions
    - Pass 3 -- Style: readability, idiomatic patterns, consistency
    - Pass 4 -- Security: injection risks, auth flaws, data exposure, dependency vulnerabilities
  - **Evidence gate prompt suffix:** the exact instruction appended to every prompt requiring the LLM to cite line numbers and code snippets
  - **JSON output schema per pass:** what fields each pass must return
  - **Token budget allocation:** how the total context window is divided across system prompt, diff content, surrounding context, and output reservation
  - **Prompt template structure:** system message, user message, examples (if few-shot)
- The following JSON Schema files exist in `/schemas/`, each valid against JSON Schema draft-07:
  - `review-packet.schema.json` -- input to the review pipeline
  - `review-output.schema.json` -- complete output of all 4 passes
  - `review-comment.schema.json` -- individual review comment with evidence fields
  - `job-status.schema.json` -- DynamoDB job status record
  - `provider-config.schema.json` -- LLM provider configuration

---

### T-0.6: Tooling Evaluation

| Field | Value |
|-------|-------|
| **Task ID** | T-0.6 |
| **Title** | Tooling evaluation |
| **Owner Agent** | tool-evaluator |
| **Dependencies** | T-0.2 |
| **Risks** | Biased evaluation -- tool recommendations may reflect familiarity rather than fitness; mitigate by requiring explicit evaluation criteria and scoring matrix for each category |

**Acceptance Criteria:**

- `/docs/tooling.md` exists
- Evaluates tools in the following categories, each with a comparison matrix (criteria, candidates, scores, recommendation):
  - **Diff parsing:** difftastic vs git-diff vs delta vs diff-so-fancy; criteria: AST-awareness, language support, output parseability, binary size
  - **AST parsing:** tree-sitter vs babel (JS-only) vs swc; criteria: language breadth, WASM support, query API, maintenance activity
  - **JSON Schema validation:** ajv vs zod vs joi vs typebox; criteria: draft-07 support, error quality, bundle size, TypeScript integration
  - **LLM SDKs:** @anthropic-ai/sdk vs AWS SDK Bedrock vs LangChain vs LiteLLM; criteria: streaming support, type safety, retry built-in, bundle size
  - **IaC framework:** AWS CDK vs SST vs Serverless Framework vs SAM; criteria: TypeScript support, Step Functions constructs, local testing, community
  - **Test framework:** Vitest vs Jest vs node:test; criteria: speed, ESM support, mocking, snapshot testing
  - **Optional vector DB:** Pinecone vs ChromaDB vs pgvector vs none-for-v1; criteria: managed hosting, cost, embedding model integration, necessity for MVP

---

### T-0.7: Testing Strategy

| Field | Value |
|-------|-------|
| **Task ID** | T-0.7 |
| **Title** | Testing strategy |
| **Owner Agent** | test-writer-fixer |
| **Dependencies** | T-0.4 |
| **Risks** | Unrealistic coverage targets -- setting 100% coverage as mandatory will slow delivery; mitigate by setting 80% line coverage as floor with explicit exclusions for generated code and IaC |

**Acceptance Criteria:**

- `/docs/testing-strategy.md` exists and defines:
  - **Golden packet fixtures:** structure and location of known-good test fixtures (input diff + expected review JSON)
  - **Evidence gate unit tests:** test categories (valid citations, invalid line refs, hallucinated snippets, partial matches, empty evidence)
  - **Schema validation tests:** tests that every schema in `/schemas/` validates correct documents and rejects malformed ones
  - **Integration test plan:** how to run Step Functions locally using `stepfunctions-local` or AWS SAM local, what scenarios to cover
  - **End-to-end test plan:** how to trigger a full pipeline run against a test repository, what to assert on the output
  - **Coverage requirements:** minimum 80% line coverage for `packages/core`, exclusions documented
  - **Test naming convention:** pattern for test file names and describe/it blocks
  - **Mock strategy:** what is mocked (LLM API, GitHub API, AWS services) and what libraries are used

---

### T-0.8: Repo File Tree + Cross-Review

| Field | Value |
|-------|-------|
| **Task ID** | T-0.8 |
| **Title** | Repo file tree + cross-review |
| **Owner Agent** | Direct |
| **Dependencies** | T-0.3, T-0.4, T-0.5, T-0.6, T-0.7 |
| **Risks** | Missed cross-references -- documents may refer to files or concepts that do not align; mitigate by systematic pairwise review of all documents |

**Acceptance Criteria:**

- Complete file tree is added to `/docs/architecture.md` showing every planned file in the repository
- All documents are cross-referenced:
  - RFC references architecture diagrams by name
  - Architecture references schemas by file path
  - Testing strategy references golden fixtures by file path
  - Prompting strategy references schemas by file path
  - Tooling evaluation recommendations are reflected in architecture component choices
- No inconsistencies found between documents (or all found inconsistencies are resolved)
- A "Document Index" section is added to this sprint plan listing all docs and their purposes

---

### T-0.9: Ask Blocking Question

| Field | Value |
|-------|-------|
| **Task ID** | T-0.9 |
| **Title** | Ask blocking question |
| **Owner Agent** | Direct |
| **Dependencies** | T-0.8 |
| **Risks** | Wrong question asked -- asking a non-critical question wastes the opportunity; mitigate by reviewing all open design decisions and selecting the one with highest downstream impact |

**Acceptance Criteria:**

- At least one critical blocking question is identified from the design documents
- The question is presented to the user with context on why it blocks progress
- The user's answer is recorded in this sprint plan or in the relevant document
- The answer does not invalidate any prior design decisions (or if it does, affected documents are updated)

---

## Epic 1: Core Engine (Phase 1 -- After User APPROVED)

**Goal:** Build and test all core review logic as local-only, provider-pluggable TypeScript packages that can run from a CLI without any AWS infrastructure.

**Exit Criteria:** CLI can review a real PR using Claude direct, all unit tests pass, evidence gate rejects hallucinated references, golden packet test suite green.

**Duration:** Sprint days 4-9

**Prerequisite Gate:** User has reviewed Epic 0 deliverables and issued `APPROVED`.

### Task Table

| Task ID | Title | Owner Agent | Dependencies | Risks |
|---------|-------|-------------|--------------|-------|
| T-1.1 | Packet builder | backend-architect | T-0.5 | Schema mismatch with actual GH payloads |
| T-1.2 | Diff parser (difftastic + tree-sitter) | backend-architect | T-0.6, T-1.1 | tree-sitter WASM binary size, difftastic integration complexity |
| T-1.3 | Context gatherer | backend-architect | T-1.1 | Token budget overruns, GitHub API rate limits |
| T-1.4 | Evidence validator | backend-architect | T-0.5, T-1.1 | False positives rejecting valid citations |
| T-1.5 | Schema validator | backend-architect | T-0.5 | Validation performance overhead |
| T-1.6 | Prompt runner | ai-engineer | T-0.5, T-1.1, T-1.4, T-1.5 | Prompt template drift, token limit exceeded |
| T-1.7 | Claude direct provider | ai-engineer | T-0.5 | API changes, rate limit handling |
| T-1.8 | Bedrock provider | ai-engineer | T-0.5, T-1.7 | Bedrock-specific payload differences |
| T-1.9 | CLI tool | rapid-prototyper | T-1.6, T-1.7 | UX polish, error messaging |
| T-1.10 | Golden packet test suite | test-writer-fixer | T-1.6 | Fixture maintenance burden |
| T-1.11 | Evidence gate test suite | test-writer-fixer | T-1.4 | Adversarial case coverage |

---

### T-1.1: Packet Builder

| Field | Value |
|-------|-------|
| **Task ID** | T-1.1 |
| **Title** | Packet builder |
| **Owner Agent** | backend-architect |
| **Dependencies** | T-0.5 |
| **Risks** | Schema mismatch with actual GitHub payloads -- the `review-packet.schema.json` may not account for all webhook payload variations (draft PRs, forks, org-level hooks); mitigate by testing against captured real payloads |

**Acceptance Criteria:**

- `ReviewPacket` class exists in `packages/core/src/packet-builder/`
- Builds a complete review packet from GitHub PR webhook payload + diff data
- Validates the constructed packet against `review-packet.schema.json`
- Throws a typed error with field-level details if validation fails
- Serializes to JSON suitable for S3 storage (no circular refs, no functions)
- Handles edge cases: draft PRs, PRs from forks, PRs with no description
- Unit tests pass with at least 3 fixture payloads (normal PR, draft PR, fork PR)

---

### T-1.2: Diff Parser (difftastic + tree-sitter)

| Field | Value |
|-------|-------|
| **Task ID** | T-1.2 |
| **Title** | Diff parser (difftastic + tree-sitter) |
| **Owner Agent** | backend-architect |
| **Dependencies** | T-0.6, T-1.1 |
| **Risks** | tree-sitter WASM binary size may exceed Lambda deployment limits (mitigate by lazy-loading per language); difftastic integration complexity as it is a CLI tool not a library (mitigate by wrapping as child process with structured output parsing) |

**Acceptance Criteria:**

- Diff parser module exists in `packages/core/src/diff-parser/`
- Parses unified diffs and produces structured, AST-aware diff output
- Handles multi-file PRs with mixed languages
- Supports at minimum: JavaScript, TypeScript, Python, Go
- Gracefully degrades to plain text diff for unsupported languages
- Output includes: file path, language, hunks with line numbers, AST node types for changed regions
- Unit tests pass covering: single file change, multi-file change, binary file (skip gracefully), rename/move, large diff (>1000 lines)

---

### T-1.3: Context Gatherer

| Field | Value |
|-------|-------|
| **Task ID** | T-1.3 |
| **Title** | Context gatherer |
| **Owner Agent** | backend-architect |
| **Dependencies** | T-1.1 |
| **Risks** | Token budget overruns -- gathering too much context blows the LLM context window (mitigate by hard budget enforcement with priority-based trimming); GitHub API rate limits -- excessive API calls for large repos (mitigate by caching and batching) |

**Acceptance Criteria:**

- Context gatherer module exists in `packages/core/src/context-gatherer/`
- Fetches surrounding file context (N lines above/below each hunk, configurable)
- Resolves related files: imports, exports, type definitions referenced by changed code
- Includes PR description and commit messages as context
- Enforces a configurable hard token budget (default: 60% of model context window)
- Implements priority-based trimming: PR description > changed code > surrounding context > related files
- Returns a structured context object with source attribution for each section
- Unit tests pass covering: simple PR, PR with many imports, PR exceeding token budget (verify trimming), PR with no description

---

### T-1.4: Evidence Validator

| Field | Value |
|-------|-------|
| **Task ID** | T-1.4 |
| **Title** | Evidence validator |
| **Owner Agent** | backend-architect |
| **Dependencies** | T-0.5, T-1.1 |
| **Risks** | False positives rejecting valid citations -- overly strict matching may reject comments that cite slightly reformatted code; mitigate by allowing normalized whitespace matching and configurable strictness levels |

**Acceptance Criteria:**

- Evidence validator module exists in `packages/core/src/evidence-validator/`
- Validates that every LLM review comment cites specific line numbers that exist in the diff
- Validates that cited code snippets actually appear at the cited line numbers (with whitespace normalization)
- Rejects comments with hallucinated line references (line numbers outside the diff range)
- Rejects comments with fabricated code snippets (text not found in the source)
- Returns a validation result with: valid comments (passed), rejected comments (with rejection reason), and a confidence score
- Supports configurable strictness: `strict` (exact match), `normal` (whitespace-normalized), `lenient` (fuzzy substring)
- Unit tests pass including adversarial cases:
  - Comment citing a line that exists but with wrong code snippet
  - Comment citing a line number outside the diff
  - Comment with no line citation at all
  - Comment citing code that appears in a different file than claimed
  - Comment with correct citation (should pass)

---

### T-1.5: Schema Validator

| Field | Value |
|-------|-------|
| **Task ID** | T-1.5 |
| **Title** | Schema validator |
| **Owner Agent** | backend-architect |
| **Dependencies** | T-0.5 |
| **Risks** | Validation performance overhead -- validating large review outputs against complex schemas could add latency; mitigate by pre-compiling schemas and benchmarking |

**Acceptance Criteria:**

- Schema validator module exists in `packages/core/src/schema-validator/`
- Uses the JSON Schema validation library selected in T-0.6
- Pre-compiles all schemas at module load time for performance
- Validates any object against any registered schema by name
- Returns structured error reports with: field path, expected type/value, actual type/value
- Provides a `validateOrThrow` method that throws typed errors
- Provides a `validateSafe` method that returns a result object (valid/invalid + errors)
- Unit tests pass covering: valid document, missing required field, wrong type, extra fields (configurable behavior), nested validation errors

---

### T-1.6: Prompt Runner

| Field | Value |
|-------|-------|
| **Task ID** | T-1.6 |
| **Title** | Prompt runner |
| **Owner Agent** | ai-engineer |
| **Dependencies** | T-0.5, T-1.1, T-1.4, T-1.5 |
| **Risks** | Prompt template drift -- templates may diverge from schema expectations as both evolve (mitigate by validating prompt output against schema in every test); Token limit exceeded -- assembled prompts may exceed model context window (mitigate by pre-calculating token count before API call) |

**Acceptance Criteria:**

- Prompt runner module exists in `packages/core/src/prompt-runner/`
- Orchestrates the 4-pass review strategy (structural, logic, style, security)
- Assembles prompts from templates + review packet + gathered context
- Calls the configured provider adapter for each pass
- Collects and merges results from all 4 passes into a single `review-output` document
- Appends the evidence gate suffix to every prompt
- Validates each pass output against `review-output.schema.json` (or pass-specific sub-schema)
- Runs the evidence validator on every comment before including it in final output
- Pre-calculates token count and fails fast if budget exceeded
- Supports configurable pass selection (run only structural + security, skip style, etc.)
- Unit tests pass with a mock provider returning canned responses
- Unit tests cover: all 4 passes succeed, one pass fails (graceful degradation), token budget exceeded, evidence gate rejects a comment

---

### T-1.7: Claude Direct Provider

| Field | Value |
|-------|-------|
| **Task ID** | T-1.7 |
| **Title** | Claude direct provider |
| **Owner Agent** | ai-engineer |
| **Dependencies** | T-0.5 |
| **Risks** | API changes -- Anthropic may update the Claude API (mitigate by pinning SDK version and abstracting behind provider contract); Rate limit handling -- burst reviews may hit rate limits (mitigate by implementing exponential backoff with jitter) |

**Acceptance Criteria:**

- Claude direct provider exists in `packages/core/src/providers/claude-direct/`
- Implements the provider contract interface defined in the RFC (T-0.3)
- Handles streaming responses (converts to complete response for downstream processing)
- Implements retry with exponential backoff and jitter for transient errors (429, 500, 503)
- Respects rate limits by reading response headers and throttling
- Supports model selection via configuration (claude-sonnet, claude-opus, etc.)
- Maps provider-specific errors to standardized error types from the provider contract
- Unit tests pass with mocked HTTP responses covering: successful response, rate limited (retry succeeds), server error (retry exhausted), malformed response, streaming response

---

### T-1.8: Bedrock Provider

| Field | Value |
|-------|-------|
| **Task ID** | T-1.8 |
| **Title** | Bedrock provider |
| **Owner Agent** | ai-engineer |
| **Dependencies** | T-0.5, T-1.7 |
| **Risks** | Bedrock-specific payload differences -- Bedrock wraps Claude API with different request/response shapes (mitigate by thorough SDK documentation review and integration testing); IAM auth complexity in local development (mitigate by supporting AWS profile-based auth) |

**Acceptance Criteria:**

- Bedrock provider exists in `packages/core/src/providers/bedrock/`
- Implements the same provider contract interface as Claude direct
- Handles IAM-based authentication (supports AWS credentials chain: env vars, profile, instance role)
- Handles streaming via Bedrock's `InvokeModelWithResponseStream`
- Implements retry with exponential backoff for Bedrock-specific throttling errors
- Maps Bedrock error codes to standardized provider contract error types
- Supports model ID selection via configuration (e.g., `anthropic.claude-3-sonnet-20240229-v1:0`)
- Unit tests pass with mocked AWS SDK calls covering: successful response, throttled (retry succeeds), access denied, model not found, streaming response

---

### T-1.9: CLI Tool

| Field | Value |
|-------|-------|
| **Task ID** | T-1.9 |
| **Title** | CLI tool |
| **Owner Agent** | rapid-prototyper |
| **Dependencies** | T-1.6, T-1.7 |
| **Risks** | UX polish -- CLI output formatting and error messages may be poor (mitigate by user testing with real PRs); Error messaging -- unclear errors when API keys are missing or invalid (mitigate by pre-flight checks) |

**Acceptance Criteria:**

- CLI tool exists in `packages/cli/`
- Invocable as `lintellect review --pr <url>` (or via `npx`/`tsx` during development)
- Runs a complete local review using the core packages (packet builder, diff parser, context gatherer, prompt runner)
- Outputs formatted review to stdout by default (human-readable, colored)
- Supports `--output json` flag for machine-readable JSON output to file
- Supports `--provider <claude-direct|bedrock>` flag (default: claude-direct)
- Supports `--passes <structural,logic,style,security>` flag for selective passes
- Performs pre-flight checks: API key present, network reachable, PR URL valid
- Displays progress indicators for each pass
- Handles errors gracefully with actionable error messages
- Integration tests pass against a test PR with a mock provider

---

### T-1.10: Golden Packet Test Suite

| Field | Value |
|-------|-------|
| **Task ID** | T-1.10 |
| **Title** | Golden packet test suite |
| **Owner Agent** | test-writer-fixer |
| **Dependencies** | T-1.6 |
| **Risks** | Fixture maintenance burden -- golden fixtures must be updated whenever schemas or prompt templates change (mitigate by keeping fixtures minimal and documenting the update procedure) |

**Acceptance Criteria:**

- Test suite exists in `packages/core/src/__tests__/golden/`
- Contains at least 5 golden test fixtures, each consisting of:
  - Input: a known diff + PR metadata (the review packet)
  - Expected output: the expected review JSON (structure-validated, not exact-match on LLM text)
  - Mock provider responses: canned LLM responses for deterministic testing
- Fixtures cover the following edge cases:
  - Normal PR with multiple files changed
  - Empty diff (no changes, should produce empty review)
  - Binary file changes (should be skipped gracefully)
  - Large PR exceeding token budget (should trigger trimming)
  - PR with only rename/move operations
- Tests run the prompt runner with the mock provider and assert:
  - Output validates against `review-output.schema.json`
  - Evidence gate passes for all included comments
  - Correct number of passes executed
  - No rejected comments in the final output
- All tests pass

---

### T-1.11: Evidence Gate Test Suite

| Field | Value |
|-------|-------|
| **Task ID** | T-1.11 |
| **Title** | Evidence gate test suite |
| **Owner Agent** | test-writer-fixer |
| **Dependencies** | T-1.4 |
| **Risks** | Adversarial case coverage -- it is difficult to anticipate all ways an LLM might hallucinate (mitigate by collecting real hallucination examples during development and adding them as fixtures) |

**Acceptance Criteria:**

- Test suite exists in `packages/core/src/__tests__/evidence-gate/`
- Contains at least 10 test cases covering:
  - Valid citation with correct line number and matching code snippet (ACCEPT)
  - Valid citation with whitespace differences in snippet (ACCEPT under normal/lenient strictness)
  - Citation with line number that exists in the diff but wrong code snippet (REJECT)
  - Citation with line number outside the diff range entirely (REJECT)
  - Citation with fabricated code snippet not found anywhere in source (REJECT)
  - Citation referencing a different file than the one being reviewed (REJECT)
  - Comment with no line citation at all (REJECT)
  - Comment with partial line range (e.g., lines 10-15) where some lines are in diff and some are not (configurable)
  - Multiple citations in one comment, some valid and some invalid (REJECT entire comment)
  - Edge case: line number at exact boundary of diff hunk (ACCEPT)
- Each test case documents: input comment, input diff, expected verdict, reason
- All tests pass under all three strictness levels where applicable

---

## Epic 2: AWS Hosted Pipeline (Phase 2 -- After User APPROVED_FOR_AWS)

**Goal:** Deploy the core engine as a fully orchestrated, production-grade AWS pipeline that processes GitHub PR webhooks end-to-end and posts review comments automatically.

**Exit Criteria:** A real PR triggers the webhook, flows through the full pipeline, and a review comment appears on the PR. CI/CD pipeline deploys successfully.

**Duration:** Sprint days 10-15

**Prerequisite Gate:** User has reviewed Epic 1 deliverables, CLI works end-to-end, and user has issued `APPROVED_FOR_AWS`.

### Task Table

| Task ID | Title | Owner Agent | Dependencies | Risks |
|---------|-------|-------------|--------------|-------|
| T-2.1 | Webhook Lambda + API Gateway | backend-architect | T-1.1 | Webhook secret rotation, payload size limits |
| T-2.2 | SQS queues (intake + DLQ) | devops-automator | T-2.1 | Message ordering assumptions |
| T-2.3 | Step Functions state machine | backend-architect | T-1.6, T-2.2 | Express vs Standard choice, state payload size limits |
| T-2.4 | Worker Lambdas | backend-architect | T-1.2, T-1.3, T-1.6, T-2.3 | Cold start latency, Lambda timeout for large PRs |
| T-2.5 | S3 bucket | devops-automator | T-2.3 | Cross-account access if needed later |
| T-2.6 | DynamoDB job status table | devops-automator | T-2.3 | Hot partition if single repo generates many PRs |
| T-2.7 | GitHub comment poster Lambda | backend-architect | T-2.4 | GitHub API rate limits, comment formatting |
| T-2.8 | IaC stack (CDK/SST) | devops-automator | T-2.1, T-2.2, T-2.3, T-2.4, T-2.5, T-2.6, T-2.7 | Circular deps in CloudFormation, stack size limits |
| T-2.9 | CI/CD pipeline | devops-automator | T-2.8 | Secrets management in CI, deployment rollback |
| T-2.10 | DEMO.md | Direct | T-2.9 | Environment-specific steps |

---

### T-2.1: Webhook Lambda + API Gateway

| Field | Value |
|-------|-------|
| **Task ID** | T-2.1 |
| **Title** | Webhook Lambda + API Gateway |
| **Owner Agent** | backend-architect |
| **Dependencies** | T-1.1 |
| **Risks** | Webhook secret rotation -- rotating the GitHub webhook secret requires coordinated update of API Gateway and GitHub settings (mitigate by storing secret in Secrets Manager with rotation Lambda); Payload size limits -- GitHub webhooks can be large for PRs with many files (mitigate by extracting only necessary fields and fetching full data lazily) |

**Acceptance Criteria:**

- Lambda function exists in `packages/aws/src/lambdas/webhook-handler/`
- API Gateway HTTP API route configured to receive POST at `/webhook/github`
- Validates GitHub webhook signature (`X-Hub-Signature-256` header) using HMAC-SHA256
- Rejects requests with invalid or missing signatures (returns 401)
- Extracts PR metadata from webhook payload (repo, PR number, head SHA, base SHA, author)
- Publishes a message to the SQS intake queue with extracted metadata
- Returns 202 Accepted immediately (does not wait for processing)
- Handles non-PR events gracefully (returns 200 with "ignored" body)
- Integration tests pass with sample webhook payloads (valid signature, invalid signature, non-PR event)

---

### T-2.2: SQS Queues (Intake + DLQ)

| Field | Value |
|-------|-------|
| **Task ID** | T-2.2 |
| **Title** | SQS queues (intake + DLQ) |
| **Owner Agent** | devops-automator |
| **Dependencies** | T-2.1 |
| **Risks** | Message ordering assumptions -- SQS standard queues do not guarantee ordering (confirm this is acceptable for independent PR reviews); mitigate by documenting that ordering is not required and each message is independently processable |

**Acceptance Criteria:**

- SQS intake queue provisioned via IaC with:
  - Visibility timeout set to 6x the Step Functions execution timeout (or 5 minutes minimum)
  - Message retention period of 4 days
  - Receive message wait time of 20 seconds (long polling)
- Dead Letter Queue (DLQ) provisioned via IaC with:
  - Max receive count of 3 before messages move to DLQ
  - Message retention period of 14 days
  - CloudWatch alarm configured for DLQ depth > 0
- Redrive policy correctly links intake queue to DLQ
- IaC deploys cleanly with `cdk synth` and `cdk deploy`
- Queue ARNs are exported as stack outputs for cross-reference

---

### T-2.3: Step Functions State Machine

| Field | Value |
|-------|-------|
| **Task ID** | T-2.3 |
| **Title** | Step Functions state machine |
| **Owner Agent** | backend-architect |
| **Dependencies** | T-1.6, T-2.2 |
| **Risks** | Express vs Standard choice -- Express workflows have a 5-minute timeout which may be too short for large PR reviews (mitigate by using Standard workflows with per-step timeouts); State payload size limits -- Step Functions has a 256KB payload limit (mitigate by passing S3 references instead of data) |

**Acceptance Criteria:**

- Step Functions state machine definition exists in `packages/aws/src/state-machines/review-pipeline.asl.json` (or equivalent CDK construct)
- Implements the following states in order:
  1. **ValidateInput:** validates the incoming message against job schema
  2. **BuildPacket:** invokes packet builder Lambda, writes packet to S3
  3. **ParseDiff:** invokes diff parser Lambda, reads packet from S3, writes parsed diff to S3
  4. **GatherContext:** invokes context gatherer Lambda, reads parsed diff from S3, writes context to S3
  5. **RunReview:** invokes prompt runner Lambda, reads all artifacts from S3, writes review output to S3
  6. **EvidenceGate:** invokes evidence validator Lambda, reads review from S3, writes validated review to S3
  7. **PostComment:** invokes comment poster Lambda, reads validated review from S3, posts to GitHub
- Each state has:
  - Configurable timeout (default: 60s for light steps, 300s for review step)
  - Retry policy with exponential backoff for transient errors
  - Catch block that writes failure to DynamoDB and moves to a FailState
- All data is passed between states as S3 references (keys), not inline payloads
- DynamoDB job status is updated at each state transition (PENDING -> IN_PROGRESS -> each step -> COMPLETED or FAILED)
- ASL definition validates against the AWS Step Functions schema
- Integration tests pass using local Step Functions emulation (stepfunctions-local)

---

### T-2.4: Worker Lambdas

| Field | Value |
|-------|-------|
| **Task ID** | T-2.4 |
| **Title** | Worker Lambdas |
| **Owner Agent** | backend-architect |
| **Dependencies** | T-1.2, T-1.3, T-1.6, T-2.3 |
| **Risks** | Cold start latency -- first invocation may be slow due to tree-sitter WASM loading (mitigate by provisioned concurrency on diff-worker Lambda or lazy initialization); Lambda timeout for large PRs -- the review-worker Lambda may exceed the 15-minute maximum (mitigate by chunking large PRs and processing sequentially within the state machine) |

**Acceptance Criteria:**

- Three separate Lambda functions exist:
  - `packages/aws/src/lambdas/diff-worker/` -- wraps `packages/core` diff parser
  - `packages/aws/src/lambdas/context-worker/` -- wraps `packages/core` context gatherer
  - `packages/aws/src/lambdas/review-worker/` -- wraps `packages/core` prompt runner
- Each Lambda:
  - Reads input artifacts from S3 using keys provided in the Step Functions input
  - Writes output artifacts to S3 and returns the output S3 key
  - Updates DynamoDB job status with current step and timestamp
  - Handles errors by throwing typed errors that Step Functions can catch
  - Has configurable memory (default: 512MB for diff/context, 1024MB for review) and timeout
- Unit tests pass for each Lambda handler with mocked S3 and DynamoDB
- Lambda deployment packages are within size limits (50MB zipped, 250MB unzipped)

---

### T-2.5: S3 Bucket

| Field | Value |
|-------|-------|
| **Task ID** | T-2.5 |
| **Title** | S3 bucket |
| **Owner Agent** | devops-automator |
| **Dependencies** | T-2.3 |
| **Risks** | Cross-account access if needed later -- bucket policy may need updating for multi-account setups (mitigate by parameterizing account IDs in IaC and documenting the extension path) |

**Acceptance Criteria:**

- S3 bucket provisioned via IaC with:
  - Bucket name parameterized per environment (dev/staging/prod)
  - Server-side encryption enabled (SSE-S3 or SSE-KMS, configurable)
  - Versioning disabled (artifacts are immutable, identified by job ID)
  - Lifecycle policy: objects in `reviews/` prefix expire after 90 days
  - Lifecycle policy: objects in `packets/` prefix expire after 30 days
  - Public access blocked (all four block public access settings enabled)
  - Bucket policy restricts access to pipeline IAM roles only
- Key structure documented:
  - `packets/{jobId}/review-packet.json`
  - `diffs/{jobId}/parsed-diff.json`
  - `context/{jobId}/context.json`
  - `reviews/{jobId}/review-output.json`
  - `reviews/{jobId}/validated-review.json`
- IaC deploys cleanly

---

### T-2.6: DynamoDB Job Status Table

| Field | Value |
|-------|-------|
| **Task ID** | T-2.6 |
| **Title** | DynamoDB job status table |
| **Owner Agent** | devops-automator |
| **Dependencies** | T-2.3 |
| **Risks** | Hot partition if a single repository generates many PRs in a burst (mitigate by using `jobId` as partition key which is unique per review, not per repo; add GSI on `repoUrl` for lookup patterns) |

**Acceptance Criteria:**

- DynamoDB table provisioned via IaC with:
  - Table name parameterized per environment
  - Partition key: `jobId` (String)
  - Sort key: `timestamp` (Number, epoch milliseconds)
  - GSI `gsi-pr-url`: partition key = `prUrl` (String), sort key = `timestamp` (Number) for lookup by PR
  - GSI `gsi-repo`: partition key = `repoFullName` (String), sort key = `timestamp` (Number) for lookup by repo
  - TTL attribute: `expiresAt` (set to 90 days from creation)
  - Billing mode: PAY_PER_REQUEST (on-demand) for unpredictable workloads
  - Point-in-time recovery enabled
- Job status record schema matches `job-status.schema.json`
- IaC deploys cleanly
- Table ARN exported as stack output

---

### T-2.7: GitHub Comment Poster Lambda

| Field | Value |
|-------|-------|
| **Task ID** | T-2.7 |
| **Title** | GitHub comment poster Lambda |
| **Owner Agent** | backend-architect |
| **Dependencies** | T-2.4 |
| **Risks** | GitHub API rate limits -- posting many inline comments may hit rate limits (mitigate by using the batch PR review API which posts all comments in a single request); Comment formatting edge cases -- inline comments on deleted lines, comments spanning multiple lines, markdown rendering differences (mitigate by testing against GitHub's rendering) |

**Acceptance Criteria:**

- Lambda function exists in `packages/aws/src/lambdas/comment-poster/`
- Reads the final validated review from S3
- Formats the review as a GitHub PR review using the Pull Request Review API (not individual comments):
  - Overall review body with summary
  - Inline comments on specific lines using the `comments` array with `path`, `line`, and `body`
  - Review event set to `COMMENT` (not `APPROVE` or `REQUEST_CHANGES`)
- Posts the review in a single API call to minimize rate limit consumption
- Handles rate limits by reading `X-RateLimit-Remaining` header and backing off if near zero
- Updates DynamoDB job status to `COMPLETED` with the review URL
- Handles errors: PR closed/merged before posting (update status to `SKIPPED`), auth failure (update status to `FAILED`)
- Integration tests pass with mocked GitHub API

---

### T-2.8: IaC Stack (CDK/SST)

| Field | Value |
|-------|-------|
| **Task ID** | T-2.8 |
| **Title** | IaC stack (CDK/SST) |
| **Owner Agent** | devops-automator |
| **Dependencies** | T-2.1, T-2.2, T-2.3, T-2.4, T-2.5, T-2.6, T-2.7 |
| **Risks** | Circular dependencies in CloudFormation -- resources that reference each other can cause deployment failures (mitigate by explicit dependency ordering in CDK and splitting into nested stacks if needed); Stack size limits -- CloudFormation template size limit is 1MB (mitigate by monitoring template size and extracting large ASL definitions to S3) |

**Acceptance Criteria:**

- Single CDK (or SST) app exists in `packages/aws/infra/`
- Contains all resources in a deployable stack:
  - API Gateway HTTP API
  - Webhook handler Lambda
  - SQS intake queue + DLQ
  - Step Functions state machine
  - Worker Lambdas (diff, context, review)
  - Comment poster Lambda
  - S3 bucket
  - DynamoDB table
  - IAM roles with least-privilege policies
  - CloudWatch log groups with 30-day retention
- Stack is parameterized for environments using CDK context or environment variables:
  - `dev`: relaxed limits, verbose logging
  - `staging`: production-like limits, standard logging
  - `prod`: strict limits, error-only logging, provisioned concurrency
- `cdk synth` succeeds without errors
- `cdk diff` shows expected resources (no unexpected drift)
- All Lambda functions reference the correct core packages
- Stack tags include: `project=lintellect`, `environment={env}`, `managed-by=cdk`

---

### T-2.9: CI/CD Pipeline

| Field | Value |
|-------|-------|
| **Task ID** | T-2.9 |
| **Title** | CI/CD pipeline |
| **Owner Agent** | devops-automator |
| **Dependencies** | T-2.8 |
| **Risks** | Secrets management in CI -- AWS credentials, GitHub tokens, and LLM API keys must be securely stored (mitigate by using GitHub Actions OIDC for AWS auth, GitHub Secrets for tokens); Deployment rollback strategy -- failed deployments may leave infrastructure in a broken state (mitigate by CDK rollback on failure, and blue/green deployment for Lambdas in prod) |

**Acceptance Criteria:**

- GitHub Actions workflow exists at `.github/workflows/deploy.yml`
- Pipeline stages:
  1. **Lint:** runs ESLint on all packages
  2. **Type Check:** runs `tsc --noEmit` on all packages
  3. **Test:** runs all unit and integration tests with coverage reporting
  4. **Build:** compiles all packages
  5. **Synth:** runs `cdk synth` to validate IaC
  6. **Deploy Staging:** on push to `main`, deploys to staging environment
  7. **Deploy Prod:** on GitHub Release (tag `v*`), deploys to production environment
- AWS authentication uses OIDC (no long-lived credentials)
- Secrets (GitHub App token, LLM API keys) stored in GitHub Secrets and injected as environment variables
- Pipeline includes a manual approval step before production deployment
- Pipeline runs green on a clean push to main
- Test coverage report is uploaded as a workflow artifact

---

### T-2.10: DEMO.md

| Field | Value |
|-------|-------|
| **Task ID** | T-2.10 |
| **Title** | DEMO.md |
| **Owner Agent** | Direct |
| **Dependencies** | T-2.9 |
| **Risks** | Environment-specific steps -- demo instructions may only work in the author's environment (mitigate by testing on a fresh AWS account and documenting all prerequisites) |

**Acceptance Criteria:**

- `/docs/DEMO.md` exists with:
  - **Prerequisites:** AWS account, GitHub repo, Node.js version, AWS CLI configured, required secrets
  - **Setup:** step-by-step instructions to clone, install, configure environment variables
  - **Deploy:** commands to deploy the stack to a dev environment
  - **Trigger:** how to create a test PR that triggers the webhook
  - **Observe:** how to monitor the pipeline (CloudWatch logs, Step Functions console, DynamoDB table)
  - **Verify:** how to confirm the review comment appeared on the PR
  - **Teardown:** commands to destroy the stack and clean up
  - **Troubleshooting:** common failure modes and how to resolve them
- All commands are copy-pasteable
- Expected outputs are documented (what you should see at each step)

---

## Global Risk Register

| Risk ID | Risk | Impact | Likelihood | Mitigation | Owner |
|---------|------|--------|------------|------------|-------|
| R-01 | LLM hallucinated code references | **High** -- false review comments erode trust | Medium | Evidence Gate validator (T-1.4) rejects unverifiable citations; evidence gate prompt suffix instructs LLM to cite only real code | backend-architect |
| R-02 | Token budget exceeded on large PRs | **Medium** -- review fails or truncates | High | Context gatherer (T-1.3) enforces hard token budget with priority-based trimming; chunking strategy for very large PRs | backend-architect |
| R-03 | Step Functions payload size (256KB limit) | **Medium** -- large diffs cause state machine failure | Medium | S3 pass-by-reference pattern; only S3 keys and metadata flow through state machine, never raw data | backend-architect |
| R-04 | Lambda cold start latency | **Medium** -- slow first review after idle period | Medium | Provisioned concurrency for critical Lambdas (review-worker, diff-worker); lazy initialization of heavy dependencies | devops-automator |
| R-05 | Schema drift between passes | **Medium** -- validation failures at runtime | Low | Single source of truth in `/schemas/`; schema validator (T-1.5) enforced at every boundary; CI tests validate all schemas | ai-engineer |
| R-06 | GitHub API rate limits | **Low-Medium** -- comment posting delayed or fails | Low | Batch PR review API (single request for all comments); exponential backoff; rate limit header monitoring; GitHub App installation tokens (higher limits) | backend-architect |
| R-07 | Scope creep across phases | **High** -- project never ships | Medium | sprint-prioritizer enforces phase gates; user APPROVED required between epics; scope locked once sprint starts; change requests deferred to next sprint | sprint-prioritizer |
| R-08 | tree-sitter WASM binary size | **Low** -- Lambda deployment package exceeds limits | Low | Load only required language grammars; use Lambda layers for shared binaries; monitor package size in CI | backend-architect |
| R-09 | Difftastic CLI integration complexity | **Medium** -- unreliable subprocess execution in Lambda | Medium | Tooling evaluation (T-0.6) validates approach; fallback to plain diff parser if difftastic unavailable | backend-architect |
| R-10 | Secrets rotation coordination | **Low** -- webhook validation fails during rotation | Low | Store secrets in AWS Secrets Manager with rotation Lambda; support dual-secret validation during rotation window | devops-automator |

---

## Dependency Graph

```
T-0.1 (scaffold)
  |
  v
T-0.2 (sprint plan) ----+----+----+
  |                      |    |    |
  v                      v    |    v
T-0.3 (RFC)         T-0.6    |  T-0.4 (arch)
  |                  (tools)  |    |    |
  |                    |      |    v    v
  |                    |      | T-0.5  T-0.7
  |                    |      | (prompts) (testing)
  |                    |      |    |
  v                    v      v    v
T-0.8 (cross-review) <-- all of the above
  |
  v
T-0.9 (blocking question)
  |
  v
====== USER APPROVED ======
  |
  +--> T-1.1 (packet) ---+--> T-1.2 (diff) ---+
  |       |               |                     |
  |       +--> T-1.3 (context) ----+            |
  |       |                        |            |
  |       +--> T-1.4 (evidence) ---+---> T-1.11 (evidence tests)
  |                                |
  +--> T-1.5 (schema) ----+       |
  |                        |       |
  +--> T-1.7 (claude) ----+       |
  |       |                |       |
  |       +--> T-1.8       |       |
  |       (bedrock)        v       v
  |                   T-1.6 (prompt runner) ---> T-1.10 (golden tests)
  |                        |
  v                        v
T-1.9 (CLI) <-- T-1.6 + T-1.7
  |
  v
====== USER APPROVED_FOR_AWS ======
  |
  +--> T-2.1 (webhook) --> T-2.2 (SQS) --> T-2.3 (step fn) --+
  |                                              |              |
  |                                              +--> T-2.5    |
  |                                              |   (S3)      |
  |                                              +--> T-2.6    |
  |                                              |   (dynamo)  |
  |                                              v             |
  |                                         T-2.4 (workers) ---+
  |                                              |
  |                                              v
  |                                         T-2.7 (poster)
  |                                              |
  +----------------------------------------------+
  |
  v
T-2.8 (IaC stack) --> T-2.9 (CI/CD) --> T-2.10 (DEMO)
```

---

## Sprint Velocity Assumptions

| Metric | Value | Notes |
|--------|-------|-------|
| Sprint duration | 6 working days per epic | 18 total working days across 3 epics |
| Team composition | AI agent ensemble | Parallel execution possible within dependency constraints |
| Buffer allocation | 20% per epic | ~1 day buffer per epic for unknowns |
| Review overhead | 10% per task | Time for cross-review and validation |

---

## Prioritization Rationale

### Why this ordering?

**Epic 0 first (Design):** Without validated schemas, architecture, and test strategy, code written in Epic 1 will need constant rework. The upfront design investment pays for itself by preventing churn. RICE score: Reach=all tasks, Impact=high, Confidence=high, Effort=low.

**Epic 1 second (Core Engine):** The core review logic is the product's value proposition. Building it as standalone packages with a CLI proves the concept before committing to AWS infrastructure costs. If the LLM review quality is poor, we learn cheaply. RICE score: Reach=all users, Impact=critical, Confidence=medium (LLM quality uncertain), Effort=medium.

**Epic 2 third (AWS Pipeline):** Infrastructure is an amplifier, not the product. The core engine must work before we wrap it in SQS/Step Functions/Lambda. Deploying a broken review engine to production is worse than having no deployment. RICE score: Reach=all users, Impact=high, Confidence=high (proven patterns), Effort=high.

### What was explicitly cut from v1?

| Feature | Reason for deferral |
|---------|-------------------|
| Frontend dashboard | Not required for core value delivery; CLI and GitHub comments are sufficient |
| Vector DB / RAG | Adds complexity without proven value; simpler context gathering first |
| Multi-VCS support (GitLab, Bitbucket) | GitHub-only for v1; provider pattern allows future extension |
| Custom rule configuration | Hardcoded 4-pass strategy is sufficient for v1; user-configurable rules deferred |
| Review feedback loop (learn from user reactions) | Requires usage data that does not exist yet; defer to v2 |
| Multi-language LLM support (GPT-4, Gemini) | Claude-only (direct + Bedrock) for v1; provider contract allows future extension |

---

## Document Index

| Document | Path | Purpose | Created By |
|----------|------|---------|------------|
| Sprint Plan | `/docs/SPRINT-PLAN.md` | This document -- master plan with all epics, tasks, and risks | sprint-prioritizer (T-0.2) |
| RFC | `/docs/RFC.md` | Technical design rationale and system specification | Plan agent (T-0.3) |
| Architecture | `/docs/architecture.md` | C4 diagrams, Mermaid flows, component inventory, file tree | Plan agent (T-0.4) |
| Prompting Strategy | `/docs/prompting.md` | 4-pass review strategy, prompt templates, token budgets | ai-engineer (T-0.5) |
| Tooling Evaluation | `/docs/tooling.md` | Tool comparison matrices and recommendations | tool-evaluator (T-0.6) |
| Testing Strategy | `/docs/testing-strategy.md` | Test plan, coverage targets, fixture structure | test-writer-fixer (T-0.7) |
| Demo Guide | `/docs/DEMO.md` | End-to-end deployment and demo instructions | Direct (T-2.10) |

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-02-07 | 1.0.0 | sprint-prioritizer | Initial sprint plan created with 3 epics, 30 tasks |
