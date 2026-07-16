import { describe, it, expect } from 'vitest';
import { extractPlanFromTranscript, isRetrospective, planStepLines } from './plan-extractor';

const assistant = (text: string) => ({ role: 'assistant' as const, text });

// Verbatim from the Plan card in the wild (Q 2026-07-16) — it rendered under
// "Show the first-turn plan" despite being the model answering a question about
// transcript visibility.
const REAL_RECAP = `Yes — I can see the full conversation in this session:

1. You asked me to build a self-contained index.html documenting the o8 orchestrator, serve it with python3 -m http.server, and give you the URL
2. I created the page, started the server on port 58929, and gave you http://127.0.0.1:58929/index.html
3. You shared a Design Mode screenshot showing the page with "o8 · fleet-level brain" header
4. I updated the title to "The o8 Operator — what I am and what I can do"
5. Now you're asking about transcript visibility

The entire chat history above is in my context window.`;

const REAL_PLAN = `I'll build the page, then serve it.

1. Create index.html with inline CSS and clear sections
2. Serve it on a local port with python3 -m http.server
3. Report the exact URL back`;

describe('extractPlanFromTranscript — recaps are not plans', () => {
  it('rejects the recap that shipped as a plan', () => {
    expect(extractPlanFromTranscript([assistant(REAL_RECAP)])).toBeNull();
  });

  it('still returns a real forward-looking plan', () => {
    expect(extractPlanFromTranscript([assistant(REAL_PLAN)])).toBe(REAL_PLAN.trim());
  });

  it('skips the recap and finds a later real plan', () => {
    const plan = extractPlanFromTranscript([assistant(REAL_RECAP), assistant(REAL_PLAN)]);
    expect(plan).toBe(REAL_PLAN.trim());
  });
});

describe('isRetrospective', () => {
  it('is true when the steps narrate finished work', () => {
    expect(isRetrospective(['You asked me to build X', 'I created the page', 'I updated the title'])).toBe(true);
  });

  it('is false for imperative steps', () => {
    expect(isRetrospective(['Create index.html', 'Serve it on a local port', 'Report the URL'])).toBe(false);
  });

  it('is false for steps that merely reference prior state', () => {
    // "asked" appears, but the step is still an instruction — the subject anchor
    // is what keeps this a plan.
    expect(isRetrospective(['Add the flag the operator asked for', 'Wire it to the gate'])).toBe(false);
  });

  it('tolerates one finished step among proposed ones', () => {
    expect(isRetrospective([
      'I created the scaffold',
      'Add the route handler',
      'Wire the gate',
      'Report back',
    ])).toBe(false);
  });

  it('is false for an empty list', () => {
    expect(isRetrospective([])).toBe(false);
  });
});

describe('planStepLines', () => {
  it('pulls numbered steps without their markers', () => {
    expect(planStepLines('1. Create it\n2) Serve it')).toEqual(['Create it', 'Serve it']);
  });

  it('pulls checkbox steps', () => {
    expect(planStepLines('- [ ] Create it\n- [x] Serve it')).toEqual(['Create it', 'Serve it']);
  });

  it('ignores prose around the list', () => {
    expect(planStepLines('Here goes:\n1. Do a thing\nThat is all.')).toEqual(['Do a thing']);
  });
});

describe('extractPlanFromTranscript — existing guarantees hold', () => {
  it('ignores non-assistant messages', () => {
    expect(extractPlanFromTranscript([{ role: 'user', text: REAL_PLAN }])).toBeNull();
  });

  it('needs at least two steps', () => {
    expect(extractPlanFromTranscript([assistant('1. Just the one step')])).toBeNull();
  });

  it('ignores tool-call-only turns', () => {
    expect(extractPlanFromTranscript([{ role: 'assistant', text: '', toolCalls: [{ id: 'a' }] }])).toBeNull();
  });

  it('reads content as well as text', () => {
    expect(extractPlanFromTranscript([{ role: 'assistant', content: REAL_PLAN }])).toBe(REAL_PLAN.trim());
  });
});
