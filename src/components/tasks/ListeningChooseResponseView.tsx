import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Eye,
  EyeOff,
  HelpCircle,
  Headphones,
  Loader2,
  Keyboard,
} from 'lucide-react';
import {
  speakWithCloudTTS,
  stopSpeaking,
  prefetchSpeechAudio,
  stripSpeakerAndFormatting,
  fetchCloudTtsAudio,
  chunkTextForTTS,
  pickRandomVoice,
} from '../../utils/audioSpeech';
import {
  convertToScaledScore,
  convertScaledToBand6,
  savePracticeRecord,
} from '../../utils/scoreTracker';
import { auth } from '../../firebase';
import { saveMistake } from '../../utils/mistakes';
import { normalizeListeningChooseResponseTask } from '../../utils/taskNormalizer';
import { TaskSubtitleMeta, TaskReportButton } from '../shared/TaskHeaderMeta';

export interface ListeningChooseResponseItem {
  audioPrompt?: string;
  promptAudioScript?: string;
  script?: string;
  spokenPrompt?: string;
  prompt?: string;
  speakerName?: string;
  speakerGender?: 'male' | 'female';
  options: string[];
  answer: number;
  correctAnswer?: number;
  why?: string;
  explanation?: string;
}

export interface ListeningChooseResponseTask {
  id?: string;
  title: string;
  items?: ListeningChooseResponseItem[];
  audioPrompt?: string;
  promptAudioScript?: string;
  script?: string;
  spokenPrompt?: string;
  prompt?: string;
  speakerName?: string;
  speakerGender?: 'male' | 'female';
  options?: string[];
  answer?: number;
  correctAnswer?: number;
  why?: string;
  explanation?: string;
  category?: string;
  level?: string;
  difficulty?: string;
  topic?: string;
}

interface Props {
  task: ListeningChooseResponseTask;
  coachMode?: boolean;
  onNextTask?: () => void;
  onComplete?: (result: number) => void;
}

export const ListeningChooseResponseView: React.FC<Props> = ({
  task,
  coachMode = false,
  onNextTask,
  onComplete,
}) => {
  const normalizedTask = useMemo(() => normalizeListeningChooseResponseTask(task), [task]);

  const items: ListeningChooseResponseItem[] = useMemo(() => {
    if (Array.isArray(normalizedTask.items) && normalizedTask.items.length > 0) {
      return normalizedTask.items;
    }
    return [
      {
        audioPrompt:
          normalizedTask.audioPrompt ||
          normalizedTask.promptAudioScript ||
          normalizedTask.script ||
          normalizedTask.spokenPrompt ||
          normalizedTask.prompt ||
          '',
        speakerName: normalizedTask.speakerName || 'Campus Speaker',
        speakerGender: normalizedTask.speakerGender === 'female' ? 'female' : 'male',
        options: Array.isArray(normalizedTask.options) ? normalizedTask.options : [],
        answer:
          typeof normalizedTask.answer === 'number'
            ? normalizedTask.answer
            : Number(normalizedTask.correctAnswer ?? 0),
        why:
          normalizedTask.why ||
          normalizedTask.explanation ||
          'Most natural and contextually appropriate response in this campus situation.',
      },
    ];
  }, [normalizedTask]);

  const totalItems = items.length;
  const [chooseResponseActiveIdx, setChooseResponseActiveIdx] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, number>>({});
  const [chooseResponseSubmitted, setChooseResponseSubmitted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [playCounts, setPlayCounts] = useState<Record<number, number>>({});
  const [audioSpeed, setAudioSpeed] = useState<number>(1.0);
  const [revealedHints, setRevealedHints] = useState<Record<number, boolean>>({});
  const [checkedItems, setCheckedItems] = useState<Record<number, boolean>>({});

  const currentIndex = chooseResponseActiveIdx;
  const setCurrentIndex = setChooseResponseActiveIdx;
  const submitted = chooseResponseSubmitted;
  const setSubmitted = setChooseResponseSubmitted;

  const playbackSessionRef = useRef(0);
  const hasStartedSetRef = useRef(false);

  // Reset state when task changes
  useEffect(() => {
    playbackSessionRef.current++;
    hasStartedSetRef.current = false;
    stopSpeaking();
    setChooseResponseActiveIdx(0);
    setSelectedAnswers({});
    setChooseResponseSubmitted(false);
    setIsPlaying(false);
    setIsLoadingAudio(false);
    setShowTranscript(false);
    setPlayCounts({});
    setRevealedHints({});
    setCheckedItems({});
  }, [task.id, task.title]);

  const itemVoices = useMemo(() => {
    return items.map((it) => {
      const g: 'male' | 'female' = it.speakerGender === 'female' ? 'female' : 'male';
      return pickRandomVoice(g).voiceId;
    });
  }, [items]);

  const currentItem = items[chooseResponseActiveIdx] || items[0];
  const promptText =
    currentItem?.audioPrompt ||
    currentItem?.promptAudioScript ||
    currentItem?.script ||
    currentItem?.spokenPrompt ||
    currentItem?.prompt ||
    '';
  const cleanPrompt = stripSpeakerAndFormatting(promptText);
  const speakerName = currentItem?.speakerName || task.speakerName || 'Campus Speaker';
  const gender: 'male' | 'female' =
    currentItem?.speakerGender === 'female' ? 'female' : 'male';
  const voiceName = itemVoices[chooseResponseActiveIdx] || (gender === 'female' ? 'en-US-AriaNeural' : 'en-US-ChristopherNeural');

  const correctAnswerIdx =
    typeof currentItem?.answer === 'number'
      ? currentItem.answer
      : Number(currentItem?.correctAnswer ?? 0);
  const explanation =
    currentItem?.why ||
    currentItem?.explanation ||
    'Most natural and contextually appropriate response in this campus situation.';

  // Pre-warm TTS audio for all items on mount
  useEffect(() => {
    items.forEach((it, idx) => {
      const text = stripSpeakerAndFormatting(
        it.audioPrompt || it.promptAudioScript || it.script || it.spokenPrompt || it.prompt || ''
      );
      const g: 'male' | 'female' = it.speakerGender === 'female' ? 'female' : 'male';
      const v = itemVoices[idx] || (g === 'female' ? 'en-US-AriaNeural' : 'en-US-ChristopherNeural');
      if (text) {
        prefetchSpeechAudio(text, v, g).catch(() => {});
      }
    });
    return () => {
      stopSpeaking();
    };
  }, [items, itemVoices]);

  // Pre-fetch/warm the TTS audio for the next item (chooseResponseActiveIdx + 1) as soon as current item loads
  useEffect(() => {
    const nextIdx = chooseResponseActiveIdx + 1;
    const nextItem = items[nextIdx];
    if (!nextItem) return;
    const nextText = stripSpeakerAndFormatting(
      nextItem.audioPrompt ||
        nextItem.promptAudioScript ||
        nextItem.script ||
        nextItem.spokenPrompt ||
        nextItem.prompt ||
        ''
    );
    const nextGender: 'male' | 'female' = nextItem.speakerGender === 'female' ? 'female' : 'male';
    const nextVoice = itemVoices[nextIdx] || (nextGender === 'female' ? 'en-US-AriaNeural' : 'en-US-ChristopherNeural');
    if (nextText) {
      prefetchSpeechAudio(nextText, nextVoice, nextGender).catch(() => {});
    }
  }, [chooseResponseActiveIdx, items, itemVoices]);

  const playPromptForIndex = useCallback(
    async (targetIdx: number) => {
      const item = items[targetIdx];
      if (!item) return;
      const rawText =
        item.audioPrompt ||
        item.promptAudioScript ||
        item.script ||
        item.spokenPrompt ||
        item.prompt ||
        '';
      const itemCleanPrompt = stripSpeakerAndFormatting(rawText);
      if (!itemCleanPrompt) return;

      const itemGender: 'male' | 'female' =
        item.speakerGender === 'female' ? 'female' : 'male';
      const itemVoiceName =
        itemVoices[targetIdx] || (itemGender === 'female' ? 'en-US-AriaNeural' : 'en-US-ChristopherNeural');

      hasStartedSetRef.current = true;
      const currentSession = ++playbackSessionRef.current;
      stopSpeaking();
      setIsLoadingAudio(true);

      try {
        const chunks = chunkTextForTTS(itemCleanPrompt);
        if (chunks.length > 0) {
          await fetchCloudTtsAudio(chunks[0], itemGender, itemVoiceName);
        }

        if (playbackSessionRef.current !== currentSession) return;

        await speakWithCloudTTS(itemCleanPrompt, itemGender, {
          rate: coachMode ? audioSpeed : 0.96,
          voice: itemVoiceName,
          voiceName: itemVoiceName,
          gender: itemGender,
          onStart: () => {
            if (playbackSessionRef.current === currentSession) {
              setIsLoadingAudio(false);
              setIsPlaying(true);
              setPlayCounts((prev) => ({
                ...prev,
                [targetIdx]: (prev[targetIdx] || 0) + 1,
              }));
            }
          },
          onEnd: () => {
            if (playbackSessionRef.current === currentSession) {
              setIsPlaying(false);
              setIsLoadingAudio(false);
            }
          },
          onError: () => {
            if (playbackSessionRef.current === currentSession) {
              setIsPlaying(false);
              setIsLoadingAudio(false);
            }
          },
        });
      } catch {
        if (playbackSessionRef.current === currentSession) {
          setIsPlaying(false);
          setIsLoadingAudio(false);
        }
      }
    },
    [items, itemVoices, coachMode, audioSpeed]
  );

  // Auto-play spoken prompt when advancing to the next item (chooseResponseActiveIdx changing to 1, 2, 3, 4 when !chooseResponseSubmitted)
  useEffect(() => {
    if (!chooseResponseSubmitted && (chooseResponseActiveIdx > 0 || hasStartedSetRef.current)) {
      playPromptForIndex(chooseResponseActiveIdx);
    }
  }, [chooseResponseActiveIdx, chooseResponseSubmitted, playPromptForIndex]);

  // Switch between items
  const switchToItem = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= totalItems) return;
      hasStartedSetRef.current = true;
      playbackSessionRef.current++;
      stopSpeaking();
      setIsPlaying(false);
      setIsLoadingAudio(false);
      setChooseResponseActiveIdx(idx);
    },
    [totalItems]
  );

  const handlePlayAudio = async () => {
    if (isPlaying) {
      playbackSessionRef.current++;
      stopSpeaking();
      setIsPlaying(false);
      setIsLoadingAudio(false);
      return;
    }
    await playPromptForIndex(chooseResponseActiveIdx);
  };

  const handleSelectOption = (optIdx: number) => {
    if (chooseResponseSubmitted) return;
    hasStartedSetRef.current = true;
    setSelectedAnswers((prev) => ({
      ...prev,
      [chooseResponseActiveIdx]: optIdx,
    }));
  };

  const answeredCount = Object.keys(selectedAnswers).length;
  const selectedIdx =
    selectedAnswers[chooseResponseActiveIdx] !== undefined
      ? selectedAnswers[chooseResponseActiveIdx]
      : null;

  const handleSubmit = useCallback(() => {
    if (answeredCount === 0 || chooseResponseSubmitted) return;
    playbackSessionRef.current++;
    stopSpeaking();
    setIsPlaying(false);
    setChooseResponseSubmitted(true);
    setShowTranscript(true);

    let correctTotal = 0;
    items.forEach((it, idx) => {
      const userAns = selectedAnswers[idx];
      const rightAns =
        typeof it.answer === 'number' ? it.answer : Number(it.correctAnswer ?? 0);
      if (userAns === rightAns) {
        correctTotal++;
      } else if (userAns !== undefined) {
        saveMistake(
          `${task.title} (Item ${idx + 1})`,
          'Listen & Choose a Response',
          it.options?.[userAns] ?? 'No answer',
          it.options?.[rightAns] ?? '',
          it.why || it.explanation || 'Most natural and contextually appropriate response.'
        );
      }
    });

    const scaledScore = convertToScaledScore(correctTotal, totalItems);

    savePracticeRecord({
      taskType: 'listening-choose-response',
      taskTitle: task.title,
      section: 'Listening',
      score: correctTotal,
      maxScore: totalItems,
      scaledScore30: scaledScore,
      timeSpentSeconds: totalItems * 20,
      feedbackSummary: `Scored ${correctTotal}/${totalItems} on Listen & Choose a Response`,
    });

    onComplete?.(scaledScore);
  }, [answeredCount, chooseResponseSubmitted, items, selectedAnswers, task.title, totalItems, onComplete]);

  // Keyboard shortcuts: Enter (Next Item) and Ctrl + Enter (Submit All Answers)
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
        if (!chooseResponseSubmitted && answeredCount > 0) {
          handleSubmit();
        }
        return;
      }

      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        if (chooseResponseSubmitted) return;
        if (chooseResponseActiveIdx === totalItems - 1 && answeredCount === totalItems) {
          e.preventDefault();
          handleSubmit();
        } else if (selectedIdx !== null && chooseResponseActiveIdx < totalItems - 1) {
          e.preventDefault();
          switchToItem(chooseResponseActiveIdx + 1);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    chooseResponseSubmitted,
    chooseResponseActiveIdx,
    totalItems,
    answeredCount,
    selectedIdx,
    handleSubmit,
    switchToItem,
  ]);

  const handleReset = () => {
    playbackSessionRef.current++;
    hasStartedSetRef.current = false;
    stopSpeaking();
    setSelectedAnswers({});
    setChooseResponseSubmitted(false);
    setShowTranscript(false);
    setIsPlaying(false);
    setChooseResponseActiveIdx(0);
  };

  const totalScore = items.reduce((acc, it, idx) => {
    const rightAns =
      typeof it.answer === 'number' ? it.answer : Number(it.correctAnswer ?? 0);
    return acc + (selectedAnswers[idx] === rightAns ? 1 : 0);
  }, 0);
  const scaledScore30 = convertToScaledScore(totalScore, totalItems);
  const band6Score = convertScaledToBand6(scaledScore30);
  const isCurrentCorrect = submitted && selectedIdx === correctAnswerIdx;
  const currentPlayCount = playCounts[currentIndex] || 0;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      {/* Header */}
      <div className="border-b border-slate-200 pb-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">
              {task.title}
            </h2>
            <span className="text-xs font-bold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-md">
              Item {currentIndex + 1} of {totalItems}
            </span>
          </div>
          <TaskSubtitleMeta
            task={task}
            extra={`Speaker: ${speakerName} (${gender})`}
          />
        </div>

        <div className="flex flex-col sm:items-end gap-2 self-start sm:self-center">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg">
              <Keyboard className="w-3.5 h-3.5 text-slate-400" />
              <span>
                <strong className="font-semibold text-slate-800">Enter</strong>: Next item
              </span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span>
                <strong className="font-semibold text-teal-800">Ctrl + Enter</strong>: Submit
              </span>
            </div>
            <TaskReportButton task={task} />
          </div>

          {/* Item Stepper Pills (1 .. 5) */}
          {totalItems > 1 && (
            <div className="flex items-center gap-1.5">
              {items.map((it, idx) => {
                const isCurrent = idx === currentIndex;
                const isAnswered = selectedAnswers[idx] !== undefined;
                const rightAns =
                  typeof it.answer === 'number' ? it.answer : Number(it.correctAnswer ?? 0);
                const isItemRight = submitted && selectedAnswers[idx] === rightAns;

                let pillStyle = 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200';
                if (submitted) {
                  pillStyle = isItemRight
                    ? 'bg-emerald-100 text-emerald-900 border-emerald-400 font-bold'
                    : 'bg-rose-100 text-rose-900 border-rose-400 font-bold';
                } else if (isCurrent) {
                  pillStyle = 'bg-teal-700 text-white border-teal-700 font-bold shadow-xs';
                } else if (isAnswered) {
                  pillStyle = 'bg-teal-50 text-teal-900 border-teal-300 font-semibold';
                }

                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => switchToItem(idx)}
                    className={`w-8 h-8 rounded-lg text-xs border transition-all flex items-center justify-center cursor-pointer ${pillStyle} ${
                      isCurrent && submitted ? 'ring-2 ring-slate-900 ring-offset-1' : ''
                    }`}
                    title={`Item ${idx + 1} of ${totalItems}`}
                  >
                    {idx + 1}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Spoken Prompt Audio Card */}
      <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white rounded-2xl p-6 sm:p-8 shadow-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <span className="text-xs font-semibold text-teal-400 uppercase tracking-wider">
              Spoken Prompt · Item {currentIndex + 1} of {totalItems}
            </span>
            <p className="text-sm text-slate-300">
              Listen to {speakerName}. Select the most natural response from the 4 choices below (spoken prompt text is hidden during the test).
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handlePlayAudio}
              className={`flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all shadow-md cursor-pointer ${
                isPlaying
                  ? 'bg-amber-500 hover:bg-amber-600 text-slate-950 animate-pulse'
                  : 'bg-teal-500 hover:bg-teal-400 text-slate-950'
              }`}
            >
              {isLoadingAudio ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Loading...</span>
                </>
              ) : isPlaying ? (
                <>
                  <Pause className="w-5 h-5" />
                  <span>Pause Audio</span>
                </>
              ) : (
                <>
                  <Play className="w-5 h-5 fill-current" />
                  <span>{currentPlayCount > 0 ? 'Replay Prompt' : 'Play Spoken Prompt'}</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Audio Wave / Status Indicator */}
        <div className="mt-5 pt-4 border-t border-slate-700/60 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-teal-400" />
            <span>
              {isPlaying
                ? `Playing audio (${speakerName})...`
                : currentPlayCount > 0
                ? `Played ${currentPlayCount} time${currentPlayCount > 1 ? 's' : ''}`
                : 'Ready to listen — click Play Spoken Prompt'}
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {coachMode && (
              <div className="inline-flex items-center bg-slate-800 border border-slate-700 rounded-lg p-0.5 text-[11px]">
                {[
                  { rate: 0.85, label: '0.85x Slow' },
                  { rate: 1.0, label: '1.0x Normal' },
                  { rate: 1.15, label: '1.15x Fast' },
                ].map((sp) => (
                  <button
                    key={sp.rate}
                    type="button"
                    onClick={() => setAudioSpeed(sp.rate)}
                    className={`px-2 py-0.5 rounded-md font-semibold transition-colors cursor-pointer ${
                      audioSpeed === sp.rate
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    {sp.label}
                  </button>
                ))}
              </div>
            )}

            {(submitted || coachMode) && (
              <button
                type="button"
                onClick={() => setShowTranscript(!showTranscript)}
                className="flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300 cursor-pointer"
              >
                {showTranscript ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                {showTranscript ? 'Hide Prompt Text' : 'View Spoken Script'}
              </button>
            )}
          </div>
        </div>

        {/* Revealed Transcript (after submission or when toggled in Coach Mode) */}
        {(submitted || coachMode) && showTranscript && (
          <div className="mt-4 p-4 rounded-xl bg-slate-950/60 border border-slate-700 text-sm text-slate-200 leading-relaxed font-normal">
            <div className="text-[11px] font-semibold text-teal-400 uppercase tracking-wider mb-1">
              Spoken Transcript ({speakerName}):
            </div>
            &ldquo;{cleanPrompt}&rdquo;
          </div>
        )}
      </div>

      {/* Answer Choices */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
          <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider">
            Choose the best response for Item {currentIndex + 1}:
          </span>
          <div className="flex items-center gap-2">
            {coachMode && !submitted && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setRevealedHints((prev) => ({
                      ...prev,
                      [currentIndex]: !prev[currentIndex],
                    }))
                  }
                  className="text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                >
                  {revealedHints[currentIndex] ? 'Hide Pragmatic Hint' : '💡 Coach Hint'}
                </button>
                {selectedIdx !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      const nextChecked = !checkedItems[currentIndex];
                      setCheckedItems((prev) => ({
                        ...prev,
                        [currentIndex]: nextChecked,
                      }));
                      if (nextChecked && selectedIdx !== correctAnswerIdx) {
                        saveMistake(
                          `${task.title} (Item ${currentIndex + 1})`,
                          'Listen & Choose a Response',
                          currentItem?.options?.[selectedIdx] ?? 'No answer',
                          currentItem?.options?.[correctAnswerIdx] ?? '',
                          currentItem?.why || currentItem?.explanation || 'Most natural and contextually appropriate response.'
                        );
                      }
                    }}
                    className="text-[11px] font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                  >
                    {checkedItems[currentIndex] ? 'Hide Check' : '✓ Check Item'}
                  </button>
                )}
              </>
            )}
            <span className="text-xs text-slate-500 font-mono">
              {answeredCount} of {totalItems} answered
            </span>
          </div>
        </div>

        {coachMode && revealedHints[currentIndex] && !submitted && (
          <div className="p-3.5 rounded-xl bg-indigo-50/80 border border-indigo-200 text-xs text-indigo-950 leading-relaxed">
            <strong className="font-bold text-indigo-900">🎓 Conversational Pragmatics Tip:</strong>{' '}
            {(() => {
              const rawTip = (currentItem as any)?.coachTip || (currentItem as any)?.hint;
              if (typeof rawTip === 'string') return rawTip;
              if (rawTip && typeof rawTip === 'object') {
                return String(rawTip.text || rawTip.tip || rawTip.hint || JSON.stringify(rawTip));
              }
              return String(explanation || '');
            })()}
          </div>
        )}

        <div className="space-y-2.5">
          {(currentItem?.options || []).map((opt, optIdx) => {
            const isSelected = selectedIdx === optIdx;
            const isRightOption = correctAnswerIdx === optIdx;
            const optionLetter = String.fromCharCode(65 + optIdx);
            const showEval = submitted || Boolean(coachMode && checkedItems[currentIndex]);

            let optionClasses =
              'border-slate-200 bg-white hover:bg-slate-50 text-slate-800';

            if (showEval) {
              if (isRightOption) {
                optionClasses =
                  'border-emerald-500 bg-emerald-50 text-emerald-900 font-medium ring-1 ring-emerald-500';
              } else if (isSelected && !isRightOption) {
                optionClasses = 'border-rose-400 bg-rose-50 text-rose-900';
              } else {
                optionClasses = 'border-slate-200 bg-white text-slate-400 opacity-60';
              }
            } else if (isSelected) {
              optionClasses =
                'border-teal-700 bg-teal-50/70 text-teal-900 font-medium ring-2 ring-teal-700';
            }

            return (
              <label
                key={optIdx}
                onClick={() => handleSelectOption(optIdx)}
                className={`flex items-start gap-3.5 p-4 rounded-xl border text-sm sm:text-base cursor-pointer transition-all ${optionClasses}`}
              >
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs shrink-0 ${
                    showEval && isRightOption
                      ? 'bg-emerald-600 text-white'
                      : isSelected
                      ? 'bg-teal-700 text-white'
                      : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  {optionLetter}
                </div>
                <input
                  type="radio"
                  name={`choose-response-option-${currentIndex}`}
                  checked={isSelected}
                  onChange={() => handleSelectOption(optIdx)}
                  disabled={submitted}
                  className="sr-only"
                />
                <span className="leading-snug pt-0.5">{opt}</span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Post-Submission or Coach Check Explanation for Current Item */}
      {(submitted || (coachMode && checkedItems[currentIndex])) && (
        <div
          className={`p-5 rounded-xl border leading-relaxed text-sm ${
            selectedIdx === correctAnswerIdx
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <div className="flex items-start gap-2">
            <HelpCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <strong className="block font-semibold mb-1">
                Item {currentIndex + 1}: {selectedIdx === correctAnswerIdx ? 'Correct Response!' : 'Incorrect Choice'}
              </strong>
              <p className="text-slate-800 text-xs sm:text-sm">{explanation}</p>
            </div>
          </div>
        </div>
      )}

      {/* Navigation & Action Buttons */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
        <div className="flex items-center gap-2.5 w-full sm:w-auto flex-wrap">
          {totalItems > 1 && (
            <>
              <button
                type="button"
                onClick={() => switchToItem(currentIndex - 1)}
                disabled={currentIndex === 0}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 rounded-lg transition-colors cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
                Prev
              </button>
              <button
                type="button"
                onClick={() => switchToItem(currentIndex + 1)}
                disabled={currentIndex >= totalItems - 1}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 rounded-lg transition-colors cursor-pointer"
              >
                Next Item
                <ArrowRight className="w-4 h-4" />
              </button>
            </>
          )}

          {!submitted ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={answeredCount === 0}
              className="flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 disabled:hover:bg-teal-700 rounded-lg shadow-xs transition-colors cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              {totalItems > 1
                ? `Submit All (${answeredCount}/${totalItems})`
                : 'Submit Response'}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleReset}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                Retake Set
              </button>
              {onNextTask && (
                <button
                  type="button"
                  onClick={onNextTask}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors cursor-pointer"
                >
                  Next Practice Set
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </>
          )}
        </div>

        {submitted && (
          <div className="flex items-center gap-3 text-xs sm:text-sm bg-slate-50 border border-slate-200 px-3.5 py-2 rounded-lg">
            <span>
              Score:{' '}
              <strong className="font-mono text-slate-900">
                {totalScore}/{totalItems}
              </strong>
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>
              Est. Band:{' '}
              <strong className="font-mono text-teal-800">
                Band {band6Score.toFixed(1)} / 6.0
              </strong>
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
