import { parseDialogueLine } from '../../utils/voices';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { markUserAiRequest } from '../../utils/userActivity';
import { SpeakingInterviewTask } from '../../data/curatedQuestions';
import { Mic, Play, Sparkles, AlertCircle, ArrowRight, Loader2, Headphones, Zap, RotateCcw } from 'lucide-react';
import { OfflineTranscriberModal } from '../shared/OfflineTranscriberModal';
import { checkModelCachedStatus, getWhisperModelChoice } from '../../utils/localWhisperStt';
import {
  speakWithCloudTTS,
  chunkTextForTTS,
  fetchCloudTtsAudio,
  stopSpeaking,
  createVoiceSession,
  VoiceSession,
  playChime,
  playRecordingBeep,
  transcribeAudioBlob,
  prefetchSpeechAudio,
  stripSpeakerAndFormatting,
  pickRandomVoice,
  inferGenderFromSpeaker,
} from '../../utils/audioSpeech';
import { filterWhisperHallucinations, detectFillerWords } from '../../utils/audio/fluencyMetrics';
import { calculateSpeakingMetrics, SpeakingMetrics } from '../../utils/speakingMetrics';
import { savePracticeRecord } from '../../utils/scoreTracker';
import { saveMistake } from '../../utils/mistakes';
import { getApiHeaders, hasAnyStoredApiKey } from '../../utils/apiKey';
import { safeFetchJson } from '../../utils/apiHelper';
import { evaluateLocally, mergeAiAndLocalEvaluation } from '../../utils/localEvaluator';
import { SpeakingControls } from '../views/speaking/SpeakingControls';
import { SpeakingEvaluationCard } from '../views/speaking/SpeakingEvaluationCard';
import { TaskSubtitleMeta, TaskReportButton, CollapsibleTaskInstructions } from '../shared/TaskHeaderMeta';

interface Props {
  task: SpeakingInterviewTask;
  coachMode?: boolean;
  onNextTask?: () => void;
  onComplete?: (result: any) => void;
  onOpenApiKeySettings?: () => void;
  localGraderLabel?: string;
  aiGraderLabel?: string;
  apiKeyPromptText?: string;
  keyboardShortcutHint?: string;
  activeCardHighlightClass?: string;
}

export const SpeakingInterviewView: React.FC<Props> = ({
  task,
  coachMode = false,
  onNextTask,
  onComplete,
  onOpenApiKeySettings,
}) => {
  const [currentQIndex, setCurrentQIndex] = useState(0);
  const [, setStep] = useState<'idle' | 'speaking' | 'done'>('idle');
  const [answers, setAnswers] = useState<Record<string | number, any>>({});
  const answersRef = useRef<Record<string | number, any>>({});
  const [showPromptText, setShowPromptText] = useState<boolean>(coachMode);

  const [activeAudioIdx, setActiveAudioIdx] = useState<number | null>(null);
  const [loadingAudioIdx, setLoadingAudioIdx] = useState<number | null>(null);
  const [activeMicIdx, setActiveMicIdx] = useState<number | null>(null);
  const [micStatus, setMicStatus] = useState<'idle' | 'listening' | 'transcribing'>('idle');

  const [autoStart, setAutoStart] = useState(true);
  const autoStartRef = useRef(autoStart);
  autoStartRef.current = autoStart;

  const [timeLeft, setTimeLeft] = useState<number>(coachMode ? 90 : 45);
  const [audioLevel, setAudioLevel] = useState(0);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [transcribeSeconds, setTranscribeSeconds] = useState(0);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evalSeconds, setEvalSeconds] = useState(0);
  const [micNotice, setMicNotice] = useState<string | null>(null);
  const [evaluationResult, setEvaluationResult] = useState<any>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [isBenchmarkOpen, setIsBenchmarkOpen] = useState(true);
  const [audioBlobs, setAudioBlobs] = useState<Record<number, Blob>>({});
  const [audioErrors, setAudioErrors] = useState<Record<number, string | null>>({});

  const [isTranscriberModalOpen, setIsTranscriberModalOpen] = useState(false);
  const [isAnyModelCached, setIsAnyModelCached] = useState<boolean>(true);

  const blobsRef = useRef<Record<number, Blob>>({});
  const hasCompletedRef = useRef<boolean>(false);

  useEffect(() => {
    const checkCached = async () => {
      const active = getWhisperModelChoice();
      const isCached = await checkModelCachedStatus(active);
      setIsAnyModelCached(isCached);
    };
    checkCached();
  }, [isTranscriberModalOpen]);

  const [playingRecordingQIndex, setPlayingRecordingQIndex] = useState<number | null>(null);
  const activePlayingKeyRef = useRef<string | null>(null);
  const questionAudioRef = useRef<HTMLAudioElement | null>(null);
  const recordingAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackSessionIdRef = useRef<number>(0);
  const voiceSessionRef = useRef<VoiceSession | null>(null);

  const stopAllAudio = useCallback(() => {
    playbackSessionIdRef.current++;
    if (recordingAudioRef.current) {
      try {
        recordingAudioRef.current.pause();
        recordingAudioRef.current.currentTime = 0;
      } catch {}
      recordingAudioRef.current = null;
    }
    if (questionAudioRef.current) {
      try {
        questionAudioRef.current.pause();
        questionAudioRef.current.currentTime = 0;
      } catch {}
      questionAudioRef.current = null;
    }
    activePlayingKeyRef.current = null;
    setActiveAudioIdx(null);
    setLoadingAudioIdx(null);
    setPlayingRecordingQIndex(null);
    stopSpeaking();
  }, []);

  // Always start 100% clean on mount or task change (no old draft restoration across reloads)
  useEffect(() => {
    hasCompletedRef.current = false;
    blobsRef.current = {};
    setCurrentQIndex(0);
    setStep('idle');
    setEvaluationResult(null);
    setEvalError(null);
    setShowPromptText(coachMode);
    answersRef.current = {};
    setAnswers({});
    setAudioBlobs({});
    // Clean up any legacy draft keys
    try {
      const draftStorageKey = `toefl_draft_speaking_interview_${task.id || task.title}`;
      localStorage.removeItem(draftStorageKey);
    } catch {}
    return () => {
      stopAllAudio();
    };
  }, [task.id, task.title, stopAllAudio, coachMode]);

  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  const interviewerName = (task as any).interviewerName || 'Interviewer';
  const interviewerVoiceInfo = useMemo(() => {
    const explicitGender = (task as any).interviewerGender;
    const inferred =
      explicitGender === 'male' || explicitGender === 'female'
        ? explicitGender
        : inferGenderFromSpeaker(`${interviewerName} ${task.context || ''}`);
    return pickRandomVoice(inferred || undefined);
  }, [task.id, task.title, interviewerName, (task as any).interviewerGender, task.context]);

  const interviewerGender = interviewerVoiceInfo.gender;
  const interviewerVoice = interviewerVoiceInfo.voiceId;

  // Silent background pre-synthesis of interviewer questions using the SAME single interviewer voice
  useEffect(() => {
    if (!task?.questions || task.questions.length === 0) return;
    let cancelled = false;

    const firstQ = task.questions[0]?.question;
    if (firstQ) {
      const firstChunks = chunkTextForTTS(firstQ);
      if (firstChunks.length > 0) {
        fetchCloudTtsAudio(firstChunks[0], interviewerGender, interviewerVoice).catch(() => {});
      }
    }

    (async () => {
      for (const q of task.questions) {
        if (cancelled) break;
        await prefetchSpeechAudio(q.question, interviewerVoice, interviewerGender).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [task.id, task.title, interviewerVoice, interviewerGender, task.questions]);

  // Stop audio/timers/voice session on unmount
  useEffect(() => {
    return () => {
      if (voiceSessionRef.current) {
        voiceSessionRef.current.abort();
      }
      stopAllAudio();
    };
  }, [stopAllAudio]);

  // Live 45s TOEFL response countdown timer while recording
  const handleToggleMicRef = useRef<(qIdx: number) => Promise<void>>(async () => {});

  useEffect(() => {
    let interval: any = null;
    if (micStatus === 'listening' && activeMicIdx !== null) {
      const allowedSec = coachMode
        ? Math.max(90, task.questions[activeMicIdx]?.responseTimeSeconds || 90)
        : task.questions[activeMicIdx]?.responseTimeSeconds || 45;
      setRecordingSeconds(0);
      setTimeLeft(allowedSec);
      let remaining = allowedSec;
      const targetIdx = activeMicIdx;
      interval = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
        remaining -= 1;
        setTimeLeft(Math.max(0, remaining));
        if (remaining <= 0) {
          clearInterval(interval);
          handleToggleMicRef.current(targetIdx);
        }
      }, 1000);
    } else {
      setRecordingSeconds(0);
    }
    return () => clearInterval(interval);
  }, [micStatus, activeMicIdx, task.questions, coachMode]);

  // Live timer for transcription duration
  useEffect(() => {
    let interval: any = null;
    if (micStatus === 'transcribing') {
      setTranscribeSeconds(0);
      interval = setInterval(() => setTranscribeSeconds((s) => s + 1), 1000);
    } else {
      setTranscribeSeconds(0);
    }
    return () => clearInterval(interval);
  }, [micStatus]);

  // Live timer for evaluation duration
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

  const handlePlayQuestion = async (qIdx: number) => {
    setCurrentQIndex(qIdx);
    setTimeout(() => {
      document.getElementById(`interview-question-${qIdx}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 80);

    const itemKey = `question_${qIdx}`;
    const wasPlayingThis = activePlayingKeyRef.current === itemKey;
    stopAllAudio();
    if (wasPlayingThis) {
      return;
    }

    // If currently recording another question, stop it first
    if (voiceSessionRef.current && activeMicIdx !== null) {
      try {
        voiceSessionRef.current.abort();
      } catch {}
      voiceSessionRef.current = null;
      setActiveMicIdx(null);
      setMicStatus('idle');
      setAudioLevel(0);
    }

    activePlayingKeyRef.current = itemKey;
    const currentSession = ++playbackSessionIdRef.current;

    setLoadingAudioIdx(qIdx);
    setAudioErrors((prev) => ({ ...prev, [qIdx]: null }));

    const targetQ = task.questions[qIdx];
    if (!targetQ) return;
    const parsed = parseDialogueLine(targetQ.question);
    const cleanQ = parsed.spokenText || stripSpeakerAndFormatting(targetQ.question);
    const effGender = interviewerGender;
    const voice = interviewerVoice;

    // Pre-warm next question's first chunk in parallel if available
    const nextQ = task.questions[qIdx + 1]?.question;
    if (nextQ) {
      const nextChunks = chunkTextForTTS(nextQ);
      if (nextChunks.length > 0) {
        fetchCloudTtsAudio(nextChunks[0], effGender, voice).catch(() => {});
      }
    }

    if (playbackSessionIdRef.current !== currentSession) return;

    try {
      await speakWithCloudTTS(
        cleanQ,
        effGender,
        {
          rate: 0.95,
          voice,
          voiceName: voice,
          gender: effGender,
          speaker: interviewerName,
          onStart: () => {
            if (playbackSessionIdRef.current === currentSession) {
              setLoadingAudioIdx(null);
              setActiveAudioIdx(qIdx);
            }
          },
          onEnd: async () => {
            if (playbackSessionIdRef.current === currentSession) {
              if (activePlayingKeyRef.current === itemKey) activePlayingKeyRef.current = null;
              setActiveAudioIdx(null);
              setLoadingAudioIdx(null);
              if (autoStartRef.current) {
                await playRecordingBeep();
                if (playbackSessionIdRef.current === currentSession) {
                  handleToggleMicRef.current(qIdx);
                }
              }
            }
          },
          onError: (err) => {
            if (playbackSessionIdRef.current === currentSession) {
              if (activePlayingKeyRef.current === itemKey) activePlayingKeyRef.current = null;
              setActiveAudioIdx(null);
              setLoadingAudioIdx(null);
              setAudioErrors((prev) => ({ ...prev, [qIdx]: err?.message || String(err) }));
            }
          },
        },
        voice
      );
    } catch (err: any) {
      if (playbackSessionIdRef.current === currentSession) {
        if (activePlayingKeyRef.current === itemKey) activePlayingKeyRef.current = null;
        setActiveAudioIdx(null);
        setLoadingAudioIdx(null);
        setAudioErrors((prev) => ({ ...prev, [qIdx]: err?.message || String(err) }));
      }
    }
  };

  const handleEvaluateAI = async (
    mode: 'local' | 'ai' = hasAnyStoredApiKey() ? 'ai' : 'local',
    overrideAnswers?: Record<string | number, any>
  ) => {
    if (mode === 'ai') {
      markUserAiRequest();
    }
    if (voiceSessionRef.current && activeMicIdx !== null) {
      const prevSession = voiceSessionRef.current;
      voiceSessionRef.current = null;
      try {
        await prevSession.stop();
      } catch {}
      setActiveMicIdx(null);
      setMicStatus('idle');
    }

    const effectiveAnswers = overrideAnswers || answersRef.current || answers;
    const hasAnyAnswer = task.questions.some((_, i) => {
      const a = effectiveAnswers[i];
      return typeof a === 'string' && a.trim().length > 0;
    });

    if (!hasAnyAnswer) {
      setEvalError('Please provide a spoken or typed response to at least one question before requesting evaluation.');
      return;
    }

    setIsEvaluating(true);
    setEvalError(null);

    const submissionData = task.questions.map((q, i) => {
      const rawResp = typeof effectiveAnswers[i] === 'string' ? effectiveAnswers[i] : '';
      const { transcript: response } = filterWhisperHallucinations(rawResp, []);
      const fillerWords = ['um', 'uh', 'like', 'er', 'ah', 'actually', 'basically'];
      const words = response.toLowerCase().match(/\b\w+\b/g) || [];
      const metrics = effectiveAnswers[`metrics_${i}`] as SpeakingMetrics | undefined;
      const fillerCount = metrics?.fillerWordCount ?? words.filter((w) => fillerWords.includes(w)).length;
      const wordCount = words.length;
      const timeInMinutes = (q.responseTimeSeconds || 45) / 60;
      const wpm =
        metrics?.wpm !== undefined
          ? metrics.wpm
          : timeInMinutes > 0
          ? Math.round(wordCount / timeInMinutes)
          : 0;

      return {
        question: q.question,
        transcript: response,
        studentResponse: response,
        fillerCount,
        wpm,
      };
    });

    const avgWpm = Math.round(
      submissionData.reduce((acc, s) => acc + (s.wpm || 120), 0) / (submissionData.length || 1)
    );
    const totalPauses = submissionData.reduce((acc, _, i) => {
      const m = effectiveAnswers[`metrics_${i}`] as SpeakingMetrics | undefined;
      return acc + (m?.pauseCount || 0);
    }, 0);
    const maxPause = Math.max(
      ...submissionData.map(
        (_, i) => (effectiveAnswers[`metrics_${i}`] as SpeakingMetrics | undefined)?.longestPauseSeconds || 0
      ),
      0
    );
    const totalFillers = submissionData.reduce((acc, s) => acc + (s.fillerCount || 0), 0);

    const localBaseline = evaluateLocally(
      'speaking-interview',
      {
        title: task.title,
        context: task.context,
        questions: task.questions.map((q) => q.question),
      },
      submissionData,
      {
        task,
        submissionData,
        wpm: avgWpm,
        pauseCount: totalPauses,
        longestPause: maxPause,
        fillerCount: totalFillers,
      }
    );

    let evalData: any = null;

    if (mode === 'local' || !hasAnyStoredApiKey()) {
      evalData = localBaseline;
    } else {
      try {
        const json = await safeFetchJson('/api/evaluate-response', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify({
            taskType: 'speaking-interview',
            promptData: {
              title: task.title,
              context: task.context,
              questions: task.questions.map((q) => q.question),
            },
            studentResponse: submissionData,
          }),
        });

        if (json.success && json.data) {
          evalData = mergeAiAndLocalEvaluation(json.data, localBaseline);
        } else {
          evalData = localBaseline;
        }
      } catch (err: any) {
        console.warn('[SpeakingInterview] Network error, running local rubric evaluator:', err);
        evalData = localBaseline;
      }
    }

    if (evalData) {
      setEvaluationResult({ ...evalData, submissionData });

      if (Array.isArray(evalData.corrections)) {
        for (const correction of evalData.corrections) {
          if (correction?.original && correction?.corrected) {
            await saveMistake(
              `${task.title} (Speaking Interview)`,
              'Take an Interview',
              correction.original,
              correction.corrected,
              correction.explanation || 'Speaking grammar & lexical refinement'
            );
          }
        }
      }

      const scaled = evalData.scaledScore || 24;
      const band6 =
        evalData.bandScore6 ??
        (scaled >= 29
          ? 6.0
          : scaled >= 26
          ? 5.5
          : scaled >= 23
          ? 5.0
          : scaled >= 20
          ? 4.5
          : scaled >= 17
          ? 4.0
          : 3.5);

      const formattedTranscript = submissionData
        .map(
          (s, idx) =>
            `Q${idx + 1}: ${s.question}\nResponse: ${s.studentResponse?.trim() || '(No response recorded)'}`
        )
        .join('\n\n');

      savePracticeRecord({
        taskType: 'speaking-interview',
        taskTitle: task.title,
        section: 'Speaking',
        score: scaled,
        maxScore: 30,
        scaledScore30: scaled,
        bandScore6: band6,
        timeSpentSeconds: 240,
        studentResponse: formattedTranscript,
        feedbackSummary:
          evalData.summary ||
          `Speaking Interview: Band ${band6.toFixed(1)}/6.0 · Raw Rubric: ${
            evalData.rawRubricScore ?? evalData.bandScore
          }/4.0 (${evalData.performanceLevel})`,
        grammarErrors: Array.isArray(evalData.corrections)
          ? evalData.corrections
          : Array.isArray(evalData.grammarErrors)
          ? evalData.grammarErrors
          : [],
        modelAnswer: evalData.modelBand6Rewrite || evalData.exemplar || '',
      });

      if (!hasCompletedRef.current) {
        hasCompletedRef.current = true;
        onComplete?.(scaled);
      }

      setTimeout(() => {
        document.getElementById('interview-evaluation-result')?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 150);
    }
    setIsEvaluating(false);
  };

  const handleToggleMic = async (qIdx: number) => {
    setMicNotice(null);
    markUserAiRequest();
    setCurrentQIndex(qIdx);

    // If currently recording this question, stop and finalize transcript
    if (activeMicIdx === qIdx && voiceSessionRef.current) {
      const activeSession = voiceSessionRef.current;
      voiceSessionRef.current = null;
      setMicStatus('transcribing');

      let finalTranscript = '';
      let finalMetrics: SpeakingMetrics | undefined = undefined;

      try {
        const result = await activeSession.stop();
        if (result.audioBlob) {
          blobsRef.current[qIdx] = result.audioBlob;
          setAudioBlobs((prev) => ({
            ...prev,
            [qIdx]: result.audioBlob!,
          }));
        }

        const { transcript: cleanedFromSession } = filterWhisperHallucinations(
          result.transcript || '',
          []
        );
        finalTranscript = cleanedFromSession.trim();
        finalMetrics = result.metrics;

        // If session returned empty transcript but we have a non-silent audio blob, run transcribeAudioBlob
        if (!finalTranscript && !result.isSilent && result.audioBlob && result.audioBlob.size > 500) {
          try {
            const sttRes = await transcribeAudioBlob(result.audioBlob);
            const { transcript: cleanedStt } = filterWhisperHallucinations(
              sttRes.transcript || '',
              sttRes.words || []
            );
            if (cleanedStt.trim()) {
              finalTranscript = cleanedStt.trim();
              finalMetrics =
                sttRes.metrics ||
                calculateSpeakingMetrics(
                  sttRes.words || [],
                  finalTranscript,
                  (sttRes.durationMs || 0) / 1000,
                  task.questions[qIdx]?.responseTimeSeconds || 45
                );
            }
          } catch (sttErr) {
            console.warn('[SpeakingInterview] transcribeAudioBlob fallback notice:', sttErr);
          }
        }

        // Fall back to any live transcript already in answersRef if non-empty and not a hallucination
        if (!finalTranscript) {
          const existingLive =
            typeof answersRef.current[qIdx] === 'string' ? answersRef.current[qIdx] : '';
          const { transcript: cleanedExisting } = filterWhisperHallucinations(existingLive, []);
          finalTranscript = cleanedExisting.trim();
        }

        const updatedAnswers = {
          ...answersRef.current,
          [qIdx]: finalTranscript,
          ...(finalMetrics ? { [`metrics_${qIdx}`]: finalMetrics } : {}),
        };
        answersRef.current = updatedAnswers;
        setAnswers(updatedAnswers);
      } catch (err: any) {
        setMicNotice(err.message || 'Failed to process voice recording');
      } finally {
        setActiveMicIdx(null);
        setMicStatus('idle');
        setAudioLevel(0);
        setStep('idle');
        playChime(440, 250);
      }

      // Auto-Flow advancement to next question (Q1 -> Q2 -> Q3 -> Q4) or final evaluation
      if (autoStartRef.current) {
        if (qIdx + 1 < task.questions.length) {
          const nextIdx = qIdx + 1;
          setCurrentQIndex(nextIdx);
          setTimeout(() => {
            document.getElementById(`interview-question-${nextIdx}`)?.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
            });
            handlePlayQuestion(nextIdx);
          }, 500);
        } else if (qIdx >= task.questions.length - 1) {
          setStep('done');
          const hasAnySpoken = task.questions.some((_, i) => {
            const val = answersRef.current[i];
            return typeof val === 'string' && val.trim().length > 0;
          });
          if (hasAnySpoken) {
            setTimeout(() => {
              handleEvaluateAI(hasAnyStoredApiKey() ? 'ai' : 'local', answersRef.current);
            }, 300);
          } else {
            setTimeout(() => {
              document.getElementById('interview-evaluation-result')?.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
              });
            }, 200);
          }
        }
      }
      return;
    }

    // If currently recording another question, stop it first and preserve its blob
    if (voiceSessionRef.current && activeMicIdx !== null) {
      const prevIdx = activeMicIdx;
      const prevSession = voiceSessionRef.current;
      voiceSessionRef.current = null;
      try {
        const prevResult = await prevSession.stop();
        if (prevResult.audioBlob) {
          blobsRef.current[prevIdx] = prevResult.audioBlob;
          setAudioBlobs((prev) => ({ ...prev, [prevIdx]: prevResult.audioBlob! }));
        }
      } catch {}
      setAudioLevel(0);
    }

    // Stop any playing question audio before opening the mic
    stopAllAudio();

    // Clear old text and metrics for this question so it starts fresh
    const clearedAnswers = {
      ...answersRef.current,
      [qIdx]: '',
      [`metrics_${qIdx}`]: undefined,
    };
    answersRef.current = clearedAnswers;
    setAnswers(clearedAnswers);

    const allowedSec = task.questions[qIdx]?.responseTimeSeconds || 45;
    setTimeLeft(allowedSec);
    setStep('speaking');

    const session = createVoiceSession({
      onTranscriptUpdate: (transcript) => {
        const { transcript: cleanedLive } = filterWhisperHallucinations(transcript, []);
        setAnswers((prev) => {
          const next = {
            ...prev,
            [qIdx]: cleanedLive,
          };
          answersRef.current = next;
          return next;
        });
      },
      onAudioLevel: (lvl) => setAudioLevel(lvl),
      onQuietWarning: (warning) => setMicNotice(warning),
      onDeviceDisconnected: (msg) => setMicNotice(msg),
      onNotice: (notice) => setMicNotice(notice),
      onStatusChange: (status, errorMsg) => {
        if (status === 'listening' || status === 'waiting_for_voice') {
          setMicStatus('listening');
        } else if (status === 'processing') {
          setMicStatus('transcribing');
        } else if (status === 'idle') {
          setMicStatus('idle');
          setAudioLevel(0);
        } else if (status === 'error') {
          setMicStatus('idle');
          setActiveMicIdx(null);
          setAudioLevel(0);
          if (errorMsg) setMicNotice(errorMsg);
        }
      },
    });

    voiceSessionRef.current = session;
    setActiveMicIdx(qIdx);

    try {
      await session.start();
    } catch (err: any) {
      voiceSessionRef.current = null;
      setActiveMicIdx(null);
      setMicStatus('idle');
      setAudioLevel(0);
      setMicNotice(err.message || 'Microphone could not be accessed. You can type your response.');
    }
  };

  handleToggleMicRef.current = handleToggleMic;

  const handlePlayUserRecording = (qIndex: number) => {
    const itemKey = `user_rec_${qIndex}`;
    const wasPlayingThis = activePlayingKeyRef.current === itemKey;
    stopAllAudio();
    if (wasPlayingThis) {
      return;
    }

    const blob = audioBlobs[qIndex] || blobsRef.current[qIndex];
    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.loop = false;
    activePlayingKeyRef.current = itemKey;
    recordingAudioRef.current = audio;
    setPlayingRecordingQIndex(qIndex);

    audio.onended = () => {
      if (recordingAudioRef.current === audio) {
        recordingAudioRef.current = null;
      }
      if (activePlayingKeyRef.current === itemKey) {
        activePlayingKeyRef.current = null;
      }
      setPlayingRecordingQIndex(null);
      URL.revokeObjectURL(url);
    };

    audio.onerror = () => {
      if (recordingAudioRef.current === audio) {
        recordingAudioRef.current = null;
      }
      if (activePlayingKeyRef.current === itemKey) {
        activePlayingKeyRef.current = null;
      }
      setPlayingRecordingQIndex(null);
      URL.revokeObjectURL(url);
    };

    audio.play().catch(() => {
      if (recordingAudioRef.current === audio) {
        recordingAudioRef.current = null;
      }
      if (activePlayingKeyRef.current === itemKey) {
        activePlayingKeyRef.current = null;
      }
      setPlayingRecordingQIndex(null);
      URL.revokeObjectURL(url);
    });
  };

  // Auto-scroll to the active question card whenever currentQIndex, activeMicIdx, or activeAudioIdx changes
  useEffect(() => {
    const activeIdx =
      activeMicIdx !== null
        ? activeMicIdx
        : activeAudioIdx !== null
        ? activeAudioIdx
        : currentQIndex;
    if (activeIdx > 0 || activeMicIdx !== null || activeAudioIdx !== null) {
      document.getElementById(`interview-question-${activeIdx}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [currentQIndex, activeMicIdx, activeAudioIdx]);

  // Press Enter while recording to immediately stop recording and trigger transcription
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && activeMicIdx !== null && micStatus === 'listening') {
        e.preventDefault();
        e.stopPropagation();
        handleToggleMicRef.current(activeMicIdx);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeMicIdx, micStatus]);

  return (
    <div className="space-y-6">
      {/* Offline Transcriber Model Modal */}
      <OfflineTranscriberModal
        isOpen={isTranscriberModalOpen}
        onClose={() => setIsTranscriberModalOpen(false)}
        onModelChanged={() => {
          const active = getWhisperModelChoice();
          checkModelCachedStatus(active).then(setIsAnyModelCached);
        }}
      />

      <div className="border-b border-slate-200 pb-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">{task.title}</h2>
          <TaskSubtitleMeta
            task={task}
            extra={`Interviewer: ${interviewerName} · ${task.questions.length} Questions (0s Prep · 45s)`}
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Question selector tabs */}
          <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-lg">
            {task.questions.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setCurrentQIndex(i);
                  document.getElementById(`interview-question-${i}`)?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                  });
                }}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
                  currentQIndex === i
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span>Q{i + 1}</span>
                {activeMicIdx === i && micStatus === 'transcribing' ? (
                  <Loader2 className="w-3 h-3 animate-spin text-teal-600 shrink-0" />
                ) : answers[i]?.trim() ? (
                  <span className="text-teal-600">✓</span>
                ) : null}
              </button>
            ))}
          </div>
          <TaskReportButton task={task} />
        </div>
      </div>

      {!isAnyModelCached && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-amber-900 animate-in fade-in">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <strong className="font-bold block text-slate-900">
                Offline Whisper Speech Transcriber Not Downloaded Yet
              </strong>
              <span>
                Download model (~75MB / ~245MB) once to enable 100% offline speech recognition without API keys.
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsTranscriberModalOpen(true)}
            className="px-4 py-2 bg-amber-800 hover:bg-amber-900 text-white font-bold rounded-lg transition-colors shrink-0 shadow-2xs"
          >
            Download Model (~75MB / ~245MB)
          </button>
        </div>
      )}

      {task.context && (
        <CollapsibleTaskInstructions
          label="Task Instructions"
          summary={`Scenario: ${task.context} · 4 questions from ${interviewerName} (0s prep · BEEP → 45s response)`}
        >
          <strong>Interview Scenario:</strong> {task.context} You will answer 4 sequential questions from{' '}
          <strong>{interviewerName}</strong>. There is <strong>0 seconds of preparation time</strong>—as soon as the
          interviewer finishes asking a question, a <strong>BEEP</strong> will sound and your{' '}
          <strong>45-second recording timer</strong> begins immediately (press <strong>Enter</strong> anytime while
          recording to stop and transcribe).
        </CollapsibleTaskInstructions>
      )}

      {/* Unified Top-Level Auto-Flow Control Bar */}
      <div className="bg-teal-50/70 border border-teal-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <label
            htmlFor="speaking-interview-global-autostart"
            className="flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer select-none bg-white border border-teal-200 px-3 py-1.5 rounded-lg shadow-2xs"
          >
            <input
              type="checkbox"
              id="speaking-interview-global-autostart"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
              className="rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
            />
            <span>Auto-Flow (All {task.questions.length} Interview Questions)</span>
          </label>
          <span className="text-[11px] text-slate-600">
            Plays question → <strong>BEEP (0s prep)</strong> → records 45s response (press <strong>Enter</strong> when done) → advances automatically through Q1–Q{task.questions.length}.
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowPromptText((prev) => !prev)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors bg-white hover:bg-slate-50 border-teal-300 text-teal-900 cursor-pointer shadow-2xs whitespace-nowrap"
            title={showPromptText ? 'Hide written question prompts to match the official exam' : 'Show written question prompts for reading assistance'}
          >
            {showPromptText ? (
              <>
                <span>🙈</span>
                <span>Hide Questions</span>
              </>
            ) : (
              <>
                <span>👁️</span>
                <span>Show Questions</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              stopAllAudio();
              setAnswers({});
              answersRef.current = {};
              setAudioBlobs({});
              blobsRef.current = {};
              setEvaluationResult(null);
              setEvalError(null);
              setShowPromptText(Boolean(coachMode));
              setCurrentQIndex(0);
              setAutoStart(true);
              autoStartRef.current = true;
              handlePlayQuestion(0);
            }}
            disabled={activeAudioIdx !== null || micStatus !== 'idle'}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-2xs"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Start Interview (Auto-Flow)</span>
          </button>
        </div>
      </div>

      {/* Headphone echo prevention hint */}
      <div className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2 flex items-center gap-2">
        <Headphones className="w-4 h-4 text-teal-700 shrink-0" />
        <span>Tip: Use headphones or a headset to prevent microphone echo and avoid picking up system audio.</span>
      </div>

      {micNotice && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3 text-xs text-amber-900 animate-in fade-in">
          <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <strong className="font-semibold block mb-0.5">Microphone Notice</strong>
            <span>{micNotice}</span>
          </div>
          <button
            onClick={() => setMicNotice(null)}
            className="text-amber-700 hover:text-amber-900 text-xs font-semibold px-2 py-1 rounded-md hover:bg-amber-100 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* All Interview Question Cards */}
      <div className="space-y-4">
        {task.questions.map((qItem, idx) => {
          const isAudioPlayingThis = activeAudioIdx === idx;
          const isLoadingAudioThis = loadingAudioIdx === idx;
          const isRecordingThis = activeMicIdx === idx && micStatus === 'listening';
          const isTranscribingThis = activeMicIdx === idx && micStatus === 'transcribing';
          const isActiveCard =
            currentQIndex === idx || isAudioPlayingThis || isRecordingThis || isTranscribingThis;
          const qAnswer = typeof answers[idx] === 'string' ? answers[idx] : '';
          const rawFormula = (qItem as any).speakingFormula;
          const rawVocab = (qItem as any).topicVocabulary || (qItem as any).topicVocab;
          const vocabList: any[] = Array.isArray(rawVocab)
            ? rawVocab
            : ['empirical evidence', 'practical implementation', 'long-term sustainability', 'measurable impact'];
          const rawStarters = (qItem as any).sentenceStarters;
          const startersList: any[] = Array.isArray(rawStarters)
            ? rawStarters
            : [
                'From my perspective, the most compelling factor is...',
                'To illustrate this with a concrete example,...',
              ];

          return (
            <div
              key={idx}
              id={`interview-question-${idx}`}
              onClick={() => setCurrentQIndex(idx)}
              className={`bg-white border rounded-xl p-6 transition-all space-y-4 ${
                isActiveCard
                  ? 'ring-2 ring-emerald-500 shadow-md border-emerald-400'
                  : 'shadow-xs border-slate-200'
              } ${
                isRecordingThis
                  ? 'border-rose-300'
                  : qAnswer.trim()
                  ? 'bg-emerald-50/10'
                  : ''
              }`}
            >
              <SpeakingControls
                currentQIndex={idx}
                totalQuestions={task.questions.length}
                currentQ={qItem}
                isPlayingAudio={isAudioPlayingThis}
                isLoadingAudio={isLoadingAudioThis}
                audioError={audioErrors[idx] || null}
                onHearQuestion={() => handlePlayQuestion(idx)}
                timeLeft={
                  isRecordingThis
                    ? timeLeft
                    : coachMode
                    ? 90
                    : qItem.responseTimeSeconds || 45
                }
                hasRecording={Boolean(audioBlobs[idx])}
                isPlayingRecording={playingRecordingQIndex === idx}
                onPlayUserRecording={() => handlePlayUserRecording(idx)}
                isTranscribing={isTranscribingThis}
                isRecording={isRecordingThis}
                transcribeSeconds={transcribeSeconds}
                onManualMicToggle={() => handleToggleMic(idx)}
                audioLevel={audioLevel}
                recordingSeconds={recordingSeconds}
                showPromptText={showPromptText || Boolean(evaluationResult)}
                hasAnswerText={Boolean(qAnswer.trim())}
              />

              {coachMode && (
                <div className="bg-indigo-50/70 border border-indigo-200 rounded-xl p-4 space-y-2.5 text-xs">
                  <div className="font-bold text-indigo-950 flex items-center justify-between gap-2">
                    <span>🎓 3-Step Speaking Formula &amp; Coaching Guide</span>
                    <span className="text-[11px] font-semibold text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded">
                      Relaxed 90s Coach Timer
                    </span>
                  </div>
                  {typeof rawFormula === 'string' && rawFormula ? (
                    <p className="text-indigo-900 leading-relaxed font-medium">{rawFormula}</p>
                  ) : rawFormula && typeof rawFormula === 'object' ? (
                    <div className="space-y-1 text-indigo-900 font-medium">
                      {rawFormula.pointFormula && (
                        <div>
                          <strong className="font-bold text-indigo-950">1. Point: </strong>
                          <span>{String(rawFormula.pointFormula)}</span>
                        </div>
                      )}
                      {rawFormula.reasonFormula && (
                        <div>
                          <strong className="font-bold text-indigo-950">2. Reason: </strong>
                          <span>{String(rawFormula.reasonFormula)}</span>
                        </div>
                      )}
                      {rawFormula.exampleFormula && (
                        <div>
                          <strong className="font-bold text-indigo-950">3. Example: </strong>
                          <span>{String(rawFormula.exampleFormula)}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-indigo-900 leading-relaxed font-medium">
                      Step 1: Direct Claim (5s) → Step 2: Concrete Reason &amp; Specific Example (25s) → Step 3: Broader Conclusion (15s).
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <span className="text-[11px] font-bold text-slate-700">Band 6.0 Vocabulary:</span>
                    {vocabList.map((v: any, vIdx: number) => {
                      const displayVal =
                        typeof v === 'string'
                          ? v
                          : v && typeof v === 'object'
                          ? `${v.word || v.term || ''}${v.meaning || v.definition ? ': ' + (v.meaning || v.definition) : ''}`
                          : String(v || '');
                      if (!displayVal) return null;
                      return (
                        <span
                          key={vIdx}
                          className="px-2 py-0.5 rounded-md bg-white border border-indigo-200 text-indigo-900 font-semibold text-[11px]"
                        >
                          {displayVal}
                        </span>
                      );
                    })}
                  </div>
                  <div className="space-y-1 pt-0.5">
                    <span className="text-[11px] font-bold text-slate-700 block">
                      Spoken Sentence Starters (click to insert into transcript box):
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {startersList.map((st: any, sIdx: number) => {
                        const starterText =
                          typeof st === 'string'
                            ? st
                            : st && typeof st === 'object'
                            ? String(st.text || st.starter || st.sentence || JSON.stringify(st))
                            : String(st || '');
                        if (!starterText) return null;
                        return (
                          <button
                            key={sIdx}
                            type="button"
                            onClick={() =>
                              setAnswers((prev) => {
                                const curr = typeof prev[idx] === 'string' ? prev[idx] : '';
                                const nextVal = curr.trim() ? `${curr.replace(/\s+$/, '')} ${starterText} ` : `${starterText} `;
                                const next = { ...prev, [idx]: nextVal };
                                answersRef.current = next;
                                return next;
                              })
                            }
                            className="text-left text-[11px] bg-white hover:bg-indigo-100 text-indigo-900 border border-indigo-200 px-2.5 py-1 rounded-md transition-colors cursor-pointer font-medium"
                          >
                            + &ldquo;{starterText}&rdquo;
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <textarea
                  rows={3}
                  value={qAnswer}
                  disabled={isTranscribingThis}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  autoComplete="off"
                  data-gramm="false"
                  data-gramm_editor="false"
                  data-enable-grammarly="false"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && isRecordingThis) {
                      e.preventDefault();
                      handleToggleMic(idx);
                    }
                  }}
                  onChange={(e) =>
                    setAnswers((prev) => {
                      const next = {
                        ...prev,
                        [idx]: e.target.value,
                      };
                      answersRef.current = next;
                      return next;
                    })
                  }
                  placeholder={
                    isRecordingThis
                      ? 'Listening to your speech (press Enter or click Stop when done)...'
                      : isTranscribingThis
                      ? `Processing & transcribing voice recording... ${transcribeSeconds}s`
                      : 'Click Hear Question or Speak to record your 45-second response (or type/edit manually)...'
                  }
                  className={`w-full p-3.5 text-sm rounded-lg text-slate-900 outline-hidden leading-relaxed transition-colors ${
                    isRecordingThis
                      ? 'bg-rose-50/40 border border-rose-300 focus:ring-2 focus:ring-rose-200'
                      : 'bg-slate-50 border border-slate-300 focus:bg-white focus:border-teal-600 focus:ring-2 focus:ring-teal-100'
                  }`}
                />

                {/* Post-answer fluency metrics */}
                {qAnswer.trim() && !isRecordingThis && !isTranscribingThis && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-3 text-xs bg-white border border-slate-200 p-3 rounded-lg text-slate-600">
                      {(() => {
                        const metrics = (answers as any)[`metrics_${idx}`] as SpeakingMetrics | undefined;
                        const words = qAnswer.toLowerCase().match(/\b\w+\b/g) || [];
                        const wordCount = words.length;
                        const timeInMinutes = (qItem.responseTimeSeconds || 45) / 60;
                        const wpm =
                          metrics?.wpm !== undefined
                            ? metrics.wpm
                            : timeInMinutes > 0
                            ? Math.round(wordCount / timeInMinutes)
                            : 0;

                        const detected = detectFillerWords(qAnswer);
                        const fillerCount =
                          metrics?.fillerCount ?? metrics?.fillerWordCount ?? detected.fillerCount;
                        const fillerList =
                          metrics?.fillerWords && metrics.fillerWords.length > 0
                            ? metrics.fillerWords
                            : detected.fillerWords;

                        return (
                          <>
                            <div>
                              Words: <span className="font-mono font-bold text-slate-800">{wordCount}</span>
                            </div>
                            <div>
                              WPM: <span className="font-mono font-bold text-teal-700">{wpm}</span>
                            </div>
                            {metrics?.longestPauseSeconds ? (
                              <div>
                                Longest Pause:{' '}
                                <span className="font-mono font-bold text-slate-700">
                                  {metrics.longestPauseSeconds}s
                                </span>
                              </div>
                            ) : null}

                            {fillerCount === 0 ? (
                              <div className="text-[11px] font-medium text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                                0 fillers ✓
                              </div>
                            ) : fillerCount <= 2 ? (
                              <div className="text-[11px] font-medium text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                                {fillerCount} natural filler{fillerCount > 1 ? 's' : ''} ✓
                              </div>
                            ) : fillerCount < 5 ? (
                              <div className="text-[11px] font-medium text-slate-700 bg-slate-100 px-2 py-0.5 rounded border border-slate-300">
                                {fillerCount} fillers ({fillerList.join(', ')})
                              </div>
                            ) : (
                              <div className="text-[11px] font-bold text-amber-900 bg-amber-100 px-2 py-0.5 rounded border border-amber-300">
                                ⚠️ {fillerCount} fillers ({fillerList.join(', ')})
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Global Evaluation Trigger */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="space-y-1">
          <h4 className="text-sm font-semibold text-slate-900">TOEFL Speaking Diagnostic Evaluation</h4>
          <p className="text-xs text-slate-500 mt-0.5">
            Submit your responses across the 4 interview questions to receive official ETS rubric scores, grammar corrections, and an exemplar response.
          </p>
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

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {hasAnyStoredApiKey() ? (
            <>
              <button
                type="button"
                onClick={() => handleEvaluateAI('local')}
                disabled={isEvaluating}
                className="flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-teal-900 bg-teal-50 hover:bg-teal-100 border border-teal-200 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Grade instantly in 0ms using deterministic local rubric and mechanics scanner"
              >
                <Zap className="w-3.5 h-3.5 text-amber-500" />
                <span>⚡ Instant Local Grader</span>
              </button>
              <button
                type="button"
                onClick={() => handleEvaluateAI('ai')}
                disabled={isEvaluating}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isEvaluating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Scoring your answer... {evalSeconds}s</span>
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
              onClick={() => handleEvaluateAI('local')}
              disabled={isEvaluating}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isEvaluating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Scoring your answer... {evalSeconds}s</span>
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 text-amber-300" />
                  <span>Evaluate Interview (Instant Local Grader)</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {evalError &&
        (evalError.toLowerCase().includes('no api key') ||
        evalError.toLowerCase().includes('invalid api key') ||
        evalError.toLowerCase().includes('api key not valid') ||
        evalError.toLowerCase().includes('add yours in dashboard') ||
        evalError.toLowerCase().includes('settings & api key') ? (
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
              <span className="text-slate-500 font-medium">
                Supports Gemini, NVIDIA, Groq, OpenRouter, and custom keys
              </span>
            </div>
          </div>
        ) : (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 flex items-center gap-3 text-xs text-rose-800">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{evalError}</span>
          </div>
        ))}

      {/* AI Evaluation Diagnostic Card */}
      <div id="interview-evaluation-result">
        <SpeakingEvaluationCard
          evaluationResult={evaluationResult}
          task={task}
          interviewResponses={answers}
          userTranscripts={answers}
          isBenchmarkOpen={isBenchmarkOpen}
          onToggleBenchmark={() => setIsBenchmarkOpen(!isBenchmarkOpen)}
        />
      </div>

      <div className="pt-2 flex items-center justify-end gap-3 flex-wrap">
        {(evaluationResult || Object.values(answers).some((a) => typeof a === 'string' && a.trim().length > 0)) && (
          <button
            type="button"
            onClick={() => {
              stopAllAudio();
              setAnswers({});
              answersRef.current = {};
              setAudioBlobs({});
              blobsRef.current = {};
              setEvaluationResult(null);
              setEvalError(null);
              setShowPromptText(false);
              setCurrentQIndex(0);
              setAutoStart(false);
              autoStartRef.current = false;
            }}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-2xs"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Try Again</span>
          </button>
        )}
        {onNextTask && (
          <button
            onClick={() => {
              stopAllAudio();
              setAnswers({});
              answersRef.current = {};
              setAudioBlobs({});
              blobsRef.current = {};
              setEvaluationResult(null);
              setEvalError(null);
              setShowPromptText(false);
              setCurrentQIndex(0);
              onNextTask();
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-2xs"
          >
            Next Interview Set
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
