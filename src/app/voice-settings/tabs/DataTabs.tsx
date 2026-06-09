'use client';

/**
 * Dictionary / Snippets / Instructions tabs. Dictionary is a chip list
 * (`dictionary` string[]). Snippets are {trigger → replacement} rows
 * (`replacements`). Instructions is a single freeform textarea
 * (`polish_instructions`). All persist via `voice_prefs_set`.
 */
import { useState, type CSSProperties } from 'react';
import {
  ACCENT, ACCENT_GLOW, GLASS_BG, GLASS_BG_HOVER, GLASS_BORDER_SUBTLE, SF,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY, TRANS_FAST, ICONS,
} from '../tokens';
import {
  SectionCard, SectionTitle, SectionHint, AccentButton, Icon, PAGE_TITLE_STYLE,
} from '../primitives';
import { prefList, prefReplacements, prefStr, type ReplacementRule, type TabProps } from '../helpers';

const INPUT_BASE: CSSProperties = {
  height: 34, paddingLeft: 12, paddingRight: 12, boxSizing: 'border-box',
  background: GLASS_BG, border: `1px solid ${GLASS_BORDER_SUBTLE}`, borderRadius: 9,
  color: TEXT_PRIMARY, fontSize: 13, fontFamily: SF, outline: 'none',
  transition: `border-color ${TRANS_FAST}, box-shadow ${TRANS_FAST}`,
};
const TEXTAREA_BASE: CSSProperties = {
  width: '100%', boxSizing: 'border-box', paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14,
  background: GLASS_BG, border: `1px solid ${GLASS_BORDER_SUBTLE}`, borderRadius: 12,
  color: TEXT_PRIMARY, fontSize: 13, fontFamily: SF, lineHeight: 1.6, outline: 'none', resize: 'vertical',
};

function focusStyle(focus: boolean): CSSProperties {
  return focus
    ? { borderColor: ACCENT, boxShadow: `0 0 0 2px ${ACCENT_GLOW}`, background: GLASS_BG_HOVER }
    : {};
}

// ── Dictionary ──
export function DictionaryTab({ prefs, setPref }: TabProps) {
  const words = prefList(prefs, 'dictionary');
  const [draft, setDraft] = useState('');
  const [focus, setFocus] = useState(false);

  const add = () => {
    const w = draft.trim();
    if (!w || words.some((x) => x.toLowerCase() === w.toLowerCase())) { setDraft(''); return; }
    setPref('dictionary', [...words, w]);
    setDraft('');
  };
  const remove = (w: string) => setPref('dictionary', words.filter((x) => x !== w));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <h1 style={PAGE_TITLE_STYLE}>Dictionary</h1>
      <SectionCard>
        <SectionTitle icon={ICONS.bookOpen}>Custom words</SectionTitle>
        <SectionHint>Proper nouns and terms o8 should always spell right. Applied on the next dictation — no relaunch.</SectionHint>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input
            value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
            placeholder="Add a word and press Enter"
            style={{ ...INPUT_BASE, flex: 1, ...focusStyle(focus) }}
          />
          <AccentButton label="Add" onClick={add} />
        </div>
        {words.length === 0 ? (
          <p style={{ fontSize: 12.5, color: TEXT_TERTIARY }}>No custom words yet.</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {words.map((w) => <Chip key={w} label={w} onRemove={() => remove(w)} />)}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, paddingLeft: 11, paddingRight: 7,
        borderRadius: 999, border: `1px solid ${GLASS_BORDER_SUBTLE}`,
        background: hover ? GLASS_BG_HOVER : GLASS_BG, fontSize: 12.5, color: TEXT_PRIMARY,
      }}
    >
      {label}
      <button
        type="button" aria-label={`Remove ${label}`} onClick={onRemove}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16,
          borderRadius: '50%', border: 'none', background: 'transparent', color: TEXT_TERTIARY, cursor: 'pointer', padding: 0,
        }}
      >
        <svg width="9" height="9" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}

// ── Snippets ──
export function SnippetsTab({ prefs, setPref }: TabProps) {
  const rules = prefReplacements(prefs, 'replacements');
  const [trigger, setTrigger] = useState('');
  const [replacement, setReplacement] = useState('');
  const [fT, setFT] = useState(false);
  const [fR, setFR] = useState(false);

  const add = () => {
    const t = trigger.trim();
    const r = replacement.trim();
    if (!t || !r) return;
    const next = [...rules.filter((x) => x.trigger.toLowerCase() !== t.toLowerCase()), { trigger: t, replacement: r }];
    setPref('replacements', next);
    setTrigger(''); setReplacement('');
  };
  const remove = (t: string) => setPref('replacements', rules.filter((x) => x.trigger !== t));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <h1 style={PAGE_TITLE_STYLE}>Snippets</h1>
      <SectionCard>
        <SectionTitle icon={ICONS.arrowsLeftRight}>Text expansion</SectionTitle>
        <SectionHint>Expand short triggers into longer phrases after dictation. Applied as a deterministic pass on the cleaned text.</SectionHint>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
          <input
            value={trigger} onChange={(e) => setTrigger(e.target.value)}
            onFocus={() => setFT(true)} onBlur={() => setFT(false)}
            placeholder="trigger" style={{ ...INPUT_BASE, flex: 1, minWidth: 0, ...focusStyle(fT) }}
          />
          <span style={{ color: TEXT_TERTIARY, display: 'flex' }}><Icon d={ICONS.arrowsLeftRight} size={14} /></span>
          <input
            value={replacement} onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            onFocus={() => setFR(true)} onBlur={() => setFR(false)}
            placeholder="replacement" style={{ ...INPUT_BASE, flex: 1.6, minWidth: 0, ...focusStyle(fR) }}
          />
          <AccentButton label="Add" onClick={add} />
        </div>
        {rules.length === 0 ? (
          <p style={{ fontSize: 12.5, color: TEXT_TERTIARY }}>No snippets yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rules.map((rule, i) => <SnippetRow key={rule.trigger} rule={rule} first={i === 0} onRemove={() => remove(rule.trigger)} />)}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function SnippetRow({ rule, first, onRemove }: { rule: ReplacementRule; first: boolean; onRemove: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 10, paddingBottom: 10, borderTop: first ? 'none' : `1px solid ${GLASS_BORDER_SUBTLE}` }}
    >
      <span style={{ fontSize: 12.5, color: TEXT_PRIMARY, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', flexShrink: 0 }}>{rule.trigger}</span>
      <span style={{ color: TEXT_TERTIARY, display: 'flex' }}><Icon d={ICONS.arrowsLeftRight} size={13} /></span>
      <span style={{ fontSize: 13, color: TEXT_SECONDARY, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rule.replacement}</span>
      <button
        type="button" aria-label="Remove snippet" onClick={onRemove}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6,
          border: `1px solid ${GLASS_BORDER_SUBTLE}`, background: hover ? GLASS_BG_HOVER : 'transparent',
          color: TEXT_TERTIARY, cursor: 'pointer', padding: 0, flexShrink: 0,
        }}
      >
        <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

// ── Instructions ──
export function InstructionsTab({ prefs, setPref }: TabProps) {
  const saved = prefStr(prefs, 'polish_instructions', '');
  const [value, setValue] = useState(saved);
  const [focus, setFocus] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <h1 style={PAGE_TITLE_STYLE}>Instructions</h1>
      <SectionCard>
        <SectionTitle icon={ICONS.notePencil}>Cleanup instructions</SectionTitle>
        <SectionHint>Guidance for how o8 cleans up your dictation — e.g. &ldquo;Keep my casual tone; always capitalize iOS.&rdquo; Applied on the next dictation.</SectionHint>
        <textarea
          value={value} onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => { setFocus(false); setPref('polish_instructions', value.trim()); }}
          placeholder="Tell o8 how to handle your dictation"
          rows={6}
          style={{ ...TEXTAREA_BASE, minHeight: 140, ...focusStyle(focus) }}
        />
      </SectionCard>
    </div>
  );
}
