import { inspectionKey } from './visual-inspection';
import { readVisualDraft, saveVisualDraft, type VisualInstructionDraft } from './visual-draft-store';
import type { VisualLiveScope } from './visual-live-context';
import type { RippleChoiceResolution } from '@/lib/mobile/ripple-contract';

const questions = new Map<string, { key: string; resolution: RippleChoiceResolution }>();
const remembered = (draft: VisualInstructionDraft) => draft.visualQuestion ?? questions.get(scope(draft));
const scope = (draft: VisualInstructionDraft) => JSON.stringify([draft.principal, draft.request.id]);
const key = (draft: VisualInstructionDraft) => {
  const frame = draft.request.frames.at(-1);
  return frame?.observation ? inspectionKey({ principal: draft.principal, requestId: draft.request.id, observation: frame.observation,
    candidates: frame.candidates ?? [], utterance: draft.request.utterance }) : null;
};
export function currentVisualQuestion(draft: VisualInstructionDraft): RippleChoiceResolution | null {
  const item = remembered(draft);
  return draft.status === 'draft' && !draft.request.clarification && item?.key === key(draft) ? item.resolution : null;
}
/** Explicit optional clarification uses local evidence. Uncalibrated image judgments stay observational. */
export function openVisualQuestion(draft: VisualInstructionDraft): RippleChoiceResolution | null {
  const existing = currentVisualQuestion(draft); if (existing) return existing;
  const frame = draft.request.frames.at(-1); const inputKey = key(draft);
  if (!inputKey || draft.request.clarification || !frame?.candidates || frame.candidates.length < 2 || frame.candidates.length > 4) return null;
  const question: RippleChoiceResolution = { id: `question-${crypto.randomUUID()}`, kind: 'choice', aodlPath: 'intent.target',
    question: 'Which marked component should change?', options: frame.candidates.map((candidate, index, candidates) => {
      const other = candidates.length === 2 ? candidates[1 - index] : null;
      const dx = other ? candidate.rect[0] + candidate.rect[2] / 2 - other.rect[0] - other.rect[2] / 2 : 0;
      const dy = other ? candidate.rect[1] + candidate.rect[3] / 2 - other.rect[1] - other.rect[3] / 2 : 0;
      const position = other ? Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'Left' : 'Right' : dy < 0 ? 'Upper' : 'Lower' : String(index + 1);
      return { label: `${position}: ${candidate.name}`.slice(0, 64), value: candidate.id };
    }) };
  const pendingQuestion = { key: inputKey, resolution: question };
  questions.set(scope(draft), pendingQuestion);
  void saveVisualDraft({ ...draft, visualQuestion: pendingQuestion }).catch(() => {});
  if (questions.size > 32) questions.delete(questions.keys().next().value!);
  return question;
}
export async function confirmVisualQuestion(draft: VisualInstructionDraft, value: string) {
  const current = readVisualDraft(draft.principal, draft.request.target);
  const question = current && currentVisualQuestion(current);
  if (!current || key(current) !== key(draft) || !question?.options.some(option => option.value === value)) return false;
  await saveVisualDraft({ ...current, request: { ...current.request, clarification: { id: question.id, path: question.aodlPath, value, question: question.question } } });
  return true;
}
export function visualQuestionContext(scope: VisualLiveScope) {
  const draft = readVisualDraft(scope.principal, scope.target);
  const question = draft && currentVisualQuestion(draft);
  return question ? `One optional visual clarification is open: ${question.question} Options: ${question.options.map(option => option.label).join('; ')}. An answer only updates the marked draft; it never submits a coding task.` : '';
}
export async function answerVisualQuestion(scope: VisualLiveScope, text: string): Promise<string | null> {
  const draft = readVisualDraft(scope.principal, scope.target);
  const prior = draft && remembered(draft);
  if (draft && draft.status !== 'draft') return null;
  if (!draft || !prior) return null;
  if (prior.key !== key(draft)) { questions.delete(JSON.stringify([draft.principal, draft.request.id])); await saveVisualDraft({ ...draft, visualQuestion: undefined }); return 'The marked target or instruction changed. Review the current draft before answering or sending.'; }
  const question = prior.resolution;
  const answer = text.trim().replace(/[.!?]+$/, '').toLowerCase();
  if (answer === 'skip') { questions.delete(JSON.stringify([draft.principal, draft.request.id])); await saveVisualDraft({ ...draft, visualQuestion: undefined }); return 'Clarification skipped. The marked draft has not been sent.'; }
  const matches = question.options.filter((option, index) => [option.value, option.label, draft.request.frames.at(-1)?.candidates?.[index]?.name, String(index + 1), ['first', 'second', 'third', 'fourth'][index], option.label.split(':')[0], `the ${option.label.split(':')[0].toLowerCase()} one`].some(value => value?.toLowerCase() === answer));
  if (draft.request.clarification) return matches.length === 1 ? 'That target is already confirmed. The marked draft has not been sent.' : null;
  if (matches.length !== 1) return `${question.question} ${question.options.map((option, index) => `${index + 1}: ${option.label}`).join('. ')}. The draft has not been sent.`;
  return await confirmVisualQuestion(draft, matches[0].value) ? 'That target is confirmed in the marked draft. It has not been sent.' : 'The marked draft changed. Review the current target in the composer.';
}

export function visualQuestionEvidence(draft: VisualInstructionDraft) {
  const value = remembered(draft);
  return !draft.request.clarification && value?.key === key(draft) ? value.resolution : null;
}
