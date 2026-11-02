import React, { useState, useEffect } from 'react';
import { AcademicDiscussionTask } from '../../data/curatedQuestions';
import { evaluateLocally, mergeAiAndLocalEvaluation } from '../../utils/localEvaluator';
import { MessageSquare, Sparkles, Send, AlertCircle, ArrowRight, User, Zap, Clock, Play, Pause, RotateCcw } from 'lucide-react';
import { savePracticeRecord } from '../../utils/scoreTracker';
import { FeedbackComparison } from '../shared/FeedbackComparison';
import { auth } from '../../firebase';
import { saveMistake } from '../../utils/mistakes';
import { getApiHeaders, hasAnyStoredApiKey } from '../../utils/apiKey';
import { safeFetchJson } from '../../utils/apiHelper';
import { markUserAiRequest } from '../../utils/userActivity';
import { TaskSubtitleMeta, TaskReportButton } from '../shared/TaskHeaderMeta';

interface Props {
  task: AcademicDiscussionTask;
  coachMode?: boolean;
  onNextTask?: () => void;
  onComplete?: (result: number) => void;
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
}

const OFFICIAL_DISCUSSION_TIME_SECONDS = 600; // 10 minutes official ETS Academic Discussion timing

export const AcademicDiscussionView: React.FC<Props> = ({
  task,
  coachMode = false,
  onNextTask,
  onComplete,
  onOpenApiKeySettings,
  isWritingTimerEnabled: externalTimerEnabled,
  onToggleWritingTimer,
  isWritingTimerRunning: externalTimerRunning,
  onChangeWritingTimerRunning,
  writingTimerSeconds: externalTimerSeconds,
  onChangeWritingTimerSeconds,
}) => {
  const [response, setResponse] = useState('');
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evalSeconds, setEvalSeconds] = useState(0);
  const [evalResult, setEvalResult] = useState<any>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [showCoachBlueprint, setShowCoachBlueprint] = useState(true);

  const coachBlueprint = React.useMemo(() => {
    const custom = (task as any).coachBlueprint;
    if (Array.isArray(custom) && custom.length > 0) return custom;
    return [
      {
        stage: '1. Direct Stance & Position',
        tip: 'State your clear position on the professor’s question in sentence 1 without repeating the prompt.',
        starters: [
          'In my view, the most compelling approach to this issue is ',
          'While both perspectives have merit, I strongly contend that ',
        ],
      },
      {
        stage: '2. Engage with a Classmate’s Point',
        tip: 'Acknowledge or respectfully challenge one student’s argument to show collaborative engagement.',
        starters: [
          'Building upon the point raised in the discussion, it is also crucial to consider ',
          'Although the opposing view highlights an important concern, it overlooks ',
        ],
      },
      {
        stage: '3. New Reasoning & Concrete Example',
        tip: 'Contribute an original reason or specific real-world mechanism that advances the seminar discussion.',
        starters: [
          'Specifically, empirical evidence from recent policy implementations demonstrates that ',
          'For instance, when institutions prioritize this framework, they consistently achieve ',
        ],
      },
    ];
  }, [task]);

  // Official 10-Minute Timer (auto-starts by default unless user toggled Timer Off or in Coach Mode)
  const [localTimerEnabled, setLocalTimerEnabled] = useState<boolean>(() => {
    if (coachMode) return false;
    try {
      return localStorage.getItem('toefl_writing_timer_enabled') !== 'false';
    } catch {
      return true;
    }
  });
  const isWritingTimerEnabled = externalTimerEnabled ?? localTimerEnabled;

  const [localTimeLeft, setLocalTimeLeft] = useState(OFFICIAL_DISCUSSION_TIME_SECONDS);
  const [localTimerRunning, setLocalTimerRunning] = useState<boolean>(() =>
    coachMode ? false : isWritingTimerEnabled
  );

  const timeLeft = externalTimerSeconds ?? localTimeLeft;
  const isWritingTimerRunning = externalTimerRunning ?? localTimerRunning;

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
    try {
      localStorage.setItem('toefl_writing_timer_enabled', enabled ? 'true' : 'false');
    } catch {}
    onToggleWritingTimer?.(enabled);
    if (enabled) {
      if (timeLeft <= 0) {
        setTimeLeft(OFFICIAL_DISCUSSION_TIME_SECONDS);
      }
      setIsWritingTimerRunning(true);
    } else {
      setIsWritingTimerRunning(false);
    }
  };

  useEffect(() => {
    let timer: any = null;
    if (isWritingTimerEnabled && isWritingTimerRunning && timeLeft > 0 && externalTimerSeconds === undefined) {
      timer = setInterval(() => {
        setLocalTimeLeft((prev) => (prev <= 1 ? 0 : prev - 1));
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isWritingTimerEnabled, isWritingTimerRunning, timeLeft, externalTimerSeconds]);

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
    setResponse('');
    setTimeLeft(OFFICIAL_DISCUSSION_TIME_SECONDS);
    setIsWritingTimerRunning(isWritingTimerEnabled);
    setIsEvaluating(false);
    setEvalResult(null);
    setEvalError(null);
    try {
      const draftStorageKey = `toefl_draft_academic_discussion_${task.id || task.title}`;
      localStorage.removeItem(draftStorageKey);
    } catch {}
  }, [task.id, task.title]);

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const wordCount = response.trim() ? response.trim().split(/\s+/).filter(Boolean).length : 0;
  const isTargetMet = wordCount >= 100 && wordCount <= 150;

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
      'academic-discussion',
      {
        title: task.title,
        professorPrompt: task.professorPrompt,
        s1: task.s1,
        s2: task.s2,
        question: task.question,
      },
      response,
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
            taskType: 'academic-discussion',
            promptData: {
              title: task.title,
              professorPrompt: task.professorPrompt,
              professor: `${task.professorName}: ${task.professorPrompt}`,
              s1: `${task.s1?.name}: ${task.s1?.text}`,
              s2: `${task.s2?.name}: ${task.s2?.text}`,
              question: task.question,
            },
            studentResponse: {
              response,
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
        console.warn('[AcademicDiscussion] Network/API error, running local rubric evaluator:', err);
        evalData = localBaseline;
      }
    }

    if (evalData) {
      setEvalResult(evalData);

      if (evalData.corrections) {
        for (const correction of evalData.corrections) {
          await saveMistake(
            `${task.title || task.id} (Academic Discussion)`,
            'Academic Discussion',
            correction.original,
            correction.corrected,
            correction.explanation
          );
        }
      }

      const scaled = evalData.scaledScore || 26;
      const band6 = evalData.bandScore6 ?? (scaled >= 29 ? 6.0 : scaled >= 26 ? 5.5 : scaled >= 23 ? 5.0 : scaled >= 20 ? 4.5 : scaled >= 17 ? 4.0 : 3.5);

      savePracticeRecord({
        taskType: 'academic-discussion',
        taskTitle: task.title,
        section: 'Writing',
        score: scaled,
        maxScore: 30,
        scaledScore30: scaled,
        bandScore6: band6,
        timeSpentSeconds: Math.max(10, OFFICIAL_DISCUSSION_TIME_SECONDS - timeLeft),
        studentResponse: response,
        feedbackSummary:
          evalData.summary ||
          `Academic Discussion: Band ${band6.toFixed(1)}/6.0 · Raw Rubric: ${evalData.rawRubricScore ?? evalData.bandScore}/5.0 (${evalData.performanceLevel})`,
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
          <TaskSubtitleMeta task={task} extra="Target: 100-130 words" />
        </div>

        <div className="flex items-center gap-3 text-xs flex-wrap">
          {/* Official 10-Minute Countdown Timer with Auto-Start & Timer Off/On Toggle */}
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
                title={isWritingTimerRunning ? 'Pause official timer' : 'Resume 10-minute countdown'}
              >
                {isWritingTimerRunning ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTimeLeft(OFFICIAL_DISCUSSION_TIME_SECONDS);
                  setIsWritingTimerRunning(true);
                }}
                className="p-1 hover:bg-slate-200 rounded text-slate-600 transition-colors cursor-pointer"
                title="Reset timer to 10:00"
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
                title="Turn on 10:00 official countdown timer"
              >
                ⏱️ Timer On
              </button>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">Word Count:</span>
            <span
              className={`font-mono font-bold px-2 py-0.5 rounded ${
                isTargetMet
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

      {/* Discussion Board Split Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Course Forum Feed */}
        <div className="lg:col-span-6 space-y-4">
          {/* Professor's Post */}
          <div className="bg-slate-900 text-white rounded-xl p-5 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-full bg-teal-500 text-slate-950 font-bold flex items-center justify-center text-xs">
                  {task.professorName.charAt(0)}
                </div>
                <div>
                  <span className="text-xs font-semibold text-teal-400 block">{task.professorName}</span>
                  <span className="text-[11px] text-slate-400">Course Instructor · Discussion Board Topic</span>
                </div>
              </div>
            </div>
            <p className="text-xs sm:text-sm text-slate-200 leading-relaxed font-normal whitespace-pre-line">
              {task.professorPrompt}
            </p>
          </div>

          {/* Peer Posts */}
          <div className="space-y-3">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">
              Classmate Contributions
            </span>

            {/* Student 1 */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-slate-100 text-slate-600 font-semibold flex items-center justify-center text-xs">
                  <User className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs font-bold text-slate-800">{task.s1.name}</span>
              </div>
              <p className="text-xs sm:text-sm text-slate-700 leading-relaxed font-normal">{task.s1.text}</p>
            </div>

            {/* Student 2 */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-slate-100 text-slate-600 font-semibold flex items-center justify-center text-xs">
                  <User className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs font-bold text-slate-800">{task.s2.name}</span>
              </div>
              <p className="text-xs sm:text-sm text-slate-700 leading-relaxed font-normal">{task.s2.text}</p>
            </div>
          </div>
        </div>

        {/* Right Column: Student Response Box */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 mb-1">
              <MessageSquare className="w-3.5 h-3.5 text-teal-700" />
              <span>Your Contribution to the Discussion</span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">{task.question}</p>
          </div>

          {coachMode && (
            <div className="bg-indigo-50/70 border border-indigo-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-indigo-900 uppercase tracking-wider">
                  🎓 Step-by-Step Discussion Coach &amp; Sentence Starters
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
                    const stepDesc = String(step.purpose || step.description || step.tip || '');
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
                                  setResponse((prev) =>
                                    prev.trim()
                                      ? `${prev.replace(/\s+$/, '')} ${starterText}`
                                      : starterText
                                  )
                                }
                                className="text-left text-[11px] bg-indigo-50 hover:bg-indigo-100 text-indigo-900 border border-indigo-200 px-2.5 py-1 rounded-md transition-colors cursor-pointer font-medium"
                                title="Click to insert sentence starter into your draft"
                              >
                                + &ldquo;{starterText}&rdquo;
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

          <textarea
            rows={12}
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            data-gramm="false"
            data-gramm_editor="false"
            data-enable-grammarly="false"
            placeholder={`Write your response here. Express your perspective, respond directly to ${task.s1?.name || 'Student A'} or ${task.s2?.name || 'Student B'}, and provide reasons and examples...`}
            className="w-full p-3.5 text-sm bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:bg-white focus:border-teal-600 focus:ring-2 focus:ring-teal-100 outline-hidden leading-relaxed font-normal"
          />

          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
            <div className="space-y-1 text-left w-full sm:w-auto">
              <span className="text-xs text-slate-500 block">
                {wordCount < 100 ? `${100 - wordCount} more words to reach target (100-130 words)` : 'Optimal length reached.'}
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
              <h3 className="text-lg font-bold text-slate-900 mt-1">Academic Discussion Evaluation Report</h3>
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
              userResponse={response}
              exemplarResponse={evalResult.modelBand6Rewrite || evalResult.exemplar || (task as any).modelResponse || (task as any).sampleAnswer}
              corrections={Array.isArray(evalResult.corrections) ? evalResult.corrections : Array.isArray(evalResult.grammarErrors) ? evalResult.grammarErrors : []}
              topFixes={Array.isArray(evalResult.topFixes) ? evalResult.topFixes : []}
              modelBand6Rewrite={evalResult.modelBand6Rewrite || (task as any).modelResponse}
              benchmarkAnalysis={evalResult.benchmarkAnalysis}
              notice={evalResult.notice}
              subScores={evalResult.subScores}
            />
          )}
        </div>
      )}

      <div className="pt-2 flex items-center justify-end gap-3">
        {(evalResult || response.trim().length > 0) && (
          <button
            type="button"
            onClick={() => {
              setResponse('');
              setEvalResult(null);
              setEvalError(null);
              setTimeLeft(OFFICIAL_DISCUSSION_TIME_SECONDS);
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
              setResponse('');
              setEvalResult(null);
              setEvalError(null);
              setTimeLeft(OFFICIAL_DISCUSSION_TIME_SECONDS);
              onNextTask();
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Next Discussion Topic
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
