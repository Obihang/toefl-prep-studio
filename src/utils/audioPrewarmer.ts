import {
  prefetchSpeechAudio,
  stripSpeakerAndFormatting,
  inferGenderFromSpeaker,
  pickRandomVoice,
} from './audioSpeech';
import { parseDialogueLine } from './voices';
import { normalizeListeningChooseResponseTask } from './taskNormalizer';

export interface PreCacheProgress {
  current: number;
  total: number;
  statusText: string;
  isComplete: boolean;
  error?: string;
}

type CanonicalSpeakerRole = 'professor' | 'student';

const AUTHORITY_ROLE_REGEX =
  /\b(professor|prof\.?|advisor|librarian|instructor|doctor|dr\.?|staff|dean|coordinator|director|coach|assistant|receptionist|narrator|lecturer|faculty|teacher)\b/i;
const STUDENT_ROLE_REGEX =
  /\b(student|undergraduate|grad student|classmate|peer)\b/i;

function extractVocativeNamesFromLines(
  lines: string[],
  targetRole: CanonicalSpeakerRole,
  rolesByLine: CanonicalSpeakerRole[]
): string[] {
  const vocatives: string[] = [];
  lines.forEach((rawLine, idx) => {
    const speakerRole = rolesByLine[idx];
    if (speakerRole === targetRole) return;
    const parsed = parseDialogueLine(rawLine);
    const text = parsed.spokenText || rawLine;
    const matches = [
      ...Array.from(
        text.matchAll(
          /\b(?:hi|hello|hey|thanks|thank you|yes|no|well|actually|right|sure|okay|welcome)\s*,?\s+([A-Z][a-z]{2,15})\b/g
        )
      ),
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

  if (STUDENT_ROLE_REGEX.test(s) || /\b(speaker\s*b|^b$)\b/i.test(s)) {
    return 'student';
  }
  if (AUTHORITY_ROLE_REGEX.test(s) || /\b(speaker\s*a|^a$)\b/i.test(s)) {
    return 'professor';
  }

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

  if (s && !AUTHORITY_ROLE_REGEX.test(s) && (aIsAuthority || bIsAuthority)) {
    return 'student';
  }

  return lineIndex % 2 === 0 ? 'professor' : 'student';
}

/**
 * Extracts all spoken lines for a task with the exact deterministic speaker voiceId and gender
 * that the task player component uses during playback.
 */
export function extractTaskAudioLinesWithVoices(
  task: any,
  taskType: string
): Array<{ text: string; voice: string; gender: 'male' | 'female' }> {
  if (!task) return [];
  const normType = String(taskType || task.taskType || '')
    .toLowerCase()
    .replace(/_/g, '-');
  const results: Array<{ text: string; voice: string; gender: 'male' | 'female' }> = [];

  if (normType.includes('choose-response')) {
    const normalized = normalizeListeningChooseResponseTask(task);
    const items =
      Array.isArray(normalized.items) && normalized.items.length > 0
        ? normalized.items
        : [
            {
              audioPrompt:
                normalized.audioPrompt ||
                normalized.promptAudioScript ||
                normalized.script ||
                normalized.spokenPrompt ||
                normalized.prompt ||
                '',
              speakerGender:
                normalized.speakerGender === 'female' ? 'female' : 'male',
            },
          ];
    for (const it of items) {
      const gender: 'male' | 'female' =
        it.speakerGender === 'female' ? 'female' : 'male';
      const voice = pickRandomVoice(gender).voiceId;
      const rawText =
        it.audioPrompt ||
        it.promptAudioScript ||
        it.script ||
        it.spokenPrompt ||
        it.prompt ||
        '';
      const clean = stripSpeakerAndFormatting(rawText);
      if (clean) {
        results.push({ text: clean, voice, gender });
      }
    }
    return results;
  }

  if (normType.includes('announcement')) {
    const scriptText = task.script || task.announcement || task.text || '';
    const gender: 'male' | 'female' =
      task.speakerGender === 'female' ? 'female' : 'male';
    const voice = pickRandomVoice(gender).voiceId;
    const clean = stripSpeakerAndFormatting(scriptText);
    if (clean) {
      results.push({ text: clean, voice, gender });
    }
    if (Array.isArray(task.questions)) {
      for (const q of task.questions) {
        if (q?.audioExcerpt) {
          const cleanEx = stripSpeakerAndFormatting(String(q.audioExcerpt));
          if (cleanEx) results.push({ text: cleanEx, voice, gender });
        }
      }
    }
    return results;
  }

  if (normType.includes('academic-talk')) {
    const scriptText = task.script || task.lecture || task.text || '';
    const gender: 'male' | 'female' =
      task.speakerGender === 'female' ? 'female' : 'male';
    const voice = pickRandomVoice(gender).voiceId;
    const clean = stripSpeakerAndFormatting(scriptText);
    if (clean) {
      results.push({ text: clean, voice, gender });
    }
    if (Array.isArray(task.questions)) {
      for (const q of task.questions) {
        if (q?.audioExcerpt) {
          const cleanEx = stripSpeakerAndFormatting(String(q.audioExcerpt));
          if (cleanEx) results.push({ text: cleanEx, voice, gender });
        }
      }
    }
    return results;
  }

  if (normType.includes('dialogue') || normType.includes('conversation')) {
    const scriptText = String(task.script || '');
    const lines = scriptText.split(/\n+/).filter(Boolean);
    const taskSubType = String(task.type || '').toLowerCase();
    const isSingleSpeakerPassage =
      taskSubType === 'announcement' ||
      taskSubType === 'academic_talk' ||
      taskSubType === 'lecture' ||
      (lines.length <= 2 && !/speaker b|^b:|student:/im.test(scriptText));

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

    let profVoice: { gender: 'male' | 'female'; voiceId: string };
    let studentVoice: { gender: 'male' | 'female'; voiceId: string };

    if (isSingleSpeakerPassage) {
      const inferred =
        inferGenderFromSpeaker(
          `${labelA} ${distinctScriptSpeakers.join(' ')} ${task.context || ''} ${scriptText.slice(0, 160)}`
        ) ||
        (task.speakerGenderA as 'male' | 'female' | undefined) ||
        (task.speakerGenders?.A as 'male' | 'female' | undefined);
      const singleVoice = pickRandomVoice(inferred || undefined);
      profVoice = singleVoice;
      studentVoice = singleVoice;
    } else {
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
        const role = classifyCanonicalRole(
          fullSpk || parsed.speakerName,
          idx,
          labelA,
          labelB
        );
        rolesByLine.push(role);
        if (fullSpk) {
          if (role === 'professor') profLabels.push(fullSpk);
          else studentLabels.push(fullSpk);
        }
      });

      const studentVocatives = extractVocativeNamesFromLines(lines, 'student', rolesByLine);
      const profVocatives = extractVocativeNamesFromLines(lines, 'professor', rolesByLine);

      const explicitGA = task.speakerGenderA || task.speakerGenders?.A;
      const explicitGB = task.speakerGenderB || task.speakerGenders?.B;

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

      const nameInferredStudentG = inferGenderFromSpeaker(
        [...studentLabels, ...studentVocatives].join(' ')
      );
      const nameInferredProfG = inferGenderFromSpeaker(
        [...profLabels, ...profVocatives].join(' ')
      );

      const inferredStudentGender = nameInferredStudentG || explicitStudentG;
      const inferredProfGender = nameInferredProfG || explicitProfG;

      if (inferredStudentGender && !inferredProfGender) {
        studentVoice = pickRandomVoice(inferredStudentGender);
        const targetProfGender: 'male' | 'female' =
          studentVoice.gender === 'female' ? 'male' : 'female';
        profVoice = pickRandomVoice(targetProfGender, studentVoice.voiceId);
      } else {
        profVoice = pickRandomVoice(inferredProfGender || undefined);
        const targetStudentGender: 'male' | 'female' =
          inferredStudentGender || (profVoice.gender === 'male' ? 'female' : 'male');
        studentVoice = pickRandomVoice(targetStudentGender, profVoice.voiceId);
      }
    }

    lines.forEach((line, idx) => {
      const parsed = parseDialogueLine(line);
      const rawSpeaker = parsed.speakerName || '';
      const fullSpk = parsed.speakerHint
        ? `${rawSpeaker} (${parsed.speakerHint})`
        : rawSpeaker;
      const spokenText = parsed.spokenText || stripSpeakerAndFormatting(line);
      if (!spokenText) return;

      if (isSingleSpeakerPassage) {
        results.push({
          text: spokenText,
          voice: profVoice.voiceId,
          gender: profVoice.gender,
        });
      } else {
        const role = classifyCanonicalRole(fullSpk || rawSpeaker, idx, labelA, labelB);
        const lockedVoice = role === 'student' ? studentVoice : profVoice;
        results.push({
          text: spokenText,
          voice: lockedVoice.voiceId,
          gender: lockedVoice.gender,
        });
      }
    });

    if (Array.isArray(task.questions)) {
      for (const q of task.questions) {
        if (q?.audioExcerpt) {
          const cleanEx = stripSpeakerAndFormatting(String(q.audioExcerpt));
          if (cleanEx) {
            results.push({
              text: cleanEx,
              voice: profVoice.voiceId,
              gender: profVoice.gender,
            });
          }
        }
      }
    }

    return results;
  }

  if (normType.includes('listen-repeat')) {
    const speakerName = task.speakerName || 'Narrator';
    const explicitGender = task.speakerGender;
    const inferred =
      explicitGender === 'male' || explicitGender === 'female'
        ? explicitGender
        : inferGenderFromSpeaker(`${speakerName} ${task.title || ''}`);
    const lockedVoice = pickRandomVoice(inferred || undefined);
    if (Array.isArray(task.sentences)) {
      for (const s of task.sentences) {
        const clean = stripSpeakerAndFormatting(String(s || ''));
        if (clean) {
          results.push({
            text: clean,
            voice: lockedVoice.voiceId,
            gender: lockedVoice.gender,
          });
        }
      }
    }
    return results;
  }

  if (normType.includes('speaking-interview') || normType.includes('interview')) {
    const interviewerName = task.interviewerName || 'Interviewer';
    const explicitGender = task.interviewerGender;
    const inferred =
      explicitGender === 'male' || explicitGender === 'female'
        ? explicitGender
        : inferGenderFromSpeaker(`${interviewerName} ${task.context || ''}`);
    const interviewerVoiceInfo = pickRandomVoice(inferred || undefined);
    if (Array.isArray(task.questions)) {
      for (const q of task.questions) {
        const qText = typeof q === 'string' ? q : q?.question;
        const clean = stripSpeakerAndFormatting(String(qText || ''));
        if (clean) {
          results.push({
            text: clean,
            voice: interviewerVoiceInfo.voiceId,
            gender: interviewerVoiceInfo.gender,
          });
        }
      }
    }
    return results;
  }

  return results;
}

/**
 * Pre-caches voice audio into in-memory Map & IndexedDB (toefl_tts_audio_cache)
 * for the target questions (current active question + next 2 unpracticed questions)
 * using the exact deterministic speaker voiceId and gender that the player uses.
 */
export async function preCacheTargetQuestionsAudio(
  targets: Array<{ task: any; taskType: string }>,
  onProgress?: (progress: PreCacheProgress) => void
): Promise<{ success: boolean; cached: number; total: number }> {
  const validTargets = targets.filter((t) => t && t.task);
  const totalQuestions = validTargets.length;

  if (totalQuestions === 0) {
    onProgress?.({
      current: 0,
      total: 0,
      statusText: '✅ 0/0 Audio Cached',
      isComplete: true,
    });
    return { success: true, cached: 0, total: 0 };
  }

  let cachedQuestions = 0;

  for (let qIdx = 0; qIdx < totalQuestions; qIdx++) {
    const target = validTargets[qIdx];
    onProgress?.({
      current: qIdx + 1,
      total: totalQuestions,
      statusText: `🔊 Pre-Caching ${qIdx + 1}/${totalQuestions}...`,
      isComplete: false,
    });

    const rawLines = extractTaskAudioLinesWithVoices(target.task, target.taskType);
    const seenKeys = new Set<string>();
    const uniqueLines = rawLines.filter((item) => {
      const k = `${item.voice}:::${item.text}`;
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      return true;
    });

    for (const line of uniqueLines) {
      try {
        await prefetchSpeechAudio(line.text, line.voice, line.gender);
      } catch {
        // Continue pre-caching remaining lines
      }
    }

    cachedQuestions++;
  }

  onProgress?.({
    current: totalQuestions,
    total: totalQuestions,
    statusText: `✅ ${cachedQuestions}/${totalQuestions} Audio Cached`,
    isComplete: true,
  });

  return {
    success: true,
    cached: cachedQuestions,
    total: totalQuestions,
  };
}

/**
 * Pre-caches voice audio into IndexedDB for the scoped questions in the active section
 * (Listening or Speaking) using exact deterministic speaker voices so playback starts in 0ms.
 */
export async function preCacheSectionAudio(
  section: string,
  onProgress?: (progress: PreCacheProgress) => void,
  scopedTargets?: Array<{ task: any; taskType: string }>
): Promise<{ success: boolean; cached: number; total: number }> {
  if (Array.isArray(scopedTargets) && scopedTargets.length > 0) {
    return preCacheTargetQuestionsAudio(scopedTargets, onProgress);
  }

  const normSection = section.toLowerCase();
  const discoveredTargets: Array<{ task: any; taskType: string }> = [];

  try {
    if (normSection.includes('listen')) {
      const shards: Array<{ url: string; taskType: string }> = [
        { url: '/question-bank/listening-choose-response.json', taskType: 'listening-choose-response' },
        { url: '/question-bank/listening-dialogue.json', taskType: 'listening-dialogue' },
        { url: '/question-bank/listening-announcement.json', taskType: 'listening-announcement' },
      ];
      for (const s of shards) {
        if (discoveredTargets.length >= 3) break;
        const res = await fetch(s.url);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            discoveredTargets.push({ task: data[0], taskType: s.taskType });
          }
        }
      }
    } else if (normSection.includes('speak')) {
      const lrRes = await fetch('/question-bank/listen-repeat.json');
      if (lrRes.ok) {
        const lrData = await lrRes.json();
        if (Array.isArray(lrData)) {
          lrData.slice(0, 2).forEach((t) =>
            discoveredTargets.push({ task: t, taskType: 'listen-repeat' })
          );
        }
      }
      const siRes = await fetch('/question-bank/speaking-interview.json');
      if (siRes.ok) {
        const siData = await siRes.json();
        if (Array.isArray(siData) && siData.length > 0) {
          discoveredTargets.push({ task: siData[0], taskType: 'speaking-interview' });
        }
      }
    }
  } catch (err) {
    console.warn('[AudioPrewarmer] Failed to load shards for pre-cache:', err);
  }

  return preCacheTargetQuestionsAudio(discoveredTargets.slice(0, 3), onProgress);
}

