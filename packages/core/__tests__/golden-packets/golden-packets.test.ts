import { describe, it, expect } from 'vitest';
import { ALL_GOLDEN_PACKETS } from './fixtures.js';
import { validateReviewPacket } from '../../src/schema-validator/index.js';
import { parsePatch } from '../../src/diff-parser/index.js';
import { gatherContext } from '../../src/context-gatherer/index.js';
import { buildSystemPrompt, buildUserPrompt } from '../../src/prompt-runner/prompts.js';
import { PASS_TYPES } from '../../src/types.js';

describe('Golden Packets', () => {
  describe('schema validation', () => {
    for (const { name, packet } of ALL_GOLDEN_PACKETS) {
      it(`${name}: validates against review-packet schema`, () => {
        const result = validateReviewPacket(packet);
        expect(result.valid).toBe(true);
        if (!result.valid) {
          console.error(`${name} validation errors:`, result.errors);
        }
      });
    }
  });

  describe('diff parsing', () => {
    for (const { name, packet } of ALL_GOLDEN_PACKETS) {
      it(`${name}: diff parses without errors`, () => {
        const parsed = parsePatch(packet.diff);
        expect(parsed).toBeDefined();
        expect(parsed.files).toBeDefined();

        if (packet.diff.trim()) {
          expect(parsed.files.length).toBeGreaterThan(0);
        } else {
          expect(parsed.files).toHaveLength(0);
        }
      });
    }
  });

  describe('context gathering', () => {
    for (const { name, packet } of ALL_GOLDEN_PACKETS) {
      it(`${name}: context gathers without errors`, () => {
        const parsed = parsePatch(packet.diff);
        const contexts = gatherContext(parsed);
        expect(contexts).toBeDefined();
        // Deleted files should be excluded
        for (const ctx of contexts) {
          const file = parsed.files.find(f => f.path === ctx.path);
          expect(file?.status).not.toBe('deleted');
        }
      });
    }
  });

  describe('prompt construction', () => {
    for (const passType of PASS_TYPES) {
      it(`builds valid ${passType} system prompt`, () => {
        const prompt = buildSystemPrompt(passType);
        expect(prompt).toContain(passType);
        expect(prompt.length).toBeGreaterThan(50);
      });
    }

    it('builds user prompt with diff content', () => {
      const packet = ALL_GOLDEN_PACKETS[0].packet;
      const prompt = buildUserPrompt(
        'logic',
        packet.diff,
        'some context',
        packet.pullRequest.title,
        packet.pullRequest.description
      );
      expect(prompt).toContain('## Pull Request');
      expect(prompt).toContain('## Diff');
      expect(prompt).toContain('MANDATORY RULES');
      expect(prompt).toContain(packet.pullRequest.title);
    });

    it('includes PR description when provided', () => {
      const prompt = buildUserPrompt(
        'logic',
        'diff content',
        '',
        'Title',
        'This fixes the auth bug'
      );
      expect(prompt).toContain('This fixes the auth bug');
    });

    it('omits description when null', () => {
      const prompt = buildUserPrompt(
        'logic',
        'diff content',
        '',
        'Title',
        null
      );
      expect(prompt).not.toContain('Description:');
    });
  });
});
