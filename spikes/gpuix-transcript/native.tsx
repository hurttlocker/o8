/** @jsxImportSource @gpuix/react */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { useGpuixRequired, useWindowSize, type PublicInstance } from '@gpuix/react';
import { fixture, streamedText, TURN_COUNT, PATCH } from './fixture';

const C = { bg: '#0c0e11', text: '#e8ecf2', muted: '#9da6b4', input: '#1b1e23', border: '#343b45' };
const nativeTheme = { bg: C.bg, text: C.text, textMuted: C.muted, accent: '#a1a1aa',
  fontSans: '.AppleSystemUIFont', fontMono: 'Menlo',
  metrics: { mdTextSize: 13, mdLineHeight: 19.5, codeTextSize: 12, codeLineHeight: 18, diffTextSize: 12, diffLineHeight: 18 } };
export const state = { tokens: 0, input: '', ranges: [] as number[][] };
export const api: { stream?: (n: number) => void; scroll?: (n: number) => void; composer?: () => number } = {};

export function Native() {
  const renderer = useGpuixRequired();
  const viewport = useWindowSize();
  const [tokens, setTokens] = useState(0);
  const [start, setStart] = useState(0);
  const [input, setInput] = useState('');
  const list = useRef<PublicInstance>(null);
  const composer = useRef<PublicInstance>(null);
  const end = Math.min(TURN_COUNT, start + 50);
  useLayoutEffect(() => {
    api.stream = n => { state.tokens = n; setTokens(n); };
    api.scroll = n => {
      setStart(Math.max(0, Math.min(TURN_COUNT - 40, n - 8)));
      if (list.current) renderer.scrollToItem!(list.current.id, n);
    };
    api.composer = () => composer.current!.id;
  }, [renderer]);
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: C.bg, fontFamily: '.AppleSystemUIFont', fontSize: 13 }}>
    <div style={{ height: 38, flexShrink: 0, paddingLeft: 16, paddingTop: 10, borderBottomWidth: 1, borderColor: C.border }}>
      <text style={{ color: C.text, fontSize: 12 }}>Transcript · 2,000 invented turns</text>
    </div>
    <virtual-list ref={list} itemCount={TURN_COUNT} windowStart={start} estimatedItemHeight={150}
      alignment="bottom" followTail overdraw={800} style={{ flexGrow: 1, minHeight: 0 }}
      onVisibleRange={event => {
        state.ranges.push([event.startIndex ?? 0, event.endIndex ?? 0]);
        setStart(Math.max(0, Math.min(TURN_COUNT - 40, Math.floor(event.startIndex ?? 0) - 8)));
      }}>
      {fixture.slice(start, end).map((entry, offset) => {
        const index = start + offset;
        const source = index === TURN_COUNT - 1 ? streamedText(tokens) : entry.text;
        return <div key={entry.id} style={{ paddingLeft: Math.max(16, (viewport.width - 900) / 2 + 16),
          paddingRight: Math.max(16, (viewport.width - 900) / 2 + 16), paddingTop: 6, paddingBottom: 6, width: '100%' }}>
          {entry.role === 'tool' ? <text style={{ color: C.muted, fontSize: 12 }}>Work details · {entry.toolCalls?.[0]?.args?.command as string}</text>
            : entry.role === 'user' ? <div style={{ backgroundColor: C.input, borderRadius: 8, padding: 8 }}><text style={{ color: C.text }}>{source}</text></div>
              : index % 100 === 75 ? <div><text style={{ color: C.text }}>Patch {index}</text><diff patch={PATCH} theme={nativeTheme} /></div>
                : <markdown source={source} theme={nativeTheme} style={{ color: C.text, fontSize: 13, fontWeight: 300 }} />}
        </div>;
      })}
    </virtual-list>
    <div style={{ marginLeft: 16, marginRight: 16, marginTop: 4, marginBottom: 8, padding: 8,
      borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.input, flexShrink: 0 }}>
      <input ref={composer} value={input} placeholder="Message this worker" theme={nativeTheme}
        style={{ height: 24, color: C.text, fontSize: 13, fontWeight: 300 }}
        onChange={event => { const value = event.value ?? ''; state.input = value; setInput(value); }} />
    </div>
    <div style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16,
      backgroundColor: input.length % 2 ? '#ff00ff' : '#00ff00' }} />
  </div>;
}
