import { describe, it, expect } from 'vitest';
import type { PacketExplainerQuiz } from './types';
import {
  DEFAULT_QUIZ_FILE_THRESHOLD,
  isQuizGateBlocking,
  quizPassed,
  quizScore,
} from './quiz-gate';

const quiz: PacketExplainerQuiz = {
  questions: [
    { id: 'q1', prompt: 'What does the change touch?', options: ['A', 'B', 'C'], answerIndex: 1 },
    { id: 'q2', prompt: 'What is the risk?', options: ['X', 'Y'], answerIndex: 0 },
  ],
};

describe('quizScore / quizPassed', () => {
  it('counts correct answers', () => {
    expect(quizScore(quiz, { q1: 1, q2: 0 })).toBe(2);
    expect(quizScore(quiz, { q1: 0, q2: 0 })).toBe(1);
    expect(quizScore(quiz, {})).toBe(0);
    expect(quizScore(null, { q1: 1 })).toBe(0);
  });

  it('passes only when every question is correct', () => {
    expect(quizPassed(quiz, { q1: 1, q2: 0 })).toBe(true);
    expect(quizPassed(quiz, { q1: 1 })).toBe(false);
    expect(quizPassed(quiz, { q1: 0, q2: 0 })).toBe(false);
    expect(quizPassed({ questions: [] }, {})).toBe(false);
    expect(quizPassed(null, {})).toBe(false);
  });
});

describe('isQuizGateBlocking', () => {
  const base = { enabled: true, changedFileCount: 8, quiz, answers: {} };

  it('does not block when the gate is disabled', () => {
    expect(isQuizGateBlocking({ ...base, enabled: false })).toBe(false);
  });

  it('does not block at or below the threshold', () => {
    expect(isQuizGateBlocking({ ...base, changedFileCount: DEFAULT_QUIZ_FILE_THRESHOLD })).toBe(false);
    expect(isQuizGateBlocking({ ...base, changedFileCount: DEFAULT_QUIZ_FILE_THRESHOLD + 1 })).toBe(true);
  });

  it('degrades to ungated when there is no quiz (generation off/failed)', () => {
    expect(isQuizGateBlocking({ ...base, quiz: null })).toBe(false);
    expect(isQuizGateBlocking({ ...base, quiz: { questions: [] } })).toBe(false);
  });

  it('blocks while unpassed and clears once passed', () => {
    expect(isQuizGateBlocking({ ...base, answers: {} })).toBe(true);
    expect(isQuizGateBlocking({ ...base, answers: { q1: 1, q2: 0 } })).toBe(false);
  });

  it('honors a custom threshold', () => {
    expect(isQuizGateBlocking({ ...base, changedFileCount: 3, threshold: 2 })).toBe(true);
    expect(isQuizGateBlocking({ ...base, changedFileCount: 2, threshold: 2 })).toBe(false);
  });
});
