import { db, auth } from '../firebase';
import {
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  where,
  deleteDoc,
  updateDoc,
  doc,
  serverTimestamp,
  getDoc,
} from 'firebase/firestore';

export interface Mistake {
  id: string;
  userId: string;
  questionId: string;
  taskType: string;
  userAnswer: string;
  correctAnswer: string;
  explanation: string;
  correctStreak?: number;
  createdAt: any;
}

const LOCAL_MISTAKES_KEY = 'toefl_mistakes_notebook';

function loadLocalMistakesRaw(): Mistake[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_MISTAKES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: any) => ({
      id: String(item.id || `mistake_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
      userId: String(item.userId || 'local'),
      questionId: String(item.questionId || item.question || 'Practice Question'),
      taskType: String(item.taskType || 'Practice'),
      userAnswer: String(item.userAnswer || '(blank)'),
      correctAnswer: String(item.correctAnswer || ''),
      explanation: String(item.explanation || ''),
      correctStreak: typeof item.correctStreak === 'number' ? item.correctStreak : 0,
      createdAt: item.createdAt || item.timestamp || Date.now(),
    }));
  } catch {
    return [];
  }
}

function saveLocalMistakesRaw(items: Mistake[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_MISTAKES_KEY, JSON.stringify(items.slice(0, 250)));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('toefl_mistakes_updated'));
    }
  } catch (err) {
    console.warn('Failed to save mistakes to localStorage:', err);
  }
}

function buildDedupeKey(questionId: string, taskType: string, correctAnswer: string): string {
  return `${(questionId || '').trim().toLowerCase()}|${(taskType || '').trim().toLowerCase()}|${(correctAnswer || '').trim().toLowerCase()}`;
}

export async function saveMistake(
  questionId: string,
  taskType: string,
  userAnswer: string,
  correctAnswer: string,
  explanation: string
) {
  const cleanQId = (questionId || 'Practice Item').trim();
  const cleanTask = (taskType || 'Practice').trim();
  const cleanUserAns = (userAnswer || '(no answer)').trim();
  const cleanCorrect = (correctAnswer || '').trim();
  const cleanExp = (explanation || 'Review the target rule and explanation above.').trim();

  if (!cleanCorrect || cleanUserAns.toLowerCase() === cleanCorrect.toLowerCase()) {
    return;
  }

  // 1. Always save immediately to localStorage so Mistake Notebook works 100% offline and without sign-in
  const currentLocal = loadLocalMistakesRaw();
  const targetKey = buildDedupeKey(cleanQId, cleanTask, cleanCorrect);
  const existingIdx = currentLocal.findIndex(
    (m) => buildDedupeKey(m.questionId, m.taskType, m.correctAnswer) === targetKey
  );

  const localEntry: Mistake = {
    id:
      existingIdx >= 0
        ? currentLocal[existingIdx].id
        : `mistake_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId: auth.currentUser?.uid || 'local',
    questionId: cleanQId,
    taskType: cleanTask,
    userAnswer: cleanUserAns,
    correctAnswer: cleanCorrect,
    explanation: cleanExp,
    correctStreak: 0,
    createdAt: Date.now(),
  };

  if (existingIdx >= 0) {
    currentLocal.splice(existingIdx, 1);
  }
  currentLocal.unshift(localEntry);
  saveLocalMistakesRaw(currentLocal);

  // 2. Also persist to Firestore if the user is authenticated
  if (!auth.currentUser) return;

  try {
    await addDoc(collection(db, 'mistakes'), {
      userId: auth.currentUser.uid,
      questionId: cleanQId,
      taskType: cleanTask,
      userAnswer: cleanUserAns,
      correctAnswer: cleanCorrect,
      explanation: cleanExp,
      correctStreak: 0,
      createdAt: serverTimestamp(),
    });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('toefl_mistakes_updated'));
    }
  } catch (err) {
    console.warn('Failed to save mistake to Firestore (offline):', err);
  }
}

export async function getMistakes(): Promise<Mistake[]> {
  const localMistakes = loadLocalMistakesRaw();
  const mergedMap = new Map<string, Mistake>();

  for (const lm of localMistakes) {
    const key = buildDedupeKey(lm.questionId, lm.taskType, lm.correctAnswer);
    mergedMap.set(key, lm);
  }

  if (auth.currentUser) {
    try {
      const q = query(
        collection(db, 'mistakes'),
        where('userId', '==', auth.currentUser.uid),
        orderBy('createdAt', 'desc')
      );
      const snapshot = await getDocs(q);
      snapshot.docs.forEach((docSnap) => {
        const rm = { id: docSnap.id, ...docSnap.data() } as Mistake;
        const key = buildDedupeKey(rm.questionId, rm.taskType, rm.correctAnswer);
        if (!mergedMap.has(key)) {
          mergedMap.set(key, rm);
        } else {
          // Prefer Firestore document ID if both exist so deletes sync cleanly
          const existing = mergedMap.get(key)!;
          mergedMap.set(key, {
            ...existing,
            id: rm.id,
            correctStreak: Math.max(existing.correctStreak || 0, rm.correctStreak || 0),
          });
        }
      });
    } catch (err) {
      console.warn('Failed to get mistakes from Firestore (offline):', err);
    }
  }

  return Array.from(mergedMap.values());
}

export async function updateMistakeReview(mistakeId: string, correct: boolean) {
  // 1. Update in localStorage
  const currentLocal = loadLocalMistakesRaw();
  const idx = currentLocal.findIndex((m) => m.id === mistakeId);
  if (idx >= 0) {
    const nextStreak = correct ? (currentLocal[idx].correctStreak || 0) + 1 : 0;
    if (nextStreak >= 2) {
      currentLocal.splice(idx, 1);
    } else {
      currentLocal[idx] = { ...currentLocal[idx], correctStreak: nextStreak };
    }
    saveLocalMistakesRaw(currentLocal);
  }

  // 2. Update in Firestore if signed in
  if (!auth.currentUser) return;
  try {
    const ref = doc(db, 'mistakes', mistakeId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    const currentStreak = correct ? (data.correctStreak || 0) + 1 : 0;

    if (currentStreak >= 2) {
      await deleteDoc(ref);
    } else {
      await updateDoc(ref, { correctStreak: currentStreak });
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('toefl_mistakes_updated'));
    }
  } catch (err) {
    console.warn('Failed to update mistake review (offline):', err);
  }
}

export async function deleteMistake(mistakeId: string) {
  const currentLocal = loadLocalMistakesRaw();
  const target = currentLocal.find((m) => m.id === mistakeId);
  const filtered = currentLocal.filter((m) => m.id !== mistakeId);
  saveLocalMistakesRaw(filtered);

  if (!auth.currentUser) return;
  try {
    await deleteDoc(doc(db, 'mistakes', mistakeId));
    if (target) {
      const q = query(
        collection(db, 'mistakes'),
        where('userId', '==', auth.currentUser.uid),
        where('correctAnswer', '==', target.correctAnswer)
      );
      const snap = await getDocs(q);
      await Promise.all(snap.docs.map((d) => deleteDoc(doc(db, 'mistakes', d.id))));
    }
  } catch (err) {
    console.warn('Failed to delete mistake (offline):', err);
  }
}

export async function clearAllFirestoreMistakes() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(LOCAL_MISTAKES_KEY);
    localStorage.removeItem('toefl_mistakes');
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toefl_mistakes_updated'));
  }

  if (!auth.currentUser) return;
  try {
    const q = query(
      collection(db, 'mistakes'),
      where('userId', '==', auth.currentUser.uid)
    );
    const snapshot = await getDocs(q);
    await Promise.all(snapshot.docs.map((d) => deleteDoc(doc(db, 'mistakes', d.id))));
  } catch (err) {
    console.warn('Failed to clear Firestore mistakes (offline):', err);
  }
}
