import { parseDialogueLine } from '../../utils/voices';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { markUserAiRequest } from '../../utils/userActivity';
import { ListenRepeatTask } from '../../data/curatedQuestions';
import { Volume2, Mic, MicOff, Check, RefreshCw, ArrowRight, AlertCircle, Loader2, Headphones, Pause, RotateCcw, Play } from 'lucide-react';
import { OfflineTranscriberModal } from '../shared/OfflineTranscriberModal';
import { checkModelCachedStatus, getWhisperModelChoice } from '../../utils/localWhisperStt';
import { speakWithCloudTTS, chunkTextForTTS, fetchCloudTtsAudio, stopSpeaking, createVoiceSession, VoiceSession, calculateSentenceMatch, transcribeAudioBlob, prefetchSpeechAudio, stripSpeakerAndFormatting, pickRandomVoice, inferGenderFromSpeaker, playRecordingBeep } from '../../utils/audioSpeech';
import { filterWhisperHallucinations, detectFillerWords } from '../../utils/audio/fluencyMetrics';
import { SpeakingMetrics, calculateSpeakingMetrics } from '../../utils/speakingMetrics';
import { convertToScaledScore, convertScaledToBand6, savePracticeRecord } from '../../utils/scoreTracker';
import {
  scoreListenRepeatSentence,
  calculateListenRepeatSessionScore,
} from '../../utils/toeflScoring';
import { TaskSubtitleMeta, TaskReportButton, CollapsibleTaskInstructions } from '../shared/TaskHeaderMeta';
import { saveMistake } from '../../utils/mistakes';

interface Props {
  task: ListenRepeatTask;
  onNextTask?: () => void;
  onComplete?: (result: any) => void;
  keyboardShortcutHint?: string;
  activeCardHighlightClass?: string;
  coachMode?: boolean;
}

interface SentenceState {
  userInput: string;
  isRecording: boolean;
  scorePercent?: number;
  score5?: 0 | 1 | 2 | 3 | 4 | 5;
  descriptorLabel?: string;
  badgeColorClass?: string;
  bandScore?: number;
  wordBreakdown?: Array<{ word: string; status: 'matched' | 'missed' | 'extra' }>;
  metrics?: SpeakingMetrics;
  checked: boolean;
  fillerWordsCount?: number;
  fillerWordsList?: string[];
}

export const ListenRepeatView: React.FC<Props> = ({
  task,
  onNextTask,
  onComplete,
  coachMode = false,
}) => {
  const [states, setStates] = useState<SentenceState[]>(() =>
    task.sentences.map(() => ({
      userInput: '',
      isRecording: false,
      checked: false,
    }))
  );
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [, setStep] = useState<'practice' | 'done'>('practice');
  const [activeAudioIdx, setActiveAudioIdx] = useState<number | null>(null);
  const [loadingAudioIdx, setLoadingAudioIdx] = useState<number | null>(null);
  const [activeMicIdx, setActiveMicIdx] = useState<number | null>(null);
  const [micStatus, setMicStatus] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  const [showPromptText, setShowPromptText] = useState<boolean>(() => Boolean(coachMode));
  const [audioSpeed, setAudioSpeed] = useState<number>(1.0);
  const [autoStart, setAutoStart] = useState(true);
  const autoStartRef = useRef(autoStart);
  autoStartRef.current = autoStart;
  const [audioLevel, setAudioLevel] = useState(0);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [responseTimeLeft, setResponseTimeLeft] = useState(10);
  const [transcribeSeconds, setTranscribeSeconds] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [audioBlobs, setAudioBlobs] = useState<Record<number, Blob>>({});
  const [transcribeErrors, setTranscribeErrors] = useState<Record<number, string | null>>({});
  const [audioErrors, setAudioErrors] = useState<Record<number, string | null>>({});

  const [isTranscriberModalOpen, setIsTranscriberModalOpen] = useState(false);
  const [isAnyModelCached, setIsAnyModelCached] = useState<boolean>(true);
  const [playingRecordingIdx, setPlayingRecordingIdx] = useState<number | null>(null);

  useEffect(() => {
    const checkCached = async () => {
      const active = getWhisperModelChoice();
      const isCached = await checkModelCachedStatus(active);
      setIsAnyModelCached(isCached);
    };
    checkCached();
  }, [isTranscriberModalOpen]);

  const activePlayingKeyRef = useRef<string | null>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const recordingAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackSessionIdRef = useRef<number>(0);
  const voiceSessionRef = useRef<VoiceSession | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const blobsRef = useRef<Record<number, Blob>>({});
  const hasCompletedRef = useRef<boolean>(false);

  const stopAllAudio = useCallback(() => {
    playbackSessionIdRef.current++;
    if (activeAudioRef.current) {
      try {
        activeAudioRef.current.pause();
        activeAudioRef.current.currentTime = 0;
        activeAudioRef.current.src = '';
      } catch {}
      activeAudioRef.current = null;
    }
    if (recordingAudioRef.current) {
      try {
        recordingAudioRef.current.pause();
        recordingAudioRef.current.currentTime = 0;
      } catch {}
      recordingAudioRef.current = null;
    }
    activePlayingKeyRef.current = null;
    setActiveAudioIdx(null);
    setLoadingAudioIdx(null);
    setPlayingRecordingIdx(null);
    stopSpeaking();
  }, []);

  useEffect(() => {
    hasCompletedRef.current = false;
    blobsRef.current = {};
    setCurrentIndex(0);
    setStep('practice');
    setShowPromptText(Boolean(coachMode));
    setStates(
      task.sentences.map(() => ({
        userInput: '',
        isRecording: false,
        checked: false,
      }))
    );
    setAudioBlobs({});
    return () => {
      stopAllAudio();
    };
  }, [task.id, stopAllAudio, task.sentences, coachMode]);

  const speakerName = (task as any).speakerName || 'Narrator';

  // Pick ONE locked neural voice for the cohesive single-speaker scenario across all 7 sentences
  const sentenceVoices = useMemo(() => {
    const explicitGender = (task as any).speakerGender;
    const inferred =
      explicitGender === 'male' || explicitGender === 'female'
        ? explicitGender
        : inferGenderFromSpeaker(`${speakerName} ${task.title || ''}`);
    const lockedVoice = pickRandomVoice(inferred || undefined);
    return (task.sentences || []).map(() => lockedVoice);
  }, [task.id, task.title, speakerName, (task as any).speakerGender, task.sentences]);

  // Silent background pre-synthesis so clicking "Hear sentence" is INSTANT (0 ms delay)
  useEffect(() => {
    if (!task?.sentences || task.sentences.length === 0) return;
    let cancelled = false;

    const firstSentence = task.sentences[0];
    const firstVoice = sentenceVoices[0] || pickRandomVoice();
    if (firstSentence) {
      const firstChunks = chunkTextForTTS(firstSentence);
      if (firstChunks.length > 0) {
        fetchCloudTtsAudio(firstChunks[0], firstVoice.gender, firstVoice.voiceId).catch(() => {});
      }
    }

    (async () => {
      for (let idx = 0; idx < task.sentences.length; idx++) {
        if (cancelled) break;
        const sentence = task.sentences[idx];
        const vInfo = sentenceVoices[idx] || firstVoice;
        await prefetchSpeechAudio(sentence, vInfo.voiceId, vInfo.gender).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [task.id, task.title, sentenceVoices]);

  useEffect(() => {
    return () => {
      if (voiceSessionRef.current) {
        voiceSessionRef.current.abort();
      }
    };
  }, []);

  const getSentenceResponseSeconds = useCallback(
    (idx: number) => {
      const s = task.sentences[idx] || '';
      const words = s.trim().split(/\s+/).filter(Boolean).length;
      if (words <= 9) return 8;
      if (words <= 13) return 10;
      return 12;
    },
    [task.sentences]
  );

  // Live timer for recording duration and 8-12s TOEFL response countdown
  useEffect(() => {
    let interval: any = null;
    if (micStatus === 'listening' && activeMicIdx !== null) {
      const allowedSec = getSentenceResponseSeconds(activeMicIdx);
      setRecordingSeconds(0);
      setResponseTimeLeft(allowedSec);
      let remaining = allowedSec;
      const targetIdx = activeMicIdx;
      interval = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
        remaining -= 1;
        setResponseTimeLeft(Math.max(0, remaining));
        if (remaining <= 0) {
          clearInterval(interval);
          handleToggleMicRef.current(targetIdx);
        }
      }, 1000);
    } else {
      setRecordingSeconds(0);
    }
    return () => clearInterval(interval);
  }, [micStatus, activeMicIdx, getSentenceResponseSeconds]);

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

  const handlePlay = async (index: number) => {
    setCurrentIndex(index);
    setTimeout(() => {
      document.getElementById(`listen-repeat-item-${index}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 80);
    const itemKey = `sentence_${index}`;
    const wasPlayingThis = activePlayingKeyRef.current === itemKey;
    stopAllAudio();
    if (wasPlayingThis) {
      return;
    }
    activePlayingKeyRef.current = itemKey;
    const currentSession = ++playbackSessionIdRef.current;

    setLoadingAudioIdx(index);
    setAudioErrors((prev) => ({ ...prev, [index]: null }));

    const rawSentence = task.sentences[index];
    const parsed = parseDialogueLine(rawSentence);
    const cleanSentence = parsed.spokenText || stripSpeakerAndFormatting(rawSentence);
    const effSpeaker = parsed.speakerName || speakerName;
    const assignedVoice = sentenceVoices[index] || pickRandomVoice();
    const effGender = assignedVoice.gender;
    const voice = assignedVoice.voiceId;
    const audioClips = (task as any).audioClips;
    const audioUrl = (task as any).audioUrl;

    const savedClipUrl = Array.isArray(audioClips) && audioClips[index]?.url
      ? audioClips[index].url
      : (index === 0 ? audioUrl : null);

    if (savedClipUrl && savedClipUrl.startsWith('https://') && savedClipUrl.includes('blob.vercel-storage.com')) {
      setLoadingAudioIdx(null);
      setActiveAudioIdx(index);
      try {
        await new Promise<void>((resolve, reject) => {
          if (playbackSessionIdRef.current !== currentSession) {
            resolve();
            return;
          }
          const audio = new Audio(savedClipUrl);
          audio.loop = false;
          activeAudioRef.current = audio;
          audio.playbackRate = coachMode ? audioSpeed : 1.0;
          audio.onended = async () => {
            if (activeAudioRef.current === audio) activeAudioRef.current = null;
            if (activePlayingKeyRef.current === itemKey) activePlayingKeyRef.current = null;
            setActiveAudioIdx(null);
            resolve();
            if (playbackSessionIdRef.current === currentSession && autoStartRef.current) {
              await playRecordingBeep();
              if (playbackSessionIdRef.current === currentSession) {
                handleToggleMicRef.current(index);
              }
            }
          };
          audio.onerror = () => {
            if (activeAudioRef.current === audio) activeAudioRef.current = null;
            if (activePlayingKeyRef.current === itemKey) activePlayingKeyRef.current = null;
            setActiveAudioIdx(null);
            reject(new Error('Saved audio playback error'));
          };
          audio.play().catch((err) => {
            if (activeAudioRef.current === audio) activeAudioRef.current = null;
            if (activePlayingKeyRef.current === itemKey) activePlayingKeyRef.current = null;
            setActiveAudioIdx(null);
            reject(err);
          });
        });
      } catch (err: any) {
        if (playbackSessionIdRef.current === currentSession) {
          activePlayingKeyRef.current = null;
          setActiveAudioIdx(null);
          setAudioErrors((prev) => ({ ...prev, [index]: err?.message || String(err) }));
        }
      }
      return;
    }

    // Pre-warm next sentence's first chunk in parallel if available
    if (index + 1 < task.sentences.length) {
      const nextSentence = task.sentences[index + 1];
      const nextVoice = sentenceVoices[index + 1] || assignedVoice;
      const nextChunks = chunkTextForTTS(nextSentence);
      if (nextChunks.length > 0) {
        fetchCloudTtsAudio(nextChunks[0], nextVoice.gender, nextVoice.voiceId).catch(() => {});
      }
    }

    if (playbackSessionIdRef.current !== currentSession) return;

    const voiceName = voice;
    try {
      await speakWithCloudTTS(
        cleanSentence,
        effGender,
        {
          rate: 0.9,
          voice: voiceName,
          voiceName,
          gender: effGender,
          speaker: effSpeaker,
          onStart: () => {
            if (playbackSessionIdRef.current === currentSession) {
              setLoadingAudioIdx(null);
              setActiveAudioIdx(index);
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
                  handleToggleMicRef.current(index);
                }
              }
            }
          },
          onError: (err) => {
            if (playbackSessionIdRef.current === currentSession) {
              if (activePlayingKeyRef.current === itemKey) activePlayingKeyRef.current = null;
              setActiveAudioIdx(null);
              setLoadingAudioIdx(null);
              setAudioErrors((prev) => ({ ...prev, [index]: err?.message || String(err) }));
            }
          },
        },
        voiceName
      );
    } catch (err: any) {
      if (playbackSessionIdRef.current === currentSession) {
        if (activePlayingKeyRef.current === itemKey) activePlayingKeyRef.current = null;
        setActiveAudioIdx(null);
        setLoadingAudioIdx(null);
        setAudioErrors((prev) => ({ ...prev, [index]: err?.message || String(err) }));
      }
    }
  };

  const handleRestartSentence = async (index: number) => {
    stopSpeaking();
    setActiveAudioIdx(null);
    handlePlay(index);
  };

  const handlePlayUserRecording = (index: number) => {
    const itemKey = `user_rec_${index}`;
    const wasPlayingThis = activePlayingKeyRef.current === itemKey;
    stopAllAudio();
    if (wasPlayingThis) {
      return;
    }

    const blob = audioBlobs[index];
    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.loop = false;
    activePlayingKeyRef.current = itemKey;
    recordingAudioRef.current = audio;
    setPlayingRecordingIdx(index);

    audio.onended = () => {
      if (recordingAudioRef.current === audio) {
        recordingAudioRef.current = null;
      }
      if (activePlayingKeyRef.current === itemKey) {
        activePlayingKeyRef.current = null;
      }
      setPlayingRecordingIdx(null);
      URL.revokeObjectURL(url);
    };

    audio.onerror = () => {
      if (recordingAudioRef.current === audio) {
        recordingAudioRef.current = null;
      }
      if (activePlayingKeyRef.current === itemKey) {
        activePlayingKeyRef.current = null;
      }
      setPlayingRecordingIdx(null);
      URL.revokeObjectURL(url);
    };

    audio.play().catch(() => {
      if (recordingAudioRef.current === audio) {
        recordingAudioRef.current = null;
      }
      if (activePlayingKeyRef.current === itemKey) {
        activePlayingKeyRef.current = null;
      }
      setPlayingRecordingIdx(null);
      URL.revokeObjectURL(url);
    });
  };

  const stopCurrentRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
  };

  const stopSpeechRecognition = async (indexToSave: number = currentIndex) => {
    if (voiceSessionRef.current) {
      const activeSession = voiceSessionRef.current;
      voiceSessionRef.current = null;
      try {
        const result = await activeSession.stop();
        if (result.audioBlob) {
          blobsRef.current[indexToSave] = result.audioBlob;
          setAudioBlobs((prev) => ({ ...prev, [indexToSave]: result.audioBlob! }));
        }
      } catch {}
      setActiveMicIdx(null);
      setMicStatus('idle');
      setAudioLevel(0);
    }
  };

  const advanceSentence = async () => {
    const lastIdx = Math.max(0, task.sentences.length - 1);
    const isActivelyRecording =
      mediaRecorderRef.current?.state === 'recording' || Boolean(voiceSessionRef.current);

    if (currentIndex >= lastIdx) {
      stopCurrentRecording();
      await stopSpeechRecognition(currentIndex);
      setStep('done');
      if (!isActivelyRecording && !hasCompletedRef.current) {
        hasCompletedRef.current = true;
        onComplete?.({ blobs: { ...blobsRef.current }, states });
      } else if (isActivelyRecording && !mediaRecorderRef.current && !hasCompletedRef.current) {
        hasCompletedRef.current = true;
        onComplete?.({ blobs: { ...blobsRef.current }, states });
      }
      return;
    }

    stopCurrentRecording();
    await stopSpeechRecognition(currentIndex);
    setCurrentIndex((prev) => prev + 1);
  };

  const handleToggleMic = async (index: number) => {
    setMicError(null);
    markUserAiRequest();
    setCurrentIndex(index);

    // If currently recording this item, stop and finalize transcript
    if (activeMicIdx === index && voiceSessionRef.current) {
      const activeSession = voiceSessionRef.current;
      voiceSessionRef.current = null;
      setMicStatus('transcribing');
      let alignedTranscript = '';
      try {
        const result = await activeSession.stop();
        if (result.audioBlob) {
          blobsRef.current[index] = result.audioBlob;
          setAudioBlobs((prev) => ({ ...prev, [index]: result.audioBlob! }));
        }
        if (result.error) {
          setTranscribeErrors((prev) => ({ ...prev, [index]: result.error! }));
        } else {
          setTranscribeErrors((prev) => ({ ...prev, [index]: null }));
          const { transcript: cleanRes } = filterWhisperHallucinations(result.transcript || '', []);
          if (cleanRes.trim()) {
            const { alignHomophonesAndPhonetics } = await import('../../utils/phoneticMatcher');
            const aligned = alignHomophonesAndPhonetics(cleanRes, task.sentences[index]);
            alignedTranscript = aligned;
            const metrics = result.metrics;
            setStates((prev) => {
              const next = [...prev];
              next[index] = {
                ...next[index],
                userInput: aligned,
                metrics: metrics || next[index].metrics,
                fillerWordsCount: metrics?.fillerCount ?? result.fillerWordsCount ?? 0,
                fillerWordsList: metrics?.fillerWords || result.fillerWordsList || [],
              };
              return next;
            });
          } else {
            setStates((prev) => {
              const next = [...prev];
              next[index] = {
                ...next[index],
                userInput: '',
              };
              return next;
            });
          }
        }
      } catch (err: any) {
        setMicError(err.message || 'Error processing speech recording');
      } finally {
        setActiveMicIdx(null);
        setMicStatus('idle');
        setAudioLevel(0);
      }
      if (alignedTranscript.trim() || autoStartRef.current) {
        await handleCheck(index, alignedTranscript);
      }
      return;
    }

    // If currently recording another item, stop it first and preserve its blob
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

    // Immediately clear old text and previous check score so item starts fresh
    setStates((prev) => {
      const next = [...prev];
      next[index] = {
        userInput: '',
        isRecording: true,
        checked: false,
        scorePercent: undefined,
        bandScore: undefined,
        wordBreakdown: undefined,
        metrics: undefined,
        fillerWordsCount: undefined,
        fillerWordsList: undefined,
      };
      return next;
    });

    const session = createVoiceSession({
      onTranscriptUpdate: (text) => {
        setStates((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], userInput: text };
          return next;
        });
      },
      onAudioLevel: (lvl) => setAudioLevel(lvl),
      onQuietWarning: (warning) => setMicError(warning),
      onDeviceDisconnected: (msg) => setMicError(msg),
      onNotice: (notice) => setMicError(notice),
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
          if (errorMsg) {
            setMicError(errorMsg);
          }
        }
      },
    });

    voiceSessionRef.current = session;
    setActiveMicIdx(index);

    try {
      await session.start();
    } catch (err: any) {
      setActiveMicIdx(null);
      setMicStatus('idle');
      setAudioLevel(0);
      setMicError(err.message || 'Could not start microphone');
      voiceSessionRef.current = null;
    }
  };


  const handleCheck = async (index: number, customTranscript?: string) => {
    // If mic is running, stop it first and await its audioBlob before finalizing
    if (activeMicIdx === index && voiceSessionRef.current) {
      await stopSpeechRecognition(index);
    }

    const target = task.sentences[index];
    const user = customTranscript !== undefined ? customTranscript : states[index].userInput;
    const { percentage, wordStatuses } = calculateSentenceMatch(target, user);
    const rubric = scoreListenRepeatSentence(percentage, wordStatuses);

    if (percentage < 95 && user.trim().length > 0) {
      const missedWords = wordStatuses
        .filter((w) => w.status === 'missed')
        .map((w) => w.word)
        .join(', ');
      saveMistake(
        `${task.title} — Sentence ${index + 1}`,
        'Listen and Repeat',
        user.trim(),
        target,
        missedWords
          ? `Missed or mispronounced words: ${missedWords} (${percentage}% match — ${rubric.descriptorLabel})`
          : `Accuracy: ${percentage}% (${rubric.descriptorLabel})`
      );
    }

    setStates((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        userInput: user,
        scorePercent: percentage,
        score5: rubric.score5,
        descriptorLabel: rubric.descriptorLabel,
        badgeColorClass: rubric.badgeColorClass,
        wordBreakdown: wordStatuses,
        checked: true,
      };
      return next;
    });

    // Check if all checked to save record and invoke onComplete once
    const allChecked = states.every((s, i) => (i === index ? true : s.checked));
    if (allChecked && !hasCompletedRef.current) {
      hasCompletedRef.current = true;
      const updatedSentenceScores = task.sentences.map((_, i) => {
        if (i === index) {
          return { score5: rubric.score5, accuracyPercent: percentage };
        }
        const st = states[i];
        return st?.checked
          ? { score5: st.score5 ?? 0, accuracyPercent: st.scorePercent ?? 0 }
          : null;
      });
      const sessionResult = calculateListenRepeatSessionScore(updatedSentenceScores);

      const formattedRepetition = task.sentences
        .map((sent, i) => {
          const spoken = i === index ? user : states[i]?.userInput || '';
          const pct = i === index ? percentage : states[i]?.scorePercent ?? 0;
          const sc5 = i === index ? rubric.score5 : states[i]?.score5 ?? 0;
          const desc = i === index ? rubric.descriptorLabel : states[i]?.descriptorLabel ?? 'No / Unrelated Response';
          return `Sentence ${i + 1} [Score ${sc5}/5 · ${pct}% · ${desc}]: "${spoken.trim() || '(No response)'}"`;
        })
        .join('\n');
      const targetModelText = task.sentences
        .map((sent, i) => `Sentence ${i + 1}: "${sent}"`)
        .join('\n');

      savePracticeRecord({
        taskType: 'listen-repeat',
        taskTitle: task.title,
        section: 'Speaking',
        score: sessionResult.totalRawScore35,
        maxScore: sessionResult.maxRawScore35,
        scaledScore30: sessionResult.scaledScore30,
        bandScore6: sessionResult.overallBand,
        timeSpentSeconds: 120,
        studentResponse: formattedRepetition,
        feedbackSummary: `Listen & Repeat: Band ${sessionResult.overallBand.toFixed(1)}/6.0 (${sessionResult.cefrLevel}) · Cumulative Rubric Score ${sessionResult.totalRawScore35}/${sessionResult.maxRawScore35} (Avg ${sessionResult.avgScore5.toFixed(1)}/5.0) · ${sessionResult.overallAccuracyPercent}% Word Accuracy`,
        modelAnswer: targetModelText,
      });
      onComplete?.({
        blobs: { ...blobsRef.current },
        scaledScore: sessionResult.scaledScore30,
        bandScore6: sessionResult.overallBand,
        totalRawScore35: sessionResult.totalRawScore35,
        avgScore5: sessionResult.avgScore5,
        avgPercent: sessionResult.overallAccuracyPercent,
      });
      setTimeout(() => {
        document.getElementById('listen-repeat-cumulative-result')?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 150);
    } else if (autoStartRef.current && index + 1 < task.sentences.length) {
      // Auto-advance to the next sentence when Auto-Flow is active
      const nextIdx = index + 1;
      setCurrentIndex(nextIdx);
      setTimeout(() => {
        document.getElementById(`listen-repeat-item-${nextIdx}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
        handlePlay(nextIdx);
      }, 500);
    } else if (index === task.sentences.length - 1) {
      setTimeout(() => {
        document.getElementById('listen-repeat-cumulative-result')?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 150);
    }
  };

  // Auto-scroll to the active sentence card whenever currentIndex or activeMicIdx changes
  useEffect(() => {
    const activeIdx = activeMicIdx !== null ? activeMicIdx : activeAudioIdx !== null ? activeAudioIdx : currentIndex;
    if (activeIdx > 0 || activeMicIdx !== null || activeAudioIdx !== null) {
      document.getElementById(`listen-repeat-item-${activeIdx}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [currentIndex, activeMicIdx, activeAudioIdx]);

  // Press Enter while recording to immediately stop recording, transcribe, and evaluate
  const handleToggleMicRef = useRef(handleToggleMic);
  handleToggleMicRef.current = handleToggleMic;

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

  const handleResetItem = (index: number) => {
    if (activeMicIdx === index && voiceSessionRef.current) {
      voiceSessionRef.current.abort();
      setActiveMicIdx(null);
      setMicStatus('idle');
    }
    setStates((prev) => {
      const next = [...prev];
      next[index] = { userInput: '', isRecording: false, checked: false };
      return next;
    });
    setTranscribeErrors((prev) => ({ ...prev, [index]: null }));
  };

  const handleRetryTranscription = async (index: number) => {
    const blob = audioBlobs[index];
    if (!blob) return;
    setActiveMicIdx(index);
    setMicStatus('transcribing');
    setMicError(null);
    try {
      const targetSentence = task.sentences[index];
      const { transcript, words, durationMs } = await transcribeAudioBlob(blob, undefined, targetSentence);
      if (transcript.trim()) {
        const metrics = calculateSpeakingMetrics(words, transcript, (durationMs || 0) / 1000);
        setStates((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], userInput: transcript.trim(), metrics };
          return next;
        });
        setTranscribeErrors((prev) => ({ ...prev, [index]: null }));
      }
    } catch (err: any) {
      const errCode = err?.message === 'TRANSCRIPTION_TIMEOUT' ? 'TRANSCRIPTION_TIMEOUT' : 'TRANSCRIPTION_FAILED';
      setTranscribeErrors((prev) => ({ ...prev, [index]: errCode }));
      setMicError(
        errCode === 'TRANSCRIPTION_TIMEOUT'
          ? 'Transcription timed out (20s). Audio is preserved. Click Retry transcription or type your repetition.'
          : 'Audio transcription failed. Audio is preserved. Click Retry transcription or type your repetition.'
      );
    } finally {
      setActiveMicIdx(null);
      setMicStatus('idle');
    }
  };

  const completedCount = states.filter((s) => s.checked).length;
  const sessionSummary = useMemo(() => {
    const items = task.sentences.map((_, idx) => {
      const s = states[idx];
      if (!s || !s.checked) return null;
      const fallbackRubric = scoreListenRepeatSentence(s.scorePercent ?? 0, s.wordBreakdown);
      return {
        score5: s.score5 ?? fallbackRubric.score5,
        accuracyPercent: s.scorePercent ?? 0,
      };
    });
    return calculateListenRepeatSessionScore(items);
  }, [states, task.sentences]);

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
            extra={`Speaker: ${speakerName} · ${task.sentences.length} Sentences`}
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {completedCount > 0 && (
            <div className="flex items-center gap-2 text-xs bg-teal-50 border border-teal-200 text-teal-900 px-3 py-1.5 rounded-lg flex-wrap">
              <span>Completed: <strong className="font-mono">{completedCount}/{task.sentences.length}</strong></span>
              <span aria-hidden="true">·</span>
              <span>Rubric: <strong className="font-mono text-teal-800">{sessionSummary.totalRawScore35}/{sessionSummary.maxRawScore35}</strong> <span className="text-slate-500 font-mono text-[11px]">(Avg {sessionSummary.avgScore5.toFixed(1)}/5.0)</span></span>
              <span aria-hidden="true">·</span>
              <span>Overall Band: <strong className="font-mono text-teal-800">{sessionSummary.overallBand.toFixed(1)} / 6.0</strong> <span className="text-slate-500 font-mono text-[11px]">({sessionSummary.scaledScore30}/30)</span></span>
            </div>
          )}
          <TaskReportButton task={task} />
        </div>
      </div>

      {!isAnyModelCached && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-amber-900 animate-in fade-in">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <strong className="font-bold block text-slate-900">Offline Whisper Speech Transcriber Not Downloaded Yet</strong>
              <span>Download model (~75MB / ~245MB) once to enable 100% offline speech recognition without API keys.</span>
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

      <CollapsibleTaskInstructions
        label="Task Instructions"
        summary={`Listen to ${speakerName} speak 7 sentences → BEEP (0s prep) → repeat aloud (0–5 integer rubric per sentence)`}
      >
        <strong>Task Guidelines:</strong> You will hear <strong>{speakerName}</strong> speak 7 progressive sentences in a single campus scenario. Click <strong>Hear Prompt</strong> to listen, then repeat each sentence aloud by clicking <strong>Speak</strong> (press <strong>Enter</strong> anytime while recording to immediately stop and transcribe). Each sentence is scored on the official ETS <strong>0–5 integer rubric</strong>, and your cumulative session score (out of 35) maps to your TOEFL iBT Speaking Band Score (1.0–6.0).
        <span className="block mt-1.5 text-teal-700 font-medium">
          💡 Numbers and spoken times (e.g. <em>10:00</em> and <em>ten o'clock</em>, or <em>lab</em> and <em>laboratory</em>) are automatically recognized and matched.
        </span>
      </CollapsibleTaskInstructions>

      {/* Single Unified Top-Level Auto-Start & Auto-Sequence Control Bar */}
      <div className="bg-teal-50/70 border border-teal-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <label
            htmlFor="listen-repeat-global-autostart"
            className="flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer select-none bg-white border border-teal-200 px-3 py-1.5 rounded-lg shadow-2xs"
          >
            <input
              type="checkbox"
              id="listen-repeat-global-autostart"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
              className="rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
            />
            <span>Auto-Flow (All {task.sentences.length} sentences)</span>
          </label>
          <span className="text-[11px] text-slate-600">
            Plays sentence → <strong>BEEP (0s prep)</strong> → records your voice (8–12s timer, press <strong>Enter</strong> to finish) → checks accuracy → advances automatically.
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {coachMode && (
            <div className="inline-flex items-center bg-white border border-indigo-200 rounded-lg p-0.5 text-[11px] shadow-2xs">
              {[
                { rate: 0.85, label: '0.85x Slow' },
                { rate: 1.0, label: '1.0x Normal' },
                { rate: 1.15, label: '1.15x Fast' },
              ].map((sp) => (
                <button
                  key={sp.rate}
                  type="button"
                  onClick={() => setAudioSpeed(sp.rate)}
                  className={`px-2 py-1 rounded-md font-semibold transition-colors cursor-pointer ${
                    audioSpeed === sp.rate
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {sp.label}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowPromptText((prev) => !prev)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors bg-white hover:bg-slate-50 border-teal-300 text-teal-900 cursor-pointer shadow-2xs whitespace-nowrap"
            title={showPromptText ? 'Hide written sentence prompts to match the official exam' : 'Show written sentence prompts for reading assistance'}
          >
            {showPromptText ? (
              <>
                <span>🙈</span>
                <span>Hide Sentences</span>
              </>
            ) : (
              <>
                <span>👁️</span>
                <span>Show Sentences</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              stopAllAudio();
              setStates(
                task.sentences.map(() => ({
                  userInput: '',
                  isRecording: false,
                  checked: false,
                }))
              );
              setAudioBlobs({});
              blobsRef.current = {};
              setCurrentIndex(0);
              setShowPromptText(Boolean(coachMode));
              setAutoStart(true);
              autoStartRef.current = true;
              handlePlay(0);
            }}
            disabled={activeAudioIdx !== null || micStatus !== 'idle'}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-2xs"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Start Practice (Auto-Flow)</span>
          </button>
        </div>
      </div>

      {/* Headphone echo prevention hint */}
      <div className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2 flex items-center gap-2">
        <Headphones className="w-4 h-4 text-teal-700 shrink-0" />
        <span>Tip: Use headphones or a headset to prevent microphone echo and ensure clean acoustic scoring.</span>
      </div>

      {micError && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3 text-xs text-amber-900 animate-in fade-in">
          <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <strong className="font-semibold block mb-0.5">Microphone Notice</strong>
            <span>{micError}</span>
          </div>
          <button
            onClick={() => setMicError(null)}
            className="text-amber-700 hover:text-amber-900 text-xs font-semibold px-2 py-1 rounded-md hover:bg-amber-100 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="space-y-4">
        {task.sentences.map((targetSentence, idx) => {
          const state = states[idx];
          const isAudioPlaying = activeAudioIdx === idx;
          const isRecordingThis = activeMicIdx === idx && micStatus === 'listening';
          const isTranscribingThis = activeMicIdx === idx && micStatus === 'transcribing';
          const isActiveCard =
            currentIndex === idx || isAudioPlaying || isRecordingThis || isTranscribingThis;
          const cleanDisplaySentence = targetSentence.replace(/\s*\|\s*/g, ' ').trim();
          const wordCount = cleanDisplaySentence.split(/\s+/).filter(Boolean).length;
          const sentenceRubric = state.checked
            ? scoreListenRepeatSentence(state.scorePercent ?? 0, state.wordBreakdown)
            : null;
          const itemScore5 = state.score5 ?? sentenceRubric?.score5 ?? 0;
          const itemDescriptor = state.descriptorLabel || sentenceRubric?.descriptorLabel || 'No / Unrelated Response';
          const itemBadgeClass = state.badgeColorClass || sentenceRubric?.badgeColorClass || 'bg-rose-100 text-rose-800 border-rose-300';

          return (
            <div
              key={idx}
              id={`listen-repeat-item-${idx}`}
              onClick={() => setCurrentIndex(idx)}
              className={`bg-white border rounded-xl p-5 transition-all ${
                isActiveCard
                  ? 'ring-2 ring-emerald-500 shadow-md border-emerald-400'
                  : 'shadow-xs'
              } ${
                state.checked
                  ? itemScore5 >= 4
                    ? 'border-emerald-200 bg-emerald-50/20'
                    : 'border-amber-200 bg-amber-50/20'
                  : isRecordingThis
                  ? 'border-rose-300'
                  : 'border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Item {idx + 1} of {task.sentences.length} · {wordCount} Words
                </span>

                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handlePlay(idx)}
                      disabled={loadingAudioIdx === idx}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                        isAudioPlaying
                          ? 'bg-amber-500 hover:bg-amber-600 text-slate-950 border-amber-500 font-semibold'
                          : loadingAudioIdx === idx
                          ? 'bg-teal-100 text-teal-800 border-teal-300 opacity-90'
                          : 'bg-teal-50 text-teal-800 border-teal-200 hover:bg-teal-100'
                      }`}
                    >
                      {loadingAudioIdx === idx ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-700" />
                      ) : isAudioPlaying ? (
                        <Pause className="w-3.5 h-3.5 fill-current" />
                      ) : (
                        <Volume2 className="w-3.5 h-3.5" />
                      )}
                      {loadingAudioIdx === idx ? 'Loading...' : isAudioPlaying ? 'Stop Audio' : 'Hear Prompt'}
                    </button>
                  </div>
                  {audioErrors[idx] && (
                    <div className="text-[11px] text-rose-600 font-mono text-right max-w-sm">
                      Audio failure: {audioErrors[idx]}
                    </div>
                  )}
                </div>
              </div>

              {/* Question / Sentence Prompt: Hidden by default in Exam Mode; Shown with Prosody Chunks in Coach Mode */}
              {!showPromptText && !state.checked ? (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 flex items-center gap-2">
                  <Headphones className="w-4 h-4 text-teal-600 shrink-0" />
                  <span>🎧 Listen to the sentence and speak after the beep (sentence text is hidden just like the real exam).</span>
                </div>
              ) : !state.checked ? (
                <div className="p-3.5 bg-teal-50/50 border border-teal-200 rounded-lg text-sm text-slate-800 font-medium leading-relaxed space-y-1">
                  {coachMode && targetSentence.includes('|') ? (
                    <>
                      <div className="text-[11px] font-bold text-indigo-800 uppercase tracking-wider">
                        🎓 Shadowing &amp; Prosody Chunking Guide (pause briefly at each | marker):
                      </div>
                      <div>
                        &ldquo;
                        {targetSentence.split('|').map((chunk, cIdx, arr) => (
                          <React.Fragment key={cIdx}>
                            <span>{chunk.trim()}</span>
                            {cIdx < arr.length - 1 && (
                              <span
                                className="mx-1.5 inline-flex items-center px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 font-mono font-bold text-xs"
                                title="Natural prosody pause / intonation boundary"
                              >
                                |
                              </span>
                            )}
                          </React.Fragment>
                        ))}
                        &rdquo;
                      </div>
                    </>
                  ) : (
                    <div>&ldquo;{cleanDisplaySentence}&rdquo;</div>
                  )}
                </div>
              ) : null}

              {/* Input / Dictation Area */}
              <div className="space-y-3">
                {/* Live input-level meter using AnalyserNode and recording timer */}
                {isRecordingThis && (
                  <div className="flex items-center justify-between gap-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 px-3.5 py-2.5 rounded-lg animate-in fade-in flex-wrap shadow-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="relative flex h-2.5 w-2.5 items-center justify-center shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-600"></span>
                      </span>
                      <span className="font-bold text-rose-900">Recording Active</span>
                      <span className="px-2 py-0.5 bg-rose-100 text-rose-800 rounded font-mono font-bold text-[11px]">
                        0:{String(responseTimeLeft).padStart(2, '0')} left
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-600">Speak clearly (0s prep). Press <strong>Enter</strong> or click Stop when done.</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] font-semibold text-slate-700">Mic Pulse:</span>
                      <div className="w-24 h-2.5 bg-slate-200 rounded-full overflow-hidden p-0.5 border border-slate-300">
                        <div
                          className={`h-full rounded-full transition-all duration-75 ${
                            audioLevel > 15 ? 'bg-emerald-500' : audioLevel > 5 ? 'bg-teal-500' : 'bg-slate-400'
                          }`}
                          style={{ width: `${Math.max(6, Math.min(100, audioLevel))}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono font-semibold text-slate-600 w-8 text-right">{audioLevel}%</span>
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  {/* Full-width text input line */}
                  <div className="w-full">
                    <input
                      type="text"
                      value={state.userInput}
                      disabled={isTranscribingThis}
                      spellCheck={false}
                      autoCorrect="off"
                      autoCapitalize="off"
                      autoComplete="off"
                      data-gramm="false"
                      data-gramm_editor="false"
                      data-enable-grammarly="false"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          if (isRecordingThis) {
                            handleToggleMic(idx);
                          } else if (state.userInput.trim() && !isTranscribingThis) {
                            handleCheck(idx);
                          }
                        }
                      }}
                      onChange={(e) =>
                        setStates((prev) => {
                          const next = [...prev];
                          next[idx] = { ...next[idx], userInput: e.target.value, checked: false };
                          return next;
                        })
                      }
                      placeholder={
                        isRecordingThis
                          ? 'Listening... speak clearly into your mic (press Enter to stop & transcribe)...'
                          : isTranscribingThis
                          ? `Processing voice... ${transcribeSeconds}s`
                          : 'Click Speak to record (or type your repetition and press Enter)...'
                      }
                      className={`w-full px-3.5 py-2.5 text-sm rounded-lg text-slate-900 outline-hidden transition-colors ${
                        isRecordingThis
                          ? 'bg-rose-50/40 border border-rose-300 focus:ring-2 focus:ring-rose-200'
                          : 'bg-slate-50 border border-slate-300 focus:bg-white focus:border-teal-600 focus:ring-2 focus:ring-teal-100'
                      }`}
                    />
                  </div>

                  {/* Action buttons and controls on a separate line below */}
                  <div className="flex items-center justify-end flex-wrap gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => handleToggleMic(idx)}
                        disabled={isRecordingThis ? false : (activeMicIdx !== null && activeMicIdx !== idx && micStatus !== 'idle')}
                        className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-all flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                          isRecordingThis
                            ? 'bg-rose-600 border-rose-600 text-white shadow-xs animate-pulse hover:bg-rose-700'
                            : isTranscribingThis
                            ? 'bg-slate-100 border-slate-300 text-slate-600 cursor-wait'
                            : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50 hover:border-slate-400'
                        }`}
                        title={isRecordingThis ? 'Click or press Enter to finish speaking' : 'Click mic and speak'}
                      >
                        {isRecordingThis ? (
                          <>
                            <MicOff className="w-4 h-4 text-white" />
                            <span>Stop (Enter)</span>
                          </>
                        ) : isTranscribingThis ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin text-teal-600" />
                            <span>Transcribing... {transcribeSeconds}s</span>
                          </>
                        ) : (
                          <>
                            <Mic className="w-4 h-4 text-slate-600" />
                            <span>Speak</span>
                          </>
                        )}
                      </button>

                      {audioBlobs[idx] && (
                        <>
                          <button
                            type="button"
                            onClick={() => handlePlayUserRecording(idx)}
                            className={`px-2.5 py-2 text-xs font-medium rounded-lg border transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                              playingRecordingIdx === idx
                                ? 'bg-amber-500 text-slate-950 border-amber-500 font-bold'
                                : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                            }`}
                            title={playingRecordingIdx === idx ? 'Stop playback' : 'Listen to your recorded voice'}
                          >
                            {playingRecordingIdx === idx ? (
                              <>
                                <Pause className="w-3.5 h-3.5 fill-current text-slate-950" />
                                <span>Stop</span>
                              </>
                            ) : (
                              <>
                                <Play className="w-3.5 h-3.5 text-teal-700 fill-teal-700" />
                                <span>My Voice</span>
                              </>
                            )}
                          </button>
                          {transcribeErrors[idx] && (
                            <button
                              type="button"
                              onClick={() => handleRetryTranscription(idx)}
                              disabled={isRecordingThis || isTranscribingThis}
                              className="px-2.5 py-2 text-xs font-semibold rounded-lg border border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100 transition-all flex items-center gap-1.5 whitespace-nowrap shrink-0"
                              title="Retry transcription from saved recording"
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${isTranscribingThis ? 'animate-spin text-teal-600' : 'text-amber-700'}`} />
                              <span>Retry STT</span>
                            </button>
                          )}
                        </>
                      )}

                      {!state.checked && state.userInput.trim() && (
                        <button
                          onClick={() => handleCheck(idx)}
                          disabled={!state.userInput.trim() || isRecordingThis || isTranscribingThis}
                          className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Check</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Live Transcript / Word Accuracy Diff with Official ETS 0-5 Per-Sentence Rubric */}
                {state.checked && (
                  <div className="pt-3 border-t border-slate-200/80 space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-slate-600">
                          Accuracy: <strong className="font-mono text-slate-900 text-sm">{state.scorePercent}%</strong>
                        </span>
                        <span className="text-xs font-mono font-bold text-teal-900 bg-teal-50 px-2.5 py-0.5 rounded-md border border-teal-200">
                          ETS Sentence Score: {itemScore5} / 5
                        </span>
                        <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-md border ${itemBadgeClass}`}>
                          {itemDescriptor}
                        </span>
                        {state.metrics?.wpm ? (
                          <span className="text-[10px] text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded-sm">
                            {state.metrics.wpm} WPM · {state.metrics.pauseCount ?? 0} pauses
                          </span>
                        ) : null}

                        {/* ALWAYS Display Filler Badge */}
                        {(() => {
                          const detected = detectFillerWords(state.userInput);
                          const fillerCount = state.fillerWordsCount ?? state.metrics?.fillerCount ?? detected.fillerCount;
                          const fillerList =
                            state.fillerWordsList && state.fillerWordsList.length > 0
                              ? state.fillerWordsList
                              : state.metrics?.fillerWords && state.metrics.fillerWords.length > 0
                              ? state.metrics.fillerWords
                              : detected.fillerWords;

                          if (fillerCount === 0) {
                            return (
                              <span className="text-[10px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                                0 fillers ✓
                              </span>
                            );
                          }
                          if (fillerCount <= 2) {
                            return (
                              <span className="text-[10px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                                {fillerCount} natural filler{fillerCount > 1 ? 's' : ''} ✓
                              </span>
                            );
                          }
                          if (fillerCount < 5) {
                            return (
                              <span className="text-[10px] font-medium text-slate-700 bg-slate-100 border border-slate-300 px-2 py-0.5 rounded-md">
                                {fillerCount} fillers ({fillerList.join(', ')})
                              </span>
                            );
                          }
                          return (
                            <span className="text-[10px] font-bold text-amber-900 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded-md flex items-center gap-1">
                              ⚠️ {fillerCount} fillers ({fillerList.join(', ')})
                            </span>
                          );
                        })()}
                      </div>
                      <span className="text-slate-500">
                        Target Sentence: <span className="font-medium text-slate-800 italic">"{targetSentence}"</span>
                      </span>
                    </div>

                    {/* Word-by-word breakdown with extra words and filler chips */}
                    <div className="flex flex-wrap gap-1.5 pt-1 items-center">
                      {state.wordBreakdown?.map((wb, wIdx) => (
                        <span
                          key={wIdx}
                          title={
                            wb.status === 'matched'
                              ? 'Matched in sequence'
                              : wb.status === 'extra'
                              ? 'Extra / inserted spoken word (not in target sentence)'
                              : 'Missed or out-of-order target word'
                          }
                          className={`px-2 py-0.5 rounded text-xs font-mono font-medium ${
                            wb.status === 'matched'
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                              : wb.status === 'extra'
                              ? 'bg-amber-100 text-amber-900 border border-amber-300 font-semibold'
                              : 'bg-rose-100 text-rose-800 border border-rose-300 line-through'
                          }`}
                        >
                          {wb.status === 'extra' ? `+ ${wb.word}` : wb.word}
                        </span>
                      ))}

                      {/* Render detected filler chips */}
                      {detectFillerWords(state.userInput).fillerWords.map((f, fIdx) => (
                        <span
                          key={`filler_${fIdx}`}
                          className="px-2.5 py-0.5 rounded text-xs font-mono font-bold bg-amber-100 text-amber-900 border border-amber-300 flex items-center gap-1"
                          title="Vocalized filler word detected"
                        >
                          <span>(filler: {f})</span>
                        </span>
                      ))}
                    </div>

                    {/* Fluency Coaching Tip Banner */}
                    {(() => {
                      const detected = detectFillerWords(state.userInput);
                      const fillerCount = state.fillerWordsCount ?? state.metrics?.fillerCount ?? detected.fillerCount;
                      const fillerList =
                        state.fillerWordsList && state.fillerWordsList.length > 0
                          ? state.fillerWordsList
                          : state.metrics?.fillerWords && state.metrics.fillerWords.length > 0
                          ? state.metrics.fillerWords
                          : detected.fillerWords;

                      if (fillerCount >= 3) {
                        return (
                          <div className="mt-3 p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-900 flex items-start gap-2.5 animate-in fade-in shadow-2xs">
                            <span className="text-base shrink-0">💡</span>
                            <div>
                              <strong className="font-bold block text-amber-950">Fluency Coaching Tip:</strong>
                              <span>
                                You used <strong>{fillerCount} filler word(s)</strong> ({fillerList.join(', ')}). We recommend using fewer filler words—on the TOEFL iBT Speaking section, frequent <em>"ums"</em> and <em>"uhs"</em> reduce your Delivery score. Try replacing <em>"um"</em> or <em>"uh"</em> with a brief silent pause while thinking of your next word!
                              </span>
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Cumulative Listen & Repeat Session Result Card */}
      {completedCount > 0 && (
        <div
          id="listen-repeat-cumulative-result"
          className="bg-white border-2 border-teal-200 rounded-xl p-6 shadow-xs space-y-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-teal-700">
                Official 2026 ETS TOEFL iBT · Cumulative Session Evaluation
              </span>
              <h3 className="text-lg font-bold text-slate-900 mt-0.5">
                Listen & Repeat Session Result ({sessionSummary.completedSentences} / {sessionSummary.totalSentences} Sentences Completed)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Unanswered sentences count as 0 / 5 in the cumulative 35-point session rubric.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="px-3 py-1.5 rounded-lg bg-teal-900 text-white font-mono font-bold text-sm">
                Overall Band: {sessionSummary.overallBand.toFixed(1)} / 6.0
              </span>
              <span className="px-2.5 py-1.5 rounded-lg bg-teal-50 border border-teal-200 text-teal-900 font-semibold text-xs">
                {sessionSummary.cefrLevel} · {sessionSummary.performanceDescriptor}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
              <div className="text-[11px] font-semibold text-slate-500 uppercase">Overall Band</div>
              <div className="text-lg font-bold font-mono text-teal-800 mt-0.5">
                {sessionSummary.overallBand.toFixed(1)} / 6.0
              </div>
              <div className="text-[11px] text-slate-500">{sessionSummary.performanceDescriptor}</div>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
              <div className="text-[11px] font-semibold text-slate-500 uppercase">Cumulative Rubric Score</div>
              <div className="text-lg font-bold font-mono text-slate-900 mt-0.5">
                {sessionSummary.totalRawScore35} / {sessionSummary.maxRawScore35}
              </div>
              <div className="text-[11px] text-slate-500 font-mono">
                Avg {sessionSummary.avgScore5.toFixed(1)} / 5.0 per item
              </div>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
              <div className="text-[11px] font-semibold text-slate-500 uppercase">Scaled Score</div>
              <div className="text-lg font-bold font-mono text-slate-900 mt-0.5">
                {sessionSummary.scaledScore30} / 30
              </div>
              <div className="text-[11px] text-slate-500">ETS 0–30 Speaking Scale</div>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
              <div className="text-[11px] font-semibold text-slate-500 uppercase">Overall Word Accuracy</div>
              <div className="text-lg font-bold font-mono text-slate-900 mt-0.5">
                {sessionSummary.overallAccuracyPercent}%
              </div>
              <div className="text-[11px] text-slate-500">
                Completed: {sessionSummary.completedSentences} / {sessionSummary.totalSentences} Sentences
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {task.sentences.map((_, sIdx) => {
              const st = states[sIdx];
              const sc = st?.checked
                ? st.score5 ?? scoreListenRepeatSentence(st.scorePercent ?? 0, st.wordBreakdown).score5
                : null;
              return (
                <span
                  key={sIdx}
                  className={`px-2.5 py-1 rounded-md text-xs font-mono font-semibold border ${
                    sc === null
                      ? 'bg-slate-100 text-slate-500 border-slate-200'
                      : sc >= 4
                      ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                      : sc >= 3
                      ? 'bg-sky-50 text-sky-900 border-sky-200'
                      : 'bg-amber-50 text-amber-900 border-amber-200'
                  }`}
                >
                  Sentence {sIdx + 1}: {sc !== null ? `${sc}/5 (${st.scorePercent ?? 0}%)` : '0/5 (Unanswered)'}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="pt-2 flex items-center justify-end gap-3 flex-wrap">
        {completedCount > 0 && (
          <button
            type="button"
            onClick={() => {
              stopAllAudio();
              setStates(
                task.sentences.map(() => ({
                  userInput: '',
                  isRecording: false,
                  checked: false,
                }))
              );
              setAudioBlobs({});
              blobsRef.current = {};
              setCurrentIndex(0);
              setShowPromptText(false);
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
              setStates(
                task.sentences.map(() => ({
                  userInput: '',
                  isRecording: false,
                  checked: false,
                }))
              );
              setAudioBlobs({});
              blobsRef.current = {};
              setCurrentIndex(0);
              setShowPromptText(false);
              onNextTask();
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-2xs"
          >
            Next Speaking Exercise
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
