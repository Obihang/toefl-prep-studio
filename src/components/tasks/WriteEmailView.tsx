import React, { useState, useEffect } from 'react';
import { WriteEmailTask } from '../../data/curatedQuestions';
import { evaluateLocally, mergeAiAndLocalEvaluation } from '../../utils/localEvaluator';
import { Sparkles, AlertCircle, ArrowRight, Zap, Clock, Play, Pause, RotateCcw } from 'lucide-react';
import { savePracticeRecord } from '../../utils/scoreTracker';
import { FeedbackComparison } from '../shared/FeedbackComparison';
import { auth } from '../../firebase';
import { saveMistake } from '../../utils/mistakes';
import { getApiHeaders, hasAnyStoredApiKey } from '../../utils/apiKey';
import { safeFetchJson } from '../../utils/apiHelper';
import { markUserAiRequest } from '../../utils/userActivity';
import { TaskSubtitleMeta, TaskReportButton } from '../shared/TaskHeaderMeta';

interface Props {
  task: WriteEmailTask;
  onNextTask?: () => void;
  onComplete?: (score: number) => void;
  onOpenApiKeySettings?: () => void;
  spellCheck?: boolean;
  annotatedReviewTitle?: string;
  localGraderLabel?: string;
  aiGraderLabel?: string;
  apiKeyPromptText?: string;
  isWritingTimerEnabled?: boolean;
  onToggleWritingTimer?: (enabled: boolean) => void;
  isWritingTimerRunning?: boolean;
  onChangeWritingTimerRunning?: (running: boolean) => void;
  writingTimerSeconds?: number;
  onChangeWritingTimerSeconds?: (seconds: number) => void;
  coachMode?: boolean;
}

const OFFICIAL_EMAIL_TIME_SECONDS = 420; // 7 minutes official ETS timing (PDF Page 14)

export const WriteEmailView: React.FC<Props> = ({
  task,
  onNextTask,
  onComplete,
  onOpenApiKeySettings,
  isWritingTimerEnabled: externalTimerEnabled,
  onToggleWritingTimer,
  isWritingTimerRunning: externalTimerRunning,
  onChangeWritingTimerRunning,
  writingTimerSeconds: externalTimerSeconds,
  onChangeWritingTimerSeconds,
  coachMode = false,
}) => {
  const defaultSubject = `Inquiry regarding ${task.title}`;
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState('');
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evalSeconds, setEvalSeconds] = useState(0);
  const [evalResult, setEvalResult] = useState<any>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [showCoachBlueprint, setShowCoachBlueprint] = useState(true);

  const coachBlueprint = React.useMemo(() => {
    const bp = (task as any).coachBlueprint;
    if (Array.isArray(bp) && bp.length > 0) return bp;
    return [
      {
        stage: '1. Formal Salutation & Purpose',
        purpose: 'Address the recipient politely and state your exact purpose in the opening sentence.',
        starters: [
          `Dear ${task.recipient.split(',')[0]},\n\nI am writing to formally inquire about `,
          'I hope this email finds you well. I am reaching out regarding ',
        ],
      },
      {
        stage: '2. Goal 1 & Supporting Context',
        purpose: `Address Goal 1: ${task.goals?.[0] || 'Provide background context clearly.'}`,
        starters: [
          'Specifically, I would like to explain that ',
          'As a current student in the program, I noticed that ',
        ],
      },
      {
        stage: '3. Goal 2 & Specific Details',
        purpose: `Address Goal 2: ${task.goals?.[1] || 'Elaborate on the second required point.'}`,
        starters: [
          'Furthermore, I would like to propose that ',
          'In addition to this, it would be helpful to know whether ',
        ],
      },
      {
        stage: '4. Goal 3 & Courteous Sign-Off',
        purpose: `Address Goal 3: ${task.goals?.[2] || 'Conclude with a polite next step.'}`,
        starters: [
          'Finally, could you please let me know ',
          'Thank you very much for your time and consideration.\n\nSincerely,\nAlex Rivera',
        ],
      },
    ];
  }, [task]);

  // Official 7-Minute Timer (auto-starts by default in Exam Mode; defaults to Off in Coach Mode)
  const [localTimerEnabled, setLocalTimerEnabled] = useState<boolean>(() => {
    if (coachMode) return false;
    try {
      return localStorage.getItem('toefl_writing_timer_enabled') !== 'false';
    } catch {
      return true;
    }
  });
  const isWritingTimerEnabled = coachMode ? localTimerEnabled : (externalTimerEnabled ?? localTimerEnabled);

  const [localTimeLeft, setLocalTimeLeft] = useState(OFFICIAL_EMAIL_TIME_SECONDS);
  const [localTimerRunning, setLocalTimerRunning] = useState<boolean>(() => isWritingTimerEnabled);

  const timeLeft = externalTimerSeconds ?? localTimeLeft;
  const isWritingTimerRunning = coachMode ? localTimerRunning : (externalTimerRunning ?? localTimerRunning);

  const setTimeLeft = (val: number | ((prev: number) => number)) => {
    const nextVal = typeof val === 'function' ? val(timeLeft) : val;
    setLocalTimeLeft(nextVal);
    onChangeWritingTimerSeconds?.(nextVal);
  };

  const setIsWritingTimerRunning = (val: boolean | ((prev: boolean) => boolean)) => {
    const nextVal = typeof val === 'function' ? val(isWritingTimerRunning) : val;
    setLocalTimerRunning(nextVal);
    onChangeWritingTimerRunning?.(nextVal);
  };

  const handleToggleTimerEnabled = (enabled: boolean) => {
    setLocalTimerEnabled(enabled);
    if (!coachMode) {
      try {
        localStorage.setItem('toefl_writing_timer_enabled', enabled ? 'true' : 'false');
      } catch {}
      onToggleWritingTimer?.(enabled);
    }
    if (enabled) {
      if (timeLeft <= 0) {
        setTimeLeft(OFFICIAL_EMAIL_TIME_SECONDS);
      }
      setIsWritingTimerRunning(true);
    } else {
      setIsWritingTimerRunning(false);
    }
  };

  useEffect(() => {
    if (coachMode) {
      setLocalTimerEnabled(false);
      setLocalTimerRunning(false);
    }
  }, [coachMode, task.id]);

  useEffect(() => {
    let timer: any = null;
    if (isWritingTimerEnabled && isWritingTimerRunning && timeLeft > 0 && (coachMode || externalTimerSeconds === undefined)) {
      timer = setInterval(() => {
        setLocalTimeLeft((prev) => (prev <= 1 ? 0 : prev - 1));
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isWritingTimerEnabled, isWritingTimerRunning, timeLeft, externalTimerSeconds, coachMode]);

  useEffect(() => {
    let interval: any = null;
    if (isEvaluating) {
      setEvalSeconds(0);
      interval = setInterval(() => setEvalSeconds((s) => s + 1), 1000);
    } else {
      setEvalSeconds(0);
    }
    return () => clearInterval(interval);
  }, [isEvaluating]);

  React.useEffect(() => {
    setSubject(`Inquiry regarding ${task.title}`);
    setBody('');
    setTimeLeft(OFFICIAL_EMAIL_TIME_SECONDS);
    setIsWritingTimerRunning(coachMode ? false : isWritingTimerEnabled);
    setIsEvaluating(false);
    setEvalResult(null);
    setEvalError(null);
    try {
      const draftStorageKey = `toefl_draft_write_email_${task.id || task.title}`;
      localStorage.removeItem(draftStorageKey);
    } catch {}
  }, [task.id, task.title, coachMode]);

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const wordCount = body.trim() ? body.trim().split(/\s+/).filter(Boolean).length : 0;
  const isWithinTarget = wordCount >= 80 && wordCount <= 130;

  const handleEvaluate = async (mode: 'local' | 'ai' = hasAnyStoredApiKey() ? 'ai' : 'local') => {
    // Automatically stop the countdown timer as soon as Evaluate Response is clicked
    setIsWritingTimerRunning(false);

    if (mode === 'ai') {
      markUserAiRequest();
    }
    if (wordCount < 40) {
      setEvalError('Please write at least 40 words before submitting for official TOEFL evaluation.');
      return;
    }

    setIsEvaluating(true);
    setEvalError(null);

    const localBaseline = evaluateLocally(
      'write-email',
      {
        title: task.title,
        situation: task.situation,
        recipient: task.recipient,
        goals: task.goals,
      },
      `Subject: ${subject}\n\n${body}`,
      { task }
    );

    let evalData: any = null;

    if (mode === 'local' || !hasAnyStoredApiKey()) {
      // 100% Zero-API Local Offline Evaluation (Instant)
      evalData = localBaseline;
    } else {
      try {
        const json = await safeFetchJson('/api/evaluate-response', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify({
            taskType: 'write-email',
            promptData: {
              title: task.title,
              situation: task.situation,
              recipient: task.recipient,
              goals: task.goals,
              suggestedWordCount: task.suggestedWordCount,
            },
            studentResponse: {
              subject,
              body,
              wordCount,
            },
          }),
        });

        if (json.success && json.data) {
          evalData = mergeAiAndLocalEvaluation(json.data, localBaseline);
        } else {
          evalData = localBaseline;
        }
      } catch (err: any) {
        console.warn('[WriteEmail] Network/API error, running local rubric evaluator:', err);
        evalData = localBaseline;
      }
    }

    if (evalData) {
      setEvalResult(evalData);

      if (evalData.corrections) {
        for (const correction of evalData.corrections) {
          await saveMistake(
            `${task.title || task.id} (Email Writing)`,
            'Write an Email',
            correction.original,
            correction.corrected,
            correction.explanation
          );
        }
      }

      const scaled = evalData.scaledScore || 25;
      const band6 = evalData.bandScore6 ?? (scaled >= 29 ? 6.0 : scaled >= 26 ? 5.5 : scaled >= 23 ? 5.0 : scaled >= 20 ? 4.5 : scaled >= 17 ? 4.0 : 3.5);

      savePracticeRecord({
        taskType: 'write-email',
        taskTitle: task.title,
        section: 'Writing',
        score: scaled,
        maxScore: 30,
        scaledScore30: scaled,
        bandScore6: band6,
        timeSpentSeconds: Math.max(10, OFFICIAL_EMAIL_TIME_SECONDS - timeLeft),
        studentResponse: `Subject: ${subject}\n\n${body}`,
        feedbackSummary:
          evalData.summary ||
          `Email Writing: Band ${band6.toFixed(1)}/6.0 · Raw Rubric: ${evalData.rawRubricScore ?? evalData.bandScore}/5.0 (${evalData.performanceLevel})`,
        grammarErrors: Array.isArray(evalData.corrections)
          ? evalData.corrections
          : Array.isArray(evalData.grammarErrors)
          ? evalData.grammarErrors
          : [],
        modelAnswer:
          evalData.modelBand6Rewrite ||
          evalData.exemplar ||
          (task as any).modelResponse ||
          (task as any).sampleAnswer ||
          '',
      });
      onComplete?.(scaled);
    }
    setIsEvaluating(false);
  };

  return (
    <div className="space-y-4">
      <div className="border-b border-slate-200 pb-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">{task.title}</h2>
          <TaskSubtitleMeta task={task} extra={`Target: ${task.suggestedWordCount}`} />
        </div>

        <div className="flex items-center gap-3 text-xs flex-wrap">
          {/* Official 7-Minute Countdown Timer with Auto-Start & Timer Off/On Toggle */}
          {isWritingTimerEnabled ? (
            <div className="flex items-center gap-1.5 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-lg">
              <Clock className={`w-3.5 h-3.5 ${isWritingTimerRunning ? 'text-teal-600' : 'text-slate-500'}`} />
              <span className={`font-mono font-bold ${timeLeft <= 60 ? 'text-rose-600 animate-pulse' : 'text-slate-800'}`}>
                {formatTimer(timeLeft)}
              </span>
              <button
                type="button"
                onClick={() => setIsWritingTimerRunning((r) => !r)}
                className="p-1 hover:bg-slate-200 rounded text-slate-600 transition-colors cursor-pointer"
                title={isWritingTimerRunning ? 'Pause official timer' : 'Resume 7-minute countdown'}
              >
                {isWritingTimerRunning ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTimeLeft(OFFICIAL_EMAIL_TIME_SECONDS);
                  setIsWritingTimerRunning(true);
                }}
                className="p-1 hover:bg-slate-200 rounded text-slate-600 transition-colors cursor-pointer"
                title="Reset timer to 07:00"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
              <span className="text-slate-300 select-none">|</span>
              <button
                type="button"
                onClick={() => handleToggleTimerEnabled(false)}
                className="px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-200 rounded transition-colors cursor-pointer"
                title="Turn off countdown timer for untimed practice"
              >
                ⏱️ Timer Off
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-lg text-slate-600">
              <span className="text-[11px] font-medium">Untimed Practice — Timer Off</span>
              <button
                type="button"
                onClick={() => handleToggleTimerEnabled(true)}
                className="px-2 py-0.5 text-[11px] font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded transition-colors cursor-pointer"
                title="Turn on 07:00 official countdown timer"
              >
                ⏱️ Timer On
              </button>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">Word Count:</span>
            <span
              className={`font-mono font-bold px-2 py-0.5 rounded ${
                isWithinTarget
                  ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                  : wordCount > 0
                  ? 'bg-amber-100 text-amber-900'
                  : 'bg-slate-100 text-slate-700'
              }`}
            >
              {wordCount} words
            </span>
          </div>
          <TaskReportButton task={task} />
        </div>
      </div>

      {/* Situation & Required Goals */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-5 space-y-4 bg-slate-50 border border-slate-200 rounded-xl p-5">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">
                Background Situation
              </span>
            </div>
            <p className="text-sm text-slate-800 leading-relaxed font-normal">{task.situation}</p>
          </div>

          <div className="pt-3 border-t border-slate-200">
            <span className="text-xs font-semibold text-slate-700 uppercase tracking-wider block mb-2">
              Mandatory Objectives (Must Cover All 3):
            </span>
            <ul className="space-y-2">
              {task.goals.map((g, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-slate-700 leading-snug">
                  <span className="flex items-center justify-center w-4 h-4 rounded-full bg-teal-100 text-teal-800 font-bold shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <span>{g}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="pt-2 text-xs text-slate-500">
            Recipient: <strong className="text-slate-800">{task.recipient}</strong>
          </div>
        </div>

        {/* Email Client Composer */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-3.5">
          {coachMode && (
            <div className="bg-indigo-50/70 border border-indigo-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-indigo-900 uppercase tracking-wider">
                  🎓 Step-by-Step Writing Coach &amp; Sentence Starters
                </span>
                <button
                  type="button"
                  onClick={() => setShowCoachBlueprint((v) => !v)}
                  className="text-[11px] font-semibold text-indigo-700 hover:text-indigo-950 underline cursor-pointer"
                >
                  {showCoachBlueprint ? 'Collapse Guide' : 'Expand Guide'}
                </button>
              </div>
              {showCoachBlueprint && (
                <div className="space-y-2.5">
                  {coachBlueprint.map((step: any, sIdx: number) => {
                    const stepTitle = String(step.stage || step.step || step.title || `Stage ${sIdx + 1}`);
                    const stepDesc = String(step.purpose || step.description || '');
                    const rawStarters = Array.isArray(step.starters) ? step.starters : [];

                    return (
                      <div key={sIdx} className="bg-white/90 border border-indigo-100 rounded-lg p-3 space-y-1.5">
                        <div className="text-xs font-bold text-indigo-950">{stepTitle}</div>
                        {stepDesc && <p className="text-[11px] text-slate-600 leading-snug">{stepDesc}</p>}
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {rawStarters.map((st: any, stIdx: number) => {
                            const starterText =
                              typeof st === 'string'
                                ? st
                                : st && typeof st === 'object'
                                ? String(st.text || st.starter || st.label || JSON.stringify(st))
                                : String(st || '');
                            if (!starterText) return null;

                            return (
                              <button
                                key={stIdx}
                                type="button"
                                onClick={() =>
                                  setBody((prev) =>
                                    prev.trim()
                                      ? `${prev.replace(/\s+$/, '')} ${starterText}`
                                      : starterText
                                  )
                                }
                                className="text-left text-[11px] bg-indigo-50 hover:bg-indigo-100 text-indigo-900 border border-indigo-200 px-2.5 py-1 rounded-md transition-colors cursor-pointer font-medium"
                                title="Click to insert sentence starter into your draft"
                              >
                                + &ldquo;{starterText.replace(/\n+/g, ' ')}&rdquo;
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="space-y-2 pb-2 border-b border-slate-100 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-16 text-slate-400 font-medium">To:</span>
              <span className="font-medium text-slate-800">{task.recipient}</span>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="email-subject" className="w-16 text-slate-400 font-medium">
                Subject:
              </label>
              <input
                id="email-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                data-gramm="false"
                data-gramm_editor="false"
                data-enable-grammarly="false"
                placeholder="e.g., Extension Request for Lab Paper (Marcus Vance)"
                className="flex-1 px-2.5 py-1 text-xs border border-slate-200 rounded-md bg-slate-50 focus:bg-white focus:border-teal-600 outline-hidden font-medium text-slate-900"
              />
            </div>
          </div>

          <textarea
            rows={10}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            data-gramm="false"
            data-gramm_editor="false"
            data-enable-grammarly="false"
            placeholder={`Dear ${task.recipient.split(',')[0]},\n\nI am writing to...`}
            className="w-full p-3.5 text-sm bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:bg-white focus:border-teal-600 focus:ring-2 focus:ring-teal-100 outline-hidden leading-relaxed font-normal"
          />

          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
            <div className="space-y-1 text-left w-full sm:w-auto">
              <span className="text-xs text-slate-500 block">
                {wordCount < 80 ? `Needs ${80 - wordCount} more words to reach target (80-120 words)` : 'Target length achieved.'}
              </span>
              {!hasAnyStoredApiKey() && onOpenApiKeySettings && (
                <button
                  type="button"
                  onClick={onOpenApiKeySettings}
                  className="text-[11px] text-teal-700 hover:text-teal-900 underline font-medium cursor-pointer"
                >
                  Want deeper semantic AI grading? Add a free Groq/Gemini key in Settings
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-end">
              {hasAnyStoredApiKey() ? (
                <>
                  <button
                    type="button"
                    onClick={() => handleEvaluate('local')}
                    disabled={isEvaluating}
                    className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-teal-900 bg-teal-50 hover:bg-teal-100 border border-teal-200 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                    title="Grade instantly in 0ms using deterministic local rubric and mechanics scanner"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                    <span>⚡ Instant Local Grader</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEvaluate('ai')}
                    disabled={isEvaluating}
                    className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg shadow-xs transition-colors whitespace-nowrap cursor-pointer"
                  >
                    {isEvaluating ? (
                      <>
                        <Sparkles className="w-4 h-4 animate-spin" /> Scoring your answer... {evalSeconds}s
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 text-teal-200" />
                        <span>✨ Deep AI Grader</span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => handleEvaluate('local')}
                  disabled={isEvaluating}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg shadow-xs transition-colors whitespace-nowrap cursor-pointer"
                >
                  {isEvaluating ? (
                    <>
                      <Sparkles className="w-4 h-4 animate-spin" /> Scoring your answer... {evalSeconds}s
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4 text-amber-300" /> Evaluate Response (Instant Local Grader)
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {evalError && (
        (evalError.toLowerCase().includes('no api key') ||
         evalError.toLowerCase().includes('invalid api key') ||
         evalError.toLowerCase().includes('api key not valid') ||
         evalError.toLowerCase().includes('add yours in dashboard') ||
         evalError.toLowerCase().includes('settings & api key')) ? (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2 text-amber-900">
            <div className="flex items-center gap-2 font-semibold text-sm">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>Add your free API key to use AI features</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
              {onOpenApiKeySettings && (
                <button
                  onClick={onOpenApiKeySettings}
                  className="px-3 py-1.5 bg-teal-800 hover:bg-teal-900 text-white font-semibold rounded-lg transition-colors cursor-pointer"
                >
                  Configure API Key
                </button>
              )}
              <span className="text-slate-500 font-medium">Supports Gemini, NVIDIA, Groq, OpenRouter, and custom keys</span>
            </div>
          </div>
        ) : (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 flex items-center gap-3 text-xs text-rose-800">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{evalError}</span>
          </div>
        )
      )}

      {/* AI Evaluation Diagnostic Card */}
      {evalResult && (
        <div className="bg-white border border-teal-200 rounded-xl p-6 shadow-sm space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-teal-700">Official ETS Rater Assessment</span>
                <span className="text-xs text-slate-400">·</span>
                <span className="text-xs font-medium text-slate-600">{evalResult.performanceLevel}</span>
              </div>
              <h3 className="text-lg font-bold text-slate-900 mt-1">Email Writing Diagnostic Report</h3>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <div className="bg-teal-50 border border-teal-200 px-3 py-1.5 rounded-lg text-center">
                <div className="text-[10px] text-teal-700 font-semibold uppercase tracking-wider">TOEFL Band (1-6)</div>
                <div className="text-base font-mono font-bold text-teal-900">
                  Band {(evalResult.bandScore6 ?? (evalResult.scaledScore >= 29 ? 6.0 : evalResult.scaledScore >= 26 ? 5.5 : evalResult.scaledScore >= 23 ? 5.0 : evalResult.scaledScore >= 20 ? 4.5 : 4.0)).toFixed(1)} / 6.0
                </div>
              </div>
              <div className="bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg text-center">
                <div className="text-[10px] text-slate-500 font-medium">Task Rubric</div>
                <div className="text-base font-mono font-bold text-slate-800">
                  {evalResult.rawRubricScore ?? evalResult.bandScore} / 5.0
                </div>
              </div>
              <div className="bg-slate-900 text-white px-3 py-1.5 rounded-lg text-center">
                <div className="text-[10px] text-slate-300 font-medium">Scaled Score</div>
                <div className="text-base font-mono font-bold text-teal-400">
                  {evalResult.scaledScore} / 30
                </div>
              </div>
            </div>
          </div>

          <div className="text-sm text-slate-700 bg-slate-50 p-4 rounded-lg leading-relaxed">
            {evalResult.summary}
          </div>

          {/* Criteria Grid */}
          {Array.isArray(evalResult.criteria) && evalResult.criteria.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {evalResult.criteria.map((crit: any, i: number) => (
                <div key={i} className="border border-slate-200 rounded-lg p-3.5 bg-white">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-slate-900">{crit.name}</span>
                    <span className="text-xs font-mono font-bold text-teal-800">
                      {crit.displayScore || (typeof crit.score === 'number' && crit.score <= 5 ? `${crit.score.toFixed(1)} / 5.0` : crit.score)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 leading-snug">{crit.feedback || crit.comment}</p>
                </div>
              ))}
            </div>
          )}

          {/* Feedback Comparison */}
          {evalResult && (
            <FeedbackComparison
              userResponse={body}
              exemplarResponse={evalResult.modelBand6Rewrite || evalResult.exemplar || (task as any).modelResponse || (task as any).sampleAnswer}
              corrections={Array.isArray(evalResult.corrections) ? evalResult.corrections : Array.isArray(evalResult.grammarErrors) ? evalResult.grammarErrors : []}
              topFixes={Array.isArray(evalResult.topFixes) ? evalResult.topFixes : []}
              modelBand6Rewrite={evalResult.modelBand6Rewrite || (task as any).modelResponse}
              benchmarkAnalysis={evalResult.benchmarkAnalysis}
              notice={evalResult.notice}
              subScores={evalResult.subScores}
              bulletAnalysis={evalResult.bulletAnalysis}
            />
          )}
        </div>
      )}

      <div className="pt-2 flex items-center justify-end gap-3">
        {(evalResult || body.trim().length > 0) && (
          <button
            type="button"
            onClick={() => {
              setSubject(`Inquiry regarding ${task.title}`);
              setBody('');
              setEvalResult(null);
              setEvalError(null);
              setTimeLeft(OFFICIAL_EMAIL_TIME_SECONDS);
              setIsWritingTimerRunning(isWritingTimerEnabled);
            }}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Try Again</span>
          </button>
        )}
        {onNextTask && (
          <button
            onClick={() => {
              setSubject(`Inquiry regarding ${task.title}`);
              setBody('');
              setEvalResult(null);
              setEvalError(null);
              setTimeLeft(OFFICIAL_EMAIL_TIME_SECONDS);
              onNextTask();
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Next Email Prompt
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
