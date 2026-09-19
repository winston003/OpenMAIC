import type { QuizQuestion } from '@/lib/types/stage';

export interface QuestionResult {
  questionId: string;
  correct: boolean | null;
  status: 'correct' | 'incorrect' | 'skipped' | 'pending_review';
  /** Null means no score was assigned (skipped or awaiting human review). */
  earned: number | null;
  aiComment?: string;
}

/** Persisted sentinel used for an explicit learner skip. */
export const SKIPPED_ANSWER = '__openmaic_skipped__';

export function isSkippedAnswer(value: string | string[] | undefined): boolean {
  return Array.isArray(value)
    ? value.length === 1 && value[0] === SKIPPED_ANSWER
    : value === SKIPPED_ANSWER;
}

/** True when a learner supplied a meaningful answer (an explicit skip counts). */
export function hasAnswerValue(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

/** A numerical aggregate must not be shown while any item has no assigned score. */
export function hasUnscoredResults(results: QuestionResult[]): boolean {
  return results.some((result) => result.earned === null);
}

export interface ParsedGradePayload {
  score: number;
  comment: string;
}

/** Validate the assessor payload without inventing or rounding a score. */
export function parseGradePayload(value: unknown, points: number): ParsedGradePayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as { score?: unknown; comment?: unknown };
  const rawScore = payload.score;
  const score =
    typeof rawScore === 'number'
      ? rawScore
      : typeof rawScore === 'string' && rawScore.trim().length > 0
        ? Number(rawScore)
        : Number.NaN;
  if (
    !Number.isFinite(score) ||
    score < 0 ||
    score > points ||
    typeof payload.comment !== 'string' ||
    payload.comment.trim().length === 0
  ) {
    return null;
  }
  return { score, comment: payload.comment };
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Whether a question is graded as open text (AI) rather than by exact
 * answer-key match. Classification is by the explicit `type` only: an
 * unanswered choice question (empty `answer`) is still a choice question and
 * must not be re-routed to AI grading. `hasAnswer` does not override the type.
 */
export function isShortAnswer(q: QuizQuestion): boolean {
  return q.type === 'short_answer';
}

/** Persisted answer keys may contain an exact option value or exact option label.
 * Resolve only unique exact matches so ambiguous or fuzzy entries remain pending
 * for human review instead of being guessed.
 */
export function resolveAnswerKeyToValue(q: QuizQuestion, answer: string): string {
  const opts = q.options ?? [];
  if (opts.length === 0) return answer;
  const valueMatches = opts.filter((o) => o.value === answer);
  if (valueMatches.length === 1) return valueMatches[0].value;
  const labelMatches = opts.filter((o) => o.label === answer);
  if (labelMatches.length === 1) return labelMatches[0].value;
  return answer;
}

/** Same exact resolver used by grading and the answer-review UI. */
export function answerIncludesOption(q: QuizQuestion, optionValue: string): boolean {
  return toArray(q.answer).some((a) => resolveAnswerKeyToValue(q, a) === optionValue);
}

/** Grade choice questions locally. Returns results only for non-short-answer questions. */
export function gradeChoiceQuestions(
  questions: QuizQuestion[],
  answers: Record<string, string | string[]>,
): QuestionResult[] {
  return questions
    .filter((q) => !isShortAnswer(q))
    .map((q) => {
      const pts = q.points ?? 1;
      // Compatibility resolution applies to the persisted key only. The
      // submission is a value the UI produced from the options, so resolving
      // it too would let a label (or any alias the key accepts) be submitted
      // and accepted as a different option.
      if (isSkippedAnswer(answers[q.id])) {
        return {
          questionId: q.id,
          correct: null,
          status: 'skipped' as const,
          earned: null,
        };
      }
      const userAnswer = toArray(answers[q.id]);
      const correctAnswer = toArray(q.answer).map((a) => resolveAnswerKeyToValue(q, a));
      const correct = arraysEqual(userAnswer, correctAnswer);
      return {
        questionId: q.id,
        correct,
        status: correct ? ('correct' as const) : ('incorrect' as const),
        earned: correct ? pts : 0,
      };
    });
}
