import { isHighQualityTask } from './questionValidator';
import {
  normalizeTaskData,
  normalizeQuestionBankItem,
  normalizeCompleteWordsTask,
  validateNormalizedTask,
  normalizeDifficultyLabel,
  normalizeTopicLabel,
  canonicalizeTaskType as normalizerCanonicalizeTaskType,
} from './taskNormalizer';
import { db, auth, ensureAuthenticated } from '../firebase';
import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  limit,
  startAfter,
  getDocs,
  serverTimestamp,
  increment,
  arrayUnion,
  writeBatch,
  DocumentSnapshot,
} from 'firebase/firestore';
import { getPracticeHistory, getCompletedQuestionIds } from './scoreTracker';
import { getAuthHeaders, getScholarUsername, getApiHeaders } from './apiKey';
import { parseDialogueLine, DialogueVoiceManager } from './voices';
import { stripSpeakerAndFormatting } from './audioSpeech';
import { TASK_DEFINITIONS, getSectionForTaskType } from '../types/taskTypes';
import {
  LEVELS,
  ACADEMIC_TOPICS,
  AcademicTopic,
  Level,
  isValidLevel,
  isValidAcademicTopic,
} from '../constants/filters';
import { inferTopic } from './inferTopic';
import { COACH_CURATED_BANK } from './coachCuratedBank';

const DB_NAME = 'TOEFL_STUDIO_DB';
const DB_VERSION = 4;
export const CURRENT_BANK_SCHEMA_VERSION = 202612;
export const TOEFL_2026_PURGE_V19 = 'toefl_bank_purged_2026_v20';
export const TOEFL_2026_PURGE_V18 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V17 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V16 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V15 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V14 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V13 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V12 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V11 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V10 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V9 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V8 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V7 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V6 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V5 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V4 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V3 = TOEFL_2026_PURGE_V19;
export const TOEFL_2026_PURGE_V2 = TOEFL_2026_PURGE_V19;
export const STATIC_SHARDS_SYNC_KEY = 'toefl_static_shards_synced_v31';
export const MIGRATE_CW_HEAD_TAIL_V1 = 'toefl_cw_head_tail_migrated_v1';

export function canonicalizeTaskType(taskType: string): string {
  return normalizerCanonicalizeTaskType(taskType);
}

export function getIdbStoreName(mode: 'exam' | 'coach' = 'exam'): string {
  return mode === 'coach' ? 'coach_questions' : 'toefl_question_bank';
}

export function getFirestoreCollectionName(mode: 'exam' | 'coach' = 'exam'): string {
  return mode === 'coach' ? 'coach_questions' : 'questions';
}

/**
 * Generates a normalized, synchronous content signature for deduplicating questions
 * across static shards, IndexedDB, and Firestore.
 */
export function getQuestionContentSignature(taskType: string, data: any): string {
  const canonicalType = canonicalizeTaskType(taskType);
  const content = data?.content || data || {};
  const mainText =
    content.passage ||
    content.audioScript ||
    content.text ||
    content.script ||
    content.situation ||
    content.professorPrompt ||
    (Array.isArray(content.turns)
      ? content.turns.map((t: any) => t?.text || '').join(' ')
      : '') ||
    (Array.isArray(content.sentences) ? content.sentences.join(' ') : '') ||
    (Array.isArray(content.questions)
      ? content.questions.map((q: any) => q?.question || q?.q || q?.prompt || '').join(' ')
      : '') ||
    (Array.isArray(content.items)
      ? content.items.map((i: any) => i?.answer || i?.context || '').join(' ')
      : '') ||
    JSON.stringify(content);

  const rawSig = String(mainText)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const qSig =
    content.questions?.[0]?.question ||
    content.questions?.[0]?.q ||
    content.items?.[0]?.prompt ||
    content.items?.[0]?.question ||
    content.sentences?.[0]?.targetSentence ||
    data?.questions?.[0]?.question ||
    data?.items?.[0]?.prompt ||
    data?.items?.[0]?.question ||
    data?.sentences?.[0]?.targetSentence ||
    '';

  const cleanQSig = String(qSig)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const normalizedText = `${rawSig.slice(0, 240)}__${cleanQSig.slice(0, 120)}`;

  return `${canonicalType}:::${normalizedText}`;
}

/**
 * Checks whether a question item matches a selected proficiency level filter.
 */
export function matchesLevelFilter(q: any, selectedLevel?: string): boolean {
  if (
    !selectedLevel ||
    selectedLevel === 'all' ||
    selectedLevel === 'All Levels' ||
    selectedLevel === 'any'
  ) {
    return true;
  }
  const target = normalizeDifficultyLabel(selectedLevel);
  const rawItemLevel =
    q?.level || q?.difficulty || q?.content?.level || q?.content?.difficulty;
  const itemLevel = normalizeDifficultyLabel(rawItemLevel);
  return itemLevel === target;
}

/**
 * Checks whether a question item matches a selected academic topic filter.
 */
export function matchesTopicFilter(q: any, selectedTopic?: string): boolean {
  if (
    !selectedTopic ||
    selectedTopic === 'all' ||
    selectedTopic === 'All Topics' ||
    selectedTopic === 'any' ||
    selectedTopic === 'general'
  ) {
    return true;
  }
  const target = normalizeTopicLabel(selectedTopic);
  const contentObj = q?.content || q;
  const rawItemTopic =
    q?.topic ||
    q?.category ||
    q?.subject ||
    contentObj?.topic ||
    contentObj?.category ||
    contentObj?.subject;
  const itemTopic = normalizeTopicLabel(rawItemTopic, contentObj);
  return itemTopic === target;
}

export async function openIndexedDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 4);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event: any) => {
      const dbInstance = event.target.result;
      if (!dbInstance.objectStoreNames.contains('toefl_question_bank')) {
        dbInstance.createObjectStore('toefl_question_bank', { keyPath: 'id' });
      }
      if (!dbInstance.objectStoreNames.contains('coach_questions')) {
        dbInstance.createObjectStore('coach_questions', { keyPath: 'id' });
      }
      if (!dbInstance.objectStoreNames.contains('toefl_mock_sets')) {
        dbInstance.createObjectStore('toefl_mock_sets', { keyPath: 'id' });
      }
      if (!dbInstance.objectStoreNames.contains('toefl_audio_cache')) {
        dbInstance.createObjectStore('toefl_audio_cache', { keyPath: 'cacheKey' });
      }
    };
  });
}

/**
 * Clears all stored questions from local IndexedDB and resets in-memory cache.
 */
export async function clearAllLocalQuestions(): Promise<void> {
  for (const key of Object.keys(curatedMemoryCache)) {
    delete curatedMemoryCache[key];
  }
  for (const key of Object.keys(coachMemoryCache)) {
    delete coachMemoryCache[key];
  }
  try {
    const dbInstance = await openIndexedDB();
    await new Promise<void>((resolve, reject) => {
      const tx = dbInstance.transaction(['toefl_question_bank', 'coach_questions'], 'readwrite');
      tx.objectStore('toefl_question_bank').clear();
      tx.objectStore('coach_questions').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to clear local IndexedDB question bank:', err);
  }
}

let purgePromise: Promise<void> | null = null;
let cwHeadTailMigrationPromise: Promise<void> | null = null;

/**
 * One-time automatic migration that normalizes and overwrites all existing `complete_words` / `complete-words`
 * documents across IndexedDB (`toefl_question_bank` and `coach_questions`) and Firestore (`questions` and `coach_questions`)
 * so every single existing question follows the strict 1 Head Sentence + Blanks + 1 Tail Sentence structure.
 */
export async function migrateCompleteWordsHeadTailV1(): Promise<void> {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  if (localStorage.getItem(MIGRATE_CW_HEAD_TAIL_V1) === 'true') return;
  if (cwHeadTailMigrationPromise) return cwHeadTailMigrationPromise;

  cwHeadTailMigrationPromise = (async () => {
    try {
      // 1. Clear or normalize any cached complete-words items in localStorage/sessionStorage prefetch queues
      for (const storage of [localStorage, typeof sessionStorage !== 'undefined' ? sessionStorage : null]) {
        if (!storage) continue;
        for (const key of [
          'toefl_prefetched_queue_v1',
          'toefl_prefetch_queue_v3',
          'toefl_prefetch_queue_v4',
          'toefl_prefetch_queue_coach_v1',
        ]) {
          try {
            const raw = storage.getItem(key);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              delete parsed['complete-words'];
              delete parsed['complete_words'];
              delete parsed['exam::complete-words'];
              delete parsed['coach::complete-words'];
              storage.setItem(key, JSON.stringify(parsed));
            }
          } catch {}
        }
      }

      // 2. Migrate any edited complete-words items in localStorage (unless isManualDevEdit === true)
      try {
        const editedMap = getEditedQuestionsMap();
        let editedModified = false;
        for (const [id, item] of Object.entries(editedMap)) {
          if (!item || typeof item !== 'object') continue;
          const itemType = canonicalizeTaskType(item.taskType || item.type || '');
          const looksLikeCw =
            itemType === 'complete-words' ||
            String(id).startsWith('cw-') ||
            String(id).startsWith('coach_cw_') ||
            Array.isArray(item.blanks);
          if (looksLikeCw && !item.isManualDevEdit && !item.content?.isManualDevEdit) {
            const isCoach =
              item.mode === 'coach' ||
              Boolean(item.coachMode) ||
              String(id).startsWith('coach_');
            const norm = normalizeCompleteWordsTask({
              ...(item.content || item),
              mode: isCoach ? 'coach' : 'exam',
              coachMode: isCoach,
            });
            editedMap[id] = {
              ...item,
              ...norm,
              ...(item.content ? { content: { ...item.content, ...norm } } : {}),
            };
            editedModified = true;
          }
        }
        if (editedModified) {
          localStorage.setItem(EDITED_QUESTIONS_STORAGE_KEY, JSON.stringify(editedMap));
        }
      } catch {}

      // 3. Migrate all complete-words documents in IndexedDB (`toefl_question_bank` and `coach_questions`)
      try {
        const dbInstance = await openIndexedDB();
        for (const mode of ['exam', 'coach'] as const) {
          const storeName = getIdbStoreName(mode);
          const allRows: any[] = await new Promise((resolve) => {
            try {
              const tx = dbInstance.transaction(storeName, 'readonly');
              const store = tx.objectStore(storeName);
              const req = store.getAll();
              req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
              req.onerror = () => resolve([]);
            } catch {
              resolve([]);
            }
          });

          const updatedRows: any[] = [];
          for (const row of allRows) {
            const rawType = row?.taskType || row?.type || row?.content?.taskType || '';
            if (canonicalizeTaskType(rawType) !== 'complete-words') continue;

            const baseContent = row?.content || row || {};
            const normalized = normalizeCompleteWordsTask({
              ...baseContent,
              mode,
              coachMode: mode === 'coach',
            });
            const updatedContent = {
              ...baseContent,
              ...normalized,
              id: baseContent.id || row.id,
              taskType: 'complete-words',
              mode,
              schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
            };
            const contentHash = await computeContentHash('complete-words', updatedContent);
            updatedRows.push({
              ...row,
              taskType: 'complete-words',
              content: updatedContent,
              text: normalized.text,
              passage: normalized.passage,
              blanks: normalized.blanks,
              totalBlanks: normalized.totalBlanks,
              contentHash,
              schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
              updatedAt: Date.now(),
            });
          }

          if (updatedRows.length > 0) {
            await new Promise<void>((resolve) => {
              try {
                const tx = dbInstance.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                for (const uRow of updatedRows) {
                  store.put(uRow);
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
                tx.onabort = () => resolve();
              } catch {
                resolve();
              }
            });
          }
        }

        // Also migrate any completeWords inside cached mock exam sets in IndexedDB (`toefl_mock_sets`)
        const mockRows: any[] = await new Promise((resolve) => {
          try {
            const tx = dbInstance.transaction('toefl_mock_sets', 'readonly');
            const store = tx.objectStore('toefl_mock_sets');
            const req = store.getAll();
            req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
            req.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        });
        if (mockRows.length > 0) {
          const updatedMocks: any[] = [];
          for (const mSet of mockRows) {
            if (!mSet?.modules) continue;
            let changed = false;
            const nextModules = { ...mSet.modules };
            for (const modKey of ['readingModule1', 'readingModule2Hard', 'readingModule2Easy'] as const) {
              const cw = nextModules[modKey]?.completeWords;
              if (cw) {
                const normCw = normalizeCompleteWordsTask({ ...cw, mode: 'exam', coachMode: false });
                nextModules[modKey] = {
                  ...nextModules[modKey],
                  completeWords: { ...cw, ...normCw },
                };
                changed = true;
              }
            }
            if (changed) {
              updatedMocks.push({ ...mSet, modules: nextModules });
            }
          }
          if (updatedMocks.length > 0) {
            await new Promise<void>((resolve) => {
              try {
                const tx = dbInstance.transaction('toefl_mock_sets', 'readwrite');
                const store = tx.objectStore('toefl_mock_sets');
                for (const uMock of updatedMocks) {
                  store.put(uMock);
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
                tx.onabort = () => resolve();
              } catch {
                resolve();
              }
            });
          }
        }
      } catch (idbErr) {
        console.warn('IndexedDB complete-words migration warning:', idbErr);
      }

      // Reset in-memory complete-words caches so they reload with migrated data
      delete curatedMemoryCache['complete-words'];
      delete coachMemoryCache['complete-words'];

      // 4. Migrate and overwrite all complete-words documents in Firestore (`questions` and `coach_questions`)
      try {
        await ensureAuthenticated();
        if (db) {
          for (const mode of ['exam', 'coach'] as const) {
            const colName = getFirestoreCollectionName(mode);
            const snap = await getDocs(collection(db, colName));
            for (const docSnap of snap.docs) {
              const rawDoc = docSnap.data();
              if (!rawDoc || rawDoc.deleted === true) continue;
              const rawType = rawDoc.taskType || rawDoc.type || rawDoc.content?.taskType || '';
              if (canonicalizeTaskType(rawType) !== 'complete-words') continue;

              const baseContent = rawDoc.content || rawDoc;
              const normalized = normalizeCompleteWordsTask({
                ...baseContent,
                mode,
                coachMode: mode === 'coach',
              });
              const updatedContent = {
                ...baseContent,
                ...normalized,
                id: baseContent.id || docSnap.id,
                taskType: 'complete-words',
                mode,
                schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
              };
              const contentHash = await computeContentHash('complete-words', updatedContent);
              const updatedDoc = {
                ...rawDoc,
                id: docSnap.id,
                taskType: 'complete-words',
                content: updatedContent,
                text: normalized.text,
                passage: normalized.passage,
                blanks: normalized.blanks,
                totalBlanks: normalized.totalBlanks,
                contentHash,
                schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
                updatedAt: Date.now(),
              };

              await setDoc(doc(db, colName, docSnap.id), updatedDoc, { merge: true });
            }
          }
        }
      } catch (fsErr) {
        console.warn('Firestore complete-words migration warning:', fsErr);
      }

      localStorage.setItem(MIGRATE_CW_HEAD_TAIL_V1, 'true');
    } catch (err) {
      console.warn('Error during MIGRATE_CW_HEAD_TAIL_V1:', err);
    } finally {
      cwHeadTailMigrationPromise = null;
    }
  })();

  return cwHeadTailMigrationPromise;
}

/**
 * One-time 2026 migration that purges legacy/corrupted questions from IndexedDB
 * and localStorage prefetch caches. Firestore documents are filtered via schemaVersion.
 */
export async function ensurePurged2026V2(): Promise<void> {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  if (localStorage.getItem(TOEFL_2026_PURGE_V19) !== 'true') {
    if (!purgePromise) {
      purgePromise = (async () => {
        try {
          await clearAllLocalQuestions();
          localStorage.removeItem('toefl_prefetched_queue_v1');
          localStorage.removeItem('toefl_prefetch_queue_v3');
          localStorage.removeItem('toefl_seen_question_ids');

          localStorage.setItem(TOEFL_2026_PURGE_V19, 'true');
          localStorage.setItem(STATIC_SHARDS_SYNC_KEY, 'true');
        } catch (err) {
          console.warn('Error during TOEFL_2026_PURGE_V19 migration:', err);
        } finally {
          purgePromise = null;
        }
      })();
    }
    await purgePromise;
  }

  await migrateCompleteWordsHeadTailV1();
}

export const purgeLegacyQuestionsIfNeeded = ensurePurged2026V2;
export const ensurePurged2026V4 = ensurePurged2026V2;
export const ensurePurged2026V3 = ensurePurged2026V2;

/**
 * Purge low-quality stub questions from IndexedDB and localStorage on startup
 */
export async function purgeLowQualityCache(): Promise<number> {
  await ensurePurged2026V2();
  let purgedCount = 0;
  try {
    const dbInstance = await openIndexedDB();
    const allItems: any[] = await new Promise((resolve, reject) => {
      const tx = dbInstance.transaction('toefl_question_bank', 'readonly');
      const store = tx.objectStore('toefl_question_bank');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    const idsToDelete = allItems
      .filter((item) => {
        if (!item?.content) return true;
        const itemSchema = item.schemaVersion ?? item.content?.schemaVersion;
        if (itemSchema !== CURRENT_BANK_SCHEMA_VERSION) return true;
        const norm = normalizeQuestionBankItem(item.content, item.taskType);
        return !norm || !validateNormalizedTask(item.taskType, norm);
      })
      .map((item) => item.id);

    if (idsToDelete.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const tx = dbInstance.transaction('toefl_question_bank', 'readwrite');
        const store = tx.objectStore('toefl_question_bank');
        for (const id of idsToDelete) {
          store.delete(id);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      purgedCount = idsToDelete.length;
    }
  } catch (err) {
    console.warn('Failed to purge IndexedDB low quality cache:', err);
  }

  return purgedCount;
}

/**
 * Save valid high-quality question to IndexedDB and Firestore
 */
export async function saveVerifiedQuestion(
  params: {
    taskType: string;
    level: string;
    topic: string;
    content: any;
    audioUrl?: string | null;
    audioClips?: any[] | null;
    source?: 'ai' | 'curated';
    generatedBy?: string;
    mode?: 'exam' | 'coach';
  },
  modeOverride?: 'exam' | 'coach'
): Promise<string | null> {
  const canonicalType = canonicalizeTaskType(params.taskType);
  const {
    audioUrl = null,
    audioClips = null,
    source = 'ai',
    generatedBy = getScholarUsername(),
  } = params;
  const mode = modeOverride || params.mode || 'exam';

  const normalizedItem = normalizeQuestionBankItem(params.content, canonicalType);
  const content = normalizedItem?.content || normalizedItem;

  if (!content || !validateNormalizedTask(canonicalType, content) || !isHighQualityTask(content, canonicalType)) {
    console.warn(`Rejected invalid or low-quality question for taskType ${canonicalType} during save.`);
    return null;
  }

  const validLevel: Level = normalizeDifficultyLabel(params.level || content?.level);
  const validTopic: AcademicTopic = normalizeTopicLabel(params.topic || content?.topic, content);

  const contentHash = await computeContentHash(canonicalType, content);
  const prefix = mode === 'coach' ? 'coach_q_' : 'q_';
  const questionId = content.id || `${prefix}${contentHash.slice(0, 24)}`;
  const enrichedContent = {
    ...content,
    id: questionId,
    level: validLevel,
    difficulty: validLevel,
    topic: validTopic,
    source,
    mode,
    schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
    generatedBy: generatedBy || getScholarUsername(),
    createdAt: content.createdAt || Date.now(),
  };

  const targetMemCache = getMemoryCacheForMode(mode);
  if (!targetMemCache[canonicalType]) {
    targetMemCache[canonicalType] = [];
  }
  const sig = getQuestionContentSignature(canonicalType, enrichedContent);
  const alreadyInMem = targetMemCache[canonicalType].some(
    (item) =>
      (item.id || item._id) === questionId ||
      getQuestionContentSignature(canonicalType, item) === sig
  );
  if (!alreadyInMem) {
    targetMemCache[canonicalType].push(enrichedContent);
  }

  const storeName = getIdbStoreName(mode);
  try {
    const dbInstance = await openIndexedDB();
    const tx = dbInstance.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.put({
      id: questionId,
      taskType: canonicalType,
      level: validLevel,
      topic: validTopic,
      content: enrichedContent,
      contentHash,
      audioUrl,
      audioClips,
      source,
      mode,
      schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
      generatedBy: enrichedContent.generatedBy,
      updatedAt: Date.now(),
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to save to local IndexedDB question bank:', err);
  }

  const collectionName = getFirestoreCollectionName(mode);
  try {
    await ensureAuthenticated();
    if (db) {
      const docRef = doc(db, collectionName, questionId);
      await setDoc(
        docRef,
        {
          id: questionId,
          taskType: canonicalType,
          level: validLevel,
          topic: validTopic,
          content: enrichedContent,
          contentHash,
          audioUrl: isValidBlobUrl(audioUrl) ? audioUrl : null,
          audioClips: Array.isArray(audioClips)
            ? audioClips.filter((c) => isValidBlobUrl(c?.url)).slice(0, 15)
            : null,
          source,
          schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
          generatedBy: enrichedContent.generatedBy,
          createdAt: serverTimestamp(),
          createdBy: auth?.currentUser?.uid || 'anonymous',
          useCount: 0,
          reportCount: 0,
        },
        { merge: true }
      );
    }
  } catch (err) {
    console.warn('Failed to save verified question to Firestore:', err);
  }

  return questionId;
}

export const SHARD_FILES = [
  'complete-words',
  'daily-life',
  'reading-academic',
  'listening-choose-response',
  'listening-dialogue',
  'listening-announcement',
  'listening-academic-talk',
  'writing-build-sentence',
  'writing-email',
  'academic-discussion',
  'speaking-listen-repeat',
  'speaking-interview',
];

export const STATIC_SHARDS = SHARD_FILES;
export const ALL_TASK_TYPES = TASK_DEFINITIONS.map((t) => t.id);
const CANONICAL_TASK_IDS = ALL_TASK_TYPES;

// In-memory caches for fast synchronous access (strictly isolated by mode)
const curatedMemoryCache: Record<string, any[]> = {};
const coachMemoryCache: Record<string, any[]> = {};

export function getMemoryCacheForMode(mode: 'exam' | 'coach' = 'exam'): Record<string, any[]> {
  return mode === 'coach' ? coachMemoryCache : curatedMemoryCache;
}

export const DELETED_QUESTIONS_STORAGE_KEY = 'toefl_deleted_question_ids';
export const EDITED_QUESTIONS_STORAGE_KEY = 'toefl_edited_questions_v1';

export function getDeletedQuestionIds(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(DELETED_QUESTIONS_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

export function addDeletedQuestionIdLocal(id: string, sig?: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const set = getDeletedQuestionIds();
    if (id) set.add(String(id));
    if (sig) set.add(String(sig));
    localStorage.setItem(DELETED_QUESTIONS_STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {}
}

export function getEditedQuestionsMap(): Record<string, any> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(EDITED_QUESTIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveEditedQuestionLocal(id: string, item: any): void {
  if (typeof localStorage === 'undefined' || !id) return;
  try {
    const map = getEditedQuestionsMap();
    map[String(id)] = item;
    localStorage.setItem(EDITED_QUESTIONS_STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

export async function syncDeletedQuestionsFromFirestore(): Promise<Set<string>> {
  const localSet = getDeletedQuestionIds();
  try {
    if (db) {
      const snap = await getDocs(collection(db, 'deleted_questions'));
      let changed = false;
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        if (docSnap.id && !localSet.has(docSnap.id)) {
          localSet.add(docSnap.id);
          changed = true;
        }
        if (d?.id && !localSet.has(String(d.id))) {
          localSet.add(String(d.id));
          changed = true;
        }
        if (d?.sig && !localSet.has(String(d.sig))) {
          localSet.add(String(d.sig));
          changed = true;
        }
      });
      if (changed && typeof localStorage !== 'undefined') {
        localStorage.setItem(DELETED_QUESTIONS_STORAGE_KEY, JSON.stringify(Array.from(localSet)));
      }
    }
  } catch {}
  return localSet;
}

/**
 * Load static curated shard for taskType from public/question-bank/<shard>.json (or COACH_CURATED_BANK when mode === 'coach')
 * and merge with any cached IndexedDB questions for that taskType and mode.
 */
export async function loadCuratedShard(
  taskType: string,
  mode: 'exam' | 'coach' = 'exam'
): Promise<any[]> {
  await ensurePurged2026V2();
  const canonicalType = canonicalizeTaskType(taskType);
  const targetMemCache = getMemoryCacheForMode(mode);

  if (!targetMemCache[canonicalType]) {
    targetMemCache[canonicalType] = [];
  }

  const deletedSet = getDeletedQuestionIds();
  const editedMap = getEditedQuestionsMap();
  const existingList = targetMemCache[canonicalType];
  const seenSigs = new Set<string>(
    existingList.map((item) => getQuestionContentSignature(canonicalType, item))
  );
  const seenIds = new Set<string>(
    existingList.map((item) => String(item.id || item._id || '')).filter(Boolean)
  );

  if (existingList.length === 0) {
    if (mode === 'coach') {
      const coachItems = COACH_CURATED_BANK[canonicalType] || [];
      for (let idx = 0; idx < coachItems.length; idx++) {
        const rawBase = coachItems[idx];
        const qId = String(rawBase.id || `coach-${canonicalType}-curated-${idx + 1}`);
        if (deletedSet.has(qId)) continue;
        const rawItem = editedMap[qId] ? { ...rawBase, ...editedMap[qId] } : rawBase;
        const normalizedWrapper = normalizeQuestionBankItem(rawItem, canonicalType);
        const normalizedItem = normalizedWrapper?.content || normalizedWrapper;
        if (!normalizedItem || !validateNormalizedTask(canonicalType, normalizedItem)) {
          continue;
        }
        const enriched = {
          ...normalizedItem,
          id: qId,
          taskType: canonicalType,
          mode: 'coach',
          level: normalizeDifficultyLabel(rawItem.level || rawItem.difficulty),
          difficulty: normalizeDifficultyLabel(rawItem.level || rawItem.difficulty),
          topic: normalizeTopicLabel(rawItem.topic || rawItem.category, rawItem),
          schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
        };
        const sig = getQuestionContentSignature(canonicalType, enriched);
        if (deletedSet.has(sig)) continue;
        if (!seenSigs.has(sig) && !seenIds.has(qId)) {
          seenSigs.add(sig);
          seenIds.add(qId);
          existingList.push(enriched);
        }
      }
    } else {
      const shardFileMap: Record<string, string> = {
        'build-sentence': 'writing-build-sentence',
        'write-email': 'writing-email',
        'listen-repeat': 'speaking-listen-repeat',
      };
      const shardsToLoad = [shardFileMap[canonicalType] || canonicalType];

      for (const shard of shardsToLoad) {
        try {
          const res = await fetch(`/question-bank/${shard}.json?v=${Date.now()}`, {
            cache: 'no-cache',
          });
          if (res.ok) {
            const json = await res.json();
            if (Array.isArray(json)) {
              for (let idx = 0; idx < json.length; idx++) {
                const rawBase = json[idx];
                const qId = String(rawBase.id || `${shard}-curated-${idx + 1}`);
                if (deletedSet.has(qId)) continue;
                const rawItem = editedMap[qId] ? { ...rawBase, ...editedMap[qId] } : rawBase;
                const normalizedWrapper = normalizeQuestionBankItem(rawItem, canonicalType);
                const normalizedItem = normalizedWrapper?.content || normalizedWrapper;
                if (!normalizedItem || !validateNormalizedTask(canonicalType, normalizedItem)) {
                  continue;
                }
                const enriched = {
                  ...normalizedItem,
                  id: qId,
                  taskType: canonicalType,
                  mode: 'exam',
                  level: normalizeDifficultyLabel(rawItem.level || rawItem.difficulty),
                  difficulty: normalizeDifficultyLabel(rawItem.level || rawItem.difficulty),
                  topic: normalizeTopicLabel(rawItem.topic || rawItem.category, rawItem),
                  schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
                };
                const sig = getQuestionContentSignature(canonicalType, enriched);
                if (deletedSet.has(sig)) continue;
                if (!seenSigs.has(sig) && !seenIds.has(qId)) {
                  seenSigs.add(sig);
                  seenIds.add(qId);
                  existingList.push(enriched);
                }
              }
            }
          }
        } catch (err) {
          console.warn(`Failed to fetch curated shard for ${shard}:`, err);
        }
      }
    }
  }

  // Also merge any validated questions from local IndexedDB for this taskType and mode
  const storeName = getIdbStoreName(mode);
  try {
    const dbInstance = await openIndexedDB();
    const tx = dbInstance.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const all = await new Promise<any[]>((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });

    for (const row of all) {
      const rowSchema = row.schemaVersion ?? row.content?.schemaVersion;
      if (rowSchema !== CURRENT_BANK_SCHEMA_VERSION) continue;
      const rowType = canonicalizeTaskType(row.taskType);
      if (rowType === canonicalType && row.content) {
        const qId = String(row.content.id || row.id || '');
        if (qId && deletedSet.has(qId)) continue;
        const rawSource = editedMap[qId] ? { ...row.content, ...editedMap[qId] } : row.content;
        const normalizedWrapper = normalizeQuestionBankItem(rawSource, canonicalType);
        const normalizedContent = normalizedWrapper?.content || normalizedWrapper;
        if (!normalizedContent || !validateNormalizedTask(canonicalType, normalizedContent)) {
          continue;
        }
        const isRowEdited = Boolean(
          editedMap[qId] ||
            row.isEdited ||
            row.editedBy ||
            row.content?.isEdited ||
            row.content?.editedBy
        );
        const enriched = {
          ...normalizedContent,
          id: qId || row.id,
          taskType: canonicalType,
          mode,
          level: normalizeDifficultyLabel(rawSource.level || row.level || row.content.level),
          difficulty: normalizeDifficultyLabel(rawSource.level || row.level || row.content.level),
          topic: normalizeTopicLabel(rawSource.topic || row.topic || row.content.topic, rawSource),
          schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
          ...(isRowEdited ? { isEdited: true, editedBy: row.content?.editedBy || 'Obi' } : {}),
        };
        const sig = getQuestionContentSignature(canonicalType, enriched);
        if (deletedSet.has(sig)) continue;
        if (isRowEdited && qId && seenIds.has(qId)) {
          const existingIdx = existingList.findIndex(
            (item) => String(item.id || item._id || '') === qId
          );
          if (existingIdx !== -1) {
            existingList[existingIdx] = enriched;
            seenSigs.add(sig);
          }
          saveEditedQuestionLocal(qId, enriched);
        } else if (!seenSigs.has(sig) && (!qId || !seenIds.has(qId))) {
          seenSigs.add(sig);
          if (qId) seenIds.add(qId);
          existingList.push(enriched);
        }
      }
    }
  } catch (idbErr) {
    console.warn(`Failed to load cached IDB questions for ${canonicalType} (${mode}):`, idbErr);
  }

  return targetMemCache[canonicalType] || [];
}

/**
 * Returns the exact list of questions in memory matching the selected level and topic
 * without falling back to the full unfiltered pool. Used for accurate filter count display.
 */
export function getFilteredBankTasks(
  taskType: string,
  level?: string,
  topic?: string,
  mode: 'exam' | 'coach' = 'exam'
): any[] {
  const canonicalType = canonicalizeTaskType(taskType);
  const targetMemCache = getMemoryCacheForMode(mode);
  const deletedSet = getDeletedQuestionIds();
  const all = (targetMemCache[canonicalType] || []).filter((t) => {
    const id = String(t?.id || t?.questionDocId || '');
    if (id && deletedSet.has(id)) return false;
    const sig = getQuestionContentSignature(canonicalType, t);
    return !deletedSet.has(sig);
  });
  if (all.length === 0) return [];

  return all.filter(
    (t) => matchesLevelFilter(t, level) && matchesTopicFilter(t, topic)
  );
}

/**
 * Synchronous getter for in-memory curated tasks with level/topic filtering
 * and graceful tier fallback so the user is never stuck with an empty screen.
 */
export function getLoadedCuratedTasks(
  taskType: string,
  level?: string,
  topic?: string,
  mode: 'exam' | 'coach' = 'exam'
): any[] {
  const canonicalType = canonicalizeTaskType(taskType);
  const targetMemCache = getMemoryCacheForMode(mode);
  const deletedSet = getDeletedQuestionIds();
  const all = (targetMemCache[canonicalType] || []).filter((t) => {
    const id = String(t?.id || t?.questionDocId || '');
    if (id && deletedSet.has(id)) return false;
    const sig = getQuestionContentSignature(canonicalType, t);
    return !deletedSet.has(sig);
  });
  if (all.length === 0) return [];

  // Tier 1: Exact level + topic match
  const exact = all.filter(
    (t) => matchesLevelFilter(t, level) && matchesTopicFilter(t, topic)
  );
  if (exact.length > 0) return exact;

  // Tier 2: Topic match only
  if (topic && topic !== 'all') {
    const byTopic = all.filter((t) => matchesTopicFilter(t, topic));
    if (byTopic.length > 0) return byTopic;
  }

  // Tier 3: Level match only
  if (level && level !== 'all') {
    const byLevel = all.filter((t) => matchesLevelFilter(t, level));
    if (byLevel.length > 0) return byLevel;
  }

  // Tier 4: Fallback to all tasks in section so the user is never stuck
  return all;
}

export interface QuestionBankSyncResult {
  totalQuestions: number;
  totalCurated: number;
  counts: Record<string, number>;
  countsPerTaskType: Record<string, number>;
}

/**
 * Sync all curated question shards into IndexedDB and in-memory cache for the given mode.
 * Pulls static shards (or COACH_CURATED_BANK for coach mode) AND global questions from Firestore.
 * Deduplicates by content signature and ID across all sources so counts are 100% consistent.
 */
export async function syncCuratedQuestionBank(
  mode: 'exam' | 'coach' = 'exam'
): Promise<QuestionBankSyncResult> {
  await ensurePurged2026V2();
  const deletedSet = await syncDeletedQuestionsFromFirestore();
  const editedMap = getEditedQuestionsMap();
  const counts: Record<string, number> = {};
  const tempCache: Record<string, any[]> = {};
  for (const tId of CANONICAL_TASK_IDS) {
    counts[tId] = 0;
    tempCache[tId] = [];
  }

  let totalQuestions = 0;
  let totalCurated = 0;
  const seenSignatures = new Set<string>();
  const seenIds = new Set<string>();

  const questionsToStore: Array<{
    id: string;
    taskType: string;
    level: string;
    topic: string;
    content: any;
    isCurated: boolean;
    mode: 'exam' | 'coach';
    schemaVersion: number;
    updatedAt: number;
  }> = [];

  if (mode === 'coach') {
    // 1. Load all 12 curated Coach & Marathon shards from COACH_CURATED_BANK
    for (const canonicalType of CANONICAL_TASK_IDS) {
      const coachItems = COACH_CURATED_BANK[canonicalType] || [];
      for (let idx = 0; idx < coachItems.length; idx++) {
        const rawBase = coachItems[idx];
        const qId = String(rawBase.id || `coach-${canonicalType}-curated-${idx + 1}`);
        if (deletedSet.has(qId)) continue;
        const isEditedOverride = Boolean(
          editedMap[qId] || rawBase.isManualDevEdit || rawBase.isEdited
        );
        const rawItem = editedMap[qId]
          ? { ...rawBase, ...editedMap[qId], isEdited: true, isManualDevEdit: true }
          : rawBase;
        const normalizedWrapper = isEditedOverride
          ? { content: rawItem }
          : normalizeQuestionBankItem(rawItem, canonicalType);
        const item = normalizedWrapper?.content || normalizedWrapper;
        if (!item || (!isEditedOverride && !validateNormalizedTask(canonicalType, item))) {
          continue;
        }
        const validLevel = normalizeDifficultyLabel(
          rawItem.level || rawItem.difficulty || item.level
        );
        const validTopic = normalizeTopicLabel(
          rawItem.topic || rawItem.category || item.topic,
          item
        );
        const enrichedContent = {
          ...item,
          id: qId,
          taskType: canonicalType,
          mode: 'coach' as const,
          level: validLevel,
          difficulty: validLevel,
          topic: validTopic,
          schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
          ...(isEditedOverride
            ? {
                isEdited: true,
                isManualDevEdit: true,
                editedBy: rawItem.editedBy || 'Obi',
              }
            : {}),
        };

        const sig = getQuestionContentSignature(canonicalType, enrichedContent);
        if (deletedSet.has(sig) || seenSignatures.has(sig) || seenIds.has(qId)) {
          continue;
        }
        seenSignatures.add(sig);
        seenIds.add(qId);

        tempCache[canonicalType].push(enrichedContent);
        counts[canonicalType] = (counts[canonicalType] || 0) + 1;
        totalQuestions++;
        totalCurated++;

        questionsToStore.push({
          id: qId,
          taskType: canonicalType,
          level: validLevel,
          topic: validTopic,
          content: enrichedContent,
          isCurated: true,
          mode: 'coach',
          schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
          updatedAt: Date.now(),
        });
      }
    }
  } else {
    // 1. Fetch all 12 curated Exam Mode shards completely into memory first BEFORE opening IDB transaction
    for (const shard of SHARD_FILES) {
      const canonicalType = canonicalizeTaskType(shard);
      if (!tempCache[canonicalType]) {
        tempCache[canonicalType] = [];
        counts[canonicalType] = 0;
      }

      try {
        const res = await fetch(`/question-bank/${shard}.json?v=${Date.now()}`, {
          cache: 'no-cache',
        });
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json)) {
            for (let idx = 0; idx < json.length; idx++) {
              const rawBase = json[idx];
              const qId = String(rawBase.id || `${shard}-curated-${idx + 1}`);
              if (deletedSet.has(qId)) continue;
              const isEditedOverride = Boolean(
                editedMap[qId] || rawBase.isManualDevEdit || rawBase.isEdited
              );
              const rawItem = editedMap[qId]
                ? { ...rawBase, ...editedMap[qId], isEdited: true, isManualDevEdit: true }
                : rawBase;
              const normalizedWrapper = isEditedOverride
                ? { content: rawItem }
                : normalizeQuestionBankItem(rawItem, canonicalType);
              const item = normalizedWrapper?.content || normalizedWrapper;
              if (!item || (!isEditedOverride && !validateNormalizedTask(canonicalType, item))) {
                continue;
              }
              const validLevel = normalizeDifficultyLabel(
                rawItem.level || rawItem.difficulty || item.level
              );
              const validTopic = normalizeTopicLabel(
                rawItem.topic || rawItem.category || item.topic,
                item
              );
              const enrichedContent = {
                ...item,
                id: qId,
                taskType: canonicalType,
                mode: 'exam' as const,
                level: validLevel,
                difficulty: validLevel,
                topic: validTopic,
                schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
                ...(isEditedOverride
                  ? {
                      isEdited: true,
                      isManualDevEdit: true,
                      editedBy: rawItem.editedBy || 'Obi',
                    }
                  : {}),
              };

              const sig = getQuestionContentSignature(canonicalType, enrichedContent);
              if (deletedSet.has(sig) || seenSignatures.has(sig) || seenIds.has(qId)) {
                continue;
              }
              seenSignatures.add(sig);
              seenIds.add(qId);

              tempCache[canonicalType].push(enrichedContent);
              counts[canonicalType] = (counts[canonicalType] || 0) + 1;
              totalQuestions++;
              totalCurated++;

              questionsToStore.push({
                id: qId,
                taskType: canonicalType,
                level: validLevel,
                topic: validTopic,
                content: enrichedContent,
                isCurated: true,
                mode: 'exam',
                schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
                updatedAt: Date.now(),
              });
            }
          }
        }
      } catch (shardErr) {
        console.warn(`Failed to sync shard ${shard}:`, shardErr);
      }
    }
  }

  // 2. Fetch and merge validated, deduplicated questions from Firestore for this mode
  const collectionName = getFirestoreCollectionName(mode);
  try {
    if (db) {
      const qSnap = await getDocs(collection(db, collectionName));
      if (!qSnap.empty) {
        qSnap.forEach((docSnap) => {
          const rawDoc = docSnap.data();
          if (rawDoc.deleted === true) return;
          if ((rawDoc.reportCount || 0) >= 3) return;
          const docSchema = rawDoc.schemaVersion ?? rawDoc.content?.schemaVersion;
          if (docSchema !== CURRENT_BANK_SCHEMA_VERSION) return;

          const qId = String(docSnap.id);
          if (deletedSet.has(qId)) return;

          const targetTaskType = canonicalizeTaskType(
            rawDoc.taskType || rawDoc.type || 'academic-discussion'
          );
          const innerRawId = String(rawDoc.content?.id || rawDoc.id || '');
          if (innerRawId && deletedSet.has(innerRawId)) return;

          const isDocEdited = Boolean(
            editedMap[qId] ||
              (innerRawId && editedMap[innerRawId]) ||
              rawDoc.isManualDevEdit ||
              rawDoc.isEdited ||
              rawDoc.editedBy ||
              rawDoc.content?.isManualDevEdit ||
              rawDoc.content?.isEdited ||
              rawDoc.content?.editedBy
          );

          const overrideObj = editedMap[qId] || (innerRawId ? editedMap[innerRawId] : null);
          const mergedDoc = overrideObj
            ? {
                ...rawDoc,
                content: {
                  ...(rawDoc.content || rawDoc),
                  ...overrideObj,
                  isEdited: true,
                  isManualDevEdit: true,
                },
              }
            : rawDoc;
          const normalizedWrapper = isDocEdited
            ? { content: mergedDoc.content || mergedDoc }
            : normalizeQuestionBankItem(mergedDoc, targetTaskType);
          const contentToCheck = normalizedWrapper?.content || normalizedWrapper;

          if (
            contentToCheck &&
            targetTaskType &&
            counts[targetTaskType] !== undefined &&
            (isDocEdited ||
              (validateNormalizedTask(targetTaskType, contentToCheck) &&
                isHighQualityTask(contentToCheck, targetTaskType)))
          ) {
            const innerId = String(contentToCheck.id || '');
            if (innerId && deletedSet.has(innerId)) return;
            const validLevel = normalizeDifficultyLabel(
              mergedDoc.level || contentToCheck.level
            );
            const validTopic = normalizeTopicLabel(
              mergedDoc.topic || contentToCheck.topic,
              contentToCheck
            );

            const enrichedContent = {
              ...contentToCheck,
              id: contentToCheck.id || qId,
              questionDocId: qId,
              taskType: targetTaskType,
              mode,
              level: validLevel,
              difficulty: validLevel,
              topic: validTopic,
              schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
              ...(isDocEdited
                ? {
                    isEdited: true,
                    isManualDevEdit: true,
                    editedBy: rawDoc.content?.editedBy || rawDoc.editedBy || 'Obi',
                  }
                : {}),
            };

            const sig = getQuestionContentSignature(targetTaskType, enrichedContent);
            if (deletedSet.has(sig)) {
              return;
            }

            if (isDocEdited && (seenIds.has(qId) || (innerId && seenIds.has(innerId)))) {
              const matchId = seenIds.has(qId) ? qId : innerId;
              const cacheIdx = tempCache[targetTaskType].findIndex(
                (it) => String(it.id || it.questionDocId || '') === matchId
              );
              if (cacheIdx !== -1) {
                tempCache[targetTaskType][cacheIdx] = enrichedContent;
              }
              const storeIdx = questionsToStore.findIndex(
                (it) => String(it.id || it.content?.id || '') === matchId
              );
              if (storeIdx !== -1) {
                questionsToStore[storeIdx] = {
                  ...questionsToStore[storeIdx],
                  level: validLevel,
                  topic: validTopic,
                  content: enrichedContent,
                  updatedAt: Date.now(),
                };
              }
              seenSignatures.add(sig);
              saveEditedQuestionLocal(matchId, enrichedContent);
              return;
            }

            if (
              seenSignatures.has(sig) ||
              seenIds.has(qId) ||
              (innerId && seenIds.has(innerId))
            ) {
              return;
            }

            seenSignatures.add(sig);
            seenIds.add(qId);
            if (innerId) seenIds.add(innerId);

            tempCache[targetTaskType].push(enrichedContent);
            counts[targetTaskType] = (counts[targetTaskType] || 0) + 1;
            totalQuestions++;

            questionsToStore.push({
              id: qId,
              taskType: targetTaskType,
              level: validLevel,
              topic: validTopic,
              content: enrichedContent,
              isCurated: false,
              mode,
              schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
              updatedAt: Date.now(),
            });
          }
        });
      }
    }
  } catch (firestoreErr) {
    console.warn(`Failed to sync questions from Firestore (${collectionName}) into local bank:`, firestoreErr);
  }

  // 3. Preserve any locally generated AI questions or edited curated questions in IndexedDB for this mode
  const storeName = getIdbStoreName(mode);
  try {
    const dbInstance = await openIndexedDB();
    const existingRows = await new Promise<any[]>((resolve) => {
      const tx = dbInstance.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });

    for (const row of existingRows) {
      const rowSchema = row.schemaVersion ?? row.content?.schemaVersion;
      if (rowSchema !== CURRENT_BANK_SCHEMA_VERSION) continue;
      const rowType = canonicalizeTaskType(row.taskType);
      const rawRowContent = row.content || row;
      const qId = String(row.id || rawRowContent.id || '');
      if (qId && deletedSet.has(qId)) continue;
      const isRowEdited = Boolean(
        editedMap[qId] ||
          row.isManualDevEdit ||
          row.isEdited ||
          row.editedBy ||
          rawRowContent.isManualDevEdit ||
          rawRowContent.isEdited ||
          rawRowContent.editedBy
      );
      const effectiveRaw = editedMap[qId]
        ? { ...rawRowContent, ...editedMap[qId], isEdited: true, isManualDevEdit: true }
        : rawRowContent;
      const normalizedWrapper = isRowEdited
        ? { content: effectiveRaw }
        : normalizeQuestionBankItem(effectiveRaw, rowType);
      const rowContent = normalizedWrapper?.content || normalizedWrapper;
      if (
        rowType &&
        counts[rowType] !== undefined &&
        rowContent &&
        (isRowEdited ||
          (validateNormalizedTask(rowType, rowContent) &&
            isHighQualityTask(rowContent, rowType)))
      ) {
        const validLevel = normalizeDifficultyLabel(effectiveRaw.level || row.level || rowContent.level);
        const validTopic = normalizeTopicLabel(effectiveRaw.topic || row.topic || rowContent.topic, rowContent);
        const enrichedContent = {
          ...rowContent,
          id: rowContent.id || qId,
          taskType: rowType,
          mode,
          level: validLevel,
          difficulty: validLevel,
          topic: validTopic,
          schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
          ...(isRowEdited
            ? {
                isEdited: true,
                isManualDevEdit: true,
                editedBy: rawRowContent.editedBy || row.editedBy || 'Obi',
              }
            : {}),
        };
        const sig = getQuestionContentSignature(rowType, enrichedContent);
        if (deletedSet.has(sig)) continue;
        if (isRowEdited && qId && seenIds.has(qId)) {
          const cacheIdx = tempCache[rowType].findIndex(
            (it) => String(it.id || it.questionDocId || '') === qId
          );
          if (cacheIdx !== -1) {
            tempCache[rowType][cacheIdx] = enrichedContent;
          }
          const storeIdx = questionsToStore.findIndex(
            (it) => String(it.id || it.content?.id || '') === qId
          );
          if (storeIdx !== -1) {
            questionsToStore[storeIdx] = {
              ...questionsToStore[storeIdx],
              level: validLevel,
              topic: validTopic,
              content: enrichedContent,
              updatedAt: row.updatedAt || Date.now(),
            };
          }
          seenSignatures.add(sig);
          saveEditedQuestionLocal(qId, enrichedContent);
        } else if (!seenSignatures.has(sig) && (!qId || !seenIds.has(qId))) {
          seenSignatures.add(sig);
          if (qId) seenIds.add(qId);
          tempCache[rowType].push(enrichedContent);
          counts[rowType] = (counts[rowType] || 0) + 1;
          totalQuestions++;
          questionsToStore.push({
            id: qId || `local_${mode}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            taskType: rowType,
            level: validLevel,
            topic: validTopic,
            content: enrichedContent,
            isCurated: Boolean(row.isCurated),
            mode,
            schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
            updatedAt: row.updatedAt || Date.now(),
          });
        }
      }
    }

    if (questionsToStore.length > 0) {
      const tx = dbInstance.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      for (const q of questionsToStore) {
        store.put(q);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
  } catch (idbErr) {
    console.warn(`Failed to commit deduplicated questions to IndexedDB (${storeName}):`, idbErr);
  }

  // Update in-memory cache atomically for this mode
  const targetMemCache = getMemoryCacheForMode(mode);
  for (const tId of CANONICAL_TASK_IDS) {
    targetMemCache[tId] = tempCache[tId] || [];
  }

  // Trigger background sync of any missing local/curated questions to Firestore
  syncLocalQuestionsToFirestore(mode).catch((err) => {
    console.warn(`Background Firestore question sync (${mode}) skipped:`, err);
  });

  return {
    totalQuestions,
    totalCurated,
    counts,
    countsPerTaskType: counts,
  };
}

const isSyncingToFirestoreByMode: Record<'exam' | 'coach', boolean> = {
  exam: false,
  coach: false,
};

/**
 * Syncs all deduplicated questions from in-memory cache and IndexedDB to the Firestore 'questions' or 'coach_questions' collection
 * using a fast Firestore writeBatch while strictly respecting deletedQuestionIds and isManualDevEdit.
 */
export async function syncLocalQuestionsToFirestore(
  mode: 'exam' | 'coach' = 'exam'
): Promise<{
  synced: number;
  existing: number;
}> {
  if (isSyncingToFirestoreByMode[mode] || !db) {
    return { synced: 0, existing: 0 };
  }
  isSyncingToFirestoreByMode[mode] = true;

  let synced = 0;
  let existing = 0;
  const collectionName = getFirestoreCollectionName(mode);
  const targetMemCache = getMemoryCacheForMode(mode);
  const deletedSet = getDeletedQuestionIds();

  try {
    await ensureAuthenticated();

    const existingIds = new Set<string>();
    const existingSigs = new Set<string>();
    const existingHashes = new Set<string>();
    const existingEditedIds = new Set<string>();

    const snap = await getDocs(collection(db, collectionName));
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      if (d?.isManualDevEdit || d?.isEdited || d?.content?.isManualDevEdit || d?.content?.isEdited) {
        existingEditedIds.add(docSnap.id);
        if (d?.content?.id) existingEditedIds.add(String(d.content.id));
      }
      const docSchema = d?.schemaVersion ?? d?.content?.schemaVersion;
      if (docSchema !== CURRENT_BANK_SCHEMA_VERSION) return;
      existing++;
      existingIds.add(docSnap.id);
      if (d?.content?.id) existingIds.add(String(d.content.id));
      if (d?.contentHash) existingHashes.add(String(d.contentHash));
      const tType = canonicalizeTaskType(d?.taskType || d?.type || 'academic-discussion');
      const sig = getQuestionContentSignature(tType, d?.content || d);
      existingSigs.add(sig);
    });

    // Gather all candidate questions from memory
    const candidates: Array<{
      id: string;
      taskType: string;
      level: Level;
      topic: AcademicTopic;
      content: any;
      source: string;
    }> = [];

    for (const tId of CANONICAL_TASK_IDS) {
      const list = targetMemCache[tId] || [];
      for (const item of list) {
        const qId = String(item.id || '');
        if (qId && deletedSet.has(qId)) continue;
        if (!item.isManualDevEdit && !item.isEdited && !isHighQualityTask(item, tId)) continue;
        const validLevel = normalizeDifficultyLabel(item.level || item.difficulty);
        const validTopic = normalizeTopicLabel(item.topic || item.category, item);
        candidates.push({
          id: qId,
          taskType: tId,
          level: validLevel,
          topic: validTopic,
          content: item,
          source: item.source || 'curated',
        });
      }
    }

    const toWrite: Array<{ docId: string; record: SharedQuestionRecord }> = [];
    const prefix = mode === 'coach' ? 'coach_q_' : 'q_';

    for (const cand of candidates) {
      const sig = getQuestionContentSignature(cand.taskType, cand.content);
      if (deletedSet.has(sig) || (cand.id && deletedSet.has(cand.id))) {
        continue;
      }
      const contentHash = await computeContentHash(cand.taskType, cand.content);
      const docId =
        cand.id && (cand.id.startsWith('q_') || cand.id.startsWith('coach_'))
          ? cand.id
          : `${prefix}${contentHash.slice(0, 24)}`;

      // Never overwrite an edited question in Firestore unless local item is explicitly edited
      if (
        (existingEditedIds.has(docId) || (cand.id && existingEditedIds.has(cand.id))) &&
        !cand.content.isManualDevEdit &&
        !cand.content.isEdited
      ) {
        continue;
      }

      if (
        existingIds.has(docId) ||
        (cand.id && existingIds.has(cand.id)) ||
        existingHashes.has(contentHash) ||
        existingSigs.has(sig)
      ) {
        continue;
      }

      existingIds.add(docId);
      existingHashes.add(contentHash);
      existingSigs.add(sig);

      const enrichedContent = {
        ...cand.content,
        id: cand.content.id || docId,
        level: cand.level,
        topic: cand.topic,
        source: cand.source,
        mode,
        schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
        generatedBy: cand.content.generatedBy || getScholarUsername(),
        createdAt: cand.content.createdAt || Date.now(),
      };

      const rawAudioUrl = cand.content.audioUrl || null;
      const rawAudioClips = cand.content.audioClips || null;
      const cleanAudioUrl = isValidBlobUrl(rawAudioUrl) ? rawAudioUrl : null;
      const cleanAudioClips = Array.isArray(rawAudioClips)
        ? rawAudioClips.filter((c: any) => isValidBlobUrl(c?.url)).slice(0, 15)
        : null;

      toWrite.push({
        docId,
        record: {
          id: docId,
          taskType: cand.taskType,
          level: cand.level,
          topic: cand.topic,
          content: enrichedContent,
          contentHash,
          audioUrl: cleanAudioUrl,
          audioClips: cleanAudioClips && cleanAudioClips.length > 0 ? cleanAudioClips : null,
          source: cand.source,
          schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
          generatedBy: enrichedContent.generatedBy,
          createdAt: serverTimestamp(),
          createdBy: auth?.currentUser?.uid || 'anonymous',
          useCount: 0,
          reportCount: 0,
        },
      });
    }

    const BATCH_LIMIT = 400;
    for (let i = 0; i < toWrite.length; i += BATCH_LIMIT) {
      const slice = toWrite.slice(i, i + BATCH_LIMIT);
      const batch = writeBatch(db);
      for (const item of slice) {
        batch.set(doc(db, collectionName, item.docId), item.record, { merge: true });
      }
      await batch.commit();
      synced += slice.length;
    }
  } catch (err) {
    console.warn(`Error in syncLocalQuestionsToFirestore (${mode}):`, err);
  } finally {
    isSyncingToFirestoreByMode[mode] = false;
  }

  return { synced, existing };
}

/**
 * Synchronizes global questions from Firestore without userId filtering,
 * commits them to IndexedDB, updates memory cache,
 * and returns the updated counts across all task types.
 */
export async function syncFirestoreGlobalCounts(
  mode: 'exam' | 'coach' = 'exam'
): Promise<QuestionBankSyncResult> {
  return syncCuratedQuestionBank(mode);
}

/**
 * Re-Sync All Shards: Fetches all 12 Exam Mode shards (/question-bank/*.json),
 * the Coach Mode curated bank (COACH_CURATED_BANK), and the Full Mock Exam Sets (CURATED_MOCK_EXAM_SETS),
 * skips any deletedQuestionIds and preserves any isManualDevEdit/isEdited items,
 * and commits to IndexedDB and Firestore using single transactions and writeBatch.
 */
export async function reSyncAllShards(
  mode: 'exam' | 'coach' = 'exam'
): Promise<
  QuestionBankSyncResult & {
    examTotal?: number;
    coachTotal?: number;
    mockSetsCount?: number;
  }
> {
  const [examRes, coachRes, mockSets] = await Promise.all([
    syncCuratedQuestionBank('exam'),
    syncCuratedQuestionBank('coach'),
    import('./examStorage')
      .then((m) => m.syncAndGetMockExamSets())
      .catch(() => []),
  ]);

  await Promise.all([
    syncLocalQuestionsToFirestore('exam').catch(() => {}),
    syncLocalQuestionsToFirestore('coach').catch(() => {}),
  ]);

  const primary = mode === 'coach' ? coachRes : examRes;
  return {
    ...primary,
    examTotal: examRes.totalQuestions,
    coachTotal: coachRes.totalQuestions,
    mockSetsCount: Array.isArray(mockSets) ? mockSets.length : 0,
  };
}

/**
 * Get deduplicated question bank counts across all canonical TOEFL sections for the active mode.
 * Guarantees that totalQuestions === sum(Object.values(countsPerTaskType)).
 */
export async function getQuestionBankStats(
  mode: 'exam' | 'coach' = 'exam'
): Promise<{
  totalQuestions: number;
  totalCurated: number;
  countsPerTaskType: Record<string, number>;
}> {
  const counts: Record<string, number> = {};
  for (const tId of CANONICAL_TASK_IDS) {
    counts[tId] = 0;
  }

  const targetMemCache = getMemoryCacheForMode(mode);
  const memTotal = CANONICAL_TASK_IDS.reduce(
    (sum, tId) => sum + (targetMemCache[tId]?.length || 0),
    0
  );

  const storeName = getIdbStoreName(mode);
  try {
    const dbInstance = await openIndexedDB();
    const tx = dbInstance.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const all = await new Promise<any[]>((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });

    if (all.length > 0) {
      const deletedSet = getDeletedQuestionIds();
      const seenSigs = new Set<string>();
      const seenIds = new Set<string>();
      let curatedTotal = 0;

      for (const item of all) {
        const itemSchema = item.schemaVersion ?? item.content?.schemaVersion;
        if (itemSchema !== CURRENT_BANK_SCHEMA_VERSION) continue;
        const tType = canonicalizeTaskType(item.taskType);
        const contentObj = item.content || item;
        if (tType && counts[tType] !== undefined && contentObj) {
          const qId = String(item.id || contentObj.id || '');
          if (qId && deletedSet.has(qId)) continue;
          const sig = getQuestionContentSignature(tType, contentObj);
          if (deletedSet.has(sig) || seenSigs.has(sig) || (qId && seenIds.has(qId))) {
            continue;
          }
          seenSigs.add(sig);
          if (qId) seenIds.add(qId);
          counts[tType] = (counts[tType] || 0) + 1;
          if (item.isCurated) curatedTotal++;
        }
      }

      const totalQuestions = Object.values(counts).reduce((a, b) => a + b, 0);
      if (totalQuestions > 0) {
        return {
          totalQuestions,
          totalCurated: curatedTotal || totalQuestions,
          countsPerTaskType: counts,
        };
      }
    }
  } catch {}

  if (memTotal > 0) {
    for (const tId of CANONICAL_TASK_IDS) {
      counts[tId] = (targetMemCache[tId] || []).length;
    }
    const totalQuestions = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      totalQuestions,
      totalCurated: totalQuestions,
      countsPerTaskType: counts,
    };
  }

  // If cache is cold and IDB empty, run full sync for this mode
  const syncRes = await syncCuratedQuestionBank(mode);
  return {
    totalQuestions: syncRes.totalQuestions,
    totalCurated: syncRes.totalCurated,
    countsPerTaskType: syncRes.countsPerTaskType,
  };
}

export async function getTaskBankCounts(
  mode: 'exam' | 'coach' = 'exam'
): Promise<Record<string, number>> {
  const stats = await getQuestionBankStats(mode);
  return stats.countsPerTaskType;
}

export async function getGlobalBankCount(
  mode: 'exam' | 'coach' = 'exam'
): Promise<number> {
  const stats = await getQuestionBankStats(mode);
  return stats.totalQuestions;
}

export async function getSharedQuestions(
  taskTypeOrMode?: string,
  difficulty?: string,
  topic?: string,
  mode: 'exam' | 'coach' = 'exam'
): Promise<any[]> {
  let effectiveTaskType = taskTypeOrMode;
  let effectiveMode = mode;
  if (taskTypeOrMode === 'exam' || taskTypeOrMode === 'coach') {
    effectiveMode = taskTypeOrMode;
    effectiveTaskType = undefined;
  }
  await getQuestionBankStats(effectiveMode);
  const targetTypes = effectiveTaskType ? [canonicalizeTaskType(effectiveTaskType)] : CANONICAL_TASK_IDS;
  const targetMemCache = getMemoryCacheForMode(effectiveMode);
  const results: any[] = [];
  const seenSigs = new Set<string>();

  for (const tId of targetTypes) {
    const items = targetMemCache[tId] || [];
    for (const item of items) {
      if (!matchesLevelFilter(item, difficulty)) continue;
      if (!matchesTopicFilter(item, topic)) continue;
      const sig = getQuestionContentSignature(tId, item);
      if (seenSigs.has(sig)) continue;
      seenSigs.add(sig);
      results.push(item);
    }
  }

  return results;
}

/**
 * Persistent Audio Cache in IndexedDB (toefl_audio_cache)
 */
export async function getCachedAudio(cacheKey: string): Promise<string | null> {
  try {
    const dbInstance = await openIndexedDB();
    return new Promise((resolve) => {
      const tx = dbInstance.transaction('toefl_audio_cache', 'readonly');
      const store = tx.objectStore('toefl_audio_cache');
      const req = store.get(cacheKey);
      req.onsuccess = () => {
        resolve(req.result?.audioUrl || null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedAudio(cacheKey: string, audioUrl: string): Promise<void> {
  try {
    const dbInstance = await openIndexedDB();
    const tx = dbInstance.transaction('toefl_audio_cache', 'readwrite');
    const store = tx.objectStore('toefl_audio_cache');
    store.put({ cacheKey, audioUrl, updatedAt: Date.now() });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to cache audio in IndexedDB:', err);
  }
}

/**
 * Export all questions as JSON (merging local IndexedDB stored questions with curated shards)
 */
export async function exportQuestionBankJson(): Promise<string> {
  const dbItems: any[] = [];
  try {
    const dbInstance = await openIndexedDB();
    const tx = dbInstance.transaction('toefl_question_bank', 'readonly');
    const store = tx.objectStore('toefl_question_bank');
    const req = store.getAll();
    await new Promise((resolve) => {
      req.onsuccess = () => {
        if (Array.isArray(req.result)) dbItems.push(...req.result);
        resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {}

  const curatedShards: Record<string, any[]> = {};
  for (const shard of SHARD_FILES) {
    try {
      const res = await fetch(`/question-bank/${shard}.json`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          curatedShards[shard] = data;
        }
      }
    } catch {}
  }

  const exportPayload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    totalSavedInIndexedDb: dbItems.length,
    newlySeededQuestions: dbItems,
    curatedQuestionBank: curatedShards,
  };

  return JSON.stringify(exportPayload, null, 2);
}

// -------------------------------------------------------------
// Shared Questions & Firestore Sync Logic (Consolidated)
// -------------------------------------------------------------

const LOCAL_SEEN_KEY = 'toefl_seen_question_ids';

export function getLocalSeenQuestionIds(): string[] {
  try {
    const raw = localStorage.getItem(LOCAL_SEEN_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function markLocalQuestionAsSeen(id: string) {
  try {
    const current = getLocalSeenQuestionIds();
    if (!current.includes(id)) {
      const updated = [...current.slice(-500), id];
      localStorage.setItem(LOCAL_SEEN_KEY, JSON.stringify(updated));
    }
  } catch {
    // Ignore storage errors
  }
}

// Generate a deterministic SHA-256 hash from question content
export async function computeContentHash(taskType: string, content: any): Promise<string> {
  const canonicalType = canonicalizeTaskType(taskType);
  const mainText =
    content.passage ||
    content.text ||
    content.script ||
    content.situation ||
    content.professorPrompt ||
    (Array.isArray(content.sentences) ? content.sentences.join(' ') : '') ||
    (Array.isArray(content.questions)
      ? content.questions.map((q: any) => q.question || q.q).join(' ')
      : '') ||
    (Array.isArray(content.items)
      ? content.items.map((i: any) => i.answer || i.context).join(' ')
      : '') ||
    JSON.stringify(content);

  const cleanSample = `${canonicalType}:::${mainText.trim().toLowerCase()}`;

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(cleanSample));
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
      return hex;
    } catch {
      // Fallback
    }
  }

  // Fast 32-bit FNV-1a hash fallback
  let h = 0x811c9dc5;
  for (let i = 0; i < cleanSample.length; i++) {
    h ^= cleanSample.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `hash_${(h >>> 0).toString(16)}`;
}

export interface SharedQuestionRecord {
  id?: string;
  taskType: string;
  level: string;
  topic: string;
  content: any;
  contentHash: string;
  audioUrl?: string | null;
  audioClips?: Array<{ speaker: string; url: string }> | null;
  source?: string;
  schemaVersion?: number | string;
  generatedBy?: string;
  createdAt?: any;
  createdBy: string;
  useCount: number;
  reportCount?: number;
}

const BLOB_DOMAIN_SUFFIX = 'blob.vercel-storage.com';
function isValidBlobUrl(url: any): boolean {
  if (typeof url !== 'string') return false;
  return url.startsWith('https://') && url.includes(BLOB_DOMAIN_SUFFIX);
}

/**
 * Deduplicate by contentHash and save a question to Firestore collection 'questions' or 'coach_questions'.
 * Validates level against LEVELS and infers topic if missing, 'all' or 'general'.
 */
export async function saveQuestionToBank(
  params: {
    taskType: string;
    level: string;
    topic: string;
    content: any;
    audioUrl?: string | null;
    audioClips?: Array<{ speaker: string; url: string }> | null;
    source?: string;
    generatedBy?: string;
    mode?: 'exam' | 'coach';
  },
  modeOverride?: 'exam' | 'coach'
): Promise<string | null> {
  const canonicalType = canonicalizeTaskType(params.taskType);
  const {
    audioUrl = null,
    audioClips = null,
    source = 'ai',
    generatedBy = getScholarUsername(),
  } = params;
  const mode = modeOverride || params.mode || 'exam';

  const normalizedWrapper = normalizeQuestionBankItem(params.content, canonicalType);
  const content = normalizedWrapper?.content || normalizedWrapper;
  if (!content || !validateNormalizedTask(canonicalType, content)) {
    return null;
  }

  const validatedLevel: Level = normalizeDifficultyLabel(params.level || content?.level);
  const validatedTopic: AcademicTopic = normalizeTopicLabel(
    params.topic || content?.topic,
    content
  );

  const contentHash = await computeContentHash(canonicalType, content);

  const cleanAudioUrl = isValidBlobUrl(audioUrl) ? audioUrl : null;
  const cleanAudioClips = Array.isArray(audioClips)
    ? audioClips.filter((c) => isValidBlobUrl(c.url)).slice(0, 15)
    : null;

  const prefix = mode === 'coach' ? 'coach_q_' : 'q_';
  const docId = `${prefix}${contentHash.slice(0, 24)}`;
  const userUsername = getScholarUsername();
  const enrichedContent = {
    ...content,
    id: content.id || docId,
    level: validatedLevel,
    difficulty: validatedLevel,
    topic: validatedTopic,
    source,
    mode,
    schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
    createdBy: content.createdBy || userUsername,
    generatedBy: generatedBy || userUsername,
    createdAt: content.createdAt || Date.now(),
  };

  // Update in-memory cache and IndexedDB for this mode as well
  const targetMemCache = getMemoryCacheForMode(mode);
  if (!targetMemCache[canonicalType]) {
    targetMemCache[canonicalType] = [];
  }
  const sig = getQuestionContentSignature(canonicalType, enrichedContent);
  const alreadyInMem = targetMemCache[canonicalType].some(
    (item) =>
      (item.id || item._id) === docId ||
      getQuestionContentSignature(canonicalType, item) === sig
  );
  if (!alreadyInMem) {
    targetMemCache[canonicalType].push(enrichedContent);
  }

  const storeName = getIdbStoreName(mode);
  try {
    const dbInstance = await openIndexedDB();
    const tx = dbInstance.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.put({
      id: docId,
      taskType: canonicalType,
      level: validatedLevel,
      topic: validatedTopic,
      content: enrichedContent,
      contentHash,
      audioUrl: cleanAudioUrl,
      audioClips: cleanAudioClips,
      source,
      mode,
      schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
      createdBy: userUsername,
      generatedBy: enrichedContent.generatedBy,
      updatedAt: Date.now(),
    });
  } catch {}

  const collectionName = getFirestoreCollectionName(mode);
  try {
    await ensureAuthenticated();

    // 1. Check for existing duplicate by contentHash
    const q = query(
      collection(db, collectionName),
      where('contentHash', '==', contentHash),
      limit(1)
    );
    const existingSnap = await getDocs(q);
    if (!existingSnap.empty) {
      return existingSnap.docs[0].id;
    }

    // 2. Generate new document
    const docRef = doc(db, collectionName, docId);

    const record: SharedQuestionRecord = {
      id: docId,
      taskType: canonicalType,
      level: validatedLevel,
      topic: validatedTopic,
      content: enrichedContent,
      contentHash,
      audioUrl: cleanAudioUrl,
      audioClips: cleanAudioClips && cleanAudioClips.length > 0 ? cleanAudioClips : null,
      source,
      schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
      generatedBy: enrichedContent.generatedBy,
      createdAt: serverTimestamp(),
      createdBy: userUsername,
      useCount: 0,
      reportCount: 0,
    };

    await setDoc(docRef, record, { merge: false });
    return docId;
  } catch (err) {
    console.warn(`Failed to save question to Firestore bank (${collectionName}):`, err);
    return docId;
  }
}

export async function saveQuestionToSharedBank(
  taskTypeOrParams:
    | string
    | {
        taskType: string;
        level?: string;
        topic?: string;
        content?: any;
        data?: any;
        audioUrl?: string | null;
        audioClips?: Array<{ speaker: string; url: string }> | null;
        source?: string;
        generatedBy?: string;
        mode?: 'exam' | 'coach';
      },
  levelOrMode?: string,
  topic?: string,
  content?: any,
  mode?: 'exam' | 'coach'
): Promise<string | null> {
  if (typeof taskTypeOrParams === 'object' && taskTypeOrParams !== null) {
    const p = taskTypeOrParams;
    const effectiveMode = (levelOrMode as 'exam' | 'coach') || p.mode || 'exam';
    return saveQuestionToBank(
      {
        taskType: p.taskType,
        level: p.level || 'intermediate',
        topic: p.topic || 'campus-life',
        content: p.content || p.data,
        audioUrl: p.audioUrl,
        audioClips: p.audioClips,
        source: p.source,
        generatedBy: p.generatedBy,
        mode: effectiveMode,
      },
      effectiveMode
    );
  }
  return saveQuestionToBank(
    {
      taskType: taskTypeOrParams,
      level: levelOrMode || 'intermediate',
      topic: topic || 'campus-life',
      content,
      mode: mode || 'exam',
    },
    mode || 'exam'
  );
}

/**
 * Get the list of seen question IDs for the current user from userProgress/{uid}
 */
export async function getUserSeenQuestionIds(uid?: string): Promise<string[]> {
  const effectiveUid = uid || auth?.currentUser?.uid;
  const localSeen = getLocalSeenQuestionIds();
  if (!effectiveUid) return localSeen;

  try {
    const userDocRef = doc(db, 'userProgress', effectiveUid);
    const snap = await getDoc(userDocRef);
    if (snap.exists()) {
      const data = snap.data();
      const serverSeen: string[] = Array.isArray(data.seenQuestionIds)
        ? data.seenQuestionIds
        : [];
      return Array.from(new Set([...localSeen, ...serverSeen]));
    }
  } catch (err) {
    console.warn('Failed to fetch userProgress:', err);
  }
  return localSeen;
}

/**
 * Mark a question as seen in userProgress/{uid} and local storage
 */
export async function markQuestionAsSeen(questionId: string, uid?: string): Promise<void> {
  markLocalQuestionAsSeen(questionId);
  const effectiveUid = uid || auth?.currentUser?.uid;
  if (!effectiveUid) return;

  try {
    const userDocRef = doc(db, 'userProgress', effectiveUid);
    await setDoc(
      userDocRef,
      {
        seenQuestionIds: arrayUnion(questionId),
        lastUpdated: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn('Failed to mark question in userProgress:', err);
  }
}

export type MatchTier = 'exact' | 'topic-only' | 'level-only' | 'any';

export interface UnseenQuestionResult {
  question: any;
  tier: MatchTier;
}

export interface TierQueryConfig {
  tier: MatchTier;
  level?: string;
  topic?: string;
}

/**
 * Pure helper defining the 4-tier querying plan for a given level and topic request.
 * (level+topic) -> (topic only) -> (level only) -> any
 */
export function getQueryTiers(level: string = 'all', topic: string = 'all'): TierQueryConfig[] {
  const normalizedLvl = level && level !== 'all' ? normalizeDifficultyLabel(level) : undefined;
  const normalizedTop =
    topic && topic !== 'all' && topic !== 'general' ? normalizeTopicLabel(topic) : undefined;

  const isLevelConcrete = Boolean(normalizedLvl && isValidLevel(normalizedLvl));
  const isTopicConcrete = Boolean(normalizedTop && isValidAcademicTopic(normalizedTop));

  if (isLevelConcrete && isTopicConcrete) {
    return [
      { tier: 'exact', level: normalizedLvl, topic: normalizedTop },
      { tier: 'topic-only', topic: normalizedTop },
      { tier: 'level-only', level: normalizedLvl },
      { tier: 'any' },
    ];
  } else if (isLevelConcrete) {
    return [{ tier: 'exact', level: normalizedLvl }, { tier: 'any' }];
  } else if (isTopicConcrete) {
    return [{ tier: 'exact', topic: normalizedTop }, { tier: 'any' }];
  } else {
    return [{ tier: 'exact' }];
  }
}

/**
 * Pure function to select a question from an in-memory bank matching tier requirements.
 * Used for simulated tests and offline tier verification.
 */
export function selectQuestionFromBankTiers(
  bank: SharedQuestionRecord[],
  seenIds: string[],
  level: string = 'all',
  topic: string = 'all',
  taskType?: string
): UnseenQuestionResult | null {
  const tiers = getQueryTiers(level, topic);
  const canonicalTarget = taskType ? canonicalizeTaskType(taskType) : undefined;

  for (const tierConfig of tiers) {
    const matched = bank.filter((item) => {
      if (canonicalTarget && canonicalizeTaskType(item.taskType) !== canonicalTarget) {
        return false;
      }
      if ((item.reportCount || 0) >= 3) return false;
      const itemId = item.id || (item as any).questionDocId;
      if (itemId && seenIds.includes(itemId)) return false;

      if (tierConfig.level && !matchesLevelFilter(item, tierConfig.level)) return false;
      if (tierConfig.topic && !matchesTopicFilter(item, tierConfig.topic)) return false;

      return true;
    });

    if (matched.length > 0) {
      return {
        question: matched[0],
        tier: tierConfig.tier,
      };
    }
  }

  return null;
}

/**
 * Fetch an unseen question from Firestore questions or coach_questions bank using tier querying:
 * (level+topic) -> (topic only) -> (level only) -> any.
 * Skips items with reportCount >= 3 and already seen questions.
 * Applies lazy backfill if document has outdated/missing topic or level.
 */
export async function fetchUnseenQuestion(
  taskType: string,
  level: string = 'all',
  topic: string = 'all',
  mode: 'exam' | 'coach' = 'exam'
): Promise<UnseenQuestionResult | null> {
  const canonicalType = canonicalizeTaskType(taskType);
  const collectionName = getFirestoreCollectionName(mode);
  try {
    const currentUid = auth?.currentUser?.uid;
    const seenIds = await getUserSeenQuestionIds(currentUid);
    const tiers = getQueryTiers(level, topic);

    for (const tierConfig of tiers) {
      let q = query(collection(db, collectionName), where('taskType', '==', canonicalType));
      if (tierConfig.level) {
        q = query(q, where('level', '==', tierConfig.level));
      }
      if (tierConfig.topic) {
        q = query(q, where('topic', '==', tierConfig.topic));
      }
      q = query(q, limit(35));

      const snapshot = await getDocs(q);
      if (snapshot.empty) continue;

      const deletedSet = getDeletedQuestionIds();
      for (const docSnap of snapshot.docs) {
        if (deletedSet.has(docSnap.id)) continue;
        const data = docSnap.data();
        if (data.deleted === true) continue;

        // 0. Skip legacy pre-schemaVersion documents
        const docSchema = data.schemaVersion ?? data.content?.schemaVersion;
        if (docSchema !== CURRENT_BANK_SCHEMA_VERSION) {
          continue;
        }

        // 1. Skip reported questions (reportCount >= 3)
        if ((data.reportCount || 0) >= 3) {
          continue;
        }

        // 2. Skip already seen questions
        if (seenIds.includes(docSnap.id)) {
          continue;
        }

        // 3. Lazy backfill check: if topic or level not in allowed lists, repair doc
        const isTopicValid = isValidAcademicTopic(data.topic);
        const isLevelValid = isValidLevel(data.level);

        let activeTopic = data.topic;
        let activeLevel = data.level;

        if (!isTopicValid || !isLevelValid) {
          const updates: Record<string, any> = {};
          if (!isTopicValid) {
            activeTopic = normalizeTopicLabel(data.topic, data.content || data);
            updates.topic = activeTopic;
          }
          if (!isLevelValid) {
            activeLevel = normalizeDifficultyLabel(data.level || data.content?.level);
            updates.level = activeLevel;
          }
          updateDoc(doc(db, collectionName, docSnap.id), updates).catch((err) => {
            console.warn(`Lazy backfill update failed for ${docSnap.id}:`, err);
          });
        }

        const normalizedWrapper = normalizeQuestionBankItem(data.content || data, canonicalType);
        const normalizedDataContent = normalizedWrapper?.content || normalizedWrapper;
        if (!normalizedDataContent || !validateNormalizedTask(canonicalType, normalizedDataContent)) {
          continue;
        }

        // 4. Mark usage and update userProgress
        updateDoc(doc(db, collectionName, docSnap.id), {
          useCount: increment(1),
        }).catch(() => {});

        markQuestionAsSeen(docSnap.id, currentUid).catch(() => {});

        return {
          question: {
            ...normalizedDataContent,
            id: docSnap.id,
            questionDocId: docSnap.id,
            taskType: canonicalType,
            mode,
            level: activeLevel,
            difficulty: activeLevel,
            topic: activeTopic,
            reportCount: data.reportCount || 0,
            audioUrl: data.audioUrl || null,
            audioClips: data.audioClips || null,
            isSharedBank: true,
          },
          tier: tierConfig.tier,
        };
      }
    }
  } catch (err) {
    console.warn(`Error fetching unseen question from bank (${collectionName}):`, err);
  }

  return null;
}

/**
 * Fetch a random shared question passing filter options and attaching tier match information.
 */
export async function fetchRandomSharedQuestion(
  taskType: string,
  level: string = 'all',
  topic: string = 'all',
  mode: 'exam' | 'coach' = 'exam'
): Promise<any | null> {
  const result = await fetchUnseenQuestion(taskType, level, topic, mode);
  if (!result) return null;
  return {
    ...result.question,
    matchTier: result.tier,
    tier: result.tier,
  };
}

/**
 * Get count of unseen questions currently available in bank for taskType, level, topic, and mode.
 * Skips items with reportCount >= 3.
 */
export async function getUnseenQuestionCount(
  taskType: string,
  level: string = 'all',
  topic: string = 'all',
  mode: 'exam' | 'coach' = 'exam'
): Promise<number> {
  const canonicalType = canonicalizeTaskType(taskType);
  const collectionName = getFirestoreCollectionName(mode);
  try {
    const seenIds = await getUserSeenQuestionIds();
    let q = query(collection(db, collectionName), where('taskType', '==', canonicalType));
    if (level && level !== 'all' && isValidLevel(level)) {
      q = query(q, where('level', '==', level));
    }
    if (topic && topic !== 'all' && isValidAcademicTopic(topic)) {
      q = query(q, where('topic', '==', topic));
    }
    q = query(q, limit(40));
    const snap = await getDocs(q);
    let unseen = 0;
    snap.docs.forEach((d) => {
      const data = d.data();
      const docSchema = data.schemaVersion ?? data.content?.schemaVersion;
      if (
        docSchema === CURRENT_BANK_SCHEMA_VERSION &&
        (data.reportCount || 0) < 3 &&
        !seenIds.includes(d.id)
      ) {
        unseen++;
      }
    });
    return unseen;
  } catch {
    return 0;
  }
}

// Background prefetch locking to ensure at most one prefetch runs at a time
let isBackgroundPrefetching = false;

export function isPrefetchActive(): boolean {
  return isBackgroundPrefetching;
}

/**
 * Check bank count and trigger background batch generation if unseen count < 5.
 * Never sends 'all' or 'general' to generator or bank; selects concrete level and topic with fewest questions.
 */
export async function triggerBackgroundPrefetchIfNeeded(
  taskType: string,
  level: string = 'all',
  topic: string = 'all',
  generateBatchFn: (tType: string, lvl: string, top: string) => Promise<any[]>,
  mode: 'exam' | 'coach' = 'exam'
): Promise<void> {
  if (isBackgroundPrefetching) return;

  const canonicalType = canonicalizeTaskType(taskType);
  const count = await getUnseenQuestionCount(canonicalType, level, topic, mode);
  if (count >= 5) return;

  // Determine concrete level (never 'all')
  const concreteLevel: Level =
    level !== 'all' && isValidLevel(level) ? level : 'intermediate';

  // Determine concrete topic (never 'all' or 'general'): pick topic with fewest unseen questions
  let concreteTopic: AcademicTopic = 'campus-life';
  if (topic !== 'all' && isValidAcademicTopic(topic)) {
    concreteTopic = topic;
  } else {
    try {
      let minCount = Infinity;
      for (const candTopic of ACADEMIC_TOPICS) {
        const unseenForTopic = await getUnseenQuestionCount(
          canonicalType,
          concreteLevel,
          candTopic,
          mode
        );
        if (unseenForTopic < minCount) {
          minCount = unseenForTopic;
          concreteTopic = candTopic;
        }
      }
    } catch {
      concreteTopic = ACADEMIC_TOPICS[Math.floor(Math.random() * ACADEMIC_TOPICS.length)];
    }
  }

  isBackgroundPrefetching = true;
  window.dispatchEvent(
    new CustomEvent('toefl_prefetch_status', { detail: { isPrefetching: true } })
  );

  try {
    const items = await generateBatchFn(canonicalType, concreteLevel, concreteTopic);

    // Process items with max concurrency of 2
    const chunkLimit = 2;
    for (let i = 0; i < items.length; i += chunkLimit) {
      const chunk = items.slice(i, i + chunkLimit);
      await Promise.all(
        chunk.map(async (item) => {
          let audioUrl: string | null = null;
          let audioClips: Array<{ speaker: string; url: string }> | null = null;

          if (canonicalType === 'listening-dialogue' || canonicalType === 'listen-repeat') {
            try {
              const authHdrs = await getAuthHeaders();
              const headers = { ...getApiHeaders(), ...authHdrs };

              if (
                canonicalType === 'listening-dialogue' &&
                Array.isArray(item.turns) &&
                item.turns.length > 0
              ) {
                audioClips = [];
                const voiceManager = new DialogueVoiceManager();
                for (let tIdx = 0; tIdx < item.turns.length; tIdx++) {
                  const turn = item.turns[tIdx];
                  const rawText = turn.text || '';
                  const parsed = parseDialogueLine(rawText);
                  if (!parsed.spokenText) continue;

                  const speaker =
                    parsed.speakerName ||
                    turn.speaker ||
                    (tIdx % 2 === 0 ? 'Speaker A' : 'Speaker B');
                  const voiceName = voiceManager.getVoiceForSpeaker(
                    speaker,
                    parsed.speakerHint
                  );

                  try {
                    const ttsRes = await fetch('/api/tts', {
                      method: 'POST',
                      headers,
                      body: JSON.stringify({
                        text: parsed.spokenText,
                        voiceName,
                        speaker,
                      }),
                    });
                    const ttsJson = await ttsRes.json();
                    if (ttsJson.success && isValidBlobUrl(ttsJson.audioUrl)) {
                      audioClips.push({ speaker, url: ttsJson.audioUrl });
                    }
                  } catch {}
                }
                if (audioClips.length > 0) {
                  audioClips = audioClips.slice(0, 15);
                  audioUrl = audioClips[0].url;
                }
              } else if (
                canonicalType === 'listen-repeat' &&
                Array.isArray(item.sentences) &&
                item.sentences.length > 0
              ) {
                audioClips = [];
                for (const sentence of item.sentences) {
                  const cleanSentence = stripSpeakerAndFormatting(sentence || '');
                  if (!cleanSentence) continue;
                  try {
                    const ttsRes = await fetch('/api/tts', {
                      method: 'POST',
                      headers,
                      body: JSON.stringify({
                        text: cleanSentence,
                        voiceName: 'en-US-JennyNeural',
                        speaker: 'Narrator',
                      }),
                    });
                    const ttsJson = await ttsRes.json();
                    if (ttsJson.success && isValidBlobUrl(ttsJson.audioUrl)) {
                      audioClips.push({ speaker: 'Narrator', url: ttsJson.audioUrl });
                    }
                  } catch {}
                }
                if (audioClips.length > 0) {
                  audioClips = audioClips.slice(0, 15);
                  audioUrl = audioClips[0].url;
                }
              } else {
                const textToSpeak = stripSpeakerAndFormatting(
                  item.script ||
                    (Array.isArray(item.sentences) ? item.sentences.join(' ') : '')
                );
                if (textToSpeak) {
                  const ttsRes = await fetch('/api/tts', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                      text: textToSpeak,
                      voiceName:
                        item.speakerGender === 'female'
                          ? 'en-US-JennyNeural'
                          : 'en-US-GuyNeural',
                      speaker: item.speakerName || 'Narrator',
                    }),
                  });
                  const ttsJson = await ttsRes.json();
                  if (ttsJson.success && isValidBlobUrl(ttsJson.audioUrl)) {
                    audioUrl = ttsJson.audioUrl;
                  }
                }
              }
            } catch (audioErr) {
              console.warn('Background audio pre-synthesis skipped:', audioErr);
            }
          }

          await saveQuestionToBank({
            taskType: canonicalType,
            level: concreteLevel,
            topic: concreteTopic,
            content: item,
            audioUrl,
            audioClips,
            mode,
          });
        })
      );
    }
  } catch (err) {
    console.warn('Background question prefetch failed:', err);
  } finally {
    isBackgroundPrefetching = false;
    window.dispatchEvent(
      new CustomEvent('toefl_prefetch_status', { detail: { isPrefetching: false } })
    );
  }
}

/**
 * Report a shared question using writeBatch:
 * - sets questionReports/{questionDocId}__{uid}
 * - increments reportCount on questions/{questionDocId}
 */
export async function reportSharedQuestion(
  questionDocId: string,
  userId?: string,
  reason: string = 'User flagged question'
): Promise<boolean> {
  const currentUid = userId || auth?.currentUser?.uid;
  if (!currentUid) {
    throw new Error('You must be signed in to report a question.');
  }
  if (!questionDocId) {
    throw new Error('Question ID is missing.');
  }

  const batch = writeBatch(db);
  const reportDocId = `${questionDocId}__${currentUid}`;
  const reportRef = doc(db, 'questionReports', reportDocId);

  batch.set(reportRef, {
    questionId: questionDocId,
    uid: currentUid,
    reason: reason || 'User flagged question',
    createdAt: serverTimestamp(),
  });

  const questionRef = doc(db, 'questions', questionDocId);
  batch.update(questionRef, {
    reportCount: increment(1),
  });

  await batch.commit();
  return true;
}

export interface RepairBankReport {
  scanned: number;
  repaired: number;
  duplicatesRemoved: number;
  corruptedPurged: number;
  totalClean: number;
  totalProcessed: number;
  totalFixed: number;
}

function isCorruptedQuestionRecord(taskType: string, content: any): boolean {
  if (!content || typeof content !== 'object') return true;
  if (content.deleted === true || (content.reportCount || 0) >= 3) return true;

  const tType = canonicalizeTaskType(taskType);

  if (tType === 'complete-words') {
    const blanks = content.blanks;
    if (!Array.isArray(blanks) || blanks.length < 8) return true;
    for (const b of blanks) {
      const ans = String(b?.answer || '').trim();
      const pref = String(b?.prefix || '').trim();
      if (!ans || !/^[a-zA-Z]+(?:-[a-zA-Z]+)?$/.test(ans)) return true;
      if (!pref || !/^[a-zA-Z]+(?:-[a-zA-Z]+)?$/.test(pref)) return true;
    }
    const text = String(content.text || '').trim();
    if (text.length < 30) return true;
    return false;
  }

  if (tType === 'listening-choose-response') {
    const items =
      Array.isArray(content.items) && content.items.length > 0
        ? content.items
        : Array.isArray(content.options)
        ? [content]
        : [];
    if (items.length === 0) return true;
    for (const it of items) {
      if (!Array.isArray(it?.options) || it.options.length < 4) return true;
    }
    return false;
  }

  if (
    tType === 'reading-academic' ||
    tType === 'daily-life' ||
    tType === 'listening-dialogue' ||
    tType === 'listening-announcement' ||
    tType === 'listening-academic-talk'
  ) {
    const questions = content.questions;
    if (!Array.isArray(questions) || questions.length === 0) return true;
    for (const q of questions) {
      if (!Array.isArray(q?.options) || q.options.length < 4) return true;
    }
    return false;
  }

  if (tType === 'build-sentence') {
    const items =
      Array.isArray(content.sentences) && content.sentences.length > 0
        ? content.sentences
        : Array.isArray(content.items) && content.items.length > 0
        ? content.items
        : [content];
    if (items.length === 0) return true;
    for (const it of items) {
      const hasChunks =
        (Array.isArray(it?.targetChunks) && it.targetChunks.length > 0) ||
        (Array.isArray(it?.words) && it.words.length > 0) ||
        (Array.isArray(it?.chunks) && it.chunks.length > 0);
      if (!hasChunks) return true;
    }
    return false;
  }

  if (!validateNormalizedTask(tType, content)) return true;
  return false;
}

/**
 * Smart, Protective & Detailed Question Bank Audit & Repair:
 * 1. Preserves Developer Edits (isManualDevEdit / isEdited) and Deletions (deletedQuestionIds).
 * 2. Detects and purges broken AI-generated questions (complete-words < 8 blanks or non-alphabetic answers,
 *    reading/listening with 0 questions or < 4 options, build-sentence with empty targetChunks/words).
 * 3. Normalizes (including 1 Head Sentence + Blanks + 1 Tail Sentence on complete-words) and deduplicates.
 * 4. Uses fast Firestore writeBatch(db) and single IndexedDB transactions.
 * 5. Returns detailed report: { scanned, repaired, duplicatesRemoved, corruptedPurged, totalClean }.
 */
export async function repairAndAuditQuestionBank(
  targetMode: 'exam' | 'coach' | 'both' = 'both',
  onProgress?: (processed: number, fixed: number, status?: string) => void
): Promise<RepairBankReport> {
  const deletedSet = await syncDeletedQuestionsFromFirestore();
  const editedMap = getEditedQuestionsMap();
  const modes: Array<'exam' | 'coach'> =
    targetMode === 'both' ? ['exam', 'coach'] : [targetMode];

  let scanned = 0;
  let repaired = 0;
  let duplicatesRemoved = 0;
  let corruptedPurged = 0;
  let totalClean = 0;

  for (const mode of modes) {
    const storeName = getIdbStoreName(mode);
    const collectionName = getFirestoreCollectionName(mode);
    const targetMemCache = getMemoryCacheForMode(mode);

    // Gather all records from IndexedDB, Firestore, and memory for this mode
    const rawRecordsMap = new Map<
      string,
      {
        docId: string;
        raw: any;
        fromFirestore: boolean;
        fromIdb: boolean;
      }
    >();

    // 1. Read IndexedDB
    let dbInstance: IDBDatabase | null = null;
    try {
      dbInstance = await openIndexedDB();
      const idbRows: any[] = await new Promise((resolve) => {
        const tx = dbInstance!.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => resolve([]);
      });
      for (const row of idbRows) {
        const docId = String(row.id || row.content?.id || '');
        if (docId) {
          rawRecordsMap.set(docId, {
            docId,
            raw: row,
            fromFirestore: false,
            fromIdb: true,
          });
        }
      }
    } catch {}

    // 2. Read Firestore
    try {
      await ensureAuthenticated();
      if (db) {
        const snap = await getDocs(collection(db, collectionName));
        snap.forEach((docSnap) => {
          const docId = docSnap.id;
          const fsData = docSnap.data();
          const existing = rawRecordsMap.get(docId);
          const isFsEdited = Boolean(
            fsData?.isManualDevEdit ||
              fsData?.isEdited ||
              fsData?.content?.isManualDevEdit ||
              fsData?.content?.isEdited
          );
          if (!existing) {
            rawRecordsMap.set(docId, {
              docId,
              raw: fsData,
              fromFirestore: true,
              fromIdb: false,
            });
          } else {
            existing.fromFirestore = true;
            if (isFsEdited && !existing.raw?.isManualDevEdit && !existing.raw?.isEdited) {
              existing.raw = fsData;
            }
          }
        });
      }
    } catch {}

    // 3. Also ensure in-memory items are included if not already in map
    for (const tId of CANONICAL_TASK_IDS) {
      const memList = targetMemCache[tId] || [];
      for (const item of memList) {
        const docId = String(item.questionDocId || item.id || '');
        if (docId && !rawRecordsMap.has(docId)) {
          rawRecordsMap.set(docId, {
            docId,
            raw: {
              id: docId,
              taskType: tId,
              level: item.level,
              topic: item.topic,
              content: item,
              mode,
              schemaVersion: item.schemaVersion ?? CURRENT_BANK_SCHEMA_VERSION,
              isEdited: item.isEdited,
              isManualDevEdit: item.isManualDevEdit,
            },
            fromFirestore: false,
            fromIdb: false,
          });
        }
      }
    }

    const seenSigs = new Set<string>();
    const seenIds = new Set<string>();
    const seenTitles = new Set<string>();
    const cleanIdbRows: any[] = [];
    const cleanMemByTask: Record<string, any[]> = {};
    for (const tId of CANONICAL_TASK_IDS) {
      cleanMemByTask[tId] = [];
    }

    const firestoreBatchOps: Array<{
      op: 'set' | 'delete';
      docId: string;
      payload?: any;
    }> = [];

    for (const { docId, raw, fromFirestore } of rawRecordsMap.values()) {
      scanned++;
      const rawContent = raw.content || raw;
      const innerId = String(rawContent?.id || docId || '');
      const tType = canonicalizeTaskType(
        raw.taskType || rawContent?.taskType || raw.type || 'academic-discussion'
      );

      // Step 1: Purge any deleted or heavily reported question
      const preSig = getQuestionContentSignature(tType, rawContent);
      if (
        deletedSet.has(docId) ||
        (innerId && deletedSet.has(innerId)) ||
        deletedSet.has(preSig) ||
        raw.deleted === true ||
        rawContent?.deleted === true ||
        (raw.reportCount || 0) >= 3 ||
        (rawContent?.reportCount || 0) >= 3
      ) {
        corruptedPurged++;
        if (fromFirestore) {
          firestoreBatchOps.push({ op: 'delete', docId });
        }
        continue;
      }

      // Step 1b: Strictly preserve Developer Edits (never overwrite!)
      const isDevEdited = Boolean(
        editedMap[docId] ||
          (innerId && editedMap[innerId]) ||
          raw.isManualDevEdit ||
          raw.isEdited ||
          rawContent?.isManualDevEdit ||
          rawContent?.isEdited
      );

      if (isDevEdited) {
        const override = editedMap[docId] || (innerId ? editedMap[innerId] : null);
        const preservedContent = {
          ...rawContent,
          ...(override || {}),
          id: innerId || docId,
          questionDocId: docId,
          taskType: tType,
          mode,
          level: normalizeDifficultyLabel(
            override?.level || rawContent?.level || raw.level || 'intermediate'
          ),
          topic: normalizeTopicLabel(
            override?.topic || rawContent?.topic || raw.topic || 'science-tech',
            rawContent
          ),
          schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
          isEdited: true,
          isManualDevEdit: true,
        };
        const devSig = getQuestionContentSignature(tType, preservedContent);
        seenSigs.add(devSig);
        seenIds.add(docId);
        if (innerId) seenIds.add(innerId);
        if (cleanMemByTask[tType]) {
          cleanMemByTask[tType].push(preservedContent);
        }
        cleanIdbRows.push({
          id: docId,
          taskType: tType,
          level: preservedContent.level,
          topic: preservedContent.topic,
          content: preservedContent,
          isCurated: Boolean(raw.isCurated),
          isEdited: true,
          isManualDevEdit: true,
          mode,
          schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
          updatedAt: raw.updatedAt || Date.now(),
        });
        totalClean++;
        continue;
      }

      // Step 2 & 3: Normalize non-edited question and check for corruption
      const normalizedWrapper = normalizeQuestionBankItem(rawContent, tType);
      const normalizedContent = normalizedWrapper?.content || normalizedWrapper;

      if (
        !normalizedContent ||
        !cleanMemByTask[tType] ||
        isCorruptedQuestionRecord(tType, normalizedContent) ||
        !isHighQualityTask(normalizedContent, tType)
      ) {
        corruptedPurged++;
        if (fromFirestore) {
          firestoreBatchOps.push({ op: 'delete', docId });
        }
        continue;
      }

      const validLevel = normalizeDifficultyLabel(
        raw.level || rawContent?.level || normalizedContent.level
      );
      const validTopic = normalizeTopicLabel(
        raw.topic || rawContent?.topic || normalizedContent.topic,
        normalizedContent
      );

      const finalContent = {
        ...normalizedContent,
        id: innerId || docId,
        questionDocId: docId,
        taskType: tType,
        mode,
        level: validLevel,
        difficulty: validLevel,
        topic: validTopic,
        schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
      };

      const sig = getQuestionContentSignature(tType, finalContent);
      if (deletedSet.has(sig)) {
        corruptedPurged++;
        if (fromFirestore) {
          firestoreBatchOps.push({ op: 'delete', docId });
        }
        continue;
      }

      const rawTitle = String(
        finalContent.title ||
          finalContent.passage?.slice(0, 80) ||
          finalContent.text?.slice(0, 80) ||
          finalContent.script?.slice(0, 80) ||
          ''
      )
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
      const titleKey = rawTitle.length >= 12 ? `${tType}::title::${rawTitle}` : '';

      // Step 3b: Deduplicate by signature, ID, or normalized title
      if (
        seenSigs.has(sig) ||
        seenIds.has(docId) ||
        (innerId && seenIds.has(innerId)) ||
        (titleKey && seenTitles.has(titleKey))
      ) {
        duplicatesRemoved++;
        if (fromFirestore) {
          firestoreBatchOps.push({ op: 'delete', docId });
        }
        continue;
      }

      seenSigs.add(sig);
      seenIds.add(docId);
      if (innerId) seenIds.add(innerId);
      if (titleKey) seenTitles.add(titleKey);

      // Check if normalization repaired topic, level, schemaVersion, or complete-words text/blanks
      const wasTopicInvalid = !isValidAcademicTopic(raw.topic) || raw.topic !== validTopic;
      const wasLevelInvalid = !isValidLevel(raw.level) || raw.level !== validLevel;
      const wasSchemaOutdated =
        (raw.schemaVersion ?? rawContent?.schemaVersion) !== CURRENT_BANK_SCHEMA_VERSION;
      const wasCompleteWordsRepaired =
        tType === 'complete-words' &&
        (rawContent?.text !== finalContent.text ||
          JSON.stringify(rawContent?.blanks) !== JSON.stringify(finalContent.blanks));

      if (
        wasTopicInvalid ||
        wasLevelInvalid ||
        wasSchemaOutdated ||
        wasCompleteWordsRepaired
      ) {
        repaired++;
        if (fromFirestore) {
          firestoreBatchOps.push({
            op: 'set',
            docId,
            payload: {
              taskType: tType,
              level: validLevel,
              topic: validTopic,
              content: finalContent,
              schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
            },
          });
        }
      }

      cleanMemByTask[tType].push(finalContent);
      cleanIdbRows.push({
        id: docId,
        taskType: tType,
        level: validLevel,
        topic: validTopic,
        content: finalContent,
        isCurated: Boolean(raw.isCurated),
        mode,
        schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
        updatedAt: Date.now(),
      });
      totalClean++;

      if (onProgress && scanned % 25 === 0) {
        onProgress(
          scanned,
          repaired + duplicatesRemoved + corruptedPurged,
          `Auditing ${mode.toUpperCase()} bank (${scanned} scanned)...`
        );
      }
    }

    // Step 4a: Update in-memory cache atomically
    for (const tId of CANONICAL_TASK_IDS) {
      targetMemCache[tId] = cleanMemByTask[tId] || [];
    }

    // Step 4b: Commit clean rows to IndexedDB in a single readwrite transaction
    if (dbInstance) {
      try {
        await new Promise<void>((resolve) => {
          const tx = dbInstance!.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          store.clear();
          for (const row of cleanIdbRows) {
            store.put(row);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        });
      } catch (idbErr) {
        console.warn(`Failed to commit repaired IndexedDB (${storeName}):`, idbErr);
      }
    }

    // Step 4c: Commit all Firestore repairs & deletions using fast writeBatch(db)
    if (db && firestoreBatchOps.length > 0) {
      try {
        await ensureAuthenticated();
        const BATCH_LIMIT = 400;
        for (let i = 0; i < firestoreBatchOps.length; i += BATCH_LIMIT) {
          const slice = firestoreBatchOps.slice(i, i + BATCH_LIMIT);
          const batch = writeBatch(db);
          for (const item of slice) {
            const ref = doc(db, collectionName, item.docId);
            if (item.op === 'delete') {
              batch.delete(ref);
            } else if (item.payload) {
              batch.set(ref, item.payload, { merge: true });
            }
          }
          await batch.commit();
        }
      } catch (fsErr) {
        console.warn(`Firestore batch repair notice (${collectionName}):`, fsErr);
      }
    }
  }

  const totalFixed = repaired + duplicatesRemoved + corruptedPurged;
  if (onProgress) {
    onProgress(scanned, totalFixed, 'Audit & repair complete!');
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toefl_bank_updated'));
  }

  return {
    scanned,
    repaired,
    duplicatesRemoved,
    corruptedPurged,
    totalClean,
    totalProcessed: scanned,
    totalFixed,
  };
}

/**
 * Repair Question Bank (delegates to smart, protective repairAndAuditQuestionBank).
 */
export async function repairQuestionBank(
  onProgress?: (processed: number, fixed: number, status?: string) => void
): Promise<RepairBankReport> {
  return repairAndAuditQuestionBank('both', onProgress);
}

export async function getQuestionCountsPerSection(
  mode: 'exam' | 'coach' = 'exam'
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {
    Reading: 0,
    Listening: 0,
    Speaking: 0,
    Writing: 0,
  };

  try {
    const stats = await getQuestionBankStats(mode);
    for (const [taskType, count] of Object.entries(stats.countsPerTaskType)) {
      const section = getSectionForTaskType(taskType);
      if (section && counts[section] !== undefined) {
        counts[section] += count;
      }
    }
  } catch {
    // Return zeroes if offline or unseeded
  }

  return counts;
}

export async function getQuestionCountsPerTaskType(
  mode: 'exam' | 'coach' = 'exam'
): Promise<Record<string, number>> {
  try {
    const stats = await getQuestionBankStats(mode);
    return stats.countsPerTaskType;
  } catch {
    return {};
  }
}

export async function seedDefaultQuestionsToFirestore(): Promise<{
  created: number;
  skipped: number;
  failed: number;
}> {
  const report = { created: 0, skipped: 0, failed: 0 };
  await ensureAuthenticated();

  try {
    const {
      CURATED_READING_PASSAGES,
      CURATED_LISTENING,
      CURATED_LISTEN_REPEAT,
      CURATED_SPEAKING_INTERVIEWS,
      CURATED_BUILD_SENTENCES,
      CURATED_COMPLETE_WORDS,
      CURATED_WRITE_EMAILS,
      CURATED_ACADEMIC_DISCUSSIONS,
    } = await import('../data/curatedQuestions');

    const seedList: Array<{ taskType: string; data: any }> = [];
    CURATED_READING_PASSAGES?.forEach((p) =>
      seedList.push({ taskType: 'reading-passage', data: p })
    );
    CURATED_LISTENING?.forEach((l) =>
      seedList.push({ taskType: 'listening-dialogue', data: l })
    );
    CURATED_LISTEN_REPEAT?.forEach((l) =>
      seedList.push({ taskType: 'listen-repeat', data: l })
    );
    CURATED_SPEAKING_INTERVIEWS?.forEach((s) =>
      seedList.push({ taskType: 'speaking-interview', data: s })
    );
    CURATED_BUILD_SENTENCES?.forEach((b) =>
      seedList.push({ taskType: 'build-sentence', data: b })
    );
    CURATED_COMPLETE_WORDS?.forEach((c) =>
      seedList.push({ taskType: 'complete-words', data: c })
    );
    CURATED_WRITE_EMAILS?.forEach((w) =>
      seedList.push({ taskType: 'write-email', data: w })
    );
    CURATED_ACADEMIC_DISCUSSIONS?.forEach((a) =>
      seedList.push({ taskType: 'academic-discussion', data: a })
    );

    for (const item of seedList) {
      try {
        const itemLevel = normalizeDifficultyLabel(item.data.level);
        const itemTopic = normalizeTopicLabel(item.data.topic, item.data);

        const id = await saveQuestionToBank({
          taskType: item.taskType,
          level: itemLevel,
          topic: itemTopic,
          content: item.data,
        });
        if (id) report.created++;
        else report.skipped++;
      } catch {
        report.failed++;
      }
    }
  } catch (err) {
    console.info('Auto-seeding skipped or failed:', err);
  }

  return report;
}

export function generateQuestionDocId(taskType: string, taskData: any): Promise<string> {
  return computeContentHash(taskType, taskData).then((h) => `q_${h.slice(0, 24)}`);
}

export function saveSharedQuestion(params: any): Promise<string> {
  const itemLevel = normalizeDifficultyLabel(params.level || params.data?.level);
  const itemTopic = normalizeTopicLabel(
    params.topic || params.data?.topic,
    params.data
  );

  return saveQuestionToBank({
    taskType: params.taskType,
    level: itemLevel,
    topic: itemTopic,
    content: params.data,
    audioUrl: params.audioUrl,
  }).then((id) => id || `local_${Date.now()}`);
}

// ============================================================================
// Developer Admin Mode, Question Editing/Deletion, & User Presence Directory
// ============================================================================

export const DEV_UNLOCKED_KEY = 'toefl_dev_unlocked';
export const DEV_PIN_KEY = 'toefl_dev_pin';

export function isDevAdminUnlocked(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(DEV_UNLOCKED_KEY) === 'true';
}

export function isEligibleDevUsername(username?: string | null, email?: string | null): boolean {
  if (isDevAdminUnlocked()) return true;
  const cleanName = String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
  if (cleanName === 'obi' || cleanName === 'obihang') return true;
  const storedScholar = String(getScholarUsername() || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
  if (storedScholar === 'obi' || storedScholar === 'obihang') return true;
  const storedDisplay =
    typeof localStorage !== 'undefined'
      ? String(localStorage.getItem('toefl_display_name') || '')
          .trim()
          .replace(/^@+/, '')
          .toLowerCase()
      : '';
  if (storedDisplay === 'obi' || storedDisplay === 'obihang') return true;
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (cleanEmail === 'obiehang@gmail.com' || cleanEmail.startsWith('obihang@') || cleanEmail.startsWith('obi@')) {
    return true;
  }
  return false;
}

export function getDevAdminPin(): string {
  if (typeof localStorage === 'undefined') return 'obi2026';
  return localStorage.getItem(DEV_PIN_KEY) || 'obi2026';
}

export function setDevAdminPin(newPin: string): void {
  if (typeof localStorage === 'undefined') return;
  const trimmed = newPin.trim();
  if (trimmed) {
    localStorage.setItem(DEV_PIN_KEY, trimmed);
  }
}

export function unlockDevAdmin(pinInput: string, userEmail?: string | null): boolean {
  const expectedPin = getDevAdminPin();
  const cleanPin = String(pinInput || '').trim();
  const cleanEmail = String(userEmail || '').trim().toLowerCase();
  if (
    cleanPin === expectedPin ||
    cleanPin === 'obi2026' ||
    cleanEmail === 'obiehang@gmail.com'
  ) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DEV_UNLOCKED_KEY, 'true');
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('toefl_dev_admin_changed', { detail: { unlocked: true } }));
    }
    return true;
  }
  return false;
}

export function lockDevAdmin(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(DEV_UNLOCKED_KEY);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toefl_dev_admin_changed', { detail: { unlocked: false } }));
  }
}

/**
 * Permanently deletes a question from in-memory cache, local IndexedDB, and Firestore,
 * and adds its ID & content signature to the persistent deleted blocklist so even static
 * shard questions never reappear after reload or resync.
 */
export async function deleteQuestionFromBank(
  questionId: string,
  mode: 'exam' | 'coach' = 'exam',
  taskObj?: any
): Promise<boolean> {
  const cleanId = String(questionId || taskObj?.questionDocId || taskObj?.id || '').trim();
  if (!cleanId && !taskObj) return false;

  const targetMemCache = getMemoryCacheForMode(mode);
  let foundItem: any = taskObj || null;
  let foundTaskType: string = taskObj?.taskType || '';

  for (const tId of CANONICAL_TASK_IDS) {
    const list = targetMemCache[tId] || [];
    const match = list.find(
      (item) =>
        String(item.id || '') === cleanId ||
        String(item.questionDocId || '') === cleanId ||
        (taskObj?.title && item.title === taskObj.title)
    );
    if (match && !foundItem) {
      foundItem = match;
      foundTaskType = tId;
    }
  }

  const sig =
    foundItem && (foundTaskType || foundItem.taskType)
      ? getQuestionContentSignature(foundTaskType || foundItem.taskType, foundItem)
      : undefined;

  addDeletedQuestionIdLocal(cleanId, sig);
  if (foundItem?.id) addDeletedQuestionIdLocal(String(foundItem.id), sig);
  if (foundItem?.questionDocId) addDeletedQuestionIdLocal(String(foundItem.questionDocId), sig);

  // Remove from both memory caches
  for (const cache of [curatedMemoryCache, coachMemoryCache]) {
    for (const tId of Object.keys(cache)) {
      cache[tId] = (cache[tId] || []).filter((item) => {
        const iId = String(item.id || '');
        const docId = String(item.questionDocId || '');
        const itemSig = getQuestionContentSignature(tId, item);
        if (cleanId && (iId === cleanId || docId === cleanId)) return false;
        if (sig && itemSig === sig) return false;
        return true;
      });
    }
  }

  // Remove from IndexedDB
  const storeName = getIdbStoreName(mode);
  try {
    const dbInstance = await openIndexedDB();
    const allRows: any[] = await new Promise((resolve) => {
      const tx = dbInstance.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });

    const idsToRemove = new Set<string>();
    if (cleanId) idsToRemove.add(cleanId);
    for (const row of allRows) {
      const rId = String(row.id || '');
      const cId = String(row.content?.id || row.content?.questionDocId || '');
      const rSig = getQuestionContentSignature(row.taskType || foundTaskType || 'academic-discussion', row.content || row);
      if (rId === cleanId || cId === cleanId || (sig && rSig === sig)) {
        if (rId) idsToRemove.add(rId);
      }
    }

    if (idsToRemove.size > 0) {
      await new Promise<void>((resolve) => {
        const tx = dbInstance.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        idsToRemove.forEach((id) => store.delete(id));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    }
  } catch (err) {
    console.warn('Failed to delete question from IndexedDB:', err);
  }

  // Record in Firestore deleted_questions and delete/tombstone in collection
  const collectionName = getFirestoreCollectionName(mode);
  try {
    await ensureAuthenticated();
    if (db && cleanId) {
      const safeDocId = cleanId.replace(/[\/\\#?]/g, '_');
      await setDoc(
        doc(db, 'deleted_questions', safeDocId),
        {
          id: cleanId,
          mode,
          sig: sig || null,
          deletedAt: Date.now(),
          deletedBy: getScholarUsername() || 'Obi',
        },
        { merge: true }
      ).catch(() => {});

      await deleteDoc(doc(db, collectionName, cleanId)).catch(async () => {
        await setDoc(
          doc(db, collectionName, cleanId),
          { deleted: true, reportCount: 999 },
          { merge: true }
        ).catch(() => {});
      });
    }
  } catch (err) {
    console.warn('Firestore question deletion notice:', err);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('toefl_bank_updated', {
        detail: { mode, action: 'delete', questionId: cleanId },
      })
    );
  }

  return true;
}

/**
 * Updates a question's title, difficulty/level, topic, passage/script, or questions/answer key
 * across in-memory cache, localStorage override map, IndexedDB, and Firestore.
 */
export async function updateQuestionInBank(
  questionId: string,
  updatedItem: Partial<any>,
  mode: 'exam' | 'coach' = 'exam'
): Promise<any> {
  const cleanId = String(questionId || updatedItem?.id || updatedItem?.questionDocId || '').trim();
  const targetMemCache = getMemoryCacheForMode(mode);

  let existingItem: any = null;
  let foundType: string = canonicalizeTaskType(updatedItem?.taskType || 'academic-discussion');

  for (const tId of CANONICAL_TASK_IDS) {
    const list = targetMemCache[tId] || [];
    const idx = list.findIndex(
      (item) => String(item.id || '') === cleanId || String(item.questionDocId || '') === cleanId
    );
    if (idx !== -1) {
      existingItem = list[idx];
      foundType = tId;
      break;
    }
  }

  const canonicalType = canonicalizeTaskType(updatedItem.taskType || foundType);
  const preferBlanks =
    canonicalType === 'complete-words' &&
    updatedItem.text === existingItem?.text &&
    Array.isArray(updatedItem.blanks) &&
    JSON.stringify(updatedItem.blanks) !== JSON.stringify(existingItem?.blanks);

  const rawMerged = {
    ...(existingItem || {}),
    ...updatedItem,
    id: cleanId || existingItem?.id || `edited_${Date.now()}`,
    taskType: canonicalType,
    mode,
    isEdited: true,
    isManualDevEdit: true,
    updatedAt: Date.now(),
    editedBy: getScholarUsername() || 'Obi',
    _preferBlanks: preferBlanks,
  };

  const validLevel: Level = normalizeDifficultyLabel(
    rawMerged.level || rawMerged.difficulty || existingItem?.level || 'intermediate'
  );
  const validTopic: AcademicTopic = normalizeTopicLabel(
    rawMerged.topic || rawMerged.category || existingItem?.topic || 'science-tech',
    rawMerged
  );

  const normalizedWrapper = normalizeQuestionBankItem(rawMerged, canonicalType);
  const normalizedBase = normalizedWrapper?.content || normalizedWrapper || rawMerged;

  const finalContent = {
    ...updatedItem,
    ...normalizedBase,
    id: rawMerged.id,
    questionDocId: rawMerged.questionDocId || rawMerged.id,
    taskType: canonicalType,
    mode,
    level: validLevel,
    difficulty: validLevel,
    topic: validTopic,
    schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
    isEdited: true,
    isManualDevEdit: true,
    updatedAt: Date.now(),
    editedBy: getScholarUsername() || 'Obi',
  };
  delete (finalContent as any)._preferBlanks;

  // Save in localStorage override map so static shard items retain edits across reloads
  saveEditedQuestionLocal(finalContent.id, finalContent);
  if (cleanId && cleanId !== finalContent.id) {
    saveEditedQuestionLocal(cleanId, finalContent);
  }

  // Update in-memory cache
  if (!targetMemCache[canonicalType]) {
    targetMemCache[canonicalType] = [];
  }
  const list = targetMemCache[canonicalType];
  const existingIdx = list.findIndex(
    (item) =>
      String(item.id || '') === String(finalContent.id) ||
      String(item.questionDocId || '') === cleanId
  );
  if (existingIdx !== -1) {
    list[existingIdx] = finalContent;
  } else {
    list.unshift(finalContent);
  }

  // Save to IndexedDB
  const storeName = getIdbStoreName(mode);
  const contentHash = await computeContentHash(canonicalType, finalContent);
  try {
    const dbInstance = await openIndexedDB();
    await new Promise<void>((resolve) => {
      const tx = dbInstance.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put({
        id: finalContent.id,
        taskType: canonicalType,
        level: validLevel,
        topic: validTopic,
        content: finalContent,
        contentHash,
        mode,
        isEdited: true,
        isManualDevEdit: true,
        editedBy: finalContent.editedBy,
        schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch (err) {
    console.warn('Failed to update question in IndexedDB:', err);
  }

  // Save to Firestore
  const collectionName = getFirestoreCollectionName(mode);
  try {
    await ensureAuthenticated();
    if (db) {
      const docId = String(finalContent.questionDocId || finalContent.id);
      await setDoc(
        doc(db, collectionName, docId),
        {
          id: docId,
          taskType: canonicalType,
          level: validLevel,
          topic: validTopic,
          content: finalContent,
          contentHash,
          isEdited: true,
          isManualDevEdit: true,
          editedBy: finalContent.editedBy,
          schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
          updatedAt: serverTimestamp(),
          createdBy: finalContent.createdBy || auth?.currentUser?.uid || 'Obi',
          useCount: finalContent.useCount || 0,
        },
        { merge: true }
      );
    }
  } catch (err) {
    console.warn('Failed to update question in Firestore:', err);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('toefl_bank_updated', {
        detail: { mode, action: 'update', questionId: finalContent.id, updatedItem: finalContent },
      })
    );
  }

  return finalContent;
}

export interface AppUserRecord {
  id: string;
  username: string;
  firstSeenAt: number;
  lastActiveAt: number;
  questionsPracticed: number;
  questionsGenerated: number;
  myBestBand: number;
}

const APP_USERS_LOCAL_CACHE_KEY = 'toefl_app_users_local_map_v1';
const AI_GENERATED_COUNT_KEY = 'toefl_ai_generated_count';

export function getPersistentClientId(): string {
  if (typeof localStorage === 'undefined') return 'server_client';
  try {
    if (auth?.currentUser?.uid) {
      localStorage.setItem('toefl_client_id', auth.currentUser.uid);
      return auth.currentUser.uid;
    }
  } catch {}
  let cid = localStorage.getItem('toefl_client_id') || localStorage.getItem('local_device_id');
  if (!cid) {
    cid = 'user_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
    localStorage.setItem('toefl_client_id', cid);
  }
  return cid;
}

export function incrementAiGeneratedCount(delta: number = 1): number {
  if (typeof localStorage === 'undefined') return 0;
  try {
    const current = parseInt(localStorage.getItem(AI_GENERATED_COUNT_KEY) || '0', 10) || 0;
    const next = current + delta;
    localStorage.setItem(AI_GENERATED_COUNT_KEY, String(next));
    syncUserActivityToFirestore().catch(() => {});
    return next;
  } catch {
    return 0;
  }
}

export async function syncUserActivityToFirestore(
  overrides?: Partial<AppUserRecord>
): Promise<AppUserRecord | null> {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;

  try {
    const clientId = getPersistentClientId();
    const rawUsername =
      overrides?.username ||
      localStorage.getItem('toefl_display_name') ||
      localStorage.getItem('toefl_username') ||
      getScholarUsername() ||
      `Guest_${clientId.slice(0, 5)}`;
    const cleanUsername = String(rawUsername).trim().replace(/^@+/, '') || `Guest_${clientId.slice(0, 5)}`;

    let firstSeenAt = parseInt(localStorage.getItem('toefl_first_seen_at') || '0', 10);
    if (!firstSeenAt || isNaN(firstSeenAt)) {
      firstSeenAt = Date.now();
      localStorage.setItem('toefl_first_seen_at', String(firstSeenAt));
    }

    const history = getPracticeHistory();
    const completedIds = getCompletedQuestionIds();
    const questionsPracticed =
      overrides?.questionsPracticed ?? Math.max(history.length, completedIds.length);
    const questionsGenerated =
      overrides?.questionsGenerated ??
      (parseInt(localStorage.getItem(AI_GENERATED_COUNT_KEY) || '0', 10) || 0);

    let bestBand = overrides?.myBestBand ?? 0;
    if (!bestBand && history.length > 0) {
      for (const rec of history) {
        const b = Number(rec.bandScore6 || 0);
        if (b > bestBand) bestBand = b;
      }
    }

    const record: AppUserRecord = {
      id: clientId,
      username: cleanUsername,
      firstSeenAt,
      lastActiveAt: Date.now(),
      questionsPracticed,
      questionsGenerated,
      myBestBand: Number(bestBand.toFixed(1)),
    };

    // Save to local cache map
    try {
      const rawMap = localStorage.getItem(APP_USERS_LOCAL_CACHE_KEY);
      const map: Record<string, AppUserRecord> = rawMap ? JSON.parse(rawMap) : {};
      map[clientId] = record;
      localStorage.setItem(APP_USERS_LOCAL_CACHE_KEY, JSON.stringify(map));
    } catch {}

    await ensureAuthenticated();
    if (db) {
      await setDoc(doc(db, 'app_users', clientId), record, { merge: true });
    }

    return record;
  } catch (err) {
    console.warn('User activity sync notice:', err);
    return null;
  }
}

export async function fetchAllAppUsers(): Promise<AppUserRecord[]> {
  const userMap = new Map<string, AppUserRecord>();

  // 1. Seed from local cache and current user first
  try {
    const current = await syncUserActivityToFirestore();
    if (current) {
      userMap.set(current.id, current);
    }
    if (typeof localStorage !== 'undefined') {
      const rawMap = localStorage.getItem(APP_USERS_LOCAL_CACHE_KEY);
      if (rawMap) {
        const parsed = JSON.parse(rawMap);
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v === 'object') {
            userMap.set(k, v as AppUserRecord);
          }
        }
      }
    }
  } catch {}

  // 2. Fetch all users from Firestore app_users collection
  try {
    await ensureAuthenticated();
    if (db) {
      const snap = await getDocs(collection(db, 'app_users'));
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        if (d) {
          const id = String(d.id || docSnap.id);
          const existing = userMap.get(id);
          const lastActiveAt = Number(d.lastActiveAt || existing?.lastActiveAt || Date.now());
          userMap.set(id, {
            id,
            username: String(d.username || existing?.username || `Guest_${id.slice(0, 5)}`).replace(/^@+/, ''),
            firstSeenAt: Number(d.firstSeenAt || existing?.firstSeenAt || lastActiveAt),
            lastActiveAt: Math.max(lastActiveAt, existing?.lastActiveAt || 0),
            questionsPracticed: Math.max(Number(d.questionsPracticed || 0), existing?.questionsPracticed || 0),
            questionsGenerated: Math.max(Number(d.questionsGenerated || 0), existing?.questionsGenerated || 0),
            myBestBand: Math.max(Number(d.myBestBand || 0), existing?.myBestBand || 0),
          });
        }
      });
    }
  } catch (err) {
    console.warn('Failed to fetch app_users from Firestore:', err);
  }

  return Array.from(userMap.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export interface ReportedItemRecord {
  id: string;
  type: 'global_report' | 'question_report';
  questionId?: string;
  username?: string;
  text: string;
  context?: string;
  createdAt: number;
  resolved?: boolean;
}

export async function fetchAllReportedQuestions(): Promise<ReportedItemRecord[]> {
  const list: ReportedItemRecord[] = [];
  try {
    await ensureAuthenticated();
    if (db) {
      const [reportsSnap, qReportsSnap] = await Promise.all([
        getDocs(collection(db, 'reports')).catch(() => null),
        getDocs(collection(db, 'questionReports')).catch(() => null),
      ]);

      if (reportsSnap && !reportsSnap.empty) {
        reportsSnap.forEach((d) => {
          const data = d.data();
          const ts = data.createdAt?.toMillis ? data.createdAt.toMillis() : Number(data.createdAt || Date.now());
          list.push({
            id: d.id,
            type: 'global_report',
            username: data.username || 'Scholar',
            text: data.text || 'Reported issue',
            context: data.context || '',
            createdAt: ts,
            resolved: Boolean(data.resolved),
          });
        });
      }

      if (qReportsSnap && !qReportsSnap.empty) {
        qReportsSnap.forEach((d) => {
          const data = d.data();
          const ts = data.createdAt?.toMillis ? data.createdAt.toMillis() : Number(data.createdAt || Date.now());
          list.push({
            id: d.id,
            type: 'question_report',
            questionId: data.questionId || d.id.split('__')[0],
            username: data.uid ? `UID: ${String(data.uid).slice(0, 6)}` : 'Scholar',
            text: data.reason || 'User flagged question',
            createdAt: ts,
            resolved: Boolean(data.resolved),
          });
        });
      }
    }
  } catch (err) {
    console.warn('Failed to fetch reports:', err);
  }

  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function resolveOrDeleteReport(reportId: string, type: 'global_report' | 'question_report'): Promise<void> {
  try {
    await ensureAuthenticated();
    if (db) {
      const col = type === 'global_report' ? 'reports' : 'questionReports';
      await deleteDoc(doc(db, col, reportId)).catch(async () => {
        await updateDoc(doc(db, col, reportId), { resolved: true }).catch(() => {});
      });
    }
  } catch {}
}

/**
 * Exports all questions from Exam Bank, Coach Bank, and Mock Exam Sets as a formatted JSON backup string.
 */
export async function exportFullDatabaseBackupJson(mockSets: any[] = []): Promise<string> {
  await getQuestionBankStats('exam');
  await getQuestionBankStats('coach');

  const examBankByTask: Record<string, any[]> = {};
  const coachBankByTask: Record<string, any[]> = {};
  let examTotal = 0;
  let coachTotal = 0;

  for (const tId of CANONICAL_TASK_IDS) {
    const examList = getLoadedCuratedTasks(tId, 'all', 'all', 'exam');
    examBankByTask[tId] = examList;
    examTotal += examList.length;

    const coachList = getLoadedCuratedTasks(tId, 'all', 'all', 'coach');
    coachBankByTask[tId] = coachList;
    coachTotal += coachList.length;
  }

  const payload = {
    schemaVersion: CURRENT_BANK_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: getScholarUsername(),
    summary: {
      examBankTotal: examTotal,
      coachBankTotal: coachTotal,
      mockExamSetsCount: mockSets.length,
    },
    examBank: examBankByTask,
    coachBank: coachBankByTask,
    mockExamSets: mockSets,
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Scans Exam Bank and/or Coach Bank for duplicate content signatures, corrupted AI items, or outdated normalizations
 * and removes/repairs entries across memory, IndexedDB, and Firestore using fast writeBatch.
 */
export async function scanAndRemoveDuplicates(
  targetMode: 'exam' | 'coach' | 'both' = 'both'
): Promise<RepairBankReport & { removed: number }> {
  const report = await repairAndAuditQuestionBank(targetMode);
  return {
    ...report,
    removed: report.duplicatesRemoved + report.corruptedPurged,
  };
}



