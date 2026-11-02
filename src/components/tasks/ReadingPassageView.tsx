import React, { useState, useEffect, useCallback } from 'react';
import { ReadingPassageTask } from '../../data/curatedQuestions';
import { CheckCircle2, RotateCcw, ArrowRight, HelpCircle, Highlighter, AlertCircle, Target, Keyboard } from 'lucide-react';
import { convertToScaledScore, convertScaledToBand6, savePracticeRecord } from '../../utils/scoreTracker';
import { auth } from '../../firebase';
import { saveMistake } from '../../utils/mistakes';
import { inferReadingQuestionType } from '../../utils/taskNormalizer';
import { ReadingQuestionSkill } from '../../types';
import { TaskSubtitleMeta, TaskReportButton } from '../shared/TaskHeaderMeta';

interface Props {
  task: ReadingPassageTask;
  onNextTask?: () => void;
  onComplete?: (result: number) => void;
  skillFocus?: ReadingQuestionSkill;
  leftColumnClassName?: string;
  rightColumnClassName?: string;
  footerBarClassName?: string;
  coachMode?: boolean;
}

export const ReadingPassageView: React.FC<Props> = ({
  task,
  onNextTask,
  onComplete,
  skillFocus = 'all',
  leftColumnClassName = 'lg:sticky lg:top-6 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto',
  rightColumnClassName = 'lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-2 scroll-smooth',
  footerBarClassName = 'flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200',
  coachMode = false,
}) => {
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [isHighlightMode, setIsHighlightMode] = useState(false);
  const [passageHighlights, setPassageHighlights] = useState<string[]>([]);
  const [activeQuestionIdx, setActiveQuestionIdx] = useState<number>(0);
  const [openHints, setOpenHints] = useState<Record<number, boolean>>({});
  const [checkedQuestions, setCheckedQuestions] = useState<Record<number, boolean>>({});

  useEffect(() => {
    setSelectedAnswers({});
    setSubmitted(false);
    setActiveQuestionIdx(0);
    setOpenHints({});
    setCheckedQuestions({});
    setPassageHighlights([]);
  }, [task.id, task.title]);

  const handleSelect = (qIdx: number, optIdx: number) => {
    if (submitted) return;
    setActiveQuestionIdx(qIdx);
    setSelectedAnswers((prev) => ({ ...prev, [qIdx]: optIdx }));
    if (checkedQuestions[qIdx]) {
      setCheckedQuestions((prev) => ({ ...prev, [qIdx]: false }));
    }
  };

  const calculateScore = useCallback(() => {
    let correct = 0;
    task.questions.forEach((q, i) => {
      if (selectedAnswers[i] === q.answer) correct++;
    });
    return correct;
  }, [task.questions, selectedAnswers]);

  const handleSubmit = useCallback(() => {
    if (submitted || Object.keys(selectedAnswers).length === 0) return;
    setSubmitted(true);
    const correctCount = calculateScore();
    const total = task.questions.length;
    const scaledScore = convertToScaledScore(correctCount, total);

    task.questions.forEach((q, i) => {
      if (selectedAnswers[i] !== q.answer) {
        saveMistake(
          `${task.title} — ${q.q}`,
          'Academic Reading',
          q.options[selectedAnswers[i]] ?? 'No answer',
          q.options[q.answer],
          q.why
        );
      }
    });

    savePracticeRecord({
      taskType: 'reading-passage',
      taskTitle: task.title,
      section: 'Reading',
      score: correctCount,
      maxScore: total,
      scaledScore30: scaledScore,
      timeSpentSeconds: 180,
      feedbackSummary: `Scored ${correctCount}/${total} on passage comprehension (${Math.round((correctCount / total) * 100)}%)`,
    });

    onComplete?.(scaledScore);
  }, [submitted, selectedAnswers, calculateScore, task.questions, task.title, onComplete]);

  const handleReset = () => {
    setSelectedAnswers({});
    setSubmitted(false);
    setActiveQuestionIdx(0);
    setOpenHints({});
    setCheckedQuestions({});
  };

  const score = submitted ? calculateScore() : 0;
  const total = task.questions.length;
  const allAnswered = task.questions.every((_, i) => selectedAnswers[i] !== undefined);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'radio'))
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!submitted && Object.keys(selectedAnswers).length > 0) {
          handleSubmit();
        }
        return;
      }

      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        if (submitted) return;
        if (allAnswered && activeQuestionIdx >= total - 1) {
          e.preventDefault();
          handleSubmit();
        } else if (selectedAnswers[activeQuestionIdx] !== undefined) {
          e.preventDefault();
          const nextIdx = Math.min(total - 1, activeQuestionIdx + 1);
          setActiveQuestionIdx(nextIdx);
          document.getElementById(`question-${nextIdx}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [submitted, selectedAnswers, allAnswered, activeQuestionIdx, total, handleSubmit]);

  const missedIndices = React.useMemo(() => {
    if (!submitted) return [];
    return task.questions
      .map((q, i) => (selectedAnswers[i] !== q.answer ? i : -1))
      .filter((i) => i !== -1);
  }, [submitted, selectedAnswers, task.questions]);

  const handlePassageMouseUp = () => {
    if (!isHighlightMode) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString().trim();
    if (text && text.length > 1) {
      setPassageHighlights((prev) => (prev.includes(text) ? prev : [...prev, text]));
    }
  };

  const renderHighlightedPassage = () => {
    if (passageHighlights.length === 0) {
      return <p className="whitespace-pre-line">{task.passage}</p>;
    }
    const sorted = [...passageHighlights].sort((a, b) => b.length - a.length);
    const escaped = sorted.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
    const parts = task.passage.split(pattern);

    return (
      <p className="whitespace-pre-line">
        {parts.map((part, i) => {
          const isMatch = sorted.some((h) => h.toLowerCase() === part.toLowerCase());
          return isMatch ? (
            <mark key={i} className="bg-amber-200/90 text-slate-900 rounded-xs px-0.5 font-normal">
              {part}
            </mark>
          ) : (
            <span key={i}>{part}</span>
          );
        })}
      </p>
    );
  };

  return (
    <div className="space-y-4">
      <div className="border-b border-slate-200 pb-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">{task.title}</h2>
            {coachMode && (
              <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-800 border border-indigo-200">
                🎓 Coach &amp; Marathon Mode ({task.questions.length} Questions)
              </span>
            )}
          </div>
          <TaskSubtitleMeta task={task} extra={`${task.questions.length} Questions`} />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg">
            <Keyboard className="w-3.5 h-3.5 text-slate-400" />
            <span><strong className="font-semibold text-slate-800">Enter</strong>: Next item</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span><strong className="font-semibold text-teal-800">Ctrl + Enter</strong>: Submit</span>
          </div>
          <button
            onClick={() => setIsHighlightMode(!isHighlightMode)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              isHighlightMode
                ? 'bg-amber-100 text-amber-900 border-amber-300'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <Highlighter className="w-3.5 h-3.5" />
            {isHighlightMode ? 'Highlighting Active' : 'Text Highlighter'}
          </button>
          {passageHighlights.length > 0 && (
            <button
              type="button"
              onClick={() => setPassageHighlights([])}
              className="text-[11px] text-amber-800 hover:text-amber-950 underline px-1 cursor-pointer"
              title="Clear all passage highlights"
            >
              Clear ({passageHighlights.length})
            </button>
          )}
          <TaskReportButton task={task} />
        </div>
      </div>

      {/* Two-Column Official Layout on Desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Passage */}
        <div
          data-highlighter-active={isHighlightMode ? 'true' : 'false'}
          data-no-select-vocab={isHighlightMode ? 'true' : undefined}
          onMouseUp={handlePassageMouseUp}
          className={`lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 shadow-xs ${leftColumnClassName}`}
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Reading Passage</span>
            <span className="text-xs text-slate-400">
              {task.passage.split(/\s+/).length} words
            </span>
          </div>
          <div
            className={`prose prose-slate max-w-none text-slate-800 leading-relaxed text-sm sm:text-base font-normal selection:bg-amber-200 ${
              isHighlightMode ? 'cursor-text' : ''
            }`}
          >
            {renderHighlightedPassage()}
          </div>
        </div>

        {/* Right Column: Comprehension Questions */}
        <div className={`lg:col-span-5 space-y-5 ${rightColumnClassName}`}>
          <div className="flex items-center justify-between border-b border-slate-200 pb-2">
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Comprehension Questions</span>
            <span className="text-xs text-slate-500 font-mono">
              {Object.keys(selectedAnswers).length}/{total} Answered
            </span>
          </div>

          {task.questions.map((q, qIdx) => {
            const userChoice = selectedAnswers[qIdx];
            const isCorrect = userChoice === q.answer;
            const isQuestionChecked = submitted || Boolean(checkedQuestions[qIdx]);
            const inferredSkill = (q as any).skillKey || inferReadingQuestionType(q.q);
            const rawBadgeType = String((q as any).questionType || inferredSkill);
            const isTargetSkill = skillFocus !== 'all' && inferredSkill === skillFocus;

            const getSkillBadge = (type: string) => {
              const lower = type.toLowerCase();
              if (lower.includes('negative') || lower.includes('except')) {
                return { label: 'Negative Factual (EXCEPT/NOT)', color: 'bg-rose-50 text-rose-700 border-rose-200', strategy: 'Eliminate the 3 choices explicitly stated in the passage; the remaining unmentioned or contradicted choice is correct.' };
              }
              if (lower.includes('infer')) {
                return { label: 'Inference', color: 'bg-purple-50 text-purple-700 border-purple-200', strategy: 'Look for a logical consequence strongly implied by combining two facts in the target paragraph without going beyond the text.' };
              }
              if (lower.includes('vocab') || lower.includes('meaning')) {
                return { label: 'Vocabulary in Context', color: 'bg-amber-50 text-amber-700 border-amber-200', strategy: 'Substitute each option back into the target sentence and verify that it preserves the surrounding clause logic.' };
              }
              if (lower.includes('rhetorical') || lower.includes('purpose') || lower.includes('relate')) {
                return { label: 'Rhetorical Purpose', color: 'bg-indigo-50 text-indigo-700 border-indigo-200', strategy: 'Read the topic sentence immediately preceding the cited detail to see what claim the author is illustrating or contrasting.' };
              }
              return { label: 'Factual Detail', color: 'bg-teal-50 text-teal-700 border-teal-200', strategy: 'Locate the key noun phrase in the passage and match the option that paraphrases the cause-and-effect relationship accurately.' };
            };
            const skillBadge = getSkillBadge(rawBadgeType);
            const rawHint = (q as any).hint;
            const hintText =
              typeof rawHint === 'string'
                ? rawHint
                : rawHint && typeof rawHint === 'object'
                ? String(rawHint.text || rawHint.hint || rawHint.tip || rawHint.strategy || JSON.stringify(rawHint))
                : String(skillBadge.strategy || '');

            return (
              <div
                key={qIdx}
                id={`question-${qIdx}`}
                className={`bg-white border rounded-xl p-5 shadow-xs transition-colors ${
                  isQuestionChecked
                    ? isCorrect
                      ? 'border-emerald-200 bg-emerald-50/20'
                      : 'border-rose-200 bg-rose-50/20'
                    : isTargetSkill
                    ? 'border-teal-400 ring-2 ring-teal-100'
                    : 'border-slate-200'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center justify-center w-5 h-5 rounded-md bg-slate-100 text-slate-700 text-xs font-bold">
                      {qIdx + 1}
                    </span>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${skillBadge.color}`}>
                      {skillBadge.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isTargetSkill && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-teal-100 text-teal-800">
                        <Target className="w-3 h-3" />
                        Target Skill
                      </span>
                    )}
                    {coachMode && !submitted && (
                      <>
                        <button
                          type="button"
                          onClick={() => setOpenHints((prev) => ({ ...prev, [qIdx]: !prev[qIdx] }))}
                          className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 transition-colors cursor-pointer"
                        >
                          {openHints[qIdx] ? 'Hide Hint' : '💡 Coach Hint & Strategy'}
                        </button>
                        {userChoice !== undefined && !checkedQuestions[qIdx] && (
                          <button
                            type="button"
                            onClick={() => {
                              setCheckedQuestions((prev) => ({ ...prev, [qIdx]: true }));
                              if (userChoice !== q.answer) {
                                saveMistake(
                                  `${task.title} — ${q.q}`,
                                  'Academic Reading',
                                  q.options[userChoice] ?? 'No answer',
                                  q.options[q.answer],
                                  q.why
                                );
                              }
                            }}
                            className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-teal-700 hover:bg-teal-800 text-white transition-colors cursor-pointer"
                          >
                            ✓ Check This Question
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {coachMode && openHints[qIdx] && !submitted && (
                  <div className="mb-3 p-3 rounded-lg bg-indigo-50/80 border border-indigo-200 text-xs text-indigo-950 space-y-1">
                    <div className="font-bold text-indigo-900">🎓 {skillBadge.label} Strategy:</div>
                    <p className="text-indigo-900 leading-relaxed">{hintText}</p>
                  </div>
                )}

                <p className="text-sm font-semibold text-slate-900 leading-snug mb-3.5">{q.q}</p>

                <div className="space-y-2">
                  {q.options.map((opt, optIdx) => {
                    const isSelected = userChoice === optIdx;
                    const isRightOption = q.answer === optIdx;

                    let optionClasses =
                      'border-slate-200 bg-slate-50/50 hover:bg-slate-100/70 text-slate-800';

                    if (isQuestionChecked) {
                      if (isRightOption) {
                        optionClasses = 'border-emerald-500 bg-emerald-50 text-emerald-900 font-medium';
                      } else if (isSelected && !isRightOption) {
                        optionClasses = 'border-rose-400 bg-rose-50 text-rose-900';
                      } else {
                        optionClasses = 'border-slate-200 bg-white text-slate-400 opacity-60';
                      }
                    } else if (isSelected) {
                      optionClasses =
                        'border-teal-600 bg-teal-50/60 text-teal-950 ring-1 ring-teal-600 font-medium';
                    }

                    return (
                      <label
                        key={optIdx}
                        onClick={() => handleSelect(qIdx, optIdx)}
                        className={`flex items-start gap-3 p-3 rounded-lg border text-xs sm:text-sm cursor-pointer transition-all ${optionClasses}`}
                      >
                        <input
                          type="radio"
                          name={`q-${qIdx}`}
                          checked={isSelected}
                          disabled={submitted}
                          onChange={() => handleSelect(qIdx, optIdx)}
                          className="mt-0.5 text-teal-700 focus:ring-teal-500 shrink-0"
                        />
                        <span className="leading-snug">{opt}</span>
                      </label>
                    );
                  })}
                </div>

                {isQuestionChecked && (
                  <div className="mt-3.5 pt-3 border-t border-slate-200/80 text-xs leading-relaxed">
                    <div className="flex items-start gap-1.5 text-slate-700">
                      <HelpCircle className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
                      <div>
                        <strong className={isCorrect ? 'text-emerald-700' : 'text-slate-800'}>
                          {isCorrect ? 'Correct!' : 'Official Explanation:'}
                        </strong>{' '}
                        <span>{q.why}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Action Bar */}
          <div className={footerBarClassName}>
            {!submitted ? (
              <button
                onClick={handleSubmit}
                disabled={!allAnswered}
                className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 disabled:hover:bg-teal-700 rounded-lg shadow-xs transition-colors whitespace-nowrap"
              >
                <CheckCircle2 className="w-4 h-4" />
                Submit Answers
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  onClick={handleReset}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-4 h-4" />
                  Retake
                </button>
                {submitted && missedIndices.length > 0 && (
                  <button
                    onClick={() => {
                      const firstMissed = document.getElementById(`question-${missedIndices[0]}`);
                      firstMissed?.scrollIntoView({ behavior: 'smooth' });
                    }}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <AlertCircle className="w-4 h-4" />
                    Review Mistakes
                  </button>
                )}
                {onNextTask && (
                  <button
                    onClick={onNextTask}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    Next Passage
                    <ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            )}

            {submitted && (
              <div className="flex flex-wrap items-center gap-3 text-xs sm:text-sm bg-slate-50 border border-slate-200 px-3.5 py-2 rounded-lg whitespace-nowrap shrink-0">
                <span className="whitespace-nowrap">
                  Score: <strong className="font-mono text-slate-900">{score}</strong>/{total}
                </span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="whitespace-nowrap">
                  Est. Scaled: <strong className="font-mono text-teal-800">Band {convertScaledToBand6(convertToScaledScore(score, total), 'Reading').toFixed(1)} / 6.0</strong> <span className="font-mono text-slate-500 text-xs">({convertToScaledScore(score, total)}/30)</span>
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
