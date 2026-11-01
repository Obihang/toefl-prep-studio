import { db, auth } from '../firebase';
import { collection, addDoc, doc, getDoc, getDocs, updateDoc, setDoc, query, where, serverTimestamp } from 'firebase/firestore';

export interface PracticeRecord {
  id: string;
  taskType: string;
  taskTitle: string;
  section: 'Reading' | 'Listening' | 'Speaking' | 'Writing';
  date: string;
  score: number;
  maxScore: number;
  rawScore?: number;
  rawMaxScore?: number;
  scaledScore30: number;
  bandScore6?: number; // Official updated TOEFL 1.0 - 6.0 band scale
  timeSpentSeconds: number;
  studentResponse?: string;
  feedbackSummary?: string;
  grammarErrors?: Array<{ original: string; corrected: string; explanation: string; type?: string }>;
  modelAnswer?: string;
}

export type ScoreEntry = PracticeRecord;

export function band6ToScaled30(band6: number): number {
  const b = Math.round((Number(band6) || 1) * 2) / 2;
  if (b >= 6.0) return 30;
  if (b >= 5.5) return 28;
  if (b >= 5.0) return 25;
  if (b >= 4.5) return 22;
  if (b >= 4.0) return 19;
  if (b >= 3.5) return 16;
  if (b >= 3.0) return 13;
  if (b >= 2.5) return 10;
  if (b >= 2.0) return 7;
  if (b >= 1.5) return 4;
  return 2;
}

export function sanitizePracticeRecord(raw: any): { record: PracticeRecord; changed: boolean } {
  const origScore = Number(raw?.score ?? 0);
  const origMax = Number(raw?.maxScore ?? 30);
  let scaled30: number;

  if (typeof raw?.scaledScore30 === 'number' && !isNaN(raw.scaledScore30) && raw.scaledScore30 >= 0 && raw.scaledScore30 <= 30) {
    scaled30 = Math.round(raw.scaledScore30);
  } else if (typeof raw?.bandScore6 === 'number' && !isNaN(raw.bandScore6) && raw.bandScore6 >= 1 && raw.bandScore6 <= 6) {
    scaled30 = band6ToScaled30(raw.bandScore6);
  } else if (origScore > origMax && origScore <= 30) {
    // Corrupted entry where scaled30 was stored in score alongside raw maxScore (e.g. 30/1, 28/10)
    scaled30 = Math.round(origScore);
  } else if (origMax > 0 && origMax !== 30 && origScore <= origMax) {
    scaled30 = convertToScaledScore(origScore, origMax);
  } else {
    scaled30 = Math.min(30, Math.max(0, Math.round(origScore)));
  }

  const section = (raw?.section || 'Reading') as 'Reading' | 'Listening' | 'Speaking' | 'Writing';
  const bandScore6 =
    typeof raw?.bandScore6 === 'number' && !isNaN(raw.bandScore6) && raw.bandScore6 >= 1 && raw.bandScore6 <= 6
      ? raw.bandScore6
      : convertScaledToBand6(scaled30, section);

  const changed =
    raw?.score !== scaled30 ||
    raw?.maxScore !== 30 ||
    raw?.scaledScore30 !== scaled30 ||
    raw?.bandScore6 !== bandScore6;

  const record: PracticeRecord = {
    ...raw,
    id: raw?.id || 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    taskType: raw?.taskType || 'academic-discussion',
    taskTitle: raw?.taskTitle || raw?.taskType || 'Practice Task',
    section,
    date: raw?.date || new Date().toISOString(),
    rawScore: raw?.rawScore ?? (origMax !== 30 && origScore <= origMax ? origScore : undefined),
    rawMaxScore: raw?.rawMaxScore ?? (origMax !== 30 ? origMax : undefined),
    score: scaled30,
    maxScore: 30,
    scaledScore30: scaled30,
    bandScore6,
    timeSpentSeconds: Number(raw?.timeSpentSeconds || 60),
    studentResponse: typeof raw?.studentResponse === 'string' ? raw.studentResponse : undefined,
    feedbackSummary: typeof raw?.feedbackSummary === 'string' ? raw.feedbackSummary : (typeof raw?.feedback === 'string' ? raw.feedback : undefined),
    grammarErrors: Array.isArray(raw?.grammarErrors) ? raw.grammarErrors : undefined,
    modelAnswer: typeof raw?.modelAnswer === 'string' ? raw.modelAnswer : undefined,
  };

  return { record, changed };
}

export function getCurrentUserId(): string {
  if (typeof window === 'undefined') return 'anonymous';
  try {
    if (auth?.currentUser?.uid) {
      return auth.currentUser.uid;
    }
  } catch {}
  let localId = localStorage.getItem('local_device_id');
  if (!localId) {
    localId = 'anon-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('local_device_id', localId);
  }
  return localId;
}

const getStorageKey = () => `toefl_prep_history_${getCurrentUserId()}`;

export function getPracticeHistory(): PracticeRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const key = getStorageKey();
    const raw = localStorage.getItem(key) || localStorage.getItem('toefl_score_history');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    let anyRepaired = false;
    const examModeOnly = parsed.filter((item) => {
      if (!item || typeof item !== 'object') {
        anyRepaired = true;
        return false;
      }
      if ((item as any).practiceMode === 'coach' || (item as any).mode === 'coach') {
        anyRepaired = true;
        return false;
      }
      if ((item as any).isMockExam === true) {
        anyRepaired = true;
        return false;
      }
      const title = String(item.taskTitle || '');
      if (
        title.startsWith('Full Mock Test') ||
        title.startsWith('Full-Length 2026 TOEFL iBT® Mock Exam') ||
        title.includes('(Timed Out)')
      ) {
        anyRepaired = true;
        return false;
      }
      return true;
    });

    const sanitized = examModeOnly.map((item) => {
      const { record, changed } = sanitizePracticeRecord(item);
      if (changed) anyRepaired = true;
      return record;
    });

    if (anyRepaired) {
      try {
        localStorage.setItem(key, JSON.stringify(sanitized));
        localStorage.setItem('toefl_score_history', JSON.stringify(sanitized));
      } catch {}
    }

    return sanitized;
  } catch {
    return [];
  }
}

export const COMPLETED_QUESTIONS_KEY = 'toefl_completed_question_ids';

export function getCompletedQuestionIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(COMPLETED_QUESTIONS_KEY);
    const stored: string[] = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(stored) ? [...stored] : [];

    // Also include titles/IDs from existing practice history so prior completions count immediately
    const historyRaw =
      localStorage.getItem(getStorageKey()) || localStorage.getItem('toefl_score_history');
    if (historyRaw) {
      const parsed = JSON.parse(historyRaw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.taskTitle && typeof item.taskTitle === 'string') {
            list.push(item.taskTitle.trim().toLowerCase());
          }
          if (item?.questionId && typeof item.questionId === 'string') {
            list.push(item.questionId.trim());
          }
        }
      }
    }
    return Array.from(new Set(list.filter(Boolean)));
  } catch {
    return [];
  }
}

export function markQuestionCompleted(questionOrId: any): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const current = new Set(getCompletedQuestionIds());
    if (typeof questionOrId === 'string' && questionOrId.trim()) {
      current.add(questionOrId.trim());
      current.add(questionOrId.trim().toLowerCase());
    } else if (questionOrId && typeof questionOrId === 'object') {
      const candidates = [
        questionOrId.id,
        questionOrId.questionDocId,
        questionOrId.content?.id,
        questionOrId.title,
        questionOrId.content?.title,
      ];
      for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) {
          current.add(c.trim());
          current.add(c.trim().toLowerCase());
        }
      }
    }
    const updated = Array.from(current);
    localStorage.setItem(COMPLETED_QUESTIONS_KEY, JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent('toefl_completed_questions_updated'));
    return updated;
  } catch {
    return [];
  }
}

export function isQuestionCompleted(question: any, completedIds?: string[] | Set<string>): boolean {
  if (!question) return false;
  const set =
    completedIds instanceof Set
      ? completedIds
      : new Set(Array.isArray(completedIds) ? completedIds : getCompletedQuestionIds());
  if (set.size === 0) return false;

  const candidates = [
    question.id,
    question.questionDocId,
    question.content?.id,
    question.title,
    question.content?.title,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      if (set.has(c.trim()) || set.has(c.trim().toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

export async function savePracticeRecord(
  record: Omit<PracticeRecord, 'id' | 'date'>,
  practiceModeOverride?: 'exam' | 'coach'
): Promise<PracticeRecord> {
  const { record: fullRecord } = sanitizePracticeRecord({
    ...record,
    rawScore: record.rawScore ?? record.score,
    rawMaxScore: record.rawMaxScore ?? record.maxScore,
    id: 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    date: new Date().toISOString(),
  });

  // 1. Do NOT save Coach & Marathon Mode scores into official scoreHistory (`toefl_score_history`)
  const activeMode =
    practiceModeOverride ||
    (record as any)?.practiceMode ||
    (typeof window !== 'undefined' && localStorage.getItem('toefl_practice_mode') === 'coach'
      ? 'coach'
      : 'exam');
  if (activeMode === 'coach') {
    return fullRecord;
  }

  // 2. Do NOT push Full Mock Test entries into single-task Section Practice scoreHistory (`toefl_score_history`)
  const isInMockExam =
    Boolean((record as any)?.isMockExam) ||
    (typeof window !== 'undefined' && localStorage.getItem('toefl_in_mock_test') === 'true');
  if (isInMockExam) {
    return fullRecord;
  }

  try {
    const history = getPracticeHistory();
    history.unshift(fullRecord);
    const trimmed = history.slice(0, 100);
    localStorage.setItem(getStorageKey(), JSON.stringify(trimmed));
    localStorage.setItem('toefl_score_history', JSON.stringify(trimmed));

    if (fullRecord.taskTitle) {
      markQuestionCompleted(fullRecord.taskTitle);
    }

    if (auth.currentUser) {
      await saveTaskCompletion(fullRecord.taskType, fullRecord);
    }
  } catch (e) {
    console.error('Failed to save score record', e);
  }

  return fullRecord;
}

export const saveScoreEntry = savePracticeRecord;

export async function saveTaskCompletion(taskType: string, fullRecord?: PracticeRecord) {
  const userId = getCurrentUserId();
  const today = new Date().toISOString().split('T')[0];

  // 1. Save Completion (with optional saved response & evaluation details)
  try {
    const payload: Record<string, any> = {
      userId,
      taskType,
      completedAt: serverTimestamp(),
    };
    if (fullRecord) {
      payload.taskTitle = fullRecord.taskTitle;
      payload.section = fullRecord.section;
      payload.scaledScore30 = fullRecord.scaledScore30;
      payload.bandScore6 = fullRecord.bandScore6 ?? null;
      if (fullRecord.studentResponse) payload.studentResponse = fullRecord.studentResponse;
      if (fullRecord.feedbackSummary) payload.feedbackSummary = fullRecord.feedbackSummary;
      if (Array.isArray(fullRecord.grammarErrors) && fullRecord.grammarErrors.length > 0) {
        payload.grammarErrors = fullRecord.grammarErrors.slice(0, 20);
      }
      if (fullRecord.modelAnswer) payload.modelAnswer = fullRecord.modelAnswer;
    }
    await addDoc(collection(db, 'completions'), payload);
  } catch (err) {
    console.error('Failed to save completion record:', err);
  }

  // 2. Update Stats (Streak)
  try {
    const statsRef = doc(db, 'userStats', userId);
    const statsSnap = await getDoc(statsRef);
    
    let currentStreak = 1;
    let lastCompletedDate = today;

    if (statsSnap.exists()) {
      const data = statsSnap.data();
      const lastDate = new Date(data.lastCompletedDate);
      const todayDate = new Date(today);
      
      const diffTime = Math.abs(todayDate.getTime() - lastDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays === 1) {
        currentStreak = (data.currentStreak || 0) + 1;
      } else if (diffDays > 1) {
        currentStreak = 1;
      } else {
        currentStreak = data.currentStreak || 1;
      }
      lastCompletedDate = today;
    }

    await setDoc(statsRef, { userId, currentStreak, lastCompletedDate }, { merge: true });
  } catch (err) {
    console.error('Failed to update userStats:', err);
  }
  
  // 3. Save Day in Subcollection
  try {
    await setDoc(doc(db, 'userStats', userId, 'completedDays', today), { date: today, userId });
  } catch (err) {
    console.error('Failed to save completedDay:', err);
  }
}

export async function getUserStats() {
  const userId = getCurrentUserId();
  try {
    const statsSnap = await getDoc(doc(db, 'userStats', userId));
    return statsSnap.exists() ? statsSnap.data() : null;
  } catch (err) {
    console.warn('Failed to get userStats from Firestore (offline):', err);
    return null;
  }
}

export async function getCompletedDays() {
  const userId = getCurrentUserId();
  try {
    const q = query(collection(db, 'userStats', userId, 'completedDays'), where('userId', '==', userId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => doc.data().date);
  } catch (err) {
    console.warn('Failed to get completedDays from Firestore (offline):', err);
    return [];
  }
}

export function clearPracticeHistory() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(getStorageKey());
    localStorage.removeItem('toefl_score_history');
  }
}

export function clearAllUserProgress() {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(getStorageKey());
    localStorage.removeItem('toefl_score_history');
    localStorage.removeItem(COMPLETED_QUESTIONS_KEY);
    localStorage.removeItem('toefl_mistakes');
    localStorage.removeItem(`toefl_mistakes_${getCurrentUserId()}`);
    localStorage.removeItem('toefl_exam_history');
    localStorage.removeItem('toefl_mock_set_scores_v1');
    localStorage.removeItem('toefl_exam_used_ids');
    localStorage.removeItem('toefl_adaptive_difficulty');
    localStorage.removeItem('toefl_difficulty_history');
    localStorage.removeItem(`toefl_daily_plan_${getCurrentUserId()}`);

    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (
        key &&
        (key.startsWith('toefl_prep_history_') ||
          key.startsWith('toefl_mistakes_') ||
          key.startsWith('toefl_daily_plan_') ||
          key.startsWith('toefl_draft_'))
      ) {
        localStorage.removeItem(key);
      }
    }

    window.dispatchEvent(new CustomEvent('toefl_completed_questions_updated'));
    window.dispatchEvent(new CustomEvent('toefl_mistakes_updated'));
    window.dispatchEvent(new CustomEvent('toefl_daily_plan_updated'));
    window.dispatchEvent(new CustomEvent('toefl_exam_history_updated'));
    window.dispatchEvent(new CustomEvent('toefl_progress_reset'));
  } catch (e) {
    console.warn('Failed to clear all user progress:', e);
  }
}

export const resetPracticeHistory = clearPracticeHistory;

export {
  TOEFL_TEST_STRUCTURE_2026,
  TOEFL_CONCORDANCE_TABLE_2026,
  OFFICIAL_TASK_RUBRICS,
  convertScaledToBand6,
  percentageToBand6,
  convertOverall120ToBand6,
  getBandScoreRangeForSection,
  getCefrFromBand6,
  getTaskRawRubric,
  convertRawRubricToBand6,
} from './toeflScoring';
import { convertScaledToBand6, getCefrFromBand6 } from './toeflScoring';

export function convertToBandScore6(score: number, maxScore: number, section?: 'Reading' | 'Listening' | 'Writing' | 'Speaking'): number {
  const scaled = convertToScaledScore(score, maxScore);
  return convertScaledToBand6(scaled, section);
}

export interface ScoreEquivalency {
  cefr: string;
  toefl120Range: string;
  badgeText: string;
}

export function getScoreEquivalency(bandScore6: number): ScoreEquivalency {
  if (bandScore6 <= 0) {
    return { cefr: 'N/A', toefl120Range: '0/120', badgeText: 'No Data (0 / 120)' };
  }
  const band = Math.round(bandScore6 * 2) / 2;
  if (band >= 6.0) return { cefr: 'C2', toefl120Range: '~114–120/120', badgeText: 'Band 6.0 (CEFR C2 • ~114–120/120)' };
  if (band >= 5.5) return { cefr: 'C1', toefl120Range: '~107–113/120', badgeText: 'Band 5.5 (CEFR C1 • ~107–113/120)' };
  if (band >= 5.0) return { cefr: 'C1', toefl120Range: '~95–106/120', badgeText: 'Band 5.0 (CEFR C1 • ~95–106/120)' };
  if (band >= 4.5) return { cefr: 'B2', toefl120Range: '~84–94/120', badgeText: 'Band 4.5 (CEFR B2 • ~84–94/120)' };
  if (band >= 4.0) return { cefr: 'B2', toefl120Range: '~72–83/120', badgeText: 'Band 4.0 (CEFR B2 • ~72–83/120)' };
  if (band >= 3.5) return { cefr: 'B1', toefl120Range: '~57–71/120', badgeText: 'Band 3.5 (CEFR B1 • ~57–71/120)' };
  if (band >= 3.0) return { cefr: 'B1', toefl120Range: '~42–56/120', badgeText: 'Band 3.0 (CEFR B1 • ~42–56/120)' };
  if (band >= 2.0) return { cefr: 'A2', toefl120Range: '~25–41/120', badgeText: 'Band 2.0 (CEFR A2 • ~25–41/120)' };
  return { cefr: 'A1', toefl120Range: '~0–24/120', badgeText: 'Band 1.0 (CEFR A1 • ~0–24/120)' };
}

export function calculateToeflEstimate(history: PracticeRecord[]): {
  overallScore: number;
  overallBand6: number;
  readingScore: number;
  readingBand6: number;
  listeningScore: number;
  listeningBand6: number;
  speakingScore: number;
  speakingBand6: number;
  writingScore: number;
  writingBand6: number;
  cefrLevel: string;
  cefrCode: string;
  totalCompleted: number;
} {
  if (!history || history.length === 0) {
    return {
      overallScore: 0,
      overallBand6: 0,
      readingScore: 0,
      readingBand6: 0,
      listeningScore: 0,
      listeningBand6: 0,
      speakingScore: 0,
      speakingBand6: 0,
      writingScore: 0,
      writingBand6: 0,
      cefrLevel: 'N/A (Need Data)',
      cefrCode: 'N/A',
      totalCompleted: 0,
    };
  }

  const getSectionAvg = (sec: 'Reading' | 'Listening' | 'Speaking' | 'Writing') => {
    const records = history.filter((h) => h.section === sec);
    if (records.length === 0) return 0;
    const sum = records.reduce((acc, r) => acc + r.scaledScore30, 0);
    return Math.round(sum / records.length);
  };

  const readingScore = getSectionAvg('Reading');
  const listeningScore = getSectionAvg('Listening');
  const speakingScore = getSectionAvg('Speaking');
  const writingScore = getSectionAvg('Writing');

  const readingBand6 = convertScaledToBand6(readingScore, 'Reading');
  const listeningBand6 = convertScaledToBand6(listeningScore, 'Listening');
  const speakingBand6 = convertScaledToBand6(speakingScore, 'Speaking');
  const writingBand6 = convertScaledToBand6(writingScore, 'Writing');

  const rawAvg = (readingBand6 + listeningBand6 + speakingBand6 + writingBand6) / 4;
  const overallBand6 = Math.round(rawAvg * 2) / 2;
  const overallScore = readingScore + listeningScore + speakingScore + writingScore;
  const cefr = getCefrFromBand6(overallBand6);

  return {
    overallScore,
    overallBand6,
    readingScore,
    readingBand6,
    listeningScore,
    listeningBand6,
    speakingScore,
    speakingBand6,
    writingScore,
    writingBand6,
    cefrLevel: cefr.name,
    cefrCode: cefr.code,
    totalCompleted: history.length,
  };
}

export interface MyBestSectionScore {
  section: 'Reading' | 'Listening' | 'Speaking' | 'Writing';
  scaledScore30: number;
  bandScore6: number;
  date?: string;
  taskTitle?: string;
  attemptsCount: number;
}

export interface MyBestScoresSummary {
  overallBand6: number;
  totalScaled120: number;
  cefrCode: string;
  cefrLevel: string;
  reading: MyBestSectionScore;
  listening: MyBestSectionScore;
  speaking: MyBestSectionScore;
  writing: MyBestSectionScore;
  hasAnyAttempts: boolean;
}

export function calculateMyBestScores(history: PracticeRecord[]): MyBestScoresSummary {
  const getBestForSection = (
    sec: 'Reading' | 'Listening' | 'Speaking' | 'Writing'
  ): MyBestSectionScore => {
    const records = (history || []).filter((h) => h.section === sec);
    if (records.length === 0) {
      return {
        section: sec,
        scaledScore30: 0,
        bandScore6: 0,
        attemptsCount: 0,
      };
    }

    let bestScaled = 0;
    let bestBand = 0;
    let bestDate: string | undefined;
    let bestTitle: string | undefined;

    for (const r of records) {
      const s =
        typeof r.scaledScore30 === 'number'
          ? Math.max(0, Math.min(30, Math.round(r.scaledScore30)))
          : Math.max(0, Math.min(30, Math.round(Number(r.score || 0))));
      const b = r.bandScore6 ?? convertScaledToBand6(s, sec);

      if (b > bestBand || (b === bestBand && s >= bestScaled)) {
        bestBand = b;
        bestScaled = Math.max(bestScaled, s);
        bestDate = r.date;
        bestTitle = r.taskTitle;
      } else if (s > bestScaled) {
        bestScaled = s;
      }
    }

    return {
      section: sec,
      scaledScore30: bestScaled,
      bandScore6: bestBand,
      date: bestDate,
      taskTitle: bestTitle,
      attemptsCount: records.length,
    };
  };

  const reading = getBestForSection('Reading');
  const listening = getBestForSection('Listening');
  const speaking = getBestForSection('Speaking');
  const writing = getBestForSection('Writing');
  const hasAnyAttempts = Boolean(history && history.length > 0);

  if (!hasAnyAttempts) {
    return {
      overallBand6: 0,
      totalScaled120: 0,
      cefrCode: 'N/A',
      cefrLevel: 'N/A (Need Data)',
      reading,
      listening,
      speaking,
      writing,
      hasAnyAttempts: false,
    };
  }

  const totalScaled120 =
    reading.scaledScore30 +
    listening.scaledScore30 +
    speaking.scaledScore30 +
    writing.scaledScore30;
  const rawAvgBand =
    (reading.bandScore6 +
      listening.bandScore6 +
      speaking.bandScore6 +
      writing.bandScore6) /
    4;
  const overallBand6 = Math.max(1.0, Math.round(rawAvgBand * 2) / 2);
  const cefr = getCefrFromBand6(overallBand6);

  return {
    overallBand6,
    totalScaled120,
    cefrCode: cefr.code,
    cefrLevel: cefr.name,
    reading,
    listening,
    speaking,
    writing,
    hasAnyAttempts: true,
  };
}

export function convertToScaledScore(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, score / maxScore));
  if (ratio >= 0.95) return 30;
  if (ratio >= 0.9) return 28;
  if (ratio >= 0.8) return 25;
  if (ratio >= 0.7) return 22;
  if (ratio >= 0.6) return 19;
  if (ratio >= 0.5) return 16;
  if (ratio >= 0.4) return 13;
  return Math.max(8, Math.round(ratio * 30));
}

export function getWeakAreas(history: PracticeRecord[]): { section: string, avgScore: number }[] {
  if (!history || history.length === 0) return [];

  const sections = ['Reading', 'Listening', 'Speaking', 'Writing'];
  const weakAreas: { section: string, avgScore: number }[] = [];

  for (const section of sections) {
    const records = history.filter((r) => r.section === section);
    if (records.length >= 2) {
      const avg = records.reduce((acc, r) => acc + r.scaledScore30, 0) / records.length;
      if (avg < 20) {
        weakAreas.push({ section, avgScore: Math.round(avg) });
      }
    }
  }
  return weakAreas;
}

