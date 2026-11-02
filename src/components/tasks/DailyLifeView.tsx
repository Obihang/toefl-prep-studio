import React, { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2,
  RotateCcw,
  ArrowRight,
  HelpCircle,
  FileText,
  Mail,
  MessageSquare,
  Calendar,
  Utensils,
  Receipt,
  AlertCircle,
  Share2,
  Keyboard,
} from 'lucide-react';
import { convertToScaledScore, convertScaledToBand6, savePracticeRecord } from '../../utils/scoreTracker';
import { auth } from '../../firebase';
import { saveMistake } from '../../utils/mistakes';
import { ReadingQuestionSkill } from '../../types';
import { TaskSubtitleMeta, TaskReportButton } from '../shared/TaskHeaderMeta';

interface QuestionItem {
  q: string;
  options: string[];
  answer: number;
  why?: string;
  questionType?: string;
}

export interface DailyLifeTask {
  id?: string;
  title: string;
  formatType?: string;
  format?: string;
  category?: string;
  context?: string;
  contentText?: string;
  text?: string;
  passage?: string;
  notice?: string;
  level?: string;
  difficulty?: string;
  topic?: string;
  questions: QuestionItem[];
}

interface Props {
  task: DailyLifeTask;
  onNextTask?: () => void;
  onComplete?: (result: number) => void;
  skillFocus?: ReadingQuestionSkill;
  leftColumnClassName?: string;
  rightColumnClassName?: string;
  footerBarClassName?: string;
  coachMode?: boolean;
}

export const DailyLifeView: React.FC<Props> = ({
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
  const [activeQuestionIdx, setActiveQuestionIdx] = useState<number>(0);
  const [openHints, setOpenHints] = useState<Record<number, boolean>>({});
  const [checkedQuestions, setCheckedQuestions] = useState<Record<number, boolean>>({});

  useEffect(() => {
    setSelectedAnswers({});
    setSubmitted(false);
    setActiveQuestionIdx(0);
    setOpenHints({});
    setCheckedQuestions({});
  }, [task.id, task.title]);

  const format = (task.formatType || task.format || 'notice').toLowerCase();
  const textContent = task.contentText || task.text || task.notice || '';

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
          'Read in Daily Life',
          q.options[selectedAnswers[i]] ?? 'No answer',
          q.options[q.answer],
          q.why || 'Supported directly by the document.'
        );
      }
    });

    savePracticeRecord({
      taskType: 'daily-life',
      taskTitle: task.title,
      section: 'Reading',
      score: correctCount,
      maxScore: total,
      scaledScore30: scaledScore,
      timeSpentSeconds: 120,
      feedbackSummary: `Scored ${correctCount}/${total} on real-world document reading (${Math.round((correctCount / total) * 100)}%)`,
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
          document.getElementById(`dl-q-${nextIdx}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [submitted, selectedAnswers, allAnswered, activeQuestionIdx, total, handleSubmit]);

  const getFormatBadge = () => {
    switch (format) {
      case 'email':
        return { label: 'Official Email', icon: Mail, color: 'bg-blue-50 text-blue-700 border-blue-200' };
      case 'text-chain':
        return { label: 'SMS / Chat Chain', icon: MessageSquare, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
      case 'menu':
        return { label: 'Dining Menu', icon: Utensils, color: 'bg-amber-50 text-amber-700 border-amber-200' };
      case 'schedule':
        return { label: 'Campus Schedule', icon: Calendar, color: 'bg-purple-50 text-purple-700 border-purple-200' };
      case 'invoice':
        return { label: 'Receipt / Invoice', icon: Receipt, color: 'bg-slate-100 text-slate-800 border-slate-300' };
      case 'social-post':
        return { label: 'Social Announcement', icon: Share2, color: 'bg-indigo-50 text-indigo-700 border-indigo-200' };
      default:
        return { label: 'Campus Notice', icon: FileText, color: 'bg-teal-50 text-teal-700 border-teal-200' };
    }
  };

  const badge = getFormatBadge();
  const BadgeIcon = badge.icon;

  const renderDocumentContent = () => {
    if (format === 'email') {
      const lines = textContent.split('\n');
      const subjectLine = lines.find((l) => l.startsWith('Subject:')) || 'Subject: University Notice';
      const bodyLines = lines.filter((l) => !l.startsWith('Subject:')).join('\n').trim();

      return (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
          <div className="bg-slate-50 border-b border-slate-200 p-4 space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-700">From:</span>
              <span>{task.context || 'Campus Administration'}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-700">To:</span>
              <span>All Registered Students</span>
            </div>
            <div className="text-sm font-semibold text-slate-900 pt-1">
              {subjectLine.replace('Subject:', '').trim()}
            </div>
          </div>
          <div className="p-5 text-sm text-slate-800 leading-relaxed whitespace-pre-line font-normal">
            {bodyLines}
          </div>
        </div>
      );
    }

    if (format === 'text-chain') {
      const messages = textContent.split('\n').filter(Boolean);
      return (
        <div className="bg-slate-100 border border-slate-200 rounded-2xl p-5 shadow-xs max-w-xl mx-auto space-y-3">
          <div className="text-center text-xs font-medium text-slate-400 pb-2 border-b border-slate-200">
            {task.context || 'Group Chat — Active Today'}
          </div>
          {messages.map((msg, i) => {
            const isLeft = i % 2 === 0;
            return (
              <div
                key={i}
                className={`flex flex-col ${isLeft ? 'items-start' : 'items-end'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs sm:text-sm leading-relaxed shadow-xs ${
                    isLeft
                      ? 'bg-white text-slate-800 rounded-tl-xs border border-slate-200'
                      : 'bg-teal-700 text-white rounded-tr-xs'
                  }`}
                >
                  {msg}
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    if (format === 'invoice') {
      return (
        <div className="bg-amber-50/40 border-2 border-dashed border-amber-200 rounded-xl p-5 font-mono text-xs sm:text-sm text-slate-800 shadow-xs">
          <div className="text-center font-bold text-slate-900 uppercase tracking-widest pb-3 border-b border-dashed border-amber-300">
            {task.title}
          </div>
          <pre className="mt-3 whitespace-pre-line leading-relaxed font-mono font-medium text-slate-700">
            {textContent}
          </pre>
        </div>
      );
    }

    return (
      <div className="bg-white border-2 border-slate-200 rounded-xl p-6 shadow-xs relative">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-teal-600"></span>
            <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
              {task.context || 'Official Campus Bulletin'}
            </span>
          </div>
          <span className="text-xs text-slate-400">
            {textContent.split(/\s+/).length} words
          </span>
        </div>
        <div className="text-slate-800 leading-relaxed text-sm sm:text-base whitespace-pre-line font-normal">
          {textContent}
        </div>
      </div>
    );
  };

  const getQuestionSkillBadge = (qType?: string, qText?: string) => {
    const clean = (qType || '').trim().toLowerCase();
    const stem = (qText || '').toLowerCase();

    let resolved = clean;
    if (!resolved || resolved === 'factual') {
      if (/\b(not|except|least likely|false)\b/i.test(qText || '') && !/\b(cannot|whether or not)\b/i.test(qText || '')) {
        resolved = 'negative_factual';
      } else if (/\b(purpose|main reason|why did .* send|why was .* posted|why is .* writing|who issued|intended for|primarily to|written to)\b/i.test(stem)) {
        resolved = 'main_purpose';
      } else if (/\b(closest in meaning|mean by|means|the word|the phrase|expression|informal|refers to)\b/i.test(stem)) {
        resolved = 'idiomatic_meaning';
      } else if (/\b(infer|inferred|imply|implied|implies|most likely|probably|suggests|can be concluded|what will .* likely)\b/i.test(stem)) {
        resolved = 'inference';
      } else {
        resolved = 'factual_detail';
      }
    }

    switch (resolved) {
      case 'main_purpose':
      case 'rhetorical_purpose':
        return { label: 'Main Purpose', bg: 'bg-indigo-50 text-indigo-700 border-indigo-200', strategy: 'Identify the primary action or announcement the sender wants the recipient to understand.' };
      case 'inference':
        return { label: 'Inference', bg: 'bg-purple-50 text-purple-700 border-purple-200', strategy: 'Connect two specific conditions, dates, or policies in the document to see what logically follows.' };
      case 'idiomatic_meaning':
      case 'vocabulary':
        return { label: 'Idiomatic / Informal Meaning', bg: 'bg-amber-50 text-amber-700 border-amber-200', strategy: 'Read the surrounding sentences to determine the speaker’s practical intent behind the expression.' };
      case 'negative_factual':
        return { label: 'Negative Factual (EXCEPT)', bg: 'bg-rose-50 text-rose-700 border-rose-200', strategy: 'Verify each option against the document details; choose the one option that is NOT mentioned or is contradicted.' };
      case 'factual_detail':
      case 'factual':
      default:
        return { label: 'Factual Detail', bg: 'bg-teal-50 text-teal-700 border-teal-200', strategy: 'Scan the document for the exact date, fee, requirement, or location asked about in the question.' };
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="border-b border-slate-200 pb-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${badge.color}`}>
              <BadgeIcon className="w-3.5 h-3.5" />
              {badge.label}
            </span>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">{task.title}</h2>
            {coachMode && (
              <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-800 border border-indigo-200">
                🎓 Coach &amp; Marathon Mode ({task.questions.length} Questions)
              </span>
            )}
          </div>
          <TaskSubtitleMeta
            task={task}
            extra={
              <>
                <span>{task.questions.length} Questions</span>
                {skillFocus !== 'all' && (
                  <>
                    <span aria-hidden="true" className="mx-1">·</span>
                    <span className="text-teal-700 font-semibold bg-teal-50 px-2 py-0.5 rounded-sm">
                      Focus: {skillFocus.replace('_', ' ')}
                    </span>
                  </>
                )}
              </>
            }
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg">
            <Keyboard className="w-3.5 h-3.5 text-slate-400" />
            <span><strong className="font-semibold text-slate-800">Enter</strong>: Next item</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span><strong className="font-semibold text-teal-800">Ctrl + Enter</strong>: Submit</span>
          </div>
          <TaskReportButton task={task} />
        </div>
      </div>

      {/* Grid: Document on Left, Questions on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Authentic Real-world Document */}
        <div className={`lg:col-span-6 space-y-4 ${leftColumnClassName}`}>
          {renderDocumentContent()}
        </div>

        {/* Right Column: Questions */}
        <div className={`lg:col-span-6 space-y-5 ${rightColumnClassName}`}>
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
            const skillBadge = getQuestionSkillBadge(q.questionType, q.q);
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
                id={`dl-q-${qIdx}`}
                className={`bg-white border rounded-xl p-5 shadow-xs transition-colors ${
                  isQuestionChecked
                    ? isCorrect
                      ? 'border-emerald-200 bg-emerald-50/20'
                      : 'border-rose-200 bg-rose-50/20'
                    : 'border-slate-200'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center justify-center w-5 h-5 rounded-md bg-slate-100 text-slate-700 text-xs font-bold">
                      {qIdx + 1}
                    </span>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${skillBadge.bg}`}>
                      {skillBadge.label}
                    </span>
                  </div>
                  {coachMode && !submitted && (
                    <div className="flex items-center gap-1.5">
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
                                'Read in Daily Life',
                                q.options[userChoice] ?? 'No answer',
                                q.options[q.answer],
                                q.why || 'Supported directly by the document.'
                              );
                            }
                          }}
                          className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-teal-700 hover:bg-teal-800 text-white transition-colors cursor-pointer"
                        >
                          ✓ Check This Question
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {coachMode && openHints[qIdx] && !submitted && (
                  <div className="mb-3 p-3 rounded-lg bg-indigo-50/80 border border-indigo-200 text-xs text-indigo-950 space-y-1">
                    <div className="font-bold text-indigo-900">🎓 {skillBadge.label} Strategy:</div>
                    <p className="text-indigo-900 leading-relaxed">{hintText}</p>
                  </div>
                )}

                <p className="text-sm font-semibold text-slate-900 leading-snug mb-3">{q.q}</p>

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
                      optionClasses = 'border-teal-700 bg-teal-50/60 text-teal-900 font-medium ring-1 ring-teal-700';
                    }

                    return (
                      <label
                        key={optIdx}
                        onClick={() => handleSelect(qIdx, optIdx)}
                        className={`flex items-start gap-3 p-3 rounded-lg border text-xs sm:text-sm cursor-pointer transition-all ${optionClasses}`}
                      >
                        <input
                          type="radio"
                          name={`dl-question-${qIdx}`}
                          checked={isSelected}
                          onChange={() => handleSelect(qIdx, optIdx)}
                          disabled={submitted}
                          className="mt-0.5 text-teal-700 focus:ring-teal-700 shrink-0"
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
                        <span>{q.why || 'Supported directly by the text.'}</span>
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
                className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 disabled:hover:bg-teal-700 rounded-lg shadow-xs transition-colors whitespace-nowrap cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" />
                Submit Answers
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  onClick={handleReset}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                  Retake
                </button>
                {onNextTask && (
                  <button
                    onClick={onNextTask}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Next Document
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
