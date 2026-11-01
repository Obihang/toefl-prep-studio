import { parseDialogueLine } from '../../utils/voices';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ListeningTask } from '../../data/curatedQuestions';
import { Play, Pause, RotateCcw, Volume2, Eye, EyeOff, CheckCircle2, ArrowRight, AlertCircle, Loader2 } from 'lucide-react';
import {
  playDialogue,
  stopSpeaking,
  prefetchSpeechAudio,
  stripSpeakerAndFormatting,
  pickRandomVoice,
  inferGenderFromSpeaker,
  speakWithCloudTTS,
  chunkTextForTTS,
  fetchCloudTtsAudio,
} from '../../utils/audioSpeech';
import { convertToScaledScore, convertScaledToBand6, savePracticeRecord } from '../../utils/scoreTracker';
import { auth } from '../../firebase';
import { saveMistake } from '../../utils/mistakes';
import { inferListeningQuestionType } from '../../utils/taskNormalizer';
import { TaskSubtitleMeta, TaskReportButton } from '../shared/TaskHeaderMeta';

interface Props {
  task: ListeningTask;
  onNextTask?: () => void;
  onComplete?: (result: number) => void;
  leftColumnClassName?: string;
  rightColumnClassName?: string;
  footerBarClassName?: string;
  excerptBadgeLabel?: string;
  coachMode?: boolean;
}

type CanonicalSpeakerRole = 'professor' | 'student';

const AUTHORITY_ROLE_REGEX =
  /\b(professor|prof\.?|advisor|librarian|instructor|doctor|dr\.?|staff|dean|coordinator|director|coach|assistant|receptionist|narrator|lecturer|faculty|teacher)\b/i;
const STUDENT_ROLE_REGEX =
  /\b(student|undergraduate|grad student|classmate|peer)\b/i;

function extractVocativeNamesFromLines(lines: string[], targetRole: CanonicalSpeakerRole, rolesByLine: CanonicalSpeakerRole[]): string[] {
  const vocatives: string[] = [];
  lines.forEach((rawLine, idx) => {
    // If the OTHER speaker is speaking on this turn, check if they address our target speaker by name
    const speakerRole = rolesByLine[idx];
    if (speakerRole === targetRole) return;
    const parsed = parseDialogueLine(rawLine);
    const text = parsed.spokenText || rawLine;
    // Match patterns like "Hi Emma,", "Thanks, Emma.", "That is a common assumption, Emma.", "Well, Michael,"
    const matches = [
      ...Array.from(text.matchAll(/\b(?:hi|hello|hey|thanks|thank you|yes|no|well|actually|right|sure|okay|welcome)\s*,?\s+([A-Z][a-z]{2,15})\b/g)),
      ...Array.from(text.matchAll(/,\s*([A-Z][a-z]{2,15})[.?!,]/g)),
    ];
    for (const m of matches) {
      if (m[1]) vocatives.push(m[1]);
    }
  });
  return vocatives;
}

function classifyCanonicalRole(
  rawSpeakerLabel: string,
  lineIndex: number,
  labelA: string,
  labelB: string
): CanonicalSpeakerRole {
  const s = (rawSpeakerLabel || '').trim().toLowerCase();
  const a = (labelA || '').trim().toLowerCase();
  const b = (labelB || '').trim().toLowerCase();

  // 1. Direct match against explicit student keywords
  if (STUDENT_ROLE_REGEX.test(s) || /\b(speaker\s*b|^b$)\b/i.test(s)) {
    return 'student';
  }
  // 2. Direct match against explicit professor/staff/authority keywords
  if (AUTHORITY_ROLE_REGEX.test(s) || /\b(speaker\s*a|^a$)\b/i.test(s)) {
    return 'professor';
  }

  // 3. If one of labelA / labelB is an explicit authority (e.g. "Prof. Miller") and the other is a first name (e.g. "Emma"),
  // ensure the non-authority speaker maps to 'student'!
  const aIsAuthority = AUTHORITY_ROLE_REGEX.test(a);
  const bIsAuthority = AUTHORITY_ROLE_REGEX.test(b);
  const aIsStudent = STUDENT_ROLE_REGEX.test(a);
  const bIsStudent = STUDENT_ROLE_REGEX.test(b);

  if (s && a && (s === a || s.includes(a) || a.includes(s))) {
    if (aIsStudent) return 'student';
    if (aIsAuthority) return 'professor';
    if (bIsAuthority) return 'student';
    if (bIsStudent) return 'professor';
  }
  if (s && b && (s === b || s.includes(b) || b.includes(s))) {
    if (bIsAuthority) return 'professor';
    if (bIsStudent) return 'student';
    if (aIsAuthority) return 'student';
    if (aIsStudent) return 'professor';
  }

  // 4. If the speaker label itself is a person's name (like "Emma" or "Liam") without a title,
  // and the conversation has an authority figure in labelA/labelB, a first-name-only speaker is the student!
  if (s && !AUTHORITY_ROLE_REGEX.test(s) && (aIsAuthority || bIsAuthority)) {
    return 'student';
  }

  // 5. Fallback by alternating turn order
  return lineIndex % 2 === 0 ? 'professor' : 'student';
}

export const ListeningDialogueView: React.FC<Props> = ({
  task,
  coachMode = false,
  onNextTask,
  onComplete,
  leftColumnClassName = 'lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto',
  rightColumnClassName = 'lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-2 scroll-smooth',
  footerBarClassName = 'flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200',
  excerptBadgeLabel = '🎧 Listen again to part of the conversation',
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [playingExcerptIdx, setPlayingExcerptIdx] = useState<number | null>(null);
  const [loadingExcerptIdx, setLoadingExcerptIdx] = useState<number | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [playCount, setPlayCount] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [listeningAudioFinished, setListeningAudioFinished] = useState(false);
  const [audioSpeed, setAudioSpeed] = useState<number>(1.0);
  const [revealedHints, setRevealedHints] = useState<Record<number, boolean>>({});
  const [checkedQuestions, setCheckedQuestions] = useState<Record<number, boolean>>({});

  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackSessionIdRef = useRef<number>(0);
  const isPausedRef = useRef<boolean>(false);

  const scriptText = task?.script || '';
  const lines = useMemo(() => scriptText.split(/\n+/).filter(Boolean), [scriptText]);

  // Default transcript visibility state to false (hidden) when a new listening task loads
  useEffect(() => {
    setShowTranscript(false);
    setSelectedAnswers({});
    setSubmitted(false);
    setListeningAudioFinished(false);
    setIsPlaying(false);
    setActiveLine(null);
    setPlayingExcerptIdx(null);
    setLoadingExcerptIdx(null);
    setPlayCount(0);
    setRevealedHints({});
    setCheckedQuestions({});
  }, [task.id, task.title]);

  // Assign strictly locked voices per canonical speaker role ('professor' vs 'student') once when the task loads:
  // - Conversations: ONE locked voiceId+gender for 'professor' and ONE distinct locked voiceId+gender for 'student'
  // - Announcements / Academic Talks (Lectures): ONE consistent voiceId+gender for the entire passage
  const dialogueVoices = useMemo(() => {
    const taskSubType = String((task as any).type || '').toLowerCase();
    const isSingleSpeakerPassage =
      taskSubType === 'announcement' ||
      taskSubType === 'academic_talk' ||
      taskSubType === 'lecture' ||
      (lines.length <= 2 && !/speaker b|^b:|student:/im.test(scriptText));

    // Discover the two distinct speaker labels from the script if task.speakers is missing or generic
    const distinctScriptSpeakers: string[] = [];
    lines.forEach((line) => {
      const parsed = parseDialogueLine(line);
      if (parsed.speakerName) {
        const fullLabel = parsed.speakerHint
          ? `${parsed.speakerName} (${parsed.speakerHint})`
          : parsed.speakerName;
        if (
          !distinctScriptSpeakers.some(
            (existing) => existing.toLowerCase() === fullLabel.toLowerCase()
          )
        ) {
          distinctScriptSpeakers.push(fullLabel);
        }
      }
    });

    const labelA = task.speakers?.A || distinctScriptSpeakers[0] || '';
    const labelB = task.speakers?.B || distinctScriptSpeakers[1] || '';

    if (isSingleSpeakerPassage) {
      const inferred =
        inferGenderFromSpeaker(`${labelA} ${ distinctScriptSpeakers.join(' ') } ${task.context || ''} ${scriptText.slice(0, 160)}`) ||
        ((task as any).speakerGenderA as 'male' | 'female' | undefined) ||
        ((task as any).speakerGenders?.A as 'male' | 'female' | undefined);
      const singleVoice = pickRandomVoice(inferred || undefined);
      return {
        isSingleSpeaker: true,
        professor: singleVoice,
        student: singleVoice,
        A: singleVoice,
        B: singleVoice,
      };
    }

    // Collect all speaker labels + hints across turns that map to 'professor' vs 'student' to infer gender accurately
    const profLabels: string[] = [];
    const studentLabels: string[] = [];
    if (labelA) {
      if (classifyCanonicalRole(labelA, 0, labelA, labelB) === 'professor') {
        profLabels.push(labelA);
      } else {
        studentLabels.push(labelA);
      }
    }
    if (labelB) {
      if (classifyCanonicalRole(labelB, 1, labelA, labelB) === 'student') {
        studentLabels.push(labelB);
      } else {
        profLabels.push(labelB);
      }
    }

    const rolesByLine: CanonicalSpeakerRole[] = [];
    lines.forEach((line, idx) => {
      const parsed = parseDialogueLine(line);
      const fullSpk = parsed.speakerHint
        ? `${parsed.speakerName} (${parsed.speakerHint})`
        : parsed.speakerName;
      const role = classifyCanonicalRole(fullSpk || parsed.speakerName, idx, labelA, labelB);
      rolesByLine.push(role);
      if (fullSpk) {
        if (role === 'professor') profLabels.push(fullSpk);
        else studentLabels.push(fullSpk);
      }
    });

    // Also check vocative names addressed in dialogue lines (e.g., Professor saying "That is a common assumption, Emma.")
    const studentVocatives = extractVocativeNamesFromLines(lines, 'student', rolesByLine);
    const profVocatives = extractVocativeNamesFromLines(lines, 'professor', rolesByLine);

    const explicitGA = (task as any).speakerGenderA || (task as any).speakerGenders?.A;
    const explicitGB = (task as any).speakerGenderB || (task as any).speakerGenders?.B;

    const roleA = classifyCanonicalRole(labelA, 0, labelA, labelB);
    const roleB = classifyCanonicalRole(labelB, 1, labelA, labelB);

    const explicitStudentG =
      roleA === 'student' && (explicitGA === 'male' || explicitGA === 'female')
        ? explicitGA
        : roleB === 'student' && (explicitGB === 'male' || explicitGB === 'female')
        ? explicitGB
        : undefined;

    const explicitProfG =
      roleA === 'professor' && (explicitGA === 'male' || explicitGA === 'female')
        ? explicitGA
        : roleB === 'professor' && (explicitGB === 'male' || explicitGB === 'female')
        ? explicitGB
        : undefined;

    const nameInferredStudentG = inferGenderFromSpeaker([...studentLabels, ...studentVocatives].join(' '));
    const nameInferredProfG = inferGenderFromSpeaker([...profLabels, ...profVocatives].join(' '));

    const inferredStudentGender = nameInferredStudentG || explicitStudentG;
    const inferredProfGender = nameInferredProfG || explicitProfG;

    // If student gender is known (e.g. "Emma" -> female), lock student voice first and pick opposite gender for professor if professor's gender isn't explicitly known
    if (inferredStudentGender && !inferredProfGender) {
      const studentVoice = pickRandomVoice(inferredStudentGender);
      const targetProfGender: 'male' | 'female' =
        studentVoice.gender === 'female' ? 'male' : 'female';
      const profVoice = pickRandomVoice(targetProfGender, studentVoice.voiceId);
      return {
        isSingleSpeaker: false,
        professor: profVoice,
        student: studentVoice,
        A: profVoice,
        B: studentVoice,
      };
    }

    const profVoice = pickRandomVoice(inferredProfGender || undefined);
    const targetStudentGender: 'male' | 'female' =
      inferredStudentGender || (profVoice.gender === 'male' ? 'female' : 'male');
    const studentVoice = pickRandomVoice(targetStudentGender, profVoice.voiceId);

    return {
      isSingleSpeaker: false,
      professor: profVoice,
      student: studentVoice,
      A: profVoice,
      B: studentVoice,
    };
  }, [task.id, task.title, scriptText, lines.length]);

  const dialogueLines = useMemo(() => {
    const distinctScriptSpeakers: string[] = [];
    lines.forEach((line) => {
      const parsed = parseDialogueLine(line);
      if (parsed.speakerName) {
        const fullLabel = parsed.speakerHint
          ? `${parsed.speakerName} (${parsed.speakerHint})`
          : parsed.speakerName;
        if (
          !distinctScriptSpeakers.some(
            (existing) => existing.toLowerCase() === fullLabel.toLowerCase()
          )
        ) {
          distinctScriptSpeakers.push(fullLabel);
        }
      }
    });

    const labelA = task.speakers?.A || distinctScriptSpeakers[0] || 'Professor';
    const labelB = task.speakers?.B || distinctScriptSpeakers[1] || 'Student';

    return lines.map((line, idx) => {
      const parsed = parseDialogueLine(line);
      const rawSpeaker = parsed.speakerName || '';
      const fullSpk = parsed.speakerHint
        ? `${rawSpeaker} (${parsed.speakerHint})`
        : rawSpeaker;
      const spokenText = parsed.spokenText || stripSpeakerAndFormatting(line);

      if (dialogueVoices.isSingleSpeaker) {
        return {
          rawLine: line,
          spokenText,
          role: 'professor' as CanonicalSpeakerRole,
          gender: dialogueVoices.professor.gender,
          voiceId: dialogueVoices.professor.voiceId,
          speakerName: rawSpeaker || labelA || 'Narrator',
        };
      }

      const role = classifyCanonicalRole(fullSpk || rawSpeaker, idx, labelA, labelB);
      const lockedVoice =
        role === 'student' ? dialogueVoices.student : dialogueVoices.professor;
      const defaultDisplayName = role === 'student' ? labelB : labelA;

      return {
        rawLine: line,
        spokenText,
        role,
        gender: lockedVoice.gender,
        voiceId: lockedVoice.voiceId,
        speakerName: rawSpeaker || defaultDisplayName,
      };
    });
  }, [lines, dialogueVoices, task.speakers]);

  const voices = useMemo(
    () => ({
      A: dialogueVoices.professor.voiceId,
      B: dialogueVoices.student.voiceId,
    }),
    [dialogueVoices]
  );

  const stopAllAudio = useCallback(() => {
    playbackSessionIdRef.current++;
    isPausedRef.current = true;
    setPlayingExcerptIdx(null);
    setLoadingExcerptIdx(null);
    if (activeAudioRef.current) {
      try {
        activeAudioRef.current.pause();
        activeAudioRef.current.currentTime = 0;
        activeAudioRef.current.src = '';
      } catch {}
      activeAudioRef.current = null;
    }
    stopSpeaking();
  }, []);

  const resolveExcerptSpeakerAndText = useCallback(
    (rawExcerpt: string, questionText: string) => {
      const parsed = parseDialogueLine(rawExcerpt);
      const cleanEx = (parsed.spokenText || stripSpeakerAndFormatting(rawExcerpt)).trim();
      const cleanLower = cleanEx.toLowerCase();

      // 1. Match directly against dialogueLines turns to use the exact turn's locked voiceId & gender
      const matchedTurn = dialogueLines.find(
        (turn) =>
          turn.spokenText &&
          (turn.spokenText.toLowerCase().includes(cleanLower) ||
            cleanLower.includes(turn.spokenText.toLowerCase()))
      );
      if (matchedTurn) {
        return {
          spokenText: cleanEx || matchedTurn.spokenText,
          voiceId: matchedTurn.voiceId,
          gender: matchedTurn.gender,
          speakerName: matchedTurn.speakerName,
        };
      }

      // 2. If the excerpt has a speaker prefix (e.g. "Professor Miller: ..."), classify role
      if (parsed.speakerName && !dialogueVoices.isSingleSpeaker) {
        const labelA = task.speakers?.A || 'Professor';
        const labelB = task.speakers?.B || 'Student';
        const role = classifyCanonicalRole(parsed.speakerName, 0, labelA, labelB);
        const locked = role === 'student' ? dialogueVoices.student : dialogueVoices.professor;
        return {
          spokenText: cleanEx,
          voiceId: locked.voiceId,
          gender: locked.gender,
          speakerName: parsed.speakerName,
        };
      }

      // 3. Fallback based on question subject or default to professor's locked voice
      const asksStudent =
        !dialogueVoices.isSingleSpeaker &&
        /\bwhy does the student\b|\bwhat does the student (?:imply|mean)\b/i.test(questionText || '');
      const fallbackVoice = asksStudent ? dialogueVoices.student : dialogueVoices.professor;
      return {
        spokenText: cleanEx,
        voiceId: fallbackVoice.voiceId,
        gender: fallbackVoice.gender,
        speakerName: asksStudent ? task.speakers?.A || 'Student' : task.speakers?.B || 'Professor',
      };
    },
    [dialogueLines, dialogueVoices, task.speakers]
  );

  const handlePlayExcerpt = async (qIdx: number, rawExcerpt: string, questionText: string) => {
    const resolved = resolveExcerptSpeakerAndText(rawExcerpt, questionText);
    if (!resolved.spokenText) return;

    if (playingExcerptIdx === qIdx) {
      stopAllAudio();
      setIsPlaying(false);
      setActiveLine(null);
      return;
    }

    stopAllAudio();
    setIsPlaying(false);
    setActiveLine(null);
    const currentSession = ++playbackSessionIdRef.current;
    isPausedRef.current = false;
    setLoadingExcerptIdx(qIdx);

    try {
      const chunks = chunkTextForTTS(resolved.spokenText);
      if (chunks.length > 0) {
        await fetchCloudTtsAudio(chunks[0], resolved.gender, resolved.voiceId);
      }
      if (playbackSessionIdRef.current !== currentSession) return;

      await speakWithCloudTTS(
        resolved.spokenText,
        resolved.gender,
        {
          rate: coachMode ? audioSpeed : 1.0,
          voice: resolved.voiceId,
          voiceName: resolved.voiceId,
          gender: resolved.gender,
          speaker: resolved.speakerName,
          onStart: () => {
            if (playbackSessionIdRef.current === currentSession) {
              setLoadingExcerptIdx(null);
              setPlayingExcerptIdx(qIdx);
            }
          },
          onEnd: () => {
            if (playbackSessionIdRef.current === currentSession) {
              setPlayingExcerptIdx(null);
              setLoadingExcerptIdx(null);
            }
          },
          onError: () => {
            if (playbackSessionIdRef.current === currentSession) {
              setPlayingExcerptIdx(null);
              setLoadingExcerptIdx(null);
            }
          },
        },
        resolved.voiceId
      );
    } catch {
      if (playbackSessionIdRef.current === currentSession) {
        setPlayingExcerptIdx(null);
        setLoadingExcerptIdx(null);
      }
    }
  };

  useEffect(() => {
    if (dialogueLines.length === 0) return;
    let cancelled = false;

    // 1. Immediately pre-warm the very first chunk of Turn 0 so Play starts with 0ms delay
    const firstTurn = dialogueLines[0];
    if (firstTurn?.spokenText) {
      const firstChunks = chunkTextForTTS(firstTurn.spokenText);
      if (firstChunks.length > 0) {
        fetchCloudTtsAudio(firstChunks[0], firstTurn.gender, firstTurn.voiceId).catch(() => {});
      }
    }

    // 2. Pre-warm all dialogue lines in order using their strictly locked voiceId and gender
    (async () => {
      for (const turn of dialogueLines) {
        if (cancelled) break;
        if (!turn.spokenText) continue;
        await prefetchSpeechAudio(turn.spokenText, turn.voiceId, turn.gender).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      stopAllAudio();
    };
  }, [dialogueLines, stopAllAudio]);

  const startPlayback = async () => {
    stopAllAudio();
    const currentSession = ++playbackSessionIdRef.current;
    isPausedRef.current = false;
    setIsPlaying(true);
    setPlayCount((prev) => prev + 1);
    setActiveLine(0);

    try {
      const audioClips = (task as any).audioClips;
      const audioUrl = (task as any).audioUrl;

      // 1. Play saved audioClips if present
      if (Array.isArray(audioClips) && audioClips.length > 0) {
        for (let i = 0; i < audioClips.length; i++) {
          if (playbackSessionIdRef.current !== currentSession || isPausedRef.current) break;
          setActiveLine(i);
          const clipUrl = audioClips[i].url;
          if (clipUrl) {
            await new Promise<void>((resolve) => {
              if (playbackSessionIdRef.current !== currentSession || isPausedRef.current) {
                resolve();
                return;
              }
              const audio = new Audio(clipUrl);
              activeAudioRef.current = audio;
              audio.playbackRate = coachMode ? audioSpeed : 1.0;
              audio.onended = () => {
                if (activeAudioRef.current === audio) activeAudioRef.current = null;
                resolve();
              };
              audio.onerror = () => {
                if (activeAudioRef.current === audio) activeAudioRef.current = null;
                resolve();
              };
              audio.play().catch(() => {
                if (activeAudioRef.current === audio) activeAudioRef.current = null;
                resolve();
              });
            });
          }
          if (playbackSessionIdRef.current !== currentSession || isPausedRef.current) break;
        }
      } else if (audioUrl && audioUrl.startsWith('https://') && audioUrl.includes('blob.vercel-storage.com')) {
        // 2. Play single audioUrl if present
        await new Promise<void>((resolve) => {
          if (playbackSessionIdRef.current !== currentSession || isPausedRef.current) {
            resolve();
            return;
          }
          const audio = new Audio(audioUrl);
          activeAudioRef.current = audio;
          audio.playbackRate = coachMode ? audioSpeed : 1.0;
          audio.onended = () => {
            if (activeAudioRef.current === audio) activeAudioRef.current = null;
            resolve();
          };
          audio.onerror = () => {
            if (activeAudioRef.current === audio) activeAudioRef.current = null;
            resolve();
          };
          audio.play().catch(() => {
            if (activeAudioRef.current === audio) activeAudioRef.current = null;
            resolve();
          });
        });
      } else {
        // 3. Play each turn through cached speakWithCloudTTS using the strictly locked voiceId per role
        try {
          for (let i = 0; i < dialogueLines.length; i++) {
            if (playbackSessionIdRef.current !== currentSession || isPausedRef.current) break;
            setActiveLine(i);
            const turn = dialogueLines[i];
            if (!turn.spokenText) continue;

            // Pre-warm the next turn's first chunk in parallel while this turn plays
            if (i + 1 < dialogueLines.length && dialogueLines[i + 1].spokenText) {
              const nextTurn = dialogueLines[i + 1];
              const nextChunks = chunkTextForTTS(nextTurn.spokenText);
              if (nextChunks.length > 0) {
                fetchCloudTtsAudio(nextChunks[0], nextTurn.gender, nextTurn.voiceId).catch(
                  () => {}
                );
              }
            }

            await speakWithCloudTTS(
              turn.spokenText,
              turn.gender,
              {
                rate: coachMode ? audioSpeed : 1.0,
                voice: turn.voiceId,
                voiceName: turn.voiceId,
                gender: turn.gender,
                speaker: turn.speakerName,
                skipStop: true,
              },
              turn.voiceId
            );

            if (playbackSessionIdRef.current !== currentSession || isPausedRef.current) break;
          }
        } catch (ttsErr) {
          console.warn('TTS playback failed, falling back to playDialogue:', ttsErr);
          await playDialogue(
            lines,
            voices,
            (idx) => {
              setActiveLine(idx);
            }
          );
        }
      }
      if (playbackSessionIdRef.current === currentSession && !isPausedRef.current) {
        setListeningAudioFinished(true);
      }
    } catch {
      // Audio completed or stopped
    } finally {
      if (playbackSessionIdRef.current === currentSession) {
        setIsPlaying(false);
        setActiveLine(null);
      }
    }
  };

  const handlePauseAudio = () => {
    isPausedRef.current = true;
    playbackSessionIdRef.current++;
    if (activeAudioRef.current) {
      try {
        activeAudioRef.current.pause();
      } catch {}
      activeAudioRef.current = null;
    }
    stopSpeaking();
    setIsPlaying(false);
    setActiveLine(null);
  };

  const handleRestartAudio = () => {
    stopAllAudio();
    setIsPlaying(false);
    setActiveLine(null);
    startPlayback();
  };

  const [activeQuestionIdx, setActiveQuestionIdx] = useState<number>(0);

  const handleSelectOption = (qIdx: number, optIdx: number) => {
    if (submitted) return;
    setActiveQuestionIdx(qIdx);
    setSelectedAnswers((prev) => ({ ...prev, [qIdx]: optIdx }));
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
    setShowTranscript(true); // Automatically reveal the script after the student checks their answers
    const correctCount = calculateScore();
    const total = task.questions.length;
    const scaledScore = convertToScaledScore(correctCount, total);

    if (auth.currentUser) {
      task.questions.forEach((q, i) => {
        if (selectedAnswers[i] !== q.answer) {
          saveMistake(
            task.title,
            'listening-dialogue',
            q.options[selectedAnswers[i]] ?? 'No answer',
            q.options[q.answer],
            q.why
          );
        }
      });
    }

    savePracticeRecord({
      taskType: 'listening-dialogue',
      taskTitle: task.title,
      section: 'Listening',
      score: correctCount,
      maxScore: total,
      scaledScore30: scaledScore,
      timeSpentSeconds: 150,
      feedbackSummary: `Listening comprehension: scored ${correctCount}/${total} (${Math.round((correctCount / total) * 100)}%)`,
    });
    onComplete?.(scaledScore);
  }, [submitted, selectedAnswers, calculateScore, task.questions, task.title, onComplete]);

  const handleReset = () => {
    setSelectedAnswers({});
    setSubmitted(false);
    setListeningAudioFinished(false);
    setActiveQuestionIdx(0);
    setRevealedHints({});
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
          document.getElementById(`lis-question-${nextIdx}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

  return (
    <div className="space-y-4">
      <div className="border-b border-slate-200 pb-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">{task.title}</h2>
          <TaskSubtitleMeta task={task} extra={`${task.questions.length} Questions`} />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg">
            <span>⌨️ <strong className="font-semibold text-slate-800">Enter</strong>: Next item</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span><strong className="font-semibold text-teal-800">Ctrl + Enter</strong>: Submit</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>Plays: <strong className="font-mono text-slate-800">{playCount}</strong></span>
          </div>
          <TaskReportButton task={task} />
        </div>
      </div>

      {/* 2-Column Split Layout: Sticky Audio Player Card on Left, Scrollable Comprehension Questions on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Left Column: Audio Player Deck */}
        <div className={`space-y-4 ${leftColumnClassName}`}>
          <div className="bg-slate-900 text-white rounded-xl p-6 shadow-md">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase font-medium tracking-wider text-teal-400">Audio Track</span>
              <span className="text-xs text-slate-400">· {task.context}</span>
            </div>
            <div className="text-sm text-slate-300">
              {(task as any).type === 'announcement' ||
              (task as any).type === 'academic_talk' ||
              (task as any).type === 'lecture' ||
              !task.speakers?.B ||
              task.speakers.A === task.speakers.B ? (
                <>
                  Speaker: <strong className="text-slate-100">{task.speakers?.A || 'Speaker'}</strong>
                </>
              ) : (
                <>
                  Speakers: <strong className="text-slate-100">{task.speakers.A}</strong> &amp;{' '}
                  <strong className="text-slate-100">{task.speakers.B}</strong>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center flex-wrap gap-2.5">
            {/* Primary Play / Pause Button */}
            <button
              onClick={isPlaying ? handlePauseAudio : startPlayback}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all shadow-xs whitespace-nowrap shrink-0 ${
                isPlaying
                  ? 'bg-amber-500 hover:bg-amber-600 text-slate-950 ring-2 ring-amber-300'
                  : 'bg-teal-500 hover:bg-teal-400 text-slate-950'
              }`}
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
              {isPlaying ? 'Pause Audio' : 'Play Audio'}
            </button>

            {/* Separate, Dedicated Restart Button */}
            <button
              onClick={handleRestartAudio}
              className="flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium text-slate-200 hover:text-white bg-slate-800 hover:bg-slate-700 active:bg-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0 border border-slate-700 shadow-xs"
              title="Restart dialogue from the beginning"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Restart</span>
            </button>

            {/* Transcript Toggle Button */}
            <button
              onClick={() => setShowTranscript(!showTranscript)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 border border-slate-700/60"
              title="Toggle transcript text"
            >
              {showTranscript ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {showTranscript ? 'Hide Script' : 'Show Script (Study Mode)'}
            </button>
          </div>
        </div>

        {/* Animated Waveform Visualizer & Coach Audio Speed */}
        <div className="mt-5 pt-4 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Volume2 className={`w-4 h-4 ${isPlaying ? 'text-teal-400' : playCount > 0 ? 'text-amber-400' : 'text-slate-500'}`} />
            <span className="text-xs font-mono text-slate-300">
              {isPlaying
                ? `Playing Line ${(activeLine ?? 0) + 1} of ${lines.length}...`
                : playCount > 0
                ? 'Audio Paused (click Play or Restart)'
                : `Audio Ready (${lines.length} lines)`}
            </span>
          </div>

          <div className="flex items-center gap-3">
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

            <div className="flex items-end gap-1 h-6">
              {[4, 12, 8, 16, 22, 14, 9, 20, 15, 6, 18, 11, 24, 17, 8, 14, 5].map((h, i) => (
                <div
                  key={i}
                  className={`w-1 rounded-full transition-all duration-150 ${
                    isPlaying ? 'bg-teal-400 animate-pulse' : 'bg-slate-700'
                  }`}
                  style={{
                    height: isPlaying ? `${Math.max(4, (h * (i % 2 === 0 ? 1 : 0.7)))}px` : '4px',
                    animationDelay: `${i * 70}ms`,
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Optional Transcript */}
        {showTranscript && (
          <div className="mt-4 pt-4 border-t border-slate-800 bg-slate-950/60 rounded-lg p-4 space-y-2.5 max-h-56 overflow-y-auto text-xs sm:text-sm">
            {lines.map((line, idx) => {
              const parsed = parseDialogueLine(line);
              const isSpeakerB =
                (parsed.speakerName && (parsed.speakerName.toLowerCase().includes('student') || parsed.speakerName.toLowerCase() === (task.speakers?.B || '').toLowerCase())) ||
                line.startsWith('Speaker B:') ||
                line.startsWith('B:') ||
                line.toLowerCase().startsWith('student:') ||
                idx % 2 === 1;
              const isCurrent = activeLine === idx;
              const speakerLabel = parsed.speakerName || (isSpeakerB ? task.speakers.B : task.speakers.A);
              const spokenText = parsed.spokenText || line.replace(/^(Speaker [AB]:|[AB]:|Professor.*?:|Student.*?:)\s*/i, '');

              return (
                <div
                  key={idx}
                  className={`p-2 rounded transition-colors ${
                    isCurrent
                      ? 'bg-teal-900/40 text-teal-200 border-l-2 border-teal-400'
                      : 'text-slate-300'
                  }`}
                >
                  <strong className={isSpeakerB ? 'text-cyan-400' : 'text-emerald-400'}>
                    {speakerLabel}:
                  </strong>{' '}
                  <span>{spokenText}</span>
                </div>
              );
            })}
          </div>
        )}
          </div>
        </div>

        {/* Right Column: Comprehension Questions (Shown immediately in Coach Mode, or after audio finishes in Exam Mode) */}
        <div className={`space-y-5 ${rightColumnClassName}`}>
          {!listeningAudioFinished && !submitted && !coachMode ? (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <p className="text-sm text-slate-700 font-medium leading-relaxed">
                🎧 Listen to the audio track completely. The comprehension questions will appear automatically once the audio finishes.
              </p>
              <button
                type="button"
                onClick={() => setListeningAudioFinished(true)}
                className="text-xs font-semibold text-teal-700 hover:text-teal-900 underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                Skip Audio &amp; Show Questions
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <span className="text-xs font-semibold text-slate-700 uppercase tracking-wider">Comprehension Questions</span>
                <span className="text-xs text-slate-500 font-mono">
                  {Object.keys(selectedAnswers).length}/{total} Answered
                </span>
              </div>

        {task.questions.map((q, qIdx) => {
          const userChoice = selectedAnswers[qIdx];
          const isCorrect = userChoice === q.answer;
          const skillBadge = inferListeningQuestionType(q.q, q.questionType, Boolean(q.audioExcerpt));
          const isExcerptPlaying = playingExcerptIdx === qIdx;
          const isExcerptLoading = loadingExcerptIdx === qIdx;
          const showEval = submitted || Boolean(coachMode && checkedQuestions[qIdx]);

          return (
            <div
              key={qIdx}
              id={`lis-question-${qIdx}`}
              className={`bg-white border rounded-xl p-5 shadow-xs transition-colors ${
                showEval
                  ? isCorrect
                    ? 'border-emerald-200 bg-emerald-50/20'
                    : 'border-rose-200 bg-rose-50/20'
                  : 'border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-slate-100 text-slate-700 text-xs font-semibold shrink-0">
                    {qIdx + 1}
                  </span>
                  <span className="text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-md">
                    {skillBadge}
                  </span>
                </div>
                {coachMode && !submitted && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setRevealedHints((prev) => ({
                          ...prev,
                          [qIdx]: !prev[qIdx],
                        }))
                      }
                      className="text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-2 py-0.5 rounded-md transition-colors cursor-pointer"
                    >
                      {revealedHints[qIdx] ? 'Hide Hint' : '💡 Coach Hint'}
                    </button>
                    {userChoice !== undefined && (
                      <button
                        type="button"
                        onClick={() =>
                          setCheckedQuestions((prev) => ({
                            ...prev,
                            [qIdx]: !prev[qIdx],
                          }))
                        }
                        className="text-[11px] font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2 py-0.5 rounded-md transition-colors cursor-pointer"
                      >
                        {checkedQuestions[qIdx] ? 'Hide Check' : '✓ Check Question'}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {coachMode && revealedHints[qIdx] && !submitted && (
                <div className="mb-3 p-3 rounded-lg bg-indigo-50/80 border border-indigo-200 text-xs text-indigo-950 leading-relaxed">
                  <strong className="font-bold text-indigo-900">🎓 Listening Strategy &amp; Hint:</strong>{' '}
                  {(() => {
                    const rawHint = (q as any).hint;
                    if (typeof rawHint === 'string') return rawHint;
                    if (rawHint && typeof rawHint === 'object') {
                      return String(rawHint.text || rawHint.hint || rawHint.tip || rawHint.strategy || JSON.stringify(rawHint));
                    }
                    return String(q.why || '');
                  })()}
                </div>
              )}

              {q.audioExcerpt && (
                <div className="mb-3.5 p-3 rounded-xl bg-slate-900 text-white border border-emerald-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-2xs">
                  <div className="space-y-1">
                    <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                      <span>{excerptBadgeLabel}</span>
                    </div>
                    {(submitted || coachMode) && (
                      <p className="text-xs text-slate-300 italic leading-relaxed">
                        &ldquo;{stripSpeakerAndFormatting(q.audioExcerpt)}&rdquo;
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handlePlayExcerpt(qIdx, q.audioExcerpt!, q.q)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      isExcerptPlaying
                        ? 'bg-amber-500 hover:bg-amber-600 text-slate-950'
                        : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                    }`}
                  >
                    {isExcerptLoading ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Loading...</span>
                      </>
                    ) : isExcerptPlaying ? (
                      <>
                        <Pause className="w-3.5 h-3.5 fill-current" />
                        <span>Stop Excerpt</span>
                      </>
                    ) : (
                      <span>▶️ Play Excerpt</span>
                    )}
                  </button>
                </div>
              )}

              <div className="mb-3.5">
                <p className="text-sm font-semibold text-slate-900 leading-snug">{q.q}</p>
              </div>

              <div className="space-y-2">
                {q.options.map((opt, optIdx) => {
                  const isSelected = userChoice === optIdx;
                  const isRightOption = q.answer === optIdx;

                  let optionClasses =
                    'border-slate-200 bg-slate-50/50 hover:bg-slate-100/70 text-slate-800';

                  if (showEval) {
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
                      onClick={() => handleSelectOption(qIdx, optIdx)}
                      className={`flex items-start gap-3 p-3 rounded-lg border text-xs sm:text-sm cursor-pointer transition-all ${optionClasses}`}
                    >
                      <input
                        type="radio"
                        name={`lis-q-${qIdx}`}
                        checked={isSelected}
                        disabled={submitted}
                        onChange={() => handleSelectOption(qIdx, optIdx)}
                        className="mt-0.5 text-teal-700 focus:ring-teal-500 shrink-0"
                      />
                      <span className="leading-snug">{opt}</span>
                    </label>
                  );
                })}
              </div>

              {showEval && (
                <div className="mt-3.5 pt-3 border-t border-slate-200/80 text-xs leading-relaxed">
                  <strong className={isCorrect ? 'text-emerald-700' : 'text-slate-800'}>
                    {isCorrect ? 'Correct!' : 'Official Explanation:'}
                  </strong>{' '}
                  <span className="text-slate-700">{q.why}</span>
                </div>
              )}
            </div>
          );
        })}

        {/* Footer controls */}
        <div className={footerBarClassName}>
          {!submitted ? (
            <button
              onClick={handleSubmit}
              disabled={!allAnswered}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 disabled:hover:bg-teal-700 rounded-lg shadow-xs transition-colors whitespace-nowrap"
            >
              <CheckCircle2 className="w-4 h-4" />
              Check Listening Answers
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
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
                    const firstMissed = document.getElementById(`lis-question-${missedIndices[0]}`);
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
                  Next Conversation
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
                Est. Scaled: <strong className="font-mono text-teal-800 whitespace-nowrap">Band {convertScaledToBand6(convertToScaledScore(score, total), 'Listening').toFixed(1)} / 6.0</strong> <span className="font-mono text-slate-500 text-xs">({convertToScaledScore(score, total)}/30)</span>
              </span>
            </div>
          )}
        </div>
      </div>
          )}
        </div>
      </div>
    </div>
  );
};
