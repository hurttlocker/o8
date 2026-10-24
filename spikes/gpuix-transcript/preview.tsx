'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { WorkspaceTranscript } from '../../src/components/desktop/workspace-terminal/WorkspaceTranscript';
import { WorkerPaneComposer } from '../../src/components/desktop/workspace-terminal/WorkerPaneComposer';
import { getPalette, resolveTheme } from '../../src/lib/theme/registry';
import { fixture, streamedText, TURN_COUNT } from './fixture';

const theme = resolveTheme(getPalette('dark'), 'solid');
document.title = new URLSearchParams(location.search).get('title') ?? 'GPUIX transcript benchmark preview';
for (const [key, value] of Object.entries(theme.cssVars)) document.documentElement.style.setProperty(key, value);
document.documentElement.style.setProperty('--font-sans-system', '-apple-system, BlinkMacSystemFont, sans-serif');
document.documentElement.style.setProperty('--font-mono-system', 'SFMono-Regular, Menlo, monospace');
document.documentElement.style.colorScheme = 'dark';

function Preview() {
  const [entries, setEntries] = useState(fixture);
  const [input, setInput] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const tokens = useRef(0);
  const follow = useRef(true);
  const inputRef = useRef('');
  const traversal = useRef({ requested: 0, last: -1, finished: false });
  useLayoutEffect(() => { if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [entries]);
  useEffect(() => {
    const api = {
      fixture() { return fixture; },
      stream(n: number) {
        flushSync(() => {
          tokens.current = n;
          setEntries([...fixture.slice(0, -1), { ...fixture.at(-1)!, text: streamedText(n) }]);
        });
      },
      key() {
        const field = composer.current!;
        field.focus();
        const previous = field.value;
        flushSync(() => {
          field.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, previous + 'w');
          field.dispatchEvent(new InputEvent('input', { data: 'w', inputType: 'insertText', bubbles: true }));
          field.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
        });
        if (inputRef.current !== previous + 'w') throw Error('Web input acknowledgement mismatch');
      },
      state() { return { tokens: tokens.current, input: inputRef.current, width: innerWidth, height: innerHeight,
        scrollTop: list.current?.scrollTop, scrollHeight: list.current?.scrollHeight, rows: TURN_COUNT, traversal: traversal.current }; },
      scroll(index: number) {
        follow.current = index === TURN_COUNT - 1;
        if (follow.current && list.current) { list.current.scrollTop = list.current.scrollHeight; return; }
        const row = document.querySelector(`[data-o8-message-id="${fixture[index].id}"]`);
        if (row) row.scrollIntoView({ block: 'start' });
        else if (list.current) list.current.scrollTop = index / (TURN_COUNT - 1) * list.current.scrollHeight;
      },
      wheel(delta: number) { if (list.current) list.current.scrollTop += delta; },
      focus() {
        composer.current?.focus();
        const field = composer.current!;
        const style = getComputedStyle(field);
        const context = document.createElement('canvas').getContext('2d')!;
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return { ...field.getBoundingClientRect().toJSON(), viewportHeight: innerHeight,
          x: field.getBoundingClientRect().x + parseFloat(style.paddingLeft),
          advance: context.measureText('w').width + (parseFloat(style.letterSpacing) || 0) };
      },
    };
    Object.assign(window, { bench: api });
    list.current?.scrollTo(0, list.current.scrollHeight);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.documentElement.dataset.ready = 'true';

    }));

  }, []);
  const change = (value: string) => { inputRef.current = value; setInput(value); };
  return <main style={{ position: 'relative', height: '100vh', display: 'flex', flexDirection: 'column',
    background: 'var(--t-chat-surface-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
    <div style={{ height: 38, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 16,
      borderBottom: '1px solid var(--t-divider-subtle)', fontSize: 12, fontWeight: 300 }}>Transcript · 2,000 invented turns</div>
    <div ref={list} style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 12, paddingBottom: 12 }}>
      <div style={{ maxWidth: 900, marginLeft: 'auto', marginRight: 'auto', paddingLeft: 16, paddingRight: 16 }}>
        <WorkspaceTranscript entries={entries} active={false} markLast={false} isStreaming />
      </div>
    </div>
    <div style={{ flexShrink: 0, width: '100%', maxWidth: 932, marginLeft: 'auto', marginRight: 'auto' }}>
      <WorkerPaneComposer textareaRef={composer} scopeKey="invented-benchmark" active compact={false}
        input={input} onInputChange={change} onSend={() => {}} canSend={input.length > 0} />
    </div>
    <div data-composer-paint-marker style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16,
      background: input.length % 2 ? '#ff00ff' : '#00ff00', pointerEvents: 'none' }} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
