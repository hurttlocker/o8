// Smoke test for Bug 1 — o8_view_eval wrapper handles non-JSON-serializable
// returns + medium-complexity expressions.
//
// Run from worktree root:
//   npx tsx scripts/smoke-eval-wrap.ts

import * as vm from 'node:vm';

import { createO8WebviewToolHandlers } from '@/lib/mcp/o8-webview-tools';

interface FakeClient {
  evalJs: (code: string) => Promise<{ result: string }>;
}

function makeFakeClient(): FakeClient {
  const sandbox: Record<string, unknown> = {
    JSON,
    String,
    console,
    document: { body: { outerHTML: '<html>...</html>' } },
    window: { __o8: true },
  };
  vm.createContext(sandbox);
  return {
    async evalJs(wrappedCode: string) {
      const result = vm.runInContext(wrappedCode, sandbox);
      return { result: typeof result === 'string' ? result : String(result) };
    },
  };
}

async function run() {
  let pass = 0;
  let fail = 0;

  const handlers = createO8WebviewToolHandlers(() => makeFakeClient() as never);

  async function check(name: string, code: string, predicate: (text: string) => boolean) {
    const result = await handlers.o8_view_eval({ code });
    const first = result.content[0];
    const text = first && first.type === 'text' ? first.text : '';
    const ok = predicate(text);
    if (ok) {
      pass++;
      console.log(`  PASS  ${name}: ${text.slice(0, 200)}`);
    } else {
      fail++;
      console.log(`  FAIL  ${name}: ${text.slice(0, 400)}`);
    }
  }

  await check(
    'JSON.stringify([{a:1},{b:2}])',
    'JSON.stringify([{a:1},{b:2}])',
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === true && env.value === '[{"a":1},{"b":2}]';
      } catch { return false; }
    },
  );

  await check(
    'typeof window',
    'typeof window',
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === true && env.value === 'object';
      } catch { return false; }
    },
  );

  await check(
    'multi-statement IIFE returns id',
    "(() => { var x = { id: 'panel-1' }; return x.id; })()",
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === true && env.value === 'panel-1';
      } catch { return false; }
    },
  );

  await check(
    'var x = ...; x',
    'var x = 42; x',
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === true && (env.value === 42 || env.value === '42');
      } catch { return false; }
    },
  );

  await check(
    'function value falls back to String()',
    '(() => () => 1)()',
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === true
          && env.nonSerializable === true
          && typeof env.value === 'string'
          && env.valueType === 'function';
      } catch { return false; }
    },
  );

  await check(
    'throw produces ok:false envelope',
    "(() => { throw new Error('boom'); })()",
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === false && env.error && env.error.message === 'boom';
      } catch { return false; }
    },
  );

  await check(
    'undefined value normalised',
    '(() => { /* no return */ })()',
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === true
          && env.nonSerializable === true
          && env.valueType === 'undefined';
      } catch { return false; }
    },
  );

  await check(
    'truncation envelope for long string',
    "(() => 'x'.repeat(20000))()",
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.truncated === true && typeof env.preview === 'string';
      } catch { return false; }
    },
  );

  // Phase 4 follow-up: bare object literals were silently returning the
  // last block-statement expression instead of the object. The wrapper now
  // detects single object-literal expressions and parens-wraps them.
  await check(
    'bare object literal {a:1}',
    '{a:1}',
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === true && env.value && env.value.a === 1;
      } catch { return false; }
    },
  );

  await check(
    'multi-key bare object literal',
    '{a:1, b:2, c:"hello"}',
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === true && env.value && env.value.a === 1 && env.value.b === 2 && env.value.c === 'hello';
      } catch { return false; }
    },
  );

  // Multi-statement code that does NOT start with `{` should still take
  // the regular indirect-eval path and roundtrip cleanly.
  await check(
    'multi-statement var assignment still works',
    'var y = {x:1}; JSON.stringify(y)',
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === true && env.value === '{"x":1}';
      } catch { return false; }
    },
  );

  // Arrow-function expression returns the function via the
  // non-serializable fallback (functions can't JSON.stringify) — the
  // wrapper should not crash, and value should be the function's
  // toString.
  await check(
    'arrow function expression () => 42',
    '() => 42',
    (text) => {
      try {
        const env = JSON.parse(text);
        return env.ok === true
          && env.nonSerializable === true
          && env.valueType === 'function'
          && typeof env.value === 'string'
          && env.value.includes('42');
      } catch { return false; }
    },
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(2);
});
