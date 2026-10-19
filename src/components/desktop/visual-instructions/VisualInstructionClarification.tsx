'use client';

import { useEffect, useRef, useState } from 'react';
import { RamsButton } from '@/components/desktop/settings/RamsButton';
import { requestRippleResolution } from '@/lib/mobile/ripple-client';
import type { RippleChoiceResolution } from '@/lib/mobile/ripple-contract';
import { readVisualDraft, saveVisualDraft, type VisualInstructionDraft } from '@/lib/composer/visual-draft-store';

/** Clarification is optional and belongs to the exact words and frames the user reviewed. */
type Props = { draft: VisualInstructionDraft; disabled: boolean };
export function VisualInstructionClarification(props: Props) {
  const { request } = props.draft;
  return <ClarificationState key={JSON.stringify([props.draft.principal, request.id, request.utterance, request.frames.map(frame => frame.id)])} {...props} />;
}
function ClarificationState({ draft, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [choice, setChoice] = useState<RippleChoiceResolution | null>(null);
  const run = useRef(0);
  useEffect(() => () => { run.current += 1; }, []);
  const resolve = async () => {
    const ticket = ++run.current;
    setBusy(true); setNotice('');
    const resolution = await requestRippleResolution({ utterance: draft.request.utterance, repoName: draft.request.target.repoPath.split('/').pop() });
    if (ticket !== run.current || readVisualDraft(draft.principal, draft.request.target) !== draft) return;
    setBusy(false);
    if (resolution.kind === 'choice') setChoice(resolution);
    else setNotice('No clarification returned. Send when ready.');
  };
  const confirm = (value: string) => {
    const current = readVisualDraft(draft.principal, draft.request.target);
    if (!choice || current !== draft || current.status !== 'draft') { setChoice(null); return; }
    void saveVisualDraft({ ...draft, request: { ...draft.request, clarification: { path: choice.aodlPath, value, question: choice.question } } })
      .catch(error => setNotice(String(error)));
    setChoice(null);
  };
  return <div style={{ marginTop: 8, fontSize: 12, color: 'var(--t-text-muted)' }}>
    <RamsButton variant="ghost" disabled={disabled || busy || !draft.request.utterance.trim() || draft.request.utterance.length > 4000} busy={busy} onClick={() => { void resolve(); }}>Clarify intent (optional)</RamsButton>
    {choice ? <div><p>{choice.question}</p><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {choice.options.map(option => <RamsButton key={option.value} variant="ghost" disabled={disabled} onClick={() => confirm(option.value)}>{option.label}</RamsButton>)}
      <RamsButton variant="ghost" onClick={() => setChoice(null)}>Skip</RamsButton>
    </div></div> : null}
    {draft.request.clarification ? <p>Confirmed: {draft.request.clarification.value}. Send when ready.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </div>;
}
