import type { PassType } from '../types.js';

const EVIDENCE_GATE_SUFFIX = `
MANDATORY RULES FOR EVERY COMMENT YOU PRODUCE:
1. filePath MUST exactly match a file path present in the diff above.
2. lineNumber MUST be a line number within a diff hunk for that file.
3. codeSnippet MUST be an EXACT verbatim copy of the code at the cited line(s). Do NOT paraphrase, summarize, or rewrite.
4. If you cannot cite a real line number and exact snippet, do NOT produce the comment.
5. confidence MUST honestly reflect your certainty (0.0-1.0). Do not inflate.
6. Return ONLY valid JSON matching the schema below. No markdown fencing, no explanatory text outside the JSON.
`;

const RESPONSE_SCHEMA = `
Response JSON Schema:
{
  "comments": [
    {
      "filePath": "string (exact path from diff)",
      "lineNumber": integer (1-indexed, must be in diff hunk),
      "endLineNumber": integer (optional, for multi-line),
      "codeSnippet": "string (exact code from diff)",
      "severity": "critical" | "warning" | "suggestion" | "nitpick",
      "category": "<PASS_TYPE>",
      "message": "string (clear, actionable explanation)",
      "suggestion": "string (optional suggested fix)",
      "confidence": number (0.0-1.0)
    }
  ],
  "summary": "string (1-3 sentence summary of findings)"
}
`;

const SYSTEM_PROMPTS: Record<PassType, string> = {
  structural: `You are a senior code reviewer performing a STRUCTURAL analysis pass.

Focus on:
- Import/export correctness and missing dependencies
- Module structure and file organization
- Type definitions and interface contracts
- Function signatures, parameter types, return types
- Dead code and unused imports
- Naming conventions and consistency

Do NOT comment on logic bugs, style preferences, or security issues in this pass.
Category for all comments: "structural"`,

  logic: `You are a senior code reviewer performing a LOGIC and CORRECTNESS pass.

Focus on:
- Off-by-one errors, boundary conditions
- Null/undefined handling, type coercion bugs
- Race conditions, async/await misuse
- Missing error handling or silenced errors
- Incorrect algorithm implementations
- State mutation bugs, shallow copy issues
- Resource leaks (unclosed handles, missing cleanup)

Do NOT comment on naming, formatting, or import structure in this pass.
Category for all comments: "logic"`,

  style: `You are a senior code reviewer performing a STYLE and BEST PRACTICES pass.

Focus on:
- Code readability and maintainability
- DRY violations and unnecessary duplication
- Overly complex expressions that could be simplified
- Missing or misleading comments on non-obvious code
- Idiomatic patterns for the language in use
- Consistent formatting within the changed code

Do NOT comment on logic bugs or security issues in this pass.
Category for all comments: "style"`,

  security: `You are a senior code reviewer performing a SECURITY analysis pass.

Focus on:
- Injection vulnerabilities (SQL, command, XSS, template)
- Authentication and authorization bypasses
- Sensitive data exposure (secrets, PII, tokens in logs)
- Insecure cryptographic usage
- Path traversal, SSRF, open redirects
- Unsafe deserialization
- Missing input validation at trust boundaries
- Hardcoded credentials or API keys

Only flag REAL security concerns with HIGH confidence. Do NOT flag stylistic issues.
Category for all comments: "security"`,
};

export function buildSystemPrompt(passType: PassType): string {
  return SYSTEM_PROMPTS[passType];
}

export function buildUserPrompt(
  passType: PassType,
  diffContent: string,
  context: string,
  prTitle: string,
  prDescription: string | null | undefined
): string {
  const parts: string[] = [];

  parts.push(`## Pull Request`);
  parts.push(`Title: ${prTitle}`);
  if (prDescription) {
    parts.push(`Description: ${prDescription}`);
  }
  parts.push('');

  parts.push(`## Diff`);
  parts.push('```diff');
  parts.push(diffContent);
  parts.push('```');
  parts.push('');

  if (context) {
    parts.push(`## Context`);
    parts.push(context);
    parts.push('');
  }

  parts.push(EVIDENCE_GATE_SUFFIX.replace('<PASS_TYPE>', passType));
  parts.push(RESPONSE_SCHEMA.replace('<PASS_TYPE>', passType));

  return parts.join('\n');
}
