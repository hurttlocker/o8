import { describe, it, expect } from 'vitest';
import { buildOrchestratorSystemPrompt } from './orchestrator-system-prompt';

describe('buildOrchestratorSystemPrompt — clarify-first doctrine (#1489)', () => {
  const prompt = buildOrchestratorSystemPrompt('/tmp/example-repo');

  it('renders the clarify-first doctrine section', () => {
    expect(prompt).toContain('Clarify-first — interview before dispatch');
    // The directive trigger + the ambiguity trigger both codified.
    expect(prompt).toContain('[CLARIFY-FIRST DIRECTIVE]');
    expect(prompt).toMatch(/materially ambiguous/i);
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
});
