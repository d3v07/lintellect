# Lintellect -- Tooling Evaluation

**Task ID:** T-0.6
**Author:** tool-evaluator
**Created:** 2026-02-07
**Status:** COMPLETE

---

## Table of Contents

1. [Evaluation Methodology](#evaluation-methodology)
2. [Category 1: Diff Parsing](#category-1-diff-parsing)
3. [Category 2: AST Parsing (Tree-sitter Bindings)](#category-2-ast-parsing-tree-sitter-bindings)
4. [Category 3: JSON Schema Validation](#category-3-json-schema-validation)
5. [Category 4: LLM SDK](#category-4-llm-sdk)
6. [Category 5: Infrastructure as Code](#category-5-infrastructure-as-code)
7. [Category 6: Testing Framework](#category-6-testing-framework)
8. [Category 7: Vector Database (Optional)](#category-7-vector-database-optional)
9. [Final Summary](#final-summary)
10. [Appendix: Decision Log](#appendix-decision-log)

---

## Evaluation Methodology

Each tool category is evaluated against criteria specific to Lintellect's requirements:

- **Production AWS Lambda pipeline** (SQS + Step Functions orchestration)
- **ESM-first TypeScript monorepo** (Node.js 20+ runtime)
- **JSON Schema draft-07 interop** (schema-first design, schemas in `/schemas/`)
- **Multi-pass LLM review** (structural, logic, style, security)
- **Evidence-validated output** (line numbers, code snippets must be verifiable)
- **6-day sprint cadence** (time-to-value matters more than theoretical perfection)

Rating scale used in comparison matrices:

| Rating | Meaning |
|--------|---------|
| **5** | Excellent -- best in class for this criterion |
| **4** | Good -- meets needs well with minor gaps |
| **3** | Adequate -- works but with notable trade-offs |
| **2** | Weak -- significant gaps or friction |
| **1** | Poor -- not viable for this use case |

Weights reflect Lintellect's priorities. A tool that scores 5 on a low-weight criterion and 2 on a high-weight criterion loses to a tool that scores 4 across the board.

---

## Category 1: Diff Parsing

### Context

Lintellect receives GitHub PR webhooks and must parse diffs into structured data that downstream components (context-gatherer, prompt-runner) can consume programmatically. The diff parser lives in `packages/core/src/diff-parser/` and runs both locally (CLI) and in AWS Lambda.

We need:
1. A way to **obtain** raw diffs (from GitHub API or `git diff`)
2. A way to **parse** those diffs into structured objects (file paths, hunks, line numbers, added/removed lines)
3. Optionally, **AST awareness** of what changed (function-level, class-level granularity)

These are three distinct concerns. Conflating them leads to poor tool choices.

### Candidates

| Tool | What It Does | Language | npm Package |
|------|-------------|----------|-------------|
| **difftastic** | AST-aware structural diffing engine | Rust binary | None (shell out or WASM) |
| **diff-so-fancy** | Prettifies unified diff for terminal display | Perl/Node | `diff-so-fancy` |
| **native git diff** | Produces unified diff format | C (git core) | N/A (CLI) |
| **unidiff (parse-diff)** | Parses unified diff text into structured JS objects | JavaScript | `parse-diff` / `gitdiff-parser` |

Note: The npm ecosystem has several unified diff parsers. `parse-diff` is the most widely used (~800k weekly downloads). `gitdiff-parser` is an alternative. Both parse unified diff format into structured objects with file paths, hunks, and line-level changes.

### Comparison Matrix

| Criterion | Weight | difftastic | diff-so-fancy | native git diff | parse-diff (npm) |
|-----------|--------|------------|---------------|-----------------|------------------|
| Structured output (parseable JSON) | 25% | **2** -- outputs human-readable text, no JSON mode | **1** -- terminal prettifier only, no structured output | **3** -- unified diff is a well-defined format but requires parsing | **5** -- purpose-built: returns `{files, hunks, changes}` objects |
| AST awareness | 15% | **5** -- full tree-sitter-based structural diffing | **1** -- zero AST awareness | **1** -- purely textual line-by-line | **1** -- parses diff structure, not code semantics |
| Language support breadth | 10% | **5** -- 50+ languages via tree-sitter grammars | **1** -- language-agnostic (no parsing) | **1** -- language-agnostic (no parsing) | **1** -- language-agnostic (no parsing) |
| Performance on large diffs | 15% | **3** -- fast for its scope, but subprocess overhead in Node | **2** -- stream processing but irrelevant output | **4** -- extremely fast, native C | **4** -- lightweight JS parsing, handles large diffs well |
| Node.js/npm integration | 20% | **1** -- Rust binary, requires shelling out or WASM build (unofficial) | **2** -- npm package exists but designed for terminal piping | **3** -- requires `child_process.exec` or GitHub API | **5** -- native npm package, `import parseDiff from 'parse-diff'` |
| Binary/bundle size | 5% | **1** -- ~30MB Rust binary per platform | **3** -- ~200KB Perl/Node | **5** -- already on system (0 additional) | **5** -- ~15KB package |
| Maintenance activity | 10% | **4** -- actively maintained, regular releases | **3** -- maintained but slow cadence | **5** -- part of git core, effectively permanent | **3** -- stable, infrequent updates (mature) |
| **Weighted Score** | | **2.55** | **1.55** | **3.10** | **4.20** |

### Recommendation: Composite Approach

**Primary: `parse-diff` (npm) for structured diff parsing**
**Source: GitHub API (`GET /repos/{owner}/{repo}/pulls/{number}` with `Accept: application/vnd.github.diff`) or `git diff`**
**Supplementary: tree-sitter (evaluated separately in Category 2) for AST-level analysis**

The recommended architecture separates concerns cleanly:

```
GitHub API (raw unified diff)
       |
       v
  parse-diff (npm)          -->  Structured diff objects
       |                          { files[], hunks[], changes[] }
       v
  tree-sitter (per-file)    -->  AST node annotations
       |                          { changedFunctions[], changedClasses[] }
       v
  Merged output              -->  AST-aware structured diff
```

### Rationale

1. **difftastic is the wrong tool for this job.** It is a visual diffing tool designed for human consumption. Its output is formatted text, not structured data. While it uses tree-sitter internally for AST-aware diffing, that capability is locked behind a CLI interface with no JSON output mode. Shelling out to a Rust binary from Lambda, parsing its human-readable output, and handling edge cases is fragile engineering.

2. **diff-so-fancy is a terminal prettifier.** It takes unified diff input and produces colorized terminal output. It adds zero analytical value to a pipeline that needs structured data.

3. **native git diff produces the universal input format.** Unified diff is the lingua franca. GitHub's API returns it directly. `parse-diff` consumes it. This is the correct source layer.

4. **parse-diff converts unified diff into the exact data structure we need.** File paths, hunk headers, line numbers, added/removed/context lines -- all as JavaScript objects. Zero subprocess overhead, zero native dependencies, runs identically on local machine and Lambda.

5. **AST awareness is handled separately by tree-sitter** (Category 2). We parse the changed files through tree-sitter to identify which functions, classes, or blocks were modified. This is a richer approach than difftastic because we control the analysis and can query the AST for exactly the information the prompt-runner needs.

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `parse-diff` does not handle all git diff edge cases (renames, binary markers, submodule changes) | Medium | Low | Test against corpus of real PR diffs; fall back to raw hunk text for unrecognized formats |
| Separating diff parsing from AST analysis adds complexity vs. a single tool | Low | Low | Clear interface boundary in `diff-parser/` module; AST annotation is an optional enrichment step |
| `parse-diff` maintenance slows or stops | Low | Low | The unified diff format is stable; the parser is ~300 lines of code; we can fork or inline if needed |

---

## Category 2: AST Parsing (Tree-sitter Bindings)

### Context

Lintellect needs AST awareness to tell the LLM *what* changed at a semantic level ("the `validateInput` function was modified") rather than just *where* ("lines 42-57 changed"). This enriches the review packet and enables more targeted prompts. The AST parser must run in AWS Lambda (Node.js 20 runtime) and support at minimum: JavaScript, TypeScript, Python, and Go.

### Candidates

| Tool | Approach | Native Deps | Lambda Compatibility |
|------|----------|-------------|---------------------|
| **node-tree-sitter** | Native Node.js addon (N-API) | Yes -- requires compilation per platform | Requires Lambda layer with precompiled binaries |
| **web-tree-sitter** | WASM build of tree-sitter | No -- pure WASM, runs anywhere | Excellent -- no native dependencies |
| **None (regex-based)** | Pattern matching on code text | No | Excellent -- no dependencies |

### Comparison Matrix

| Criterion | Weight | node-tree-sitter | web-tree-sitter | None (regex) |
|-----------|--------|-----------------|-----------------|--------------|
| Lambda compatibility | 25% | **2** -- requires precompiled native addon for `linux-x64`; must be packaged as Lambda layer; breaks on runtime updates | **5** -- WASM binary runs on any Node.js 20 runtime without platform-specific compilation | **5** -- no dependencies at all |
| Parse performance | 15% | **5** -- native speed, ~1-5ms for typical files | **4** -- WASM overhead adds ~2-3x vs native, still <15ms for typical files | **2** -- regex-based extraction is fast but produces wrong results on complex code |
| Language grammar availability | 20% | **5** -- full tree-sitter grammar ecosystem, 100+ languages | **5** -- same grammars, compiled to WASM via `tree-sitter build --wasm` | **1** -- must write and maintain regex per language; unreliable for nested structures |
| Bundle size | 10% | **3** -- ~2MB per language grammar (native `.node` files) | **3** -- ~2-4MB per language grammar (`.wasm` files); mitigated by on-demand loading | **5** -- zero additional size |
| API ergonomics | 15% | **4** -- synchronous API, straightforward tree queries | **4** -- async initialization, then same query API as native; slightly more boilerplate for setup | **1** -- no real API; fragile string manipulation |
| Memory footprint | 5% | **4** -- efficient native memory management | **3** -- WASM linear memory; garbage collection less predictable | **5** -- minimal memory |
| Maintenance/community | 10% | **4** -- well maintained, used by Neovim, GitHub, others | **4** -- same core project; WASM build is official and maintained | **1** -- custom code, maintained by us alone |
| **Weighted Score** | | **3.60** | **4.40** | **2.50** |

### Recommendation: web-tree-sitter (WASM)

**ADOPT** -- Use `web-tree-sitter` with language grammars loaded on demand from S3.

### Architecture

```
Lambda cold start:
  1. Load web-tree-sitter core (~400KB WASM)
  2. Initialize parser

Per-file analysis:
  1. Determine language from file extension
  2. Load language grammar from S3 cache (or bundled for top 4 languages)
  3. Parse file into AST
  4. Query AST for changed node types (functions, classes, methods)
  5. Return { language, ast_nodes_changed: [...] }
```

### Rationale

1. **Lambda portability is the deciding factor.** `node-tree-sitter` requires native compilation for `linux-x64` (or `linux-arm64` for Graviton). This means maintaining a Lambda layer that must be rebuilt whenever the Node.js runtime or tree-sitter version changes. `web-tree-sitter` runs on any platform without compilation, which eliminates an entire class of deployment failures.

2. **Performance is sufficient.** WASM tree-sitter parses a 1000-line TypeScript file in under 15ms. For a code review pipeline where the LLM call takes 5-30 seconds, the difference between 5ms (native) and 15ms (WASM) is irrelevant.

3. **Grammar loading strategy matters more than the binding choice.** The real challenge is managing grammar WASM files (~2-4MB each). For v1, we bundle the top 4 languages (JS, TS, Python, Go) in the Lambda deployment package and load others from S3 on demand. This keeps the cold bundle under 20MB.

4. **The regex alternative is a trap.** It works for the demo, then fails on the first real codebase with nested classes, decorators, or template literals. The maintenance cost of regex-based AST extraction exceeds the cost of integrating tree-sitter within the first sprint.

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| WASM grammar files push Lambda package over 50MB zip limit | Medium | Medium | Bundle only JS/TS/Python/Go grammars (~12MB total); load others from S3 on first use with in-memory cache |
| `web-tree-sitter` WASM initialization adds 100-200ms to Lambda cold start | Medium | Low | Acceptable for a pipeline where total execution is 10-60 seconds; use provisioned concurrency for prod if needed |
| Tree-sitter query language has a learning curve | Low | Low | Queries for "find enclosing function/class of line N" are well-documented; we need ~5 queries total for v1 |
| Grammar version mismatch between parser and grammar WASM | Low | Medium | Pin grammar versions in `package.json`; test grammar loading in CI |

---

## Category 3: JSON Schema Validation

### Context

Lintellect uses JSON Schema draft-07 as the contract between pipeline stages. Schemas live in `/schemas/` and define the shape of review packets, review outputs, review comments, job status records, and provider configs. The schema validator (`packages/core/src/schema-validator/`) must:

- Validate at runtime (not just compile time)
- Produce field-level error messages for debugging
- Be fast enough to validate on every pipeline stage boundary without adding meaningful latency
- Support JSON Schema draft-07 specifically (for interop with external tools and the evidence gate)

### Candidates

| Tool | Approach | JSON Schema Native | npm Package |
|------|----------|--------------------|-------------|
| **Ajv** | JSON Schema validator (compile + validate pattern) | Yes -- draft-04/06/07/2019-09/2020-12 | `ajv` |
| **Zod** | TypeScript-first schema definition with runtime validation | No -- requires `zod-to-json-schema` bridge | `zod` |
| **TypeBox** | JSON Schema Type Builder for TypeScript | Yes -- generates JSON Schema from TypeScript-like builder API | `@sinclair/typebox` |
| **Joi** | Object schema validation library | No -- proprietary schema format | `joi` |

### Comparison Matrix

| Criterion | Weight | Ajv | Zod | TypeBox | Joi |
|-----------|--------|-----|-----|---------|-----|
| JSON Schema draft-07 compliance | 25% | **5** -- gold standard; full draft-07 support including `$ref`, `if/then/else`, `allOf/anyOf/oneOf` | **2** -- Zod has its own schema format; `zod-to-json-schema` generates JSON Schema but round-tripping has edge cases | **5** -- generates valid JSON Schema draft-07 natively; schemas are JSON Schema by definition | **1** -- proprietary format; no JSON Schema output without third-party converter |
| Validation performance | 20% | **5** -- compiles schemas to optimized JS functions; fastest JSON Schema validator in benchmarks by 2-10x | **3** -- interpreted validation; adequate for most use cases but measurably slower than compiled validators | **4** -- uses Ajv internally for validation by default; inherits Ajv's performance | **3** -- interpreted; adequate but not optimized |
| TypeScript integration | 20% | **3** -- `json-schema-to-ts` or manual type definitions; types and schemas are separate artifacts that can drift | **5** -- TypeScript types are derived directly from the schema definition; single source of truth | **5** -- `Static<typeof schema>` extracts TypeScript type from schema; single source of truth | **2** -- types require separate `@types/joi` or manual definitions |
| Error message quality | 15% | **4** -- structured error objects with `instancePath`, `keyword`, `params`; verbose but complete; `ajv-errors` plugin for custom messages | **5** -- human-readable error messages by default; `.format()` returns user-friendly strings; excellent for debugging | **4** -- inherits Ajv error format; same structured errors | **4** -- good error messages with `.details[]` array; human-readable by default |
| Bundle size | 10% | **3** -- ~120KB minified (core); grows with plugins and draft-07 support module | **4** -- ~50KB minified | **5** -- ~30KB minified | **2** -- ~150KB minified |
| Schema-first workflow fit | 10% | **5** -- designed to consume JSON Schema files directly; `ajv.compile(require('./schema.json'))` | **2** -- designed for code-first workflow; consuming existing JSON Schema files requires `z.schema()` (experimental) or manual translation | **4** -- can load JSON Schema files but designed for programmatic schema construction | **2** -- code-first; no JSON Schema file loading |
| **Weighted Score** | | **4.25** | **3.25** | **4.55** | **2.15** |

### Recommendation: Ajv (primary) + TypeBox (schema authoring)

**ADOPT Ajv** for runtime validation.
**TRIAL TypeBox** for authoring new schemas with TypeScript type extraction.

### Architecture

```
Schema authoring (TypeBox):                Runtime validation (Ajv):

  TypeBox builder API                        JSON Schema files in /schemas/
       |                                            |
       v                                            v
  .schema.json file  ---- written to disk -->  ajv.compile(schema)
       |                                            |
       v                                            v
  Static<T> type     (compile-time safety)    validate(data) (runtime safety)
```

For v1, we use Ajv directly with the existing JSON Schema files in `/schemas/`. The schema-validator module pre-compiles all schemas at load time:

```typescript
// packages/core/src/schema-validator/index.ts
import Ajv from 'ajv';
import reviewPacketSchema from '../../../../schemas/review-packet.schema.json';
import reviewOutputSchema from '../../../../schemas/review-output.schema.json';
// ...

const ajv = new Ajv({ allErrors: true, verbose: true });
const validators = {
  'review-packet': ajv.compile(reviewPacketSchema),
  'review-output': ajv.compile(reviewOutputSchema),
  // ...
};

export function validate(schemaName: string, data: unknown): ValidationResult {
  const validate = validators[schemaName];
  const valid = validate(data);
  return { valid, errors: validate.errors ?? [] };
}
```

### Rationale

1. **We already have JSON Schema files.** The schemas in `/schemas/` are the source of truth (defined in T-0.5). Ajv consumes JSON Schema files natively. Zod would require translating every schema into Zod syntax or using an experimental bridge -- that is wasted effort and a source of drift.

2. **Ajv is the fastest.** In a pipeline where validation runs at every stage boundary (6+ times per review), compiled validation matters. Ajv compiles schemas to JavaScript functions once, then executes them in microseconds. Zod's interpreted validation is 5-10x slower per call.

3. **TypeBox earns a TRIAL for future schema authoring.** If we need to create new schemas in v2, TypeBox gives us the best of both worlds: TypeScript type inference AND JSON Schema output. But for v1, where schemas already exist as `.json` files, Ajv is the direct fit.

4. **Zod is excellent but wrong for this architecture.** Zod's strength is code-first schema definition in TypeScript applications. Lintellect is schema-first: the JSON Schema files are the contract, shared across pipeline stages and potentially consumed by external tools. Working against Zod's grain would cost more than it saves.

5. **Joi is outdated for this use case.** No JSON Schema compliance, no TypeScript type extraction, largest bundle. It has no advantage over the other candidates.

### Why not Zod? (Expanded)

Zod is the most popular runtime validation library in the TypeScript ecosystem, and this recommendation will be questioned. Here is the specific case against Zod for Lintellect:

- **Lintellect's schemas are the API contract.** They are consumed by the evidence validator, the prompt runner, the schema validator module, and potentially external tools. JSON Schema draft-07 is the interop format. Zod's native format is not JSON Schema.
- **`zod-to-json-schema` is a lossy bridge.** It handles most cases but has documented edge cases with `$ref`, discriminated unions, and default values. We would be adding a dependency to work around Zod not being JSON Schema native.
- **`z.schema()` is experimental.** Zod 4's JSON Schema support is not yet stable. Building a production pipeline on experimental features in a 6-day sprint is not acceptable.
- **The DX advantage disappears when schemas already exist.** Zod's killer feature is `z.infer<typeof schema>` for TypeScript types. But if the schemas already exist as JSON files, we need `json-schema-to-ts` (or TypeBox's `Static<T>`) regardless. Zod adds an extra translation step.

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Ajv error messages are hard to read for non-experts debugging pipeline failures | Medium | Low | Wrap Ajv errors in a `formatValidationError()` helper that produces human-readable messages with field path and expected vs. actual |
| TypeScript types drift from JSON Schema files | Medium | Medium | Use `json-schema-to-ts` to generate types from schemas in a build step; run in CI to catch drift |
| Ajv's `allErrors: true` mode has a small performance penalty | Low | Low | Acceptable for debugging; can disable in production if profiling shows it matters |

---

## Category 4: LLM SDK

### Context

Lintellect's prompt-runner (`packages/core/src/prompt-runner/`) orchestrates 4-pass LLM reviews. It must support:

- Claude via direct Anthropic API (primary, for local/CLI use)
- Claude via AWS Bedrock (for Lambda pipeline, IAM-authenticated)
- Streaming responses (for progress indicators in CLI mode)
- Structured JSON output (for downstream validation)
- Retry with exponential backoff for rate limits and transient errors
- Provider abstraction (our own `LLMProvider` interface, defined in the RFC)

### Candidates

| Tool | Scope | npm Package | Providers |
|------|-------|-------------|-----------|
| **Anthropic SDK** | First-party Claude SDK | `@anthropic-ai/sdk` | Anthropic API only |
| **AWS SDK (Bedrock)** | First-party AWS SDK | `@aws-sdk/client-bedrock-runtime` | All Bedrock models |
| **LangChain** | LLM orchestration framework | `langchain` + `@langchain/anthropic` + `@langchain/aws` | 50+ providers |
| **Vercel AI SDK** | Lightweight multi-provider SDK | `ai` + `@ai-sdk/anthropic` + `@ai-sdk/amazon-bedrock` | 20+ providers |

### Comparison Matrix

| Criterion | Weight | Anthropic SDK | AWS SDK (Bedrock) | LangChain | Vercel AI SDK |
|-----------|--------|---------------|-------------------|-----------|---------------|
| TypeScript types | 15% | **5** -- first-party TS, excellent type coverage for messages, tools, streaming events | **4** -- generated from AWS service model; complete but verbose (AWS SDK style) | **3** -- types exist but are often `any` or overly generic due to provider abstraction | **5** -- TypeScript-first, clean generic types |
| Streaming support | 15% | **5** -- native streaming with typed event handlers; `stream.on('text', ...)` | **4** -- `InvokeModelWithResponseStreamCommand` works but requires manual chunk assembly | **4** -- streaming works but abstraction layers add complexity and failure modes | **5** -- streaming-first design; `streamText()` returns async iterable |
| Retry/rate-limit handling | 15% | **4** -- built-in retry with configurable max retries; reads `retry-after` header | **3** -- no built-in retry; must wrap with middleware or custom logic | **3** -- retry exists but configuration is buried in provider-specific options | **3** -- basic retry; less mature than Anthropic SDK |
| Provider abstraction | 10% | **1** -- Anthropic only; by design | **2** -- Bedrock only; supports multiple model families through Bedrock but locked to AWS | **5** -- entire purpose is provider abstraction; supports 50+ providers | **4** -- clean provider abstraction; `@ai-sdk/{provider}` pattern |
| Bundle size | 10% | **4** -- ~80KB minified (single provider) | **3** -- ~200KB minified (AWS SDK v3 modular, but still hefty with Smithy runtime) | **1** -- 500KB+ minified with all dependencies; pulls in dozens of transitive deps | **4** -- ~60KB core + ~30KB per provider |
| API stability | 15% | **5** -- stable API; Anthropic maintains backward compatibility; versioned endpoints | **5** -- AWS SDK follows semver strictly; extremely stable | **2** -- frequent breaking changes between minor versions; migration guides needed regularly | **4** -- relatively stable but younger project; occasional breaking changes |
| Maintenance quality | 10% | **5** -- first-party, dedicated team, rapid feature adoption (new Claude features available day-one) | **5** -- first-party AWS, long-term support guaranteed | **3** -- large contributor base but quality varies; core team capacity stretched across massive surface area | **4** -- Vercel-backed; active development; smaller team but focused scope |
| Lock-in risk | 10% | **2** -- locked to Anthropic; switching providers requires rewriting integration | **3** -- locked to AWS Bedrock; but Bedrock supports multiple model families | **5** -- minimal lock-in; swap providers by changing config | **4** -- low lock-in; provider adapters are thin |
| **Weighted Score** | | **3.95** | **3.65** | **3.00** | **4.05** |

### Recommendation: Anthropic SDK + AWS SDK behind our own LLMProvider interface

**ADOPT both `@anthropic-ai/sdk` and `@aws-sdk/client-bedrock-runtime`**, wrapped behind Lintellect's own `LLMProvider` interface.

**AVOID LangChain.**

**ASSESS Vercel AI SDK** for potential v2 adoption if we add more providers.

### Architecture

```
packages/core/src/prompt-runner/
  |
  +-- types.ts              <-- LLMProvider interface definition
  |
  +-- providers/
       +-- claude-direct.ts  <-- implements LLMProvider using @anthropic-ai/sdk
       +-- bedrock.ts        <-- implements LLMProvider using @aws-sdk/client-bedrock-runtime
       +-- (future: openai.ts, gemini.ts, etc.)
```

The `LLMProvider` interface:

```typescript
// Simplified -- full definition in RFC (T-0.3)
export interface LLMProvider {
  readonly name: string;

  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;

  estimateTokens(text: string): number;
  maxContextTokens(model: string): number;
}

export interface CompletionRequest {
  model: string;
  systemPrompt: string;
  messages: Message[];
  maxTokens: number;
  temperature: number;
  responseFormat?: 'json' | 'text';
}
```

### Rationale

1. **We need exactly two providers, not fifty.** Lintellect v1 supports Claude direct (for CLI/local) and Claude via Bedrock (for Lambda). An abstraction layer for 50 providers is waste. Our own 40-line `LLMProvider` interface gives us the exact abstraction we need.

2. **First-party SDKs have the best type safety and feature coverage.** The Anthropic SDK supports Claude-specific features (tool use, JSON mode, system prompts) with first-class TypeScript types. The AWS SDK handles IAM authentication, SigV4 signing, and Bedrock-specific request formatting. No third-party wrapper matches this.

3. **LangChain is the wrong tool for Lintellect.** This is the most consequential recommendation in this document, so here is the full case:

   - **Dependency weight.** `langchain` + `@langchain/core` + `@langchain/anthropic` pulls in 40+ transitive dependencies totaling 500KB+. In a Lambda where cold start matters, this is unacceptable overhead for functionality we do not use.
   - **Abstraction mismatch.** LangChain's value is in chains, agents, tools, and retrieval. Lintellect's prompt-runner is a simple 4-pass loop: assemble prompt, call LLM, validate response, repeat. We do not need chains, agents, or tool use. Wrapping a simple loop in LangChain's LCEL (LangChain Expression Language) adds indirection without value.
   - **Version instability.** LangChain has shipped breaking changes in minor versions repeatedly. In a 6-day sprint, debugging LangChain version conflicts is time we cannot afford.
   - **Debugging opacity.** When an LLM call fails inside a LangChain chain, the stack trace passes through multiple abstraction layers before reaching the actual HTTP call. With the direct SDKs, the failure is one frame from the HTTP response.
   - **The initial architecture document recommended LangChain.** That recommendation was made before the pipeline design was finalized. Now that we know the pipeline is a simple sequential 4-pass loop (not a complex agent graph), LangChain's complexity is not justified.

4. **Vercel AI SDK is promising but premature for server-side Lambda use.** Its streaming-first design and clean TypeScript API are excellent. But its primary use case is Next.js server components and edge functions. The Bedrock provider (`@ai-sdk/amazon-bedrock`) is less mature than the first-party AWS SDK. Worth reassessing in v2 if we add OpenAI or Gemini support.

5. **Our own interface is 40 lines, not a framework.** The `LLMProvider` interface defined above is trivial to implement. Each concrete provider is ~100 lines of code wrapping the respective SDK. The total implementation cost is 2-3 hours. A framework would save no time and add coupling.

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Maintaining two SDK integrations doubles the surface area for bugs | Medium | Medium | Shared test suite: both providers run against the same `LLMProvider` contract tests with identical inputs and expected output shapes |
| Anthropic SDK and Bedrock SDK have subtly different behaviors for the same model | Medium | Medium | Document known differences (e.g., token counting, stop sequences); integration tests catch behavioral drift |
| Adding a third provider later requires more custom integration code | Low | Low | The `LLMProvider` interface is stable; adding a provider is ~100 lines; Vercel AI SDK can be adopted in v2 if provider count exceeds 3 |
| Team members familiar with LangChain may resist this recommendation | Low | Low | The recommendation includes specific technical justification; the prototype will demonstrate that direct SDK usage is simpler |

---

## Category 5: Infrastructure as Code

### Context

Lintellect's AWS infrastructure includes: API Gateway, Lambda functions (6+), SQS queues, Step Functions state machine, S3 bucket, DynamoDB table, IAM roles, CloudWatch log groups, and Secrets Manager secrets. The IaC tool must support all of these as first-class constructs, ideally in TypeScript to match the application code.

Step Functions is the critical discriminator. The state machine definition (T-2.3) is the most complex IaC artifact, and the tool's Step Functions support quality directly affects development velocity.

### Candidates

| Tool | Language | AWS Coverage | npm Package |
|------|----------|-------------|-------------|
| **AWS CDK** | TypeScript/Python/Java/C#/Go | Complete (first-party) | `aws-cdk-lib` |
| **SST (Ion)** | TypeScript | Near-complete (built on Pulumi) | `sst` |
| **Serverless Framework** | YAML + plugins | Lambda-centric; other services via CloudFormation | `serverless` |
| **Terraform** | HCL | Complete (via AWS provider) | N/A (CLI tool) |

### Comparison Matrix

| Criterion | Weight | AWS CDK | SST (Ion) | Serverless Framework | Terraform |
|-----------|--------|---------|-----------|---------------------|-----------|
| Step Functions support | 25% | **5** -- `aws-cdk-lib/aws-stepfunctions` provides typed state machine constructs; `tasks` submodule has Lambda, SQS, DynamoDB integrations; ASL definition from code | **4** -- supports Step Functions via underlying Pulumi AWS provider; less ergonomic than CDK's typed constructs | **2** -- `serverless-step-functions` plugin exists but is community-maintained; YAML-based ASL is error-prone; limited type safety | **3** -- `aws_sfn_state_machine` resource supports ASL JSON; no typed constructs; state machine is a string blob |
| TypeScript constructs | 20% | **5** -- native TypeScript; constructs are classes with typed props; full IDE autocomplete | **5** -- native TypeScript; `sst.aws.Function`, `sst.aws.Queue`, etc. | **1** -- YAML configuration; TypeScript only for Lambda handlers, not infrastructure | **1** -- HCL, not TypeScript; CDK-for-Terraform (cdktf) exists but adds complexity |
| Local development experience | 15% | **3** -- `cdk synth` + `sam local invoke` for Lambda testing; no live reload; `cdk watch` for iterative deploys | **5** -- `sst dev` provides live Lambda development with instant reload; best-in-class local DX | **3** -- `serverless offline` plugin for local API Gateway/Lambda; works but limited | **2** -- `terraform plan` is fast; no local Lambda execution; relies on external tools |
| Deployment speed | 10% | **3** -- CloudFormation deployments can be slow (2-5 minutes for updates); `cdk deploy --hotswap` helps for Lambda code changes | **4** -- Ion (Pulumi-based) deploys faster than CloudFormation; ~30-60 seconds for code changes | **3** -- CloudFormation-based; similar speed to CDK | **4** -- Terraform apply is generally faster than CloudFormation for small changes |
| Community and ecosystem | 10% | **5** -- massive community; Construct Hub has 1500+ published constructs; extensive AWS documentation | **3** -- growing community; smaller than CDK; documentation improving but gaps exist | **4** -- huge community; extensive plugin ecosystem; long track record | **5** -- largest IaC community overall; extensive provider ecosystem |
| Learning curve | 10% | **3** -- moderate learning curve; CloudFormation concepts required; construct levels (L1/L2/L3) add complexity | **4** -- simpler API than CDK; less boilerplate; but Ion (Pulumi) migration adds learning overhead | **4** -- simple YAML for basic cases; complexity rises with plugins and CloudFormation extensions | **3** -- HCL is straightforward; state management adds learning curve |
| Lambda bundling | 10% | **4** -- `NodejsFunction` construct uses esbuild for bundling; handles tree-shaking, external modules, and layers | **5** -- built-in bundling with esbuild; automatic optimization; zero config for most cases | **3** -- requires `serverless-esbuild` or `serverless-webpack` plugin; works but additional config | **2** -- no built-in bundling; requires external tooling (webpack, esbuild) orchestrated separately |
| **Weighted Score** | | **4.15** | **4.25** | **2.45** | **2.70** |

### Recommendation: AWS CDK

**ADOPT AWS CDK** -- Despite SST Ion scoring marginally higher in the weighted matrix, CDK is the recommendation for Lintellect v1.

### Why CDK over SST Ion (despite the scores)?

The comparison matrix shows SST Ion with a 0.10 advantage. That advantage comes entirely from local development experience (+2 on a 15% criterion). Here is why CDK is still the right choice:

1. **SST Ion is in active migration.** SST is transitioning from CDK-based (SST v2) to Pulumi-based (SST Ion/v3). This means the community is split, documentation references two different architectures, and the new version is still stabilizing. Starting a production pipeline on a tool mid-migration violates the 6-day sprint constraint.

2. **Step Functions is the critical construct.** CDK's `aws-stepfunctions` module is the best Step Functions authoring experience available. The typed state machine constructs catch errors at compile time:

   ```typescript
   const parseDiff = new tasks.LambdaInvoke(this, 'ParseDiff', {
     lambdaFunction: diffWorkerFn,
     resultPath: '$.diffResult',
     retryOnServiceExceptions: true,
   });

   const definition = validateInput
     .next(buildPacket)
     .next(parseDiff)
     .next(gatherContext)
     .next(runReview)
     .next(evidenceGate)
     .next(postComment);

   new sfn.StateMachine(this, 'ReviewPipeline', {
     definitionBody: sfn.DefinitionBody.fromChainable(definition),
     timeout: Duration.minutes(15),
   });
   ```

   SST Ion has no equivalent typed Step Functions API. You would write raw ASL JSON, which is what Terraform also requires.

3. **CDK's `NodejsFunction` handles our bundling needs.** It uses esbuild under the hood, supports external modules (for WASM files that should not be bundled), and produces optimized Lambda deployment packages. This is critical for bundling `web-tree-sitter` grammars correctly.

4. **CDK is a safe long-term bet.** It is first-party AWS, backed by a dedicated team, and is the recommended IaC tool in AWS documentation. SST Ion may become excellent, but it is not there yet.

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CloudFormation deployment speed is slow during iteration | High | Medium | Use `cdk deploy --hotswap` for Lambda code changes during development; reserve full deploys for infrastructure changes |
| CDK abstractions hide CloudFormation complexity until something breaks | Medium | Medium | Review synthesized CloudFormation template (`cdk synth`) regularly; understand what CDK generates |
| CDK version updates occasionally introduce breaking changes in construct behavior | Low | Medium | Pin `aws-cdk-lib` version in `package.json`; update deliberately with changelog review |
| Local development experience is weaker than SST | High | Low | Use `sam local invoke` for Lambda testing; unit tests cover core logic without AWS; integration tests use LocalStack or mocked AWS SDK |

---

## Category 6: Testing Framework

### Context

Lintellect is an ESM-first TypeScript monorepo. Tests cover:

- Unit tests for every module in `packages/core/src/`
- Golden packet fixtures (known input -> expected output)
- Evidence gate adversarial tests
- Schema validation tests
- Integration tests for Lambda handlers (mocked AWS services)
- Minimum 80% line coverage for `packages/core`

The testing framework must handle ESM imports, TypeScript without a separate compilation step, fast watch mode for development, and reliable mocking.

### Candidates

| Tool | Engine | ESM Support | npm Package |
|------|--------|-------------|-------------|
| **Vitest** | Vite (esbuild) | Native | `vitest` |
| **Jest** | Custom transform pipeline | Experimental (`--experimental-vm-modules`) | `jest` + `ts-jest` or `@swc/jest` |

Note: `node:test` (Node.js built-in) is a third option but lacks the assertion library, mocking framework, and coverage tooling maturity needed for a project of this complexity. It is excluded from detailed evaluation.

### Comparison Matrix

| Criterion | Weight | Vitest | Jest |
|-----------|--------|--------|------|
| Speed | 20% | **5** -- Vite-powered; uses esbuild for TypeScript transform; 2-5x faster than Jest on typical suites; worker-based parallelism | **3** -- `ts-jest` uses `tsc` (slow); `@swc/jest` is faster but still slower than esbuild; parallelism via worker threads |
| TypeScript support | 20% | **5** -- native TypeScript via esbuild; zero config; `import type` works correctly | **3** -- requires `ts-jest` or `@swc/jest` transform; configuration overhead; occasional type-stripping edge cases |
| ESM compatibility | 20% | **5** -- native ESM; imports, dynamic imports, and top-level await work without flags or workarounds | **2** -- ESM support requires `--experimental-vm-modules` flag; numerous edge cases with named exports, mocking, and interop; frequently the source of hard-to-debug test failures |
| Watch mode | 10% | **5** -- instant HMR-based watch mode; only re-runs affected tests; sub-second feedback | **4** -- watch mode works but slower to detect changes and re-run; file-system based, not HMR |
| Assertion library | 5% | **5** -- built-in `expect` API compatible with Jest; `chai` assertions also available; `expect.soft()` for non-halting assertions | **5** -- `expect` is the industry standard; extensive matcher library |
| Mocking | 10% | **4** -- `vi.mock()`, `vi.spyOn()`, `vi.fn()`; API mirrors Jest; auto-mocking less mature than Jest | **5** -- `jest.mock()` is the gold standard; auto-mocking, manual mocks in `__mocks__/`, well-documented patterns |
| Coverage | 5% | **5** -- built-in `v8` coverage (fast, accurate); also supports `istanbul`; `--coverage` flag | **4** -- `istanbul` coverage via `--coverage` flag; works but slower; `v8` coverage requires additional config |
| Community/ecosystem | 5% | **4** -- rapidly growing; most new TypeScript projects adopt Vitest; extensive plugin ecosystem | **5** -- largest test framework community; massive plugin ecosystem; more Stack Overflow answers |
| Snapshot testing | 5% | **5** -- built-in snapshot testing; inline snapshots; snapshot serializers | **5** -- pioneered snapshot testing; extensive serializer ecosystem |
| **Weighted Score** | | **4.80** | **3.45** |

### Recommendation: Vitest

**ADOPT Vitest** -- It is the clear winner for an ESM-first TypeScript project.

### Configuration

```typescript
// vitest.config.ts (root)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
```

### Rationale

1. **ESM is non-negotiable, and Jest's ESM support is still broken.** Lintellect is ESM-first (`"type": "module"` in `package.json`). Jest's ESM support has been experimental for 3+ years and still produces cryptic failures with named imports, `vi.mock()` hoisting, and dynamic imports. Vitest was built for ESM from day one.

2. **TypeScript without transform friction.** Vitest uses esbuild to strip types, which means TypeScript files are processed in milliseconds without a separate compilation step. Jest requires either `ts-jest` (slow, uses `tsc`) or `@swc/jest` (faster but still a separate dependency with its own configuration).

3. **Speed matters for developer experience.** In a 6-day sprint, the test suite runs hundreds of times. Vitest's 2-5x speed advantage over Jest compounds into hours saved. The HMR-based watch mode provides sub-second feedback, which keeps developers in flow.

4. **Jest compatibility means low learning curve.** Vitest's API (`describe`, `it`, `expect`, `vi.mock`, `vi.fn`) mirrors Jest almost exactly. Developers familiar with Jest can write Vitest tests without learning a new API. Migration from Jest is a configuration change, not a rewrite.

5. **Built-in v8 coverage is faster and more accurate.** V8's native coverage instrumentation avoids the overhead of Istanbul's code transformation. Coverage runs are nearly as fast as regular test runs.

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Vitest mocking is less mature than Jest for complex module mocking patterns | Medium | Low | Most Lintellect tests mock external APIs (HTTP calls, AWS SDK); these are straightforward `vi.mock()` patterns; complex auto-mocking is rarely needed |
| Some team members may be unfamiliar with Vitest | Low | Low | API is 95% identical to Jest; 30-minute onboarding; Vitest docs are excellent |
| Vitest ecosystem has fewer plugins than Jest | Low | Low | Core functionality (assertions, mocking, coverage, snapshots) is built-in; we do not need third-party test plugins |

---

## Category 7: Vector Database (Optional)

### Context

The initial architecture document (pre-sprint) included a vector database for semantic code search as part of the context-gatherer. The intent was to embed code snippets and retrieve semantically similar code when building context for the LLM review.

This evaluation asks: **do we need this for v1?**

### Candidates

| Tool | Type | Hosting | npm Package |
|------|------|---------|-------------|
| **pgvector** | PostgreSQL extension | Self-managed (RDS/Aurora) | `pg` + `pgvector` |
| **Pinecone** | Managed vector database | SaaS | `@pinecone-database/pinecone` |
| **ChromaDB** | Lightweight vector store | Self-hosted (requires persistent process) | `chromadb` |
| **None for v1** | N/A | N/A | N/A |

### Comparison Matrix

| Criterion | Weight | pgvector | Pinecone | ChromaDB | None for v1 |
|-----------|--------|----------|----------|----------|-------------|
| Operational complexity | 25% | **2** -- requires RDS/Aurora instance; VPC configuration; backup management; ongoing maintenance | **4** -- fully managed; no infrastructure to maintain | **2** -- requires persistent process (EC2/ECS); not Lambda-compatible without a dedicated service | **5** -- zero operational burden |
| Cost (at Lintellect scale) | 20% | **2** -- RDS db.t3.micro ~$15/mo minimum; Aurora higher; cost continues even when idle | **3** -- free tier (100K vectors); starter plan ~$70/mo; predictable but adds to monthly bill | **3** -- compute cost for hosting; free software | **5** -- $0 |
| Lambda compatibility | 20% | **3** -- requires VPC-attached Lambda; adds cold start latency (VPC NAT); connection pooling complexity | **5** -- HTTP API; no VPC needed; works from any Lambda | **1** -- requires running server; Lambda cannot host it; needs sidecar service | **5** -- N/A |
| Setup effort | 15% | **2** -- RDS provisioning, schema migration, embedding pipeline, index tuning | **3** -- quick API setup; still need embedding pipeline and ingestion logic | **2** -- Docker setup; embedding pipeline; less documentation | **5** -- zero effort |
| Query performance | 10% | **4** -- pgvector HNSW index is fast; exact results; SQL flexibility | **5** -- optimized for vector search; consistent low latency | **4** -- adequate for small-medium datasets | **1** -- no semantic search capability |
| Value for v1 MVP | 10% | **2** -- powerful but over-engineered for v1 | **2** -- capable but adds SaaS dependency for unproven feature | **2** -- lightweight but operational overhead remains | **5** -- focuses effort on proven-value features |
| **Weighted Score** | | **2.50** | **3.55** | **2.15** | **4.50** |

### Recommendation: None for v1

**DEFER to v2.** Do not implement vector database or semantic code search in v1.

### Rationale

1. **The context-gatherer can solve the problem without vectors.** The context-gatherer (T-1.3) needs to find code related to the changed files. For v1, this is achievable through:
   - **Import/export graph analysis:** Parse `import` and `require` statements to find directly related files.
   - **Type definition resolution:** Follow TypeScript `import type` and Go `import` statements to find type definitions.
   - **Keyword matching:** Search for function/class names from the diff in other files.
   - **Git blame/log:** Find recently modified related files.

   These deterministic methods are cheaper, faster, more debuggable, and more predictable than semantic search. They also do not require an embedding model or vector store.

2. **Semantic search is unproven value for code review.** We do not yet know whether semantic code retrieval improves review quality. Adding a vector database before validating this hypothesis means we might build and maintain infrastructure for a feature that does not improve outcomes. Build the simple version first, measure review quality, then decide if semantic search would help.

3. **The cost of deferral is low.** The `LLMProvider` interface and context-gatherer module are designed to be extended. Adding a vector database in v2 requires:
   - An embedding pipeline (new Lambda + S3 trigger)
   - A vector store client (Pinecone SDK or pgvector)
   - A context-gatherer plugin that queries the vector store

   None of these require rearchitecting v1. The plugin boundary is clean.

4. **The cost of premature adoption is high.** Any vector database adds: infrastructure to provision and maintain, an embedding pipeline to build and monitor, costs that accrue whether the feature is used or not, and another failure mode in the pipeline. In a 6-day sprint, this is 1-2 days of effort for unproven value.

### What changes in v2?

If review quality metrics (collected from user feedback in v1) indicate that the LLM is missing relevant context that deterministic methods cannot find, then:

- **Pinecone** is the leading candidate for v2 due to zero operational overhead and Lambda compatibility.
- **pgvector** is the alternative if we already have an Aurora instance for other features (e.g., a dashboard backend).
- **ChromaDB** remains non-viable for Lambda-based architectures.

### Risks of Deferral

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Context-gatherer misses semantically related code that import analysis does not find | Medium | Medium | LLM review quality will expose this gap; collect examples of "missed context" in v1; these become the requirements for v2 semantic search |
| Competitors ship semantic code search first | Low | Low | Semantic search is a feature differentiator only if it measurably improves review quality; ship v1 fast, iterate |
| Retrofitting vector search into v2 requires context-gatherer refactoring | Low | Low | Context-gatherer uses a plugin/strategy pattern; adding a vector source is additive, not a rewrite |

---

## Final Summary

| Category | Recommended | Runner-up | Rationale |
|----------|-------------|-----------|-----------|
| **Diff Parsing** | `parse-diff` (npm) + GitHub API raw diff | native git diff + custom parser | Structured JS objects out of the box; zero native deps; 15KB bundle; AST awareness handled separately by tree-sitter |
| **AST Parsing** | `web-tree-sitter` (WASM) | `node-tree-sitter` (native) | Lambda portability without native compilation; same grammar ecosystem; WASM overhead (2-3x) is negligible vs. LLM call latency |
| **JSON Schema Validation** | `ajv` (runtime) + `@sinclair/typebox` (schema authoring trial) | `zod` (if we were code-first) | Schema-first architecture demands JSON Schema native tooling; Ajv is fastest, fully draft-07 compliant, and consumes our existing `.json` schema files directly |
| **LLM SDK** | `@anthropic-ai/sdk` + `@aws-sdk/client-bedrock-runtime` behind own `LLMProvider` interface | Vercel AI SDK (`ai`) | Two first-party SDKs give best type safety and feature coverage for our two providers; own interface adds clean abstraction without LangChain's 500KB+ dependency weight |
| **Infrastructure as Code** | AWS CDK (`aws-cdk-lib`) | SST Ion | Best-in-class Step Functions typed constructs; first-party AWS support; SST Ion is mid-migration and too volatile for production pipeline in a 6-day sprint |
| **Testing Framework** | Vitest | Jest | Native ESM + TypeScript; 2-5x faster; Jest-compatible API; ESM is non-negotiable and Jest's ESM support is still experimental |
| **Vector Database** | None for v1 | Pinecone (v2 candidate) | Unproven value; deterministic context gathering (import graph, keyword matching) sufficient for v1; defer to v2 after measuring review quality |

### Divergences from Initial Architecture Document

The initial architecture document (`AI-Powered Code Review System_ Architecture and Technology Stack.md`) made several technology choices that this evaluation overrides:

| Original Choice | This Evaluation | Reason |
|----------------|-----------------|--------|
| Difftastic for diffing | `parse-diff` + tree-sitter separately | Difftastic is a visual tool, not a structured data pipeline component; separating diff parsing from AST analysis gives us structured output and better control |
| LangChain for LLM orchestration | Direct Anthropic SDK + AWS SDK | LangChain's abstraction weight (500KB+, version churn, debugging opacity) is not justified for a simple 4-pass sequential review loop |
| Pinecone for vector search | None for v1 | Unproven value; adds operational complexity and cost; deterministic context gathering is sufficient for MVP |
| Serverless Framework for deployment | AWS CDK | CDK has first-class Step Functions support in TypeScript; Serverless Framework's Step Functions plugin is community-maintained YAML |
| Jest for testing | Vitest | ESM-first project requires ESM-native test framework; Jest's ESM support is still experimental and unreliable |

These divergences are intentional and reflect the shift from a general architecture sketch to a production-grade sprint plan with concrete constraints (Lambda compatibility, 6-day sprints, ESM-first TypeScript).

---

## Appendix: Decision Log

| Date | Decision | Alternatives Considered | Deciding Factor |
|------|----------|------------------------|-----------------|
| 2026-02-07 | Use `parse-diff` for structured diff parsing | difftastic, diff-so-fancy, custom parser | Need structured JS objects, not visual output; zero native deps for Lambda |
| 2026-02-07 | Use `web-tree-sitter` for AST analysis | `node-tree-sitter`, regex-based extraction | Lambda portability: WASM runs anywhere without native compilation |
| 2026-02-07 | Use Ajv for JSON Schema validation | Zod, TypeBox, Joi | Schema-first architecture: schemas exist as JSON files; Ajv consumes them natively and is fastest |
| 2026-02-07 | Use Anthropic SDK + AWS SDK directly | LangChain, Vercel AI SDK | Two providers, two first-party SDKs; 40-line own interface vs. 500KB framework |
| 2026-02-07 | Use AWS CDK for IaC | SST Ion, Serverless Framework, Terraform | Best Step Functions constructs; first-party; SST Ion too volatile mid-migration |
| 2026-02-07 | Use Vitest for testing | Jest, node:test | ESM-native; 2-5x faster; Jest-compatible API eliminates learning curve |
| 2026-02-07 | Defer vector database to v2 | Pinecone, pgvector, ChromaDB | Unproven value; deterministic context gathering sufficient for MVP |

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-02-07 | 1.0.0 | tool-evaluator | Initial tooling evaluation with 7 categories |
