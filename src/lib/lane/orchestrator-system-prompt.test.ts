import { describe, it, expect } from 'vitest';
import { buildOrchestratorSystemPrompt } from './orchestrator-system-prompt';

describe('buildOrchestratorSystemPrompt — clarify-first doctrine (#1489, silent since 2026-07-11)', () => {
  // firstRunClarify pinned per-test so assertions don't depend on the
  // machine's real lanes table.
  const prompt = buildOrchestratorSystemPrompt('/tmp/example-repo', { firstRunClarify: false });

  it('renders the clarify-first doctrine section with the ambiguity trigger', () => {
    expect(prompt).toContain('Clarify-first — interview before dispatch');
    expect(prompt).toMatch(/materially ambiguous/i);
    // The old composer-injected directive block is gone — the trigger is
    // doctrine + first-run note only, never a transcript-visible block.
    expect(prompt).not.toContain('[CLARIFY-FIRST DIRECTIVE]');
  });

  it('codifies one-question-at-a-time ordered by blast radius, capped, with an escape', () => {
    expect(prompt).toContain('One question at a time');
    expect(prompt).toMatch(/data model >.*type\/interface.*>.*UX flow.*>.*mechanical/i);
    expect(prompt).toMatch(/~5/);
    expect(prompt).toContain('skip, dispatch now');
  });

  it('requires resolved Q&A to reach workers under a Resolved unknowns heading', () => {
    expect(prompt).toContain('Resolved unknowns');
    expect(prompt).toContain('buildPacketPrompt');
  });

  it('keeps the escape valve for trivially-scoped prompts (zero friction when clear)', () => {
    expect(prompt).toMatch(/Skip it entirely/i);
  });

  it('injects the first-mission note when the repo has no dispatch history', () => {
    const first = buildOrchestratorSystemPrompt('/tmp/example-repo', { firstRunClarify: true });
    expect(first).toMatch(/first mission on this repo/i);
    expect(first).toMatch(/materially ambiguous by default/i);
  });

  it('omits the note (and never leaks the template var) for repos with history', () => {
    expect(prompt).not.toMatch(/first mission on this repo/i);
    expect(prompt).not.toContain('{{CLARIFY_FIRST_RUN_NOTE}}');
  });

  it('routes servers around Claude Code background-task false failures', () => {
    expect(prompt).toContain('o8 run --detach -- <cmd>');
    expect(prompt).toContain('Never combine Bash `run_in_background` with a shell `exec`');
    expect(prompt).toMatch(/false failure notification.*replacement process remains healthy/i);
  });
});
