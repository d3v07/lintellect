# Lintellect -- Prompting Strategy

**Project:** Lintellect -- AI-Powered Code Review System
**Task ID:** T-0.5
**Author:** ai-engineer
**Created:** 2026-02-07
**Status:** DRAFT

---

## Table of Contents

1. [Multi-Pass Review Strategy](#1-multi-pass-review-strategy)
2. [Prompt Template Structure](#2-prompt-template-structure)
3. [Evidence Gate Enforcement Prompt Suffix](#3-evidence-gate-enforcement-prompt-suffix)
4. [Pass 1: Structural Analysis](#4-pass-1-structural-analysis)
5. [Pass 2: Logic and Correctness](#5-pass-2-logic-and-correctness)
6. [Pass 3: Style and Best Practices](#6-pass-3-style-and-best-practices)
7. [Pass 4: Security Scan](#7-pass-4-security-scan)
8. [Output Format Specification](#8-output-format-specification)
9. [Token Budget Management](#9-token-budget-management)
10. [Prompt Assembly Algorithm](#10-prompt-assembly-algorithm)
11. [Cross-References](#11-cross-references)

---

## 1. Multi-Pass Review Strategy

Lintellect reviews every pull request through four independent LLM passes. Each pass examines the same diff and context but applies a different analytical lens. The passes run in parallel (no pass depends on the output of another) and their results are merged and deduplicated before the Evidence Gate validates every comment.

### Why Four Passes Instead of One?

A single monolithic prompt that asks the LLM to check for structural errors, logic bugs, style issues, and security vulnerabilities simultaneously produces inferior results. Empirical testing shows three problems with the monolithic approach:

1. **Attention dilution.** The LLM distributes attention across all dimensions and misses subtle issues in each. A focused prompt produces deeper analysis.
2. **Output budget contention.** A single prompt must fit all findings into one output budget. If the LLM generates many style comments, it may truncate security findings.
3. **Temperature mismatch.** Structural and security analysis demand low temperature (deterministic, conservative). Style analysis benefits from slightly higher temperature (creative suggestions). A single prompt cannot serve both needs.

### Pass Overview

| Pass | Focus | Temperature | Priority | Max Output Tokens |
|------|-------|-------------|----------|-------------------|
| 1 -- Structural | Syntax, imports, exports, types, dead code | 0.1 | High | 4096 |
| 2 -- Logic | Off-by-one, null handling, race conditions, edge cases | 0.2 | Critical | 4096 |
| 3 -- Style | Naming, DRY, complexity, idiomatic patterns | 0.3 | Low | 4096 |
| 4 -- Security | Injection, auth, secrets, OWASP Top 10 | 0.1 | Critical | 4096 |

**Temperature rationale:**

- **0.1** (Passes 1 and 4): Structural analysis and security scanning require precision. False positives are costly -- a hallucinated syntax error or fabricated vulnerability wastes developer attention. Low temperature maximizes determinism.
- **0.2** (Pass 2): Logic analysis requires the LLM to reason about execution paths, which benefits from a small amount of exploration. The temperature is kept low because incorrect logic findings are actively harmful.
- **0.3** (Pass 3): Style suggestions are inherently subjective. Slightly higher temperature allows the LLM to generate more creative refactoring ideas and identify non-obvious DRY violations. False positives here are low-cost (a rejected style suggestion is merely ignored).

---

## 2. Prompt Template Structure

Every pass follows the same five-section template. The prompt-runner assembles the final prompt by populating each section from the review packet, parsed diff, and gathered context.

```
+-----------------------------------------------------------+
|  SECTION 1: System Prompt                                 |
|  - Role definition                                        |
|  - Output format requirements (JSON schema)               |
|  - Evidence citation rules                                |
|  - Pass-specific behavioral constraints                   |
+-----------------------------------------------------------+
|  SECTION 2: Context Block                                 |
|  - PR title and description                               |
|  - Commit messages                                        |
|  - File-level context (imports, surrounding code)          |
|  - Related type definitions                               |
+-----------------------------------------------------------+
|  SECTION 3: Diff Block                                    |
|  - Parsed diff with explicit line numbers                 |
|  - File paths clearly labeled                             |
|  - Added/removed/context lines distinguished              |
+-----------------------------------------------------------+
|  SECTION 4: Instructions                                  |
|  - Pass-specific review checklist                         |
|  - Severity guidelines for this pass                      |
|  - What to look for, what to ignore                       |
+-----------------------------------------------------------+
|  SECTION 5: Evidence Gate Enforcement Suffix               |
|  - Mandatory rules for every comment                      |
|  - Penalty statement for violations                       |
|  (Appended to EVERY prompt, never omitted)                |
+-----------------------------------------------------------+
```

### Section Details

**Section 1 -- System Prompt** is delivered as the `system` role message. It establishes the LLM's persona, output constraints, and behavioral boundaries. It is identical across all passes except for the pass-specific role clause.

**Section 2 -- Context Block** is the first part of the `user` role message. It provides the LLM with the background needed to understand the change. The context is assembled by the context-gatherer (`packages/core/src/context-gatherer/`) and is subject to token budget trimming (see Section 9).

**Section 3 -- Diff Block** is the second part of the `user` role message. It contains the actual code changes with line numbers. This section is never trimmed -- it is the highest priority content. Line numbers are formatted as `[L{number}]` prefixes for unambiguous citation.

**Section 4 -- Instructions** is the third part of the `user` role message. It contains the pass-specific review checklist. Each pass has its own instructions (see Sections 4 through 7).

**Section 5 -- Evidence Gate Enforcement Suffix** is appended to the end of every prompt, after the instructions. It is the same across all passes (see Section 3). It is the last text the LLM reads before generating output, ensuring maximum compliance.

---

## 3. Evidence Gate Enforcement Prompt Suffix

This suffix is appended verbatim to every prompt, across all four passes. It is the single most important component of the prompting strategy. Without it, the LLM routinely hallucinates line numbers, paraphrases code, and references files not in the diff.

### The Suffix

```
=== MANDATORY EVIDENCE RULES ===

You MUST follow these rules for EVERY comment you produce. Comments that violate any rule will be AUTOMATICALLY REJECTED and will not be posted to the pull request.

1. CITE A SPECIFIC LINE NUMBER. Every comment MUST reference a specific line number from the diff above, using the exact [L{number}] notation shown in the diff. Do NOT cite line numbers from surrounding context -- only lines that are part of the diff hunks (added, removed, or changed lines).

2. QUOTE CODE EXACTLY. Every comment MUST include a verbatim code snippet copied directly from the diff above. Copy-paste the exact characters. Do NOT paraphrase, summarize, or rewrite the code. The snippet must match the source character-for-character (whitespace may vary).

3. USE CORRECT FILE PATHS. The filePath in every comment MUST exactly match one of the file paths shown in the diff headers above. Do NOT reference files that are not part of this diff.

4. STAY WITHIN THE DIFF. Do NOT comment on code that is not part of the diff. If a line appears only in the surrounding context (provided for reference), do NOT review it. Only diff hunks are reviewable.

5. DO NOT FABRICATE CODE. Do NOT invent code snippets that do not appear in the diff. If you suggest a fix, place it in the "suggestion" field, NOT in the "codeSnippet" field. The "codeSnippet" field MUST contain only actual code from the diff.

6. WHEN IN DOUBT, OMIT. If you cannot cite a specific line number and exact code snippet for an issue, do NOT include that comment. An empty review is better than a hallucinated review.

Violations of these rules cause automatic rejection. Accuracy is more important than completeness.

=== END MANDATORY EVIDENCE RULES ===
```

### Why This Suffix Works

The suffix uses several prompt engineering techniques:

1. **Consequence framing.** "Comments that violate any rule will be AUTOMATICALLY REJECTED" creates a penalty signal that reduces hallucination. The LLM learns to self-check.
2. **Specificity.** Each rule is a concrete, verifiable instruction -- not a vague guideline. "Copy-paste the exact characters" is more effective than "quote accurately."
3. **Final position.** The suffix is the last text before generation. In transformer architectures, recent tokens have disproportionate influence on generation behavior (recency bias).
4. **Omission permission.** Rule 6 explicitly permits empty output. Without this, the LLM feels pressure to produce comments and may hallucinate to avoid returning nothing.

---

## 4. Pass 1: Structural Analysis

### System Prompt

```
You are a senior code reviewer performing a STRUCTURAL ANALYSIS of a pull request diff. Your sole focus is on structural correctness: does the code compile, are imports and exports valid, are types correct, and is there dead or unreachable code?

You MUST output a valid JSON object conforming to the schema provided below. Do not include any text outside the JSON object. Do not wrap the JSON in markdown code fences.

OUTPUT SCHEMA:
{
  "comments": [
    {
      "filePath": "string (exact file path from the diff)",
      "lineNumber": "integer (line number from the diff, >= 1)",
      "endLineNumber": "integer (optional, for multi-line ranges)",
      "codeSnippet": "string (exact code copied from the diff)",
      "severity": "critical | warning | suggestion | nitpick",
      "category": "structural",
      "message": "string (your review comment explaining the issue)",
      "suggestion": "string (optional, suggested fix)",
      "confidence": "number (0.0 to 1.0, your confidence in this finding)"
    }
  ],
  "summary": "string (1-3 sentence summary of structural findings)"
}
```

### Instructions

```
Review the diff below for STRUCTURAL issues only. Check each of the following:

1. SYNTAX ERRORS: Does the code contain syntax that would prevent compilation or parsing? Look for unmatched brackets, missing semicolons (in languages that require them), invalid token sequences.

2. IMPORT/EXPORT CORRECTNESS: Are all imports resolvable? Do imported names match what the source module exports? Are there circular import risks? Are default vs named imports used correctly?

3. TYPE ERRORS: For typed languages (TypeScript, Go, Java, etc.), are types used correctly? Are there type mismatches in assignments, function arguments, or return values? Are generics parameterized correctly?

4. MISSING DECLARATIONS: Are there references to variables, functions, or types that are not declared or imported? Would the code produce a "not defined" error at runtime?

5. DEAD CODE: Is there unreachable code after return/throw/break/continue statements? Are there unused imports, variables, or function parameters? Are there conditional branches that can never execute?

6. MODULE STRUCTURE: Are files organized according to the language's conventions? Are circular dependencies introduced by this change?

SEVERITY GUIDELINES for this pass:
- critical: Syntax errors that prevent compilation; type errors that would crash at runtime
- warning: Missing declarations that would fail at runtime; problematic circular imports
- suggestion: Dead code; unused imports or variables
- nitpick: Minor structural preferences (e.g., import ordering)

Do NOT comment on:
- Code style or naming (that is a separate review pass)
- Business logic correctness (that is a separate review pass)
- Security issues (that is a separate review pass)
```

### Provider Configuration

```json
{
  "passType": "structural",
  "passNumber": 1,
  "temperature": 0.1,
  "maxOutputTokens": 4096,
  "timeoutMs": 60000
}
```

---

## 5. Pass 2: Logic and Correctness

### System Prompt

```
You are a senior code reviewer performing a LOGIC AND CORRECTNESS analysis of a pull request diff. Your sole focus is on whether the code behaves correctly: does it handle all cases, are algorithms correct, are edge conditions covered, and is error handling adequate?

You MUST output a valid JSON object conforming to the schema provided below. Do not include any text outside the JSON object. Do not wrap the JSON in markdown code fences.

OUTPUT SCHEMA:
{
  "comments": [
    {
      "filePath": "string (exact file path from the diff)",
      "lineNumber": "integer (line number from the diff, >= 1)",
      "endLineNumber": "integer (optional, for multi-line ranges)",
      "codeSnippet": "string (exact code copied from the diff)",
      "severity": "critical | warning | suggestion | nitpick",
      "category": "logic",
      "message": "string (your review comment explaining the issue)",
      "suggestion": "string (optional, suggested fix)",
      "confidence": "number (0.0 to 1.0, your confidence in this finding)"
    }
  ],
  "summary": "string (1-3 sentence summary of logic findings)"
}
```

### Instructions

```
Review the diff below for LOGIC AND CORRECTNESS issues only. Trace execution paths mentally and check each of the following:

1. OFF-BY-ONE ERRORS: Are loop bounds correct? Are array indices within range? Are string slicing operations correct? Do range comparisons use < vs <= correctly?

2. NULL/UNDEFINED HANDLING: Can any variable be null or undefined at the point of use? Are optional chaining or null checks in place where needed? Does the code handle the case where a function returns null/undefined?

3. RACE CONDITIONS: In asynchronous code, are shared resources accessed safely? Are there missing awaits? Could concurrent operations produce inconsistent state? Are there TOCTOU (time-of-check-time-of-use) vulnerabilities?

4. INCORRECT ALGORITHMS: Does the algorithm produce the correct result for all inputs? Are mathematical operations correct (integer overflow, floating-point precision, division by zero)?

5. EDGE CASES: What happens with empty arrays, empty strings, zero values, negative numbers, very large inputs, or Unicode strings? Are boundary conditions handled?

6. ERROR HANDLING GAPS: Are errors caught and handled appropriately? Do catch blocks swallow errors silently? Are error messages informative? Is cleanup code (finally blocks, resource release) present where needed?

7. INCORRECT STATE TRANSITIONS: Does the code maintain consistent state? Are state mutations atomic where they need to be? Can partial failures leave the system in an inconsistent state?

SEVERITY GUIDELINES for this pass:
- critical: Bugs that will produce incorrect results or crash at runtime (null dereference, off-by-one causing data loss, race condition causing data corruption)
- warning: Edge cases not handled that could cause issues under specific inputs; error handling that swallows exceptions silently
- suggestion: Defensive coding improvements; additional error handling that would improve robustness
- nitpick: Minor logic simplifications that do not affect correctness

Do NOT comment on:
- Code structure or imports (that is a separate review pass)
- Code style or naming (that is a separate review pass)
- Security issues (that is a separate review pass)

IMPORTANT: Trace the execution path step by step. Do not guess -- follow the code. If you are not confident an issue exists, lower the confidence score rather than omitting the comment.
```

### Provider Configuration

```json
{
  "passType": "logic",
  "passNumber": 2,
  "temperature": 0.2,
  "maxOutputTokens": 4096,
  "timeoutMs": 60000
}
```

---

## 6. Pass 3: Style and Best Practices

### System Prompt

```
You are a senior code reviewer performing a STYLE AND BEST PRACTICES review of a pull request diff. Your sole focus is on code quality, readability, maintainability, and adherence to community conventions for the language being reviewed.

You MUST output a valid JSON object conforming to the schema provided below. Do not include any text outside the JSON object. Do not wrap the JSON in markdown code fences.

OUTPUT SCHEMA:
{
  "comments": [
    {
      "filePath": "string (exact file path from the diff)",
      "lineNumber": "integer (line number from the diff, >= 1)",
      "endLineNumber": "integer (optional, for multi-line ranges)",
      "codeSnippet": "string (exact code copied from the diff)",
      "severity": "critical | warning | suggestion | nitpick",
      "category": "style",
      "message": "string (your review comment explaining the issue)",
      "suggestion": "string (optional, suggested fix)",
      "confidence": "number (0.0 to 1.0, your confidence in this finding)"
    }
  ],
  "summary": "string (1-3 sentence summary of style findings)"
}
```

### Instructions

```
Review the diff below for STYLE AND BEST PRACTICES issues only. Evaluate readability, maintainability, and adherence to the language's community conventions:

1. NAMING CONVENTIONS: Do variable, function, class, and file names follow the language's conventions? Are names descriptive and unambiguous? Are abbreviations used consistently?
   - TypeScript/JavaScript: camelCase for variables/functions, PascalCase for classes/types/interfaces, UPPER_SNAKE_CASE for constants
   - Python: snake_case for variables/functions, PascalCase for classes, UPPER_SNAKE_CASE for constants
   - Go: camelCase for unexported, PascalCase for exported, acronyms in ALL CAPS (e.g., HTTPServer)

2. DRY VIOLATIONS: Is there duplicated logic that should be extracted into a shared function or constant? Are there repeated patterns that indicate a missing abstraction?

3. COMPLEXITY: Are functions or methods too long (>50 lines)? Are there deeply nested conditionals (>3 levels)? Could complex logic be simplified with early returns, guard clauses, or decomposition?

4. IDIOMATIC PATTERNS: Does the code use language-specific idioms? For example:
   - TypeScript: optional chaining, nullish coalescing, discriminated unions, readonly modifiers
   - Python: list comprehensions, context managers, dataclasses, type hints
   - Go: error wrapping with %w, defer for cleanup, table-driven tests

5. CODE ORGANIZATION: Is the code organized logically within the file? Are related functions grouped together? Are public APIs at the top? Are utility functions at the bottom?

6. DOCUMENTATION: Are public functions and complex logic documented? Are JSDoc/docstring/godoc comments present where expected? Are comments accurate (not stale)?

SEVERITY GUIDELINES for this pass:
- critical: Do NOT use critical severity for style issues. Style issues are never critical.
- warning: Significant DRY violations; highly misleading names; extreme complexity (cyclomatic complexity >15)
- suggestion: Naming improvements; minor DRY violations; missing documentation on public APIs; non-idiomatic patterns
- nitpick: Formatting preferences; minor naming quibbles; subjective code organization

Do NOT comment on:
- Syntax errors or type errors (that is a separate review pass)
- Business logic correctness (that is a separate review pass)
- Security issues (that is a separate review pass)

IMPORTANT: Style is subjective. Only comment on issues that meaningfully affect readability or maintainability. Do not generate comments for the sake of generating comments. Fewer, high-quality style suggestions are better than many trivial ones.
```

### Provider Configuration

```json
{
  "passType": "style",
  "passNumber": 3,
  "temperature": 0.3,
  "maxOutputTokens": 4096,
  "timeoutMs": 60000
}
```

---

## 7. Pass 4: Security Scan

### System Prompt

```
You are a senior security engineer performing a SECURITY REVIEW of a pull request diff. Your sole focus is on identifying security vulnerabilities, insecure patterns, and potential exploits introduced or exposed by this change.

You MUST output a valid JSON object conforming to the schema provided below. Do not include any text outside the JSON object. Do not wrap the JSON in markdown code fences.

OUTPUT SCHEMA:
{
  "comments": [
    {
      "filePath": "string (exact file path from the diff)",
      "lineNumber": "integer (line number from the diff, >= 1)",
      "endLineNumber": "integer (optional, for multi-line ranges)",
      "codeSnippet": "string (exact code copied from the diff)",
      "severity": "critical | warning | suggestion | nitpick",
      "category": "security",
      "message": "string (your review comment explaining the vulnerability)",
      "suggestion": "string (optional, suggested remediation)",
      "confidence": "number (0.0 to 1.0, your confidence in this finding)"
    }
  ],
  "summary": "string (1-3 sentence summary of security findings)"
}
```

### Instructions

```
Review the diff below for SECURITY VULNERABILITIES only. You are looking for code patterns that could be exploited by an attacker. Check each of the following categories:

1. INJECTION VULNERABILITIES:
   - SQL injection: Is user input concatenated into SQL queries without parameterization?
   - XSS (Cross-Site Scripting): Is user input rendered in HTML without escaping or sanitization?
   - Command injection: Is user input passed to shell commands (exec, spawn, system) without sanitization?
   - Template injection: Is user input interpolated into template engines unsafely?
   - LDAP/NoSQL injection: Is user input used in LDAP or NoSQL queries without sanitization?

2. AUTHENTICATION AND AUTHORIZATION:
   - Are authentication checks missing on sensitive endpoints?
   - Are authorization checks bypassed or incomplete (e.g., checking role but not resource ownership)?
   - Are JWTs validated properly (signature, expiration, issuer, audience)?
   - Are sessions managed securely (httpOnly, secure, sameSite flags)?
   - Are passwords hashed with a strong algorithm (bcrypt, argon2) with appropriate cost?

3. SECRETS AND CREDENTIALS:
   - Are API keys, passwords, tokens, or private keys hardcoded in the source code?
   - Are secrets logged or included in error messages?
   - Are environment variables used for sensitive values (and not committed to the repo)?

4. UNSAFE DESERIALIZATION:
   - Is untrusted data deserialized with eval(), JSON.parse() on unvalidated input, pickle.loads(), or similar?
   - Are deserialization libraries configured to reject unknown types?

5. SERVER-SIDE REQUEST FORGERY (SSRF):
   - Can user input control URLs that the server fetches?
   - Are internal network addresses (127.0.0.1, 10.x.x.x, 169.254.x.x) blocked?

6. PATH TRAVERSAL:
   - Can user input control file paths (../ sequences)?
   - Are file paths validated and sandboxed to allowed directories?

7. CRYPTOGRAPHIC ISSUES:
   - Are weak algorithms used (MD5, SHA1 for security purposes, DES, RC4)?
   - Are random values generated with cryptographically secure functions (crypto.randomBytes, secrets.token_bytes)?
   - Are encryption keys of sufficient length?

8. DATA EXPOSURE:
   - Are sensitive fields (PII, financial data) logged, returned in API responses, or included in error messages unnecessarily?
   - Are CORS policies overly permissive (Access-Control-Allow-Origin: *)?
   - Are HTTP security headers missing (Content-Security-Policy, X-Frame-Options, Strict-Transport-Security)?

9. DEPENDENCY RISKS:
   - Are new dependencies introduced with known vulnerabilities?
   - Are dependencies pinned to specific versions (not using ^ or ~ for security-sensitive packages)?

SEVERITY GUIDELINES for this pass:
- critical: Active exploitable vulnerabilities (SQL injection with user input, hardcoded secrets, authentication bypass, command injection)
- warning: Potentially exploitable patterns that depend on context (missing input validation, overly permissive CORS, weak cryptography)
- suggestion: Defense-in-depth improvements (additional security headers, tighter CSP, logging sanitization)
- nitpick: Minor security hygiene (dependency pinning, security-related code comments)

Do NOT comment on:
- Code structure or syntax (that is a separate review pass)
- Business logic correctness (that is a separate review pass)
- Code style or naming (that is a separate review pass)

IMPORTANT: Security findings must be specific and actionable. Do NOT report generic security advice ("always validate input"). Instead, cite the exact line where unvalidated input enters a dangerous sink and explain the attack vector. If you cannot trace a concrete attack path, lower the confidence score.
```

### Provider Configuration

```json
{
  "passType": "security",
  "passNumber": 4,
  "temperature": 0.1,
  "maxOutputTokens": 4096,
  "timeoutMs": 60000
}
```

---

## 8. Output Format Specification

### Per-Pass Output

Each pass produces a JSON object conforming to `/schemas/review-output.schema.json`. The LLM outputs the `comments` array and `summary` string. The prompt-runner wraps these with metadata (jobId, passType, passNumber, modelId, tokensUsed, durationMs, completedAt).

**LLM raw output (what the LLM generates):**

```json
{
  "comments": [
    {
      "filePath": "src/middleware/auth.ts",
      "lineNumber": 45,
      "endLineNumber": 47,
      "codeSnippet": "if (token == null) return res.status(401).send();",
      "severity": "warning",
      "category": "logic",
      "message": "Using == null checks both null and undefined, which is correct. However, the token value is not trimmed before comparison, so a whitespace-only string would pass this check and proceed to JWT verification, which may throw an unexpected error.",
      "suggestion": "const trimmedToken = token?.trim();\nif (!trimmedToken) return res.status(401).send();",
      "confidence": 0.85
    }
  ],
  "summary": "One potential edge case found in the auth middleware: whitespace-only tokens bypass the null check but will fail downstream."
}
```

**Prompt-runner enriched output (what gets written to S3):**

```json
{
  "jobId": "01HQXYZ123456789ABCDEF",
  "passType": "logic",
  "passNumber": 2,
  "comments": [
    {
      "filePath": "src/middleware/auth.ts",
      "lineNumber": 45,
      "endLineNumber": 47,
      "codeSnippet": "if (token == null) return res.status(401).send();",
      "severity": "warning",
      "category": "logic",
      "message": "Using == null checks both null and undefined, which is correct. However, the token value is not trimmed before comparison, so a whitespace-only string would pass this check and proceed to JWT verification, which may throw an unexpected error.",
      "suggestion": "const trimmedToken = token?.trim();\nif (!trimmedToken) return res.status(401).send();",
      "confidence": 0.85
    }
  ],
  "summary": "One potential edge case found in the auth middleware: whitespace-only tokens bypass the null check but will fail downstream.",
  "modelId": "claude-sonnet-4-20250514",
  "tokensUsed": {
    "input": 3800,
    "output": 420,
    "total": 4220
  },
  "durationMs": 4500,
  "completedAt": "2026-02-07T10:05:30.000Z"
}
```

### Merged Output

After all four passes complete, the prompt-runner merges them into `merged-review.json`. Deduplication rules:

1. **Same file, same line, same category**: Keep the comment with higher confidence. If confidence is equal, keep the one with higher severity.
2. **Same file, same line, different category**: Keep both. A structural issue and a logic issue on the same line are distinct findings.
3. **Overlapping line ranges**: If two comments from the same category overlap by more than 50% of their line range, treat as duplicate and keep the higher-confidence one.

### Handling Malformed LLM Output

The LLM may produce output that does not conform to the expected JSON schema. The prompt-runner handles this as follows:

1. **Not valid JSON**: Log the raw output. Retry the pass once with a lower temperature (current temperature minus 0.1, minimum 0.0). If the retry also fails, mark the pass as failed and proceed with remaining passes.
2. **Valid JSON but wrong schema**: Attempt to extract the `comments` array from wherever it appears in the response. If `comments` exists and is an array, use it. If not, mark the pass as failed.
3. **Missing required fields in comments**: Strip individual comments that lack required fields (`filePath`, `lineNumber`, `codeSnippet`, `severity`, `category`, `message`). Log the stripped comments. Proceed with remaining valid comments.
4. **Invalid enum values**: If `severity` or `category` contains an unexpected value, attempt to map it (e.g., "error" maps to "critical", "info" maps to "suggestion"). If mapping fails, strip the comment.

---

## 9. Token Budget Management

### Model Context Windows

| Model | Total Context Window | Notes |
|-------|---------------------|-------|
| Claude Sonnet 4 | 200,000 tokens | Primary model for all passes |
| Claude Haiku 3.5 | 200,000 tokens | Fallback model for cost optimization |

### Budget Allocation

The total context window is divided into three buckets:

| Bucket | Allocation | Purpose |
|--------|------------|---------|
| System prompt + Instructions | 10% (20,000 tokens) | Fixed overhead per pass |
| Context + Diff | 60% (120,000 tokens) | Variable input content |
| LLM Output | 30% (60,000 tokens) | Reserved for generated review |

**Why 60/30/10?**

- **60% for input** ensures the LLM sees enough code to make informed comments. Starving the input produces vague, generic findings.
- **30% for output** is generous but necessary. A thorough review of a large diff may produce 20+ comments, each with a code snippet, explanation, and suggestion. Under-allocating output causes truncation.
- **10% for system prompt** is sufficient. The system prompt, instructions, and evidence suffix together total approximately 2,000-3,000 tokens across all passes. The 10% allocation (20,000 tokens) provides ample headroom.

### Context + Diff Sub-Budget

Within the 60% input allocation, content is prioritized:

| Priority | Content | Token Share | Trimmable |
|----------|---------|-------------|-----------|
| 1 (highest) | Diff hunks with line numbers | 40-60% of input budget | NEVER |
| 2 | Surrounding code (N lines above/below hunks) | 15-25% of input budget | Yes, reduce N |
| 3 | Import/export statements and type definitions | 10-15% of input budget | Yes, remove least-relevant |
| 4 | Commit messages | 3-5% of input budget | Yes, truncate to first 5 |
| 5 (lowest) | PR description | 2-5% of input budget | Yes, truncate or remove entirely |

### Trimming Algorithm

When assembled content exceeds the 60% input budget, the context-gatherer trims in reverse priority order:

```
1. Truncate PR description to first 500 characters.
2. If still over budget: truncate commit messages to first 5 messages, 200 chars each.
3. If still over budget: remove type definitions for files not directly changed.
4. If still over budget: reduce surrounding code window from N lines to N/2.
5. If still over budget: reduce surrounding code window to 5 lines above/below each hunk.
6. If still over budget: remove all surrounding code (diff hunks only).
7. If STILL over budget: the diff itself exceeds the budget. Split the diff into
   file-level chunks and run separate LLM calls per file. Merge results.
```

Step 7 (diff splitting) is the last resort. It means the PR is extremely large (thousands of lines changed). In this case, each file's diff is reviewed independently, which may miss cross-file issues. A warning is emitted in the review summary.

### Token Estimation

Token counts are estimated before making the LLM API call using the provider's `estimateTokens()` method. The estimate is conservative (overestimates by approximately 10%) to avoid context window overflows. If the estimate exceeds the model's context window even after all trimming, the review is aborted with a `CONTEXT_LENGTH_EXCEEDED` error.

### Per-Pass Budget

Each pass receives the same token budget. Since all four passes process the same diff and context, the assembled prompt is nearly identical across passes (only the system prompt and instructions differ). The effective per-pass budget is:

| Component | Tokens (approximate, for Claude Sonnet 4) |
|-----------|--------------------------------------------|
| System prompt + instructions | 2,000 - 3,000 |
| Evidence gate suffix | 500 |
| Context block | 5,000 - 50,000 (varies by PR size) |
| Diff block | 5,000 - 100,000 (varies by PR size) |
| **Total input** | 12,500 - 153,500 |
| **Reserved output** | 4,096 (configurable via `maxOutputTokens`) |

### Total Pipeline Budget

For a typical PR (500 lines changed, 3 files):

| Component | Tokens |
|-----------|--------|
| Input per pass (estimated) | ~25,000 |
| Output per pass (max) | 4,096 |
| Total per pass | ~29,096 |
| Total for 4 passes | ~116,384 |

For a large PR (2,000 lines changed, 15 files):

| Component | Tokens |
|-----------|--------|
| Input per pass (estimated) | ~80,000 |
| Output per pass (max) | 4,096 |
| Total per pass | ~84,096 |
| Total for 4 passes | ~336,384 |

---

## 10. Prompt Assembly Algorithm

The prompt-runner assembles the final prompt for each pass using the following algorithm. This is implemented in `packages/core/src/prompt-runner/`.

### Step-by-Step Assembly

```
function assemblePrompt(pass: PassConfig, packet: ReviewPacket, context: GatherContext): Prompt {

  // 1. Select the system prompt for this pass
  const systemPrompt = SYSTEM_PROMPTS[pass.passType];

  // 2. Build the context block
  let contextBlock = "";
  contextBlock += formatSection("PR TITLE", packet.pullRequest.title);
  contextBlock += formatSection("PR DESCRIPTION", context.prDescription);
  contextBlock += formatSection("COMMIT MESSAGES", context.commitMessages.join("\n"));

  for (const file of context.fileContexts) {
    contextBlock += formatSection(
      `FILE CONTEXT: ${file.path}`,
      file.surroundingCode
    );
    if (file.imports.length > 0) {
      contextBlock += formatSection(
        `IMPORTS: ${file.path}`,
        file.imports.join("\n")
      );
    }
    if (file.relatedTypeDefinitions) {
      contextBlock += formatSection(
        `TYPES: ${file.path}`,
        file.relatedTypeDefinitions
      );
    }
  }

  // 3. Build the diff block with line number annotations
  const diffBlock = formatDiffWithLineNumbers(packet.diff, packet.files);

  // 4. Get pass-specific instructions
  const instructions = INSTRUCTIONS[pass.passType];

  // 5. Append the evidence gate suffix (always)
  const evidenceSuffix = EVIDENCE_GATE_SUFFIX;

  // 6. Assemble the user message
  const userMessage = [
    "=== CONTEXT ===",
    contextBlock,
    "=== DIFF ===",
    diffBlock,
    "=== INSTRUCTIONS ===",
    instructions,
    evidenceSuffix
  ].join("\n\n");

  // 7. Estimate tokens and trim if necessary
  const totalTokens = provider.estimateTokens(systemPrompt + userMessage);
  if (totalTokens > pass.maxInputTokens) {
    return assemblePromptWithTrimming(pass, packet, context, totalTokens);
  }

  return {
    systemPrompt,
    userMessage,
    temperature: pass.temperature,
    maxOutputTokens: pass.maxOutputTokens
  };
}
```

### Diff Formatting

The diff is formatted with explicit line number annotations so the LLM can cite them unambiguously:

```
--- FILE: src/middleware/auth.ts ---
[L41]  const extractToken = (req: Request): string | null => {
[L42]    const header = req.headers.authorization;
[L43]    if (!header) return null;
[L44]-   if (!token) return;
[L45]+   if (token == null) return res.status(401).send();
[L46]+   if (!token.startsWith('Bearer ')) return res.status(401).send();
[L47]    return header.split(' ')[1];
[L48]  };
```

Line markers:
- `[L{n}]` -- context line (unchanged, provided for reference)
- `[L{n}]+` -- added line (part of the diff, reviewable)
- `[L{n}]-` -- removed line (part of the diff, reviewable)

---

## 11. Cross-References

| Referenced Document | Path | Relevance |
|---------------------|------|-----------|
| Architecture | `/docs/architecture.md` | Pipeline stages that consume prompt outputs; Evidence Gate validation flow |
| RFC | `/docs/RFC.md` | LLM Provider interface; Evidence Gate specification; retry semantics |
| Tooling Evaluation | `/docs/tooling.md` | `parse-diff` for diff parsing; `web-tree-sitter` for AST; Ajv for schema validation |
| Testing Strategy | `/docs/testing-strategy.md` | Golden packet fixtures validate prompt outputs; evidence gate adversarial tests |
| Sprint Plan | `/docs/SPRINT-PLAN.md` | Task T-0.5 (this document); T-1.6 (prompt runner implementation) |

### Schema Files

| Schema | Path | Used By |
|--------|------|---------|
| `review-packet.schema.json` | `/schemas/review-packet.schema.json` | Packet builder output; prompt-runner input |
| `review-output.schema.json` | `/schemas/review-output.schema.json` | Per-pass LLM output; prompt-runner enriched output |
| `review-comment.schema.json` | `/schemas/review-comment.schema.json` | Individual comment within review output; evidence gate input |
| `job-status.schema.json` | `/schemas/job-status.schema.json` | DynamoDB job record; pipeline orchestration |
| `provider-config.schema.json` | `/schemas/provider-config.schema.json` | LLM provider configuration; prompt-runner initialization |

---

## Appendix A: Complete Example -- Full Prompt for Pass 2 (Logic)

Below is a complete, assembled prompt for Pass 2 (Logic and Correctness) reviewing a small TypeScript PR.

### System Message

```
You are a senior code reviewer performing a LOGIC AND CORRECTNESS analysis of a pull request diff. Your sole focus is on whether the code behaves correctly: does it handle all cases, are algorithms correct, are edge conditions covered, and is error handling adequate?

You MUST output a valid JSON object conforming to the schema provided below. Do not include any text outside the JSON object. Do not wrap the JSON in markdown code fences.

OUTPUT SCHEMA:
{
  "comments": [
    {
      "filePath": "string (exact file path from the diff)",
      "lineNumber": "integer (line number from the diff, >= 1)",
      "endLineNumber": "integer (optional, for multi-line ranges)",
      "codeSnippet": "string (exact code copied from the diff)",
      "severity": "critical | warning | suggestion | nitpick",
      "category": "logic",
      "message": "string (your review comment explaining the issue)",
      "suggestion": "string (optional, suggested fix)",
      "confidence": "number (0.0 to 1.0, your confidence in this finding)"
    }
  ],
  "summary": "string (1-3 sentence summary of logic findings)"
}
```

### User Message

```
=== CONTEXT ===

--- PR TITLE ---
Fix auth middleware null token handling

--- PR DESCRIPTION ---
The current auth middleware uses a falsy check (!token) which treats empty strings
as unauthorized but does not properly handle null/undefined from missing headers.
This PR switches to explicit null checks and adds a Bearer prefix validation.

--- COMMIT MESSAGES ---
Fix null check in auth middleware
Add Bearer prefix validation

--- FILE CONTEXT: src/middleware/auth.ts ---
import { Request, Response, NextFunction } from 'express';
import { verifyJwt } from '../utils/jwt';
import { AuthError } from '../errors';

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  // ... (lines 10-40 omitted for brevity)
}

--- IMPORTS: src/middleware/auth.ts ---
import { Request, Response, NextFunction } from 'express';
import { verifyJwt } from '../utils/jwt';
import { AuthError } from '../errors';

=== DIFF ===

--- FILE: src/middleware/auth.ts ---
[L41]  const extractToken = (req: Request): string | null => {
[L42]    const header = req.headers.authorization;
[L43]    if (!header) return null;
[L44]-   if (!token) return;
[L45]+   if (token == null) return res.status(401).send();
[L46]+   if (!token.startsWith('Bearer ')) return res.status(401).send();
[L47]    return header.split(' ')[1];
[L48]  };

=== INSTRUCTIONS ===

Review the diff below for LOGIC AND CORRECTNESS issues only. Trace execution paths mentally and check each of the following:

1. OFF-BY-ONE ERRORS: Are loop bounds correct? Are array indices within range? ...
2. NULL/UNDEFINED HANDLING: Can any variable be null or undefined at the point of use? ...
3. RACE CONDITIONS: In asynchronous code, are shared resources accessed safely? ...
4. INCORRECT ALGORITHMS: Does the algorithm produce the correct result for all inputs? ...
5. EDGE CASES: What happens with empty arrays, empty strings, zero values, ...?
6. ERROR HANDLING GAPS: Are errors caught and handled appropriately? ...
7. INCORRECT STATE TRANSITIONS: Does the code maintain consistent state? ...

(Full instructions as defined in Section 5 above)

=== MANDATORY EVIDENCE RULES ===

(Full evidence suffix as defined in Section 3 above)

=== END MANDATORY EVIDENCE RULES ===
```

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-02-07 | 1.0.0 | ai-engineer | Initial prompting strategy with 4 passes, evidence suffix, token budgets |
