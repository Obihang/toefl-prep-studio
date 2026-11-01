import { collection, deleteDoc, doc, getDocs, setDoc } from 'firebase/firestore';
import { db, ensureAuthenticated } from '../firebase';
import { openIndexedDB } from './questionBankStorage';
import { callBackendGenerate, runWithDynamicKeyPool } from '../services/geminiService';
import { normalizeTaskData } from './taskNormalizer';
import {
  CURATED_MOCK_EXAM_SETS,
  MockExamSet,
  MockExamReadingModule,
  MockExamListeningModule,
  MockExamWritingModule,
  MockExamSpeakingModule,
} from './mockExamSetsBank';

const IDB_STORE_MOCK_SETS = 'toefl_mock_sets';
const FIRESTORE_COLLECTION_MOCK_SETS = 'mock_exam_sets';
const MOCK_SET_SCORES_STORAGE_KEY = 'toefl_mock_set_scores_v1';
const DELETED_MOCK_SETS_STORAGE_KEY = 'toefl_deleted_mock_set_ids';
const EDITED_MOCK_SETS_STORAGE_KEY = 'toefl_edited_mock_set_titles';

function getDeletedMockSetIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(DELETED_MOCK_SETS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function getEditedMockSetTitles(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(EDITED_MOCK_SETS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export interface MockSetAttemptReport {
  sectionScores: Record<'Reading' | 'Listening' | 'Writing' | 'Speaking', number>;
  readingTrack: 'higher' | 'standard';
  listeningTrack: 'higher' | 'standard';
  completedAt: number;
  totalScore120: number;
  overallBand6: number;
  cefrCode: string;
  cefrName: string;
}

export interface MockSetScoreSummary {
  setId: string;
  bestScore120: number;
  bestBand6: number;
  bestCefr: string;
  attemptsCount: number;
  lastReport: MockSetAttemptReport;
}

function getAllMockSetsFromIDB(): Promise<MockExamSet[]> {
  return new Promise(async (resolve) => {
    try {
      const idb = await openIndexedDB();
      if (!idb.objectStoreNames.contains(IDB_STORE_MOCK_SETS)) {
        resolve([]);
        return;
      }
      const tx = idb.transaction(IDB_STORE_MOCK_SETS, 'readonly');
      const store = tx.objectStore(IDB_STORE_MOCK_SETS);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as MockExamSet[]) || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function putMockSetsToIDB(sets: MockExamSet[]): Promise<void> {
  if (!sets.length) return Promise.resolve();
  return new Promise(async (resolve) => {
    try {
      const idb = await openIndexedDB();
      if (!idb.objectStoreNames.contains(IDB_STORE_MOCK_SETS)) {
        resolve();
        return;
      }
      const tx = idb.transaction(IDB_STORE_MOCK_SETS, 'readwrite');
      const store = tx.objectStore(IDB_STORE_MOCK_SETS);
      for (const s of sets) {
        if (s && s.id) {
          store.put(s);
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function sortMockExamSets(sets: MockExamSet[]): MockExamSet[] {
  const curatedOrder: Record<string, number> = {
    mock_set_1: 1,
    mock_set_2: 2,
    mock_set_3: 3,
  };
  return [...sets].sort((a, b) => {
    const orderA = curatedOrder[a.id] ?? 999;
    const orderB = curatedOrder[b.id] ?? 999;
    if (orderA !== orderB) return orderA - orderB;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

/**
 * Saves a single MockExamSet permanently to IndexedDB (`toefl_mock_sets`)
 * and Firestore (`mock_exam_sets` collection).
 */
export async function saveMockExamSetToDb(mockSet: MockExamSet): Promise<void> {
  await putMockSetsToIDB([mockSet]);

  if (db) {
    try {
      const uid = await ensureAuthenticated();
      if (uid) {
        await setDoc(
          doc(db, FIRESTORE_COLLECTION_MOCK_SETS, mockSet.id),
          {
            id: mockSet.id,
            title: mockSet.title,
            source: mockSet.source,
            createdAt: mockSet.createdAt || Date.now(),
            modules: JSON.parse(JSON.stringify(mockSet.modules)),
          },
          { merge: true }
        );
      }
    } catch (err) {
      console.warn('[examStorage] Failed to sync MockExamSet to Firestore:', err);
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toefl_mock_sets_updated'));
  }
}

/**
 * Permanently deletes a MockExamSet from IndexedDB, Firestore, and adds to local blocklist.
 */
export async function deleteMockExamSet(setId: string): Promise<boolean> {
  if (!setId) return false;
  try {
    const deleted = getDeletedMockSetIds();
    deleted.add(setId);
    if (typeof window !== 'undefined') {
      localStorage.setItem(DELETED_MOCK_SETS_STORAGE_KEY, JSON.stringify(Array.from(deleted)));
    }
  } catch {}

  try {
    const idb = await openIndexedDB();
    if (idb.objectStoreNames.contains(IDB_STORE_MOCK_SETS)) {
      await new Promise<void>((resolve) => {
        const tx = idb.transaction(IDB_STORE_MOCK_SETS, 'readwrite');
        tx.objectStore(IDB_STORE_MOCK_SETS).delete(setId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
  } catch {}

  if (db) {
    try {
      await ensureAuthenticated();
      await deleteDoc(doc(db, FIRESTORE_COLLECTION_MOCK_SETS, setId));
    } catch (err) {
      console.warn('[examStorage] Failed to delete MockExamSet from Firestore:', err);
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toefl_mock_sets_updated'));
  }
  return true;
}

/**
 * Updates the title of an existing MockExamSet across local overrides, IndexedDB, and Firestore.
 */
export async function updateMockExamSetTitle(setId: string, newTitle: string): Promise<boolean> {
  const cleanTitle = String(newTitle || '').trim();
  if (!setId || !cleanTitle) return false;

  try {
    const map = getEditedMockSetTitles();
    map[setId] = cleanTitle;
    if (typeof window !== 'undefined') {
      localStorage.setItem(EDITED_MOCK_SETS_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {}

  try {
    const sets = await getAllMockSetsFromIDB();
    const target = sets.find((s) => s.id === setId);
    if (target) {
      target.title = cleanTitle;
      await putMockSetsToIDB([target]);
    }
  } catch {}

  if (db) {
    try {
      await ensureAuthenticated();
      await setDoc(
        doc(db, FIRESTORE_COLLECTION_MOCK_SETS, setId),
        { title: cleanTitle },
        { merge: true }
      );
    } catch {}
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toefl_mock_sets_updated'));
  }
  return true;
}

/**
 * Seeds the 3 built-in Official-Style Full Mock Exam Sets into IndexedDB & Firestore if missing,
 * merges with any AI-generated Full Mock Exam Sets in IndexedDB & Firestore, and returns all sets sorted.
 */
export async function syncAndGetMockExamSets(): Promise<MockExamSet[]> {
  const mergedMap = new Map<string, MockExamSet>();
  const deletedSet = getDeletedMockSetIds();
  const editedTitles = getEditedMockSetTitles();

  // 1. Always include the 3 curated sets as baseline (unless explicitly deleted by Admin)
  for (const curated of CURATED_MOCK_EXAM_SETS) {
    if (deletedSet.has(curated.id)) continue;
    mergedMap.set(curated.id, {
      ...curated,
      title: editedTitles[curated.id] || curated.title,
    });
  }

  // 2. Load from IndexedDB
  try {
    const idbSets = await getAllMockSetsFromIDB();
    for (const s of idbSets) {
      if (s && s.id && s.modules && !deletedSet.has(s.id)) {
        if (!mergedMap.has(s.id)) {
          mergedMap.set(s.id, {
            ...s,
            title: editedTitles[s.id] || s.title,
          });
        }
      }
    }
  } catch (err) {
    console.warn('[examStorage] Error reading IDB mock sets:', err);
  }

  // 3. Load from Firestore `mock_exam_sets` & seed missing curated sets
  if (db) {
    try {
      const snap = await getDocs(collection(db, FIRESTORE_COLLECTION_MOCK_SETS));
      const remoteIds = new Set<string>();
      snap.forEach((docSnap) => {
        const data = docSnap.data() as MockExamSet;
        if (data && data.id && data.modules && !deletedSet.has(data.id)) {
          remoteIds.add(data.id);
          if (!mergedMap.has(data.id)) {
            mergedMap.set(data.id, {
              ...data,
              title: editedTitles[data.id] || data.title,
            });
          } else if (editedTitles[data.id] || data.title) {
            const cur = mergedMap.get(data.id)!;
            mergedMap.set(data.id, {
              ...cur,
              title: editedTitles[data.id] || data.title || cur.title,
            });
          }
        }
      });

      // Seed any curated mock sets not yet in Firestore (non-blocking)
      const missingCurated = CURATED_MOCK_EXAM_SETS.filter(
        (c) => !remoteIds.has(c.id) && !deletedSet.has(c.id)
      );
      if (missingCurated.length > 0) {
        ensureAuthenticated()
          .then(async (uid) => {
            if (!uid || !db) return;
            for (const c of missingCurated) {
              try {
                await setDoc(
                  doc(db, FIRESTORE_COLLECTION_MOCK_SETS, c.id),
                  {
                    id: c.id,
                    title: editedTitles[c.id] || c.title,
                    source: c.source,
                    createdAt: c.createdAt,
                    modules: JSON.parse(JSON.stringify(c.modules)),
                  },
                  { merge: true }
                );
              } catch {}
            }
          })
          .catch(() => {});
      }
    } catch (err) {
      console.warn('[examStorage] Error syncing Firestore mock_exam_sets:', err);
    }
  }

  const allSets = sortMockExamSets(Array.from(mergedMap.values()));
  await putMockSetsToIDB(allSets);
  return allSets;
}

/**
 * Returns the total number of Full Mock Exam Sets stored in the database.
 */
export async function getMockExamSetsCount(): Promise<number> {
  try {
    const sets = await syncAndGetMockExamSets();
    return sets.length;
  } catch {
    return CURATED_MOCK_EXAM_SETS.length;
  }
}

async function generateSingleTaskWithFallback<T>(
  taskTypeId: string,
  level: string,
  topic: string,
  fallbackTask: T,
  idPrefix: string
): Promise<T> {
  try {
    const resp = await callBackendGenerate(taskTypeId, level, topic, 'exam');
    if (resp && resp.success && resp.data && !resp.data.isFallback) {
      const normalized = normalizeTaskData(resp.data, taskTypeId) as any;
      normalized.id = `${idPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      return normalized as T;
    }
  } catch (err) {
    console.warn(`[examStorage] AI generation fallback for ${taskTypeId}:`, err);
  }
  const cloned = JSON.parse(JSON.stringify(fallbackTask));
  cloned.id = `${idPrefix}_fb_${Date.now()}`;
  return normalizeTaskData(cloned, taskTypeId) as T;
}

/**
 * Generates a complete, self-contained Full Mock Exam Set via AI across all modules:
 * - Reading Module 1 (Routing)
 * - Reading Module 2 Hard (Upper-Tier Adaptive)
 * - Reading Module 2 Easy (Standard-Tier Adaptive)
 * - Listening Module 1 (Routing)
 * - Listening Module 2 Hard (Upper-Tier Adaptive)
 * - Listening Module 2 Easy (Standard-Tier Adaptive)
 * - Writing (Build a Sentence, Write an Email, Academic Discussion)
 * - Speaking (Listen & Repeat, Take an Interview)
 * Saves the newly created set permanently to IndexedDB (`toefl_mock_sets`) and Firestore (`mock_exam_sets`).
 */
export async function generateAndSaveNewAiMockExamSet(
  nextSetNumber: number,
  onProgress?: (stageText: string, step: number, total: number) => void
): Promise<MockExamSet> {
  const totalSteps = 26;
  let completedSteps = 0;
  const fallbackTemplate =
    CURATED_MOCK_EXAM_SETS[(nextSetNumber - 1) % CURATED_MOCK_EXAM_SETS.length] || CURATED_MOCK_EXAM_SETS[0];
  const setId = `mock_ai_${Date.now()}`;

  const reportProgress = (msg: string) => {
    completedSteps++;
    onProgress?.(msg, completedSteps, totalSteps);
  };

  const tasksMap: Record<string, any> = {};

  const jobs = [
    async () => {
      const res = await generateSingleTaskWithFallback(
        'complete-words', 'intermediate', 'science-tech',
        fallbackTemplate.modules.readingModule1.completeWords, `${setId}_cw_m1`
      );
      tasksMap.rM1Cw = res;
      reportProgress('Generated Reading Module 1 (Complete the Words)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'daily-life', 'intermediate', 'campus-life',
        fallbackTemplate.modules.readingModule1.dailyLife, `${setId}_dl_m1`
      );
      tasksMap.rM1Dl = res;
      reportProgress('Generated Reading Module 1 (Read in Daily Life)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'reading-academic', 'upper-intermediate', 'natural-sciences',
        fallbackTemplate.modules.readingModule1.readingPassage, `${setId}_rp_m1`
      );
      tasksMap.rM1Rp = res;
      reportProgress('Generated Reading Module 1 (Academic Passage)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'complete-words', 'advanced', 'natural-sciences',
        fallbackTemplate.modules.readingModule2Hard.completeWords, `${setId}_cw_m2h`
      );
      tasksMap.rM2HCw = res;
      reportProgress('Generated Reading Module 2 Hard (Complete the Words)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'daily-life', 'advanced', 'campus-life',
        fallbackTemplate.modules.readingModule2Hard.dailyLife, `${setId}_dl_m2h`
      );
      tasksMap.rM2HDl = res;
      reportProgress('Generated Reading Module 2 Hard (Read in Daily Life)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'reading-academic', 'advanced', 'social-sciences',
        fallbackTemplate.modules.readingModule2Hard.readingPassage, `${setId}_rp_m2h`
      );
      tasksMap.rM2HRp = res;
      reportProgress('Generated Reading Module 2 Hard (Academic Passage)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'complete-words', 'intermediate', 'environment',
        fallbackTemplate.modules.readingModule2Easy.completeWords, `${setId}_cw_m2e`
      );
      tasksMap.rM2ECw = res;
      reportProgress('Generated Reading Module 2 Standard (Complete the Words)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'daily-life', 'intermediate', 'campus-life',
        fallbackTemplate.modules.readingModule2Easy.dailyLife, `${setId}_dl_m2e`
      );
      tasksMap.rM2EDl = res;
      reportProgress('Generated Reading Module 2 Standard (Read in Daily Life)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'reading-academic', 'intermediate', 'arts-humanities',
        fallbackTemplate.modules.readingModule2Easy.readingPassage, `${setId}_rp_m2e`
      );
      tasksMap.rM2ERp = res;
      reportProgress('Generated Reading Module 2 Standard (Academic Passage)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-choose-response', 'intermediate', 'campus-life',
        fallbackTemplate.modules.listeningModule1.chooseResponse, `${setId}_lcr_m1`
      );
      tasksMap.lM1Cr = res;
      reportProgress('Generated Listening Module 1 (Choose a Response)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-dialogue', 'intermediate', 'campus-life',
        fallbackTemplate.modules.listeningModule1.conversation, `${setId}_ld_m1`
      );
      tasksMap.lM1Conv = res;
      reportProgress('Generated Listening Module 1 (Campus Conversation)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-announcement', 'intermediate', 'campus-life',
        fallbackTemplate.modules.listeningModule1.announcement, `${setId}_la_m1`
      );
      tasksMap.lM1Ann = res;
      reportProgress('Generated Listening Module 1 (Campus Announcement)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-academic-talk', 'upper-intermediate', 'natural-sciences',
        fallbackTemplate.modules.listeningModule1.academicTalk, `${setId}_lat_m1`
      );
      tasksMap.lM1Talk = res;
      reportProgress('Generated Listening Module 1 (Academic Talk)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-choose-response', 'advanced', 'campus-life',
        fallbackTemplate.modules.listeningModule2Hard.chooseResponse, `${setId}_lcr_m2h`
      );
      tasksMap.lM2HCr = res;
      reportProgress('Generated Listening Module 2 Hard (Choose a Response)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-dialogue', 'advanced', 'campus-life',
        fallbackTemplate.modules.listeningModule2Hard.conversation, `${setId}_ld_m2h`
      );
      tasksMap.lM2HConv = res;
      reportProgress('Generated Listening Module 2 Hard (Campus Conversation)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-announcement', 'advanced', 'campus-life',
        fallbackTemplate.modules.listeningModule2Hard.announcement, `${setId}_la_m2h`
      );
      tasksMap.lM2HAnn = res;
      reportProgress('Generated Listening Module 2 Hard (Campus Announcement)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-academic-talk', 'advanced', 'science-tech',
        fallbackTemplate.modules.listeningModule2Hard.academicTalk, `${setId}_lat_m2h`
      );
      tasksMap.lM2HTalk = res;
      reportProgress('Generated Listening Module 2 Hard (Academic Talk)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-choose-response', 'intermediate', 'campus-life',
        fallbackTemplate.modules.listeningModule2Easy.chooseResponse, `${setId}_lcr_m2e`
      );
      tasksMap.lM2ECr = res;
      reportProgress('Generated Listening Module 2 Standard (Choose a Response)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-dialogue', 'intermediate', 'campus-life',
        fallbackTemplate.modules.listeningModule2Easy.conversation, `${setId}_ld_m2e`
      );
      tasksMap.lM2EConv = res;
      reportProgress('Generated Listening Module 2 Standard (Campus Conversation)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-announcement', 'intermediate', 'campus-life',
        fallbackTemplate.modules.listeningModule2Easy.announcement, `${setId}_la_m2e`
      );
      tasksMap.lM2EAnn = res;
      reportProgress('Generated Listening Module 2 Standard (Campus Announcement)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listening-academic-talk', 'intermediate', 'environment',
        fallbackTemplate.modules.listeningModule2Easy.academicTalk, `${setId}_lat_m2e`
      );
      tasksMap.lM2ETalk = res;
      reportProgress('Generated Listening Module 2 Standard (Academic Talk)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'build-sentence', 'upper-intermediate', 'campus-life',
        fallbackTemplate.modules.writing.buildSentence, `${setId}_bs`
      );
      tasksMap.wBs = res;
      reportProgress('Generated Writing (Build a Sentence)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'write-email', 'intermediate', 'campus-life',
        fallbackTemplate.modules.writing.writeEmail, `${setId}_we`
      );
      tasksMap.wEmail = res;
      reportProgress('Generated Writing (Write an Email)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'academic-discussion', 'advanced', 'social-sciences',
        fallbackTemplate.modules.writing.academicDiscussion, `${setId}_ad`
      );
      tasksMap.wAd = res;
      reportProgress('Generated Writing (Academic Discussion)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'listen-repeat', 'intermediate', 'campus-life',
        fallbackTemplate.modules.speaking.listenRepeat, `${setId}_lr`
      );
      tasksMap.sLr = res;
      reportProgress('Generated Speaking (Listen & Repeat)');
    },
    async () => {
      const res = await generateSingleTaskWithFallback(
        'speaking-interview', 'upper-intermediate', 'social-sciences',
        fallbackTemplate.modules.speaking.speakingInterview, `${setId}_si`
      );
      tasksMap.sSi = res;
      reportProgress('Generated Speaking (Take an Interview)');
    },
  ];

  await runWithDynamicKeyPool(jobs);

  const readingModule1: MockExamReadingModule = {
    completeWords: tasksMap.rM1Cw,
    dailyLife: tasksMap.rM1Dl,
    readingPassage: tasksMap.rM1Rp,
  };

  const readingModule2Hard: MockExamReadingModule = {
    completeWords: tasksMap.rM2HCw,
    dailyLife: tasksMap.rM2HDl,
    readingPassage: tasksMap.rM2HRp,
  };

  const readingModule2Easy: MockExamReadingModule = {
    completeWords: tasksMap.rM2ECw,
    dailyLife: tasksMap.rM2EDl,
    readingPassage: tasksMap.rM2ERp,
  };

  const listeningModule1: MockExamListeningModule = {
    chooseResponse: tasksMap.lM1Cr,
    conversation: tasksMap.lM1Conv,
    announcement: tasksMap.lM1Ann,
    academicTalk: tasksMap.lM1Talk,
  };

  const listeningModule2Hard: MockExamListeningModule = {
    chooseResponse: tasksMap.lM2HCr,
    conversation: tasksMap.lM2HConv,
    announcement: tasksMap.lM2HAnn,
    academicTalk: tasksMap.lM2HTalk,
  };

  const listeningModule2Easy: MockExamListeningModule = {
    chooseResponse: tasksMap.lM2ECr,
    conversation: tasksMap.lM2EConv,
    announcement: tasksMap.lM2EAnn,
    academicTalk: tasksMap.lM2ETalk,
  };

  const writing: MockExamWritingModule = {
    buildSentence: tasksMap.wBs,
    writeEmail: tasksMap.wEmail,
    academicDiscussion: tasksMap.wAd,
  };

  const speaking: MockExamSpeakingModule = {
    listenRepeat: tasksMap.sLr,
    speakingInterview: tasksMap.sSi,
  };

  const newSet: MockExamSet = {
    id: setId,
    title: `Full-Length 2026 TOEFL iBT® Mock Exam #${nextSetNumber} (AI-Generated Set)`,
    source: 'ai_generated',
    createdAt: Date.now(),
    modules: {
      readingModule1,
      readingModule2Hard,
      readingModule2Easy,
      listeningModule1,
      listeningModule2Hard,
      listeningModule2Easy,
      writing,
      speaking,
    },
  };

  await saveMockExamSetToDb(newSet);
  return newSet;
}

/**
 * Retrieves saved score reports per Mock Exam Set ID from localStorage.
 */
export function getMockSetScores(): Record<string, MockSetScoreSummary> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(MOCK_SET_SCORES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Saves a completed Mock Exam Set score report to localStorage tied to `setId`.
 */
export function saveMockSetScore(
  setId: string,
  sectionScores: Record<'Reading' | 'Listening' | 'Writing' | 'Speaking', number>,
  readingTrack: 'higher' | 'standard',
  listeningTrack: 'higher' | 'standard',
  overallBand6: number,
  cefrCode: string,
  cefrName: string
): MockSetScoreSummary {
  const totalScore120 =
    (sectionScores.Reading || 0) +
    (sectionScores.Listening || 0) +
    (sectionScores.Writing || 0) +
    (sectionScores.Speaking || 0);

  const currentMap = getMockSetScores();
  const prev = currentMap[setId];

  const report: MockSetAttemptReport = {
    sectionScores: { ...sectionScores },
    readingTrack,
    listeningTrack,
    completedAt: Date.now(),
    totalScore120,
    overallBand6,
    cefrCode,
    cefrName,
  };

  const isNewBest = !prev || totalScore120 >= prev.bestScore120;

  const updated: MockSetScoreSummary = {
    setId,
    bestScore120: isNewBest ? totalScore120 : prev.bestScore120,
    bestBand6: isNewBest ? overallBand6 : prev.bestBand6,
    bestCefr: isNewBest ? cefrCode : prev.bestCefr,
    attemptsCount: (prev?.attemptsCount || 0) + 1,
    lastReport: report,
  };

  currentMap[setId] = updated;
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(MOCK_SET_SCORES_STORAGE_KEY, JSON.stringify(currentMap));
    } catch {}
  }
  return updated;
}

export const EXAM_HISTORY_STORAGE_KEY = 'toefl_exam_history';

export interface FullMockExamResult {
  id: string;
  setId: string;
  setTitle: string;
  date: string;
  completedAt: number;
  overallBand6: number;
  cefrCode: string;
  cefrName: string;
  totalScore120: number;
  sectionScores: {
    Reading: number;
    Listening: number;
    Writing: number;
    Speaking: number;
  };
  readingTrack?: 'higher' | 'standard';
  listeningTrack?: 'higher' | 'standard';
}

/**
 * Retrieves all completed Full Mock Test attempts from `toefl_exam_history`.
 * Also backfills from `toefl_mock_set_scores_v1` if `toefl_exam_history` is empty.
 */
export function getExamHistory(): FullMockExamResult[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(EXAM_HISTORY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }

    // Backfill from per-set score summaries if exam history array was not yet populated
    const setScores = getMockSetScores();
    const entries = Object.values(setScores);
    if (entries.length === 0) return [];

    const editedTitles = getEditedMockSetTitles();
    const backfilled: FullMockExamResult[] = entries
      .filter((s) => s && s.lastReport)
      .map((s) => {
        const curatedMatch = CURATED_MOCK_EXAM_SETS.find((c) => c.id === s.setId);
        const setNumMatch = s.setId.match(/mock_set_(\d+)/);
        const fallbackTitle = curatedMatch
          ? curatedMatch.title
          : setNumMatch
          ? `Mock Exam #${setNumMatch[1]}`
          : 'Full Mock Exam';
        const completedAt = s.lastReport.completedAt || Date.now();
        return {
          id: `mock-hist-${s.setId}-${completedAt}`,
          setId: s.setId,
          setTitle: editedTitles[s.setId] || fallbackTitle,
          date: new Date(completedAt).toISOString(),
          completedAt,
          overallBand6: s.lastReport.overallBand6,
          cefrCode: s.lastReport.cefrCode,
          cefrName: s.lastReport.cefrName,
          totalScore120: s.lastReport.totalScore120,
          sectionScores: {
            Reading: s.lastReport.sectionScores?.Reading || 0,
            Listening: s.lastReport.sectionScores?.Listening || 0,
            Writing: s.lastReport.sectionScores?.Writing || 0,
            Speaking: s.lastReport.sectionScores?.Speaking || 0,
          },
          readingTrack: s.lastReport.readingTrack,
          listeningTrack: s.lastReport.listeningTrack,
        };
      })
      .sort((a, b) => b.completedAt - a.completedAt);

    if (backfilled.length > 0) {
      localStorage.setItem(EXAM_HISTORY_STORAGE_KEY, JSON.stringify(backfilled));
    }
    return backfilled;
  } catch {
    return [];
  }
}

/**
 * Saves a completed 4-section Full Mock Exam result into `toefl_exam_history`.
 */
export function saveExamResult(
  input: Omit<FullMockExamResult, 'id' | 'date' | 'completedAt'> & {
    id?: string;
    date?: string;
    completedAt?: number;
  }
): FullMockExamResult {
  const now = input.completedAt || Date.now();
  const entry: FullMockExamResult = {
    id: input.id || `exam-${now}-${Math.random().toString(36).slice(2, 6)}`,
    setId: input.setId || `mock_${now}`,
    setTitle: input.setTitle || 'Full Mock Exam',
    date: input.date || new Date(now).toISOString(),
    completedAt: now,
    overallBand6: input.overallBand6,
    cefrCode: input.cefrCode,
    cefrName: input.cefrName,
    totalScore120: input.totalScore120,
    sectionScores: {
      Reading: input.sectionScores?.Reading || 0,
      Listening: input.sectionScores?.Listening || 0,
      Writing: input.sectionScores?.Writing || 0,
      Speaking: input.sectionScores?.Speaking || 0,
    },
    readingTrack: input.readingTrack,
    listeningTrack: input.listeningTrack,
  };

  if (typeof window !== 'undefined') {
    try {
      const existing = getExamHistory();
      const updated = [entry, ...existing].slice(0, 100);
      localStorage.setItem(EXAM_HISTORY_STORAGE_KEY, JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('toefl_exam_history_updated'));
    } catch (err) {
      console.warn('[examStorage] Failed to save Full Mock Exam result:', err);
    }
  }

  return entry;
}

/**
 * Clears all saved Full Mock Exam history and per-set score summaries.
 */
export function clearExamHistory(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(EXAM_HISTORY_STORAGE_KEY);
    localStorage.removeItem(MOCK_SET_SCORES_STORAGE_KEY);
    localStorage.removeItem('toefl_exam_used_ids');
    window.dispatchEvent(new CustomEvent('toefl_exam_history_updated'));
  } catch {}
}

