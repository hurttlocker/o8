import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buildAutoReviewPromptV1,
  buildBlindSecondPassPromptV1,
  buildCommentFactExtractionPromptV1,
  buildDocumentationFactExtractionPromptV1,
  buildProjectBriefPromptV1,
  PROGRAMMATIC_PROMPT_VERSION,
  REPL_HEALTH_PROMPTS_V1,
  STRICT_JSON_SYSTEM_PROMPTS_V1,
} from '@/lib/prompts/v1';

describe('programmatic prompt catalog v1', () => {
  it('exposes an explicit immutable version and stable health prompts', () => {
    expect(PROGRAMMATIC_PROMPT_VERSION).toBe('v1');
    expect(REPL_HEALTH_PROMPTS_V1).toEqual({
      cold: 'Reply with exactly: COLD',
      warm: 'Reply with exactly: WARM',
    });
    expect(Object.isFrozen(STRICT_JSON_SYSTEM_PROMPTS_V1)).toBe(true);
  });

  it('keeps request data in fact-extraction builder slots', () => {
    const commentPrompt = buildCommentFactExtractionPromptV1('ship fact 123');
    const docPrompt = buildDocumentationFactExtractionPromptV1([{
      id: 'chunk-1',
      repoName: 'o8',
      relPath: 'AGENTS.md',
      headingPath: ['Verification'],
      text: 'Run the typecheck.',
    }]);

    expect(commentPrompt).toContain('COMMENT BODY:\n<<<\nship fact 123\n>>>');
    expect(docPrompt).toContain('"id": "chunk-1"');
    expect(docPrompt).toContain('"heading": "Verification"');
  });

  it('frames worker and reviewer prompts through the shared builders', () => {
    expect(buildProjectBriefPromptV1('Project: o8', 'Fix the issue')).toBe(
      '## Project Brief\n\nProject: o8\n\n## Task\n\nFix the issue',
    );
    const blind = buildBlindSecondPassPromptV1({
      laneLabel: 'Prompt work',
      branch: 'issue/prompts',
      packetId: 'pkt-1',
      diffSummary: 'One file changed.',
      cwd: '/tmp/worktree',
      highRiskReasons: ['prompt routing changed'],
    });
    expect(blind).toContain('blind, independent second-pass reviewer');
    expect(blind).toContain('Packet: pkt-1');
    expect(blind).toContain('## Outcome closure review');
    expect(blind).toContain('Try to disprove that the original desired outcome became true');
    expect(blind).toContain('COMPLETENESS trace - when the change establishes or restores an invariant');
    expect(blind).toContain('`INVARIANT: <one sentence, or NONE>`');
    expect(blind).toContain('`SITE: <file:line> covered=<yes|no> evidence=<file:line|reason>`');
    expect(blind).toContain('every COMPLETENESS site is covered');

    const review = buildAutoReviewPromptV1({
      lane: { id: 'lane-1', label: 'Prompt work', branch: 'issue/prompts' },
      depth: 'standard',
      worktreePath: '/tmp/worktree',
      diffSummary: 'One file changed.',
      selfReviewSection: '## Agent self-review',
      deviationsEntries: [],
    });
    expect(review).toContain('An agent has completed work on lane "Prompt work"');
    expect(review).toContain('## Outcome closure review');
    expect(review).toContain('Treat the worker self-review as a claim');
    expect(review).toContain('lane_command with verb "merge"');
    expect(review).toContain('COMPLETENESS trace - when the change establishes or restores an invariant');
    expect(review).toContain('`INVARIANT: <one sentence, or NONE>`');
    expect(review).toContain('`SITE: <file:line> covered=<yes|no> evidence=<file:line|reason>`');
    expect(review).toContain('or any COMPLETENESS site is uncovered');
    expect(review).toContain('list EVERY uncovered `SITE:` line in the request-changes findings');
    expect(review).not.toContain('## Pre-edit task contract');
    expect(review).not.toContain('MINIMALITY:');
  });

  it('carries the same task contract into both review passes', () => {
    const taskContract = {
      version: 1 as const,
      requirements: [{
        id: 'R1',
        source: 'Require contract-first review.',
        expectedBehavior: 'Both reviewers verify the same requirement.',
        productionPath: 'worker prompt -> completion context -> review prompt',
        verification: 'prompt builder tests',
      }],
      smallestRoute: [{
        path: 'src/lib/prompts/v1/review.ts',
        requirements: ['R1'],
        reason: 'The shared builder owns both review protocols.',
      }],
      exclusions: [],
    };
    const review = buildAutoReviewPromptV1({
      lane: { id: 'lane-1', label: 'Contract work', branch: 'issue/contract', packetId: 'pkt-1' },
      depth: 'standard',
      worktreePath: '/tmp/worktree',
      diffSummary: 'One file changed.',
      selfReviewSection: '## Agent self-review',
      deviationsEntries: [],
      taskContract,
      taskContractRequired: true,
    });
    const blind = buildBlindSecondPassPromptV1({
      laneLabel: 'Contract work',
      branch: 'issue/contract',
      packetId: 'pkt-1',
      diffSummary: 'One file changed.',
      cwd: '/tmp/worktree',
      highRiskReasons: ['review contract changed'],
      taskContract,
      taskContractRequired: true,
    });

    for (const prompt of [review, blind]) {
      expect(prompt).toContain('R1: Both reviewers verify the same requirement.');
      expect(prompt).toContain('review.ts -> R1');
      expect(prompt).toContain('MINIMALITY');
      expect(prompt).toContain('COMPLETENESS trace - when the change establishes or restores an invariant');
      expect(prompt).toContain('`INVARIANT: <one sentence, or NONE>`');
      expect(prompt).toContain('`SITE: <file:line> covered=<yes|no> evidence=<file:line|reason>`');
    }
    expect(review).toContain('or any COMPLETENESS site is uncovered');
    expect(review).toContain('list EVERY uncovered `SITE:` line in the request-changes findings');
    expect(blind).toContain('every COMPLETENESS site is covered');
    expect(review).toContain('include contractCoverageEvidence');
    expect(review).toContain('reviewedHeadSha must equal contractCoverageEvidence.headSha');
  });

  it('fails contract-armed review closed when the worker omitted the contract', () => {
    const review = buildAutoReviewPromptV1({
      lane: { id: 'lane-1', label: 'Missing contract', branch: 'issue/contract' },
      depth: 'deep-dive',
      worktreePath: '/tmp/worktree',
      diffSummary: 'One file changed.',
      selfReviewSection: '## Agent self-review',
      deviationsEntries: [],
      taskContractRequired: true,
    });

    expect(review).toContain('Structured contract: missing');
    expect(review).toContain('You may NOT approve if the pre-edit task contract is missing');
  });

  it('keeps the native Symon template versioned and time-parameterized', () => {
    const template = readFileSync(
      new URL('./symon-native-system.txt', import.meta.url),
      'utf8',
    );
    expect(template).toContain('You are Symon, a fast, helpful macOS voice assistant for o8.');
    expect(template).toContain('outcome the user can observe');
    expect(template).toContain('this rule never gives you coding authority');
    expect(template.match(/\{CURRENT_LOCAL_TIME\}/g)).toHaveLength(1);
  });

  it('keeps each repository role surface aligned to outcome ownership', () => {
    const surfaces = [
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      'src/lib/lane/orchestrator.md',
      '.claude/agents/reviewer.md',
    ];

    for (const surface of surfaces) {
      const text = readFileSync(new URL(`../../../../${surface}`, import.meta.url), 'utf8');
      expect(text, surface).toMatch(/outcome ownership/i);
      expect(text, surface).toContain('Outcome, Evidence, Residual, and Decision');
    }
  });
});
