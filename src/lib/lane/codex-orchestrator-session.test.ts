import { describe, it, expect } from 'vitest';

import { BRAIN_PROMPT_SECTION } from '@/lib/orchestrator/brain-access';
import { buildCodexOrchestratorPrompt, codexOrchestratorModelFlags } from './codex-orchestrator-session';

describe('codexOrchestratorModelFlags', () => {
  it('keeps the cloud path verbatim (gpt-5.5 default unchanged)', () => {
    // This is the primary orchestrator path — any drift breaks every turn.
    expect(codexOrchestratorModelFlags('gpt-5.5', 'xhigh')).toEqual([
      '-c',
      'model=gpt-5.5',
      '-c',
      'model_reasoning_effort=xhigh',
    ]);
  });

  it('expands an Ollama model to the --oss local form (no reasoning effort)', () => {
    expect(codexOrchestratorModelFlags('ollama:qwen2.5-coder:32b', 'xhigh')).toEqual([
      '--oss',
      '--local-provider',
      'ollama',
      '--model',
      'qwen2.5-coder:32b',
    ]);
  });

  it('expands an LM Studio model to the --oss local form', () => {
    expect(codexOrchestratorModelFlags('lmstudio:qwen2.5-coder', 'high')).toEqual([
      '--oss',
      '--local-provider',
      'lmstudio',
      '--model',
      'qwen2.5-coder',
    ]);
  });
});

describe('buildCodexOrchestratorPrompt', () => {
  it('assembles the real orchestrator prompt with the Brain-first section', () => {
    const prompt = buildCodexOrchestratorPrompt(
      '/tmp/o8-test-repo',
      'Review the latest packet.',
    );

    expect(prompt).toContain('You are the orchestrator for o8');
    expect(prompt).toContain('o8-test-repo');
    expect(prompt).toContain(BRAIN_PROMPT_SECTION);
    expect(prompt).toContain('## ENGINEERING BRAIN');
    expect(prompt).toContain('cortex_ask');
    expect(prompt).toContain('before grepping or re-reading broad files');
    expect(prompt).toContain('## USER MESSAGE\n\nReview the latest packet.');
  });
});
