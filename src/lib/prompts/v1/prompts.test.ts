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

    const review = buildAutoReviewPromptV1({
      lane: { id: 'lane-1', label: 'Prompt work', branch: 'issue/prompts' },
      depth: 'standard',
      worktreePath: '/tmp/worktree',
      diffSummary: 'One file changed.',
      selfReviewSection: '## Agent self-review',
      deviationsEntries: [],
    });
    expect(review).toContain('An agent has completed work on lane "Prompt work"');
    expect(review).toContain('lane_command with verb "merge"');
  });

  it('keeps the native Symon template versioned and time-parameterized', () => {
    const template = readFileSync(
      new URL('./symon-native-system.txt', import.meta.url),
      'utf8',
    );
    expect(template).toContain('You are Symon, a fast, helpful macOS voice assistant for o8.');
    expect(template.match(/\{CURRENT_LOCAL_TIME\}/g)).toHaveLength(1);
  });
});
