'use client';

/**
 * Polish tab — everything that shapes how o8 cleans up your dictation, grouped so
 * humans aren't hunting across three tabs: Custom words (dictionary), Snippets
 * (trigger → replacement), and Instructions (freeform AI guidance). All persist
 * via `voice_prefs_set` and feed the polish pass.
 */
import { useState, type CSSProperties } from 'react';
import {
  ACCENT, ACCENT_GLOW, GLASS_BG, GLASS_BG_HOVER, GLASS_BORDER_SUBTLE, SF,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY, TRANS_FAST, ICONS,
} from '../tokens';
import {
  SectionCard, SectionTitle, SectionHint, AccentButton, Icon, PageHeader,
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

// ── The merged tab ──
export function PolishTab({ prefs, setPref }: TabProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader icon={ICONS.sparkle} title="Polish" />
      <DictionarySection prefs={prefs} setPref={setPref} />
      <SnippetsSection prefs={prefs} setPref={setPref} />
      <InstructionsSection prefs={prefs} setPref={setPref} />
    </div>
  );
}

// ── Dictionary ──
function DictionarySection({ prefs, setPref }: TabProps) {
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
        <Icon icon={ICONS.close} size={11} />
      </button>
    </span>
  );
}

// ── Snippets ──
function SnippetsSection({ prefs, setPref }: TabProps) {
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
    <SectionCard>
      <SectionTitle icon={ICONS.arrowsLeftRight}>Snippets</SectionTitle>
      <SectionHint>Expand short triggers into longer phrases after dictation. Applied as a deterministic pass on the cleaned text.</SectionHint>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
        <input
          value={trigger} onChange={(e) => setTrigger(e.target.value)}
          onFocus={() => setFT(true)} onBlur={() => setFT(false)}
          placeholder="trigger" style={{ ...INPUT_BASE, flex: 1, minWidth: 0, ...focusStyle(fT) }}
        />
        <span style={{ color: TEXT_TERTIARY, display: 'flex' }}><Icon icon={ICONS.arrowsLeftRight} size={14} /></span>
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
      <span style={{ color: TEXT_TERTIARY, display: 'flex' }}><Icon icon={ICONS.arrowsLeftRight} size={13} /></span>
      <span style={{ fontSize: 13, color: TEXT_SECONDARY, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rule.replacement}</span>
      <button
        type="button" aria-label="Remove snippet" onClick={onRemove}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6,
          border: `1px solid ${GLASS_BORDER_SUBTLE}`, background: hover ? GLASS_BG_HOVER : 'transparent',
          color: TEXT_TERTIARY, cursor: 'pointer', padding: 0, flexShrink: 0,
        }}
      >
        <Icon icon={ICONS.close} size={12} />
      </button>
    </div>
  );
}

// ── Instructions ──
function InstructionsSection({ prefs, setPref }: TabProps) {
  const saved = prefStr(prefs, 'polish_instructions', '');
  const [value, setValue] = useState(saved);
  const [focus, setFocus] = useState(false);

  return (
    <SectionCard>
      <SectionTitle icon={ICONS.notePencil}>Instructions</SectionTitle>
      <SectionHint>Guidance for how o8 cleans up your dictation — e.g. &ldquo;Keep my casual tone; always capitalize iOS.&rdquo; Applied on the next dictation.</SectionHint>
      <textarea
        value={value} onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => { setFocus(false); setPref('polish_instructions', value.trim()); }}
        placeholder="Tell o8 how to handle your dictation"
        rows={5}
        style={{ ...TEXTAREA_BASE, minHeight: 120, ...focusStyle(focus) }}
      />
    </SectionCard>
  );
}
