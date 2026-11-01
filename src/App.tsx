/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useAuth } from './context/AuthContext';
import { stopSpeaking } from './utils/audioSpeech';
import {
  fetchRandomSharedQuestion,
  reportSharedQuestion,
  triggerBackgroundPrefetchIfNeeded,
} from './utils/questionBankStorage';
import {
  LEVELS,
  ACADEMIC_TOPICS,
  LEVEL_LABELS,
  TOPIC_LABELS,
  isValidLevel,
  isValidAcademicTopic,
  AcademicTopic,
} from './constants/filters';
import { getApiHeaders, hasAnyProviderKey, getScholarUsername } from './utils/apiKey';
import { safeFetchJson } from './utils/apiHelper';
import { normalizeTaskData } from './utils/taskNormalizer';
import { runWithDynamicKeyPool, callBackendGenerate } from './services/geminiService';

function getReportedByMe(): string[] {
  try {
    const raw = localStorage.getItem('toefl_reported_by_me');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function markReportedByMe(id: string) {
  try {
    const current = getReportedByMe();
    if (!current.includes(id)) {
      localStorage.setItem('toefl_reported_by_me', JSON.stringify([...current, id]));
    }
  } catch {}
}

import {
  Sparkles,
  BarChart2,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Sun,
  Moon,
  X,
  Volume2,
  Database,
  Activity,
  Target,
} from 'lucide-react';
import {
  getCompletedQuestionIds,
  markQuestionCompleted,
  isQuestionCompleted,
  getPracticeHistory,
  savePracticeRecord,
  clearAllUserProgress,
  PracticeRecord,
} from './utils/scoreTracker';
import { clearExamHistory } from './utils/examStorage';
import { getMistakesList, clearAllMistakes, MistakeRecord } from './utils/mistakesTracker';
import { clearAllFirestoreMistakes } from './utils/mistakes';
import { SystemStatusModal } from './components/shared/SystemStatusModal';
import { StudioWordmark } from './components/shared/Header';
import { preCacheSectionAudio, preCacheTargetQuestionsAudio } from './utils/audioPrewarmer';
import { GlobalReportButton } from './components/shared/GlobalReportButton';
import {
  syncCuratedQuestionBank,
  getQuestionBankStats,
  getLoadedCuratedTasks,
  getFilteredBankTasks,
  matchesLevelFilter,
  matchesTopicFilter,
  loadCuratedShard,
  saveVerifiedQuestion,
  saveQuestionToSharedBank,
  isDevAdminUnlocked,
  deleteQuestionFromBank,
  syncUserActivityToFirestore,
  incrementAiGeneratedCount,
} from './utils/questionBankStorage';
import { DevQuestionEditorModal } from './components/modals/DevQuestionEditorModal';


import {
  CURATED_COMPLETE_WORDS,
  CURATED_READING_PASSAGES,
  CURATED_LISTENING,
  CURATED_LISTEN_REPEAT,
  CURATED_SPEAKING_INTERVIEWS,
  CURATED_BUILD_SENTENCES,
  CURATED_WRITE_EMAILS,
  CURATED_ACADEMIC_DISCUSSIONS,
  CompleteWordsTask,
  ReadingPassageTask,
  ListeningTask,
  ListenRepeatTask,
  SpeakingInterviewTask,
  BuildSentenceTask,
  WriteEmailTask,
  AcademicDiscussionTask,
} from './data/curatedQuestions';

import { CompleteWordsView } from './components/tasks/CompleteWordsView';
import { SelectionHandler } from './components/shared/SelectionHandler';
import { ReadingPassageView } from './components/tasks/ReadingPassageView';
import { DailyLifeView } from './components/tasks/DailyLifeView';
import { ListeningChooseResponseView } from './components/tasks/ListeningChooseResponseView';
import { ListeningDialogueView } from './components/tasks/ListeningDialogueView';
import { ListeningAnnouncementView } from './components/tasks/ListeningAnnouncementView';
import { ListeningAcademicTalkView } from './components/tasks/ListeningAcademicTalkView';
import { ListenRepeatView } from './components/tasks/ListenRepeatView';
import { SpeakingInterviewView } from './components/tasks/SpeakingInterviewView';
import { BuildSentenceView } from './components/tasks/BuildSentenceView';
import { WriteEmailView } from './components/tasks/WriteEmailView';
import { AcademicDiscussionView } from './components/tasks/AcademicDiscussionView';
import { RubricGuideModal } from './components/modals/RubricGuideModal';
import { VoiceDiagnosticToast } from './components/shared/VoiceDiagnosticToast';
import { ReadingQuestionSkill, READING_SKILL_OPTIONS, PracticeMode } from './types';
import { COACH_CURATED_BANK } from './utils/coachCuratedBank';

import { TaskTypeId, TASK_DEFINITIONS } from './types/taskTypes';
import {
  PrefetchQueue,
  PrefetchedItem,
  loadPrefetchQueueFromStorage,
  savePrefetchQueueToStorage,
  getNextTaskToPrefetch,
  hasReadyTask,
  popPrefetchedTask,
  evaluateRateLimitPause,
  PREFETCH_GAP_MS,
} from './utils/prefetchManager';
import { markUserAiRequest, getLastUserAiRequestTime } from './utils/userActivity';

const DashboardModal = lazy(() => import('./components/modals/DashboardModal').then(m => ({ default: m.DashboardModal })));
const PerformanceHistoryModal = lazy(() => import('./components/modals/ScoreHistoryModal').then(m => ({ default: m.ScoreHistoryModal })));
const MockTestView = lazy(() => import('./components/ExamEngine').then(m => ({ default: m.ExamEngine })));

export default function App() {
  const { user, displayName } = useAuth();
  const [currentTaskType, setCurrentTaskType] = useState<TaskTypeId>('complete-words');
  const [practiceMode, setPracticeMode] = useState<PracticeMode>(() => {
    try {
      return localStorage.getItem('toefl_practice_mode') === 'coach' ? 'coach' : 'exam';
    } catch {
      return 'exam';
    }
  });
  const practiceModeRef = React.useRef<PracticeMode>(practiceMode);
  practiceModeRef.current = practiceMode;

  useEffect(() => {
    try {
      localStorage.setItem('toefl_practice_mode', practiceMode);
    } catch {}
  }, [practiceMode]);

  const [level, setLevel] = useState<string>('all');
  const [topic, setTopic] = useState<string>('all');
  const [readingSkillFocus, setReadingSkillFocus] = useState<ReadingQuestionSkill>('all');

  const levelRef = React.useRef(level);
  levelRef.current = level;
  const topicRef = React.useRef(topic);
  topicRef.current = topic;
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationSuccess, setGenerationSuccess] = useState(false);
  const [lastModelUsed, setLastModelUsed] = useState<string | null>(null);
  const [isMockTest, setIsMockTest] = useState(false);
  const [reportedQuestionId, setReportedQuestionId] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [tierNotice, setTierNotice] = useState<string | null>(null);

  // Stop all playing audio whenever the user switches task types or enters/exits mock test mode
  // Also sync `toefl_in_mock_test` in localStorage so Full Mock Test attempts never enter single-task `scoreHistory`
  useEffect(() => {
    try {
      localStorage.setItem('toefl_in_mock_test', isMockTest ? 'true' : 'false');
    } catch {}
    stopSpeaking();
    return () => {
      stopSpeaking();
    };
  }, [currentTaskType, isMockTest]);

  // Track completed question IDs, score history, and mistake notebook so we prioritize unpracticed questions and support full reset
  const [completedQuestionIds, setCompletedQuestionIds] = useState<string[]>(() =>
    getCompletedQuestionIds()
  );
  const [scoreHistory, setScoreHistory] = useState<PracticeRecord[]>(() =>
    getPracticeHistory()
  );
  const [mistakeNotebook, setMistakeNotebook] = useState<MistakeRecord[]>(() =>
    getMistakesList()
  );
  const [taskResetNonce, setTaskResetNonce] = useState(0);

  const saveScoreEntry = React.useCallback(
    async (entry: Omit<PracticeRecord, 'id' | 'date'>) => {
      if (practiceMode === 'coach') return;
      if (isMockTest) return;
      await savePracticeRecord(entry, practiceMode);
      setScoreHistory(getPracticeHistory());
    },
    [practiceMode, isMockTest]
  );

  useEffect(() => {
    const syncCompleted = () => {
      setCompletedQuestionIds(getCompletedQuestionIds());
      setScoreHistory(getPracticeHistory());
      syncUserActivityToFirestore().catch(() => {});
    };
    const syncMistakes = () => {
      setMistakeNotebook(getMistakesList());
    };
    window.addEventListener('toefl_completed_questions_updated', syncCompleted);
    window.addEventListener('toefl_user_changed', syncCompleted);
    window.addEventListener('toefl_mistakes_updated', syncMistakes);
    return () => {
      window.removeEventListener('toefl_completed_questions_updated', syncCompleted);
      window.removeEventListener('toefl_user_changed', syncCompleted);
      window.removeEventListener('toefl_mistakes_updated', syncMistakes);
    };
  }, []);

  // Sync user activity & @username presence to Firestore app_users on load and when displayName changes
  useEffect(() => {
    syncUserActivityToFirestore(
      displayName ? { username: displayName } : undefined
    ).catch(() => {});
  }, [displayName, user?.uid]);

  const handleResetAllProgress = () => {
    stopSpeaking();
    // 1. Clear scoreHistory state and remove 'toefl_score_history' from localStorage
    setScoreHistory([]);
    localStorage.removeItem('toefl_score_history');

    // 2. Clear mistakeNotebook state and remove 'toefl_mistakes' from localStorage
    setMistakeNotebook([]);
    localStorage.removeItem('toefl_mistakes');
    clearAllMistakes();
    clearAllFirestoreMistakes().catch(() => {});

    // 3. Clear completed/practiced question tracking ('toefl_completed_question_ids', adaptive difficulty history, and mock exam history 'toefl_exam_history')
    localStorage.removeItem('toefl_completed_question_ids');
    localStorage.removeItem('toefl_exam_history');
    localStorage.removeItem('toefl_adaptive_difficulty');
    localStorage.removeItem('toefl_difficulty_history');
    clearExamHistory();
    clearAllUserProgress();
    setCompletedQuestionIds([]);

    // 4. Reset any active evaluation/answers on screen
    setTaskResetNonce((n) => n + 1);
    if (currentTaskType === 'write-email') {
      setWritingTimerSeconds(420);
      setIsWritingTimerRunning(isWritingTimerEnabled);
    } else if (currentTaskType === 'academic-discussion') {
      setWritingTimerSeconds(600);
      setIsWritingTimerRunning(isWritingTimerEnabled);
    }
  };

  // Ensure fresh start on reload: purge any legacy draft keys
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && key.startsWith('toefl_draft_')) {
            localStorage.removeItem(key);
          }
        }
      }
    } catch {}
  }, []);

  // Curated question bank sync state across all 12 task types
  const [bankStats, setBankStats] = useState<{
    totalQuestions: number;
    totalCurated: number;
    countsPerTaskType: Record<string, number>;
  } | null>(null);

  // Always fetch and sync curated shard for current section and total bank into IndexedDB and cache
  useEffect(() => {
    let isMounted = true;
    const syncBank = async () => {
      await loadCuratedShard(currentTaskType, practiceMode);
      const stats = await syncCuratedQuestionBank(practiceMode);
      if (isMounted) {
        setBankStats({
          totalQuestions: stats.totalQuestions,
          totalCurated: stats.totalQuestions,
          countsPerTaskType: stats.counts,
        });
      }
    };
    syncBank();
    return () => {
      isMounted = false;
    };
  }, [currentTaskType, practiceMode]);

  // Active task payload per type
  const [customTasks, setCustomTasks] = useState<Record<string, any>>({});
  const [curatedIndices, setCuratedIndices] = useState<Record<string, number>>({
    'complete-words': 0,
    'daily-life': 0,
    'reading-academic': 0,
    'reading-passage': 0,
    'listening-choose-response': 0,
    'listening-dialogue': 0,
    'listening-announcement': 0,
    'listening-academic-talk': 0,
    'listen-repeat': 0,
    'speaking-interview': 0,
    'build-sentence': 0,
    'write-email': 0,
    'academic-discussion': 0,
  });

  // Background question pre-fetch queue for instant generation (strictly isolated by practiceMode)
  const [prefetchedQueue, setPrefetchedQueue] = useState<PrefetchQueue>(() => loadPrefetchQueueFromStorage(practiceMode));
  const prefetchedQueueRef = useRef<PrefetchQueue>(prefetchedQueue);
  useEffect(() => {
    prefetchedQueueRef.current = prefetchedQueue;
  }, [prefetchedQueue]);

  // When switching between Exam Mode and Coach Mode, reload isolated prefetch queue and clear custom task overrides
  useEffect(() => {
    stopSpeaking();
    setCustomTasks({});
    setTierNotice(null);
    setGenerationError(null);
    const loadedQueue = loadPrefetchQueueFromStorage(practiceMode);
    setPrefetchedQueue(loadedQueue);
    prefetchedQueueRef.current = loadedQueue;
  }, [practiceMode]);

  const isPrefetchingRef = React.useRef<Record<string, boolean>>({});
  const failedRecentlyRef = React.useRef<Record<string, number>>({});
  const quotaExhaustedUntilRef = React.useRef<number>(0);
  const [lastGenerationWasInstant, setLastGenerationWasInstant] = useState(false);
  const [rateLimitPauseState, setRateLimitPauseState] = useState<{ kind: 'per-minute' | 'per-day' | 'unknown'; resumeAt: number; retryAfterSeconds: number } | null>(null);
  const lastPrefetchTimeRef = useRef(0);
  const prefetchRunIdRef = useRef(0);
  const isSectionPrefetchRunningRef = useRef(false);
  const lastHandledBatchCountRef = useRef(0);
  const lastDebugLogTimeRef = useRef<Record<string, number>>({});
  const [sharedBankNotice, setSharedBankNotice] = useState<string | null>(null);

  // Audio Pre-Cache State
  const [isPreCachingAudio, setIsPreCachingAudio] = useState(false);
  const [preCacheStatus, setPreCacheStatus] = useState<string | null>(null);

  const activeSection = TASK_DEFINITIONS.find((t) => t.id === currentTaskType)?.section || 'Reading';
  const isAudioSection = activeSection === 'Listening' || activeSection === 'Speaking';

  const sectionTasks = React.useMemo(
    () => TASK_DEFINITIONS.filter((t) => t.section === activeSection).map((t) => t.id),
    [activeSection]
  );
  const totalInSection = sectionTasks.length;

  const getPrefetchCount = React.useCallback(
    (taskId: string, _mode: PracticeMode = practiceMode, queueOverride?: PrefetchQueue) => {
      const q = queueOverride || prefetchedQueue;
      const items = q[taskId] || [];
      return items.filter(
        (item) => matchesLevelFilter(item, level) && matchesTopicFilter(item, topic)
      ).length;
    },
    [prefetchedQueue, level, topic, practiceMode]
  );

  const liveReadyCount = React.useMemo(
    () => sectionTasks.filter((t) => getPrefetchCount(t, practiceMode) > 0).length,
    [sectionTasks, getPrefetchCount, practiceMode]
  );

  // Modals & Developer Admin State
  const [isRubricsOpen, setIsRubricsOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isDashboardOpen, setIsDashboardOpen] = useState(false);
  const [isStatusModalOpen, setIsStatusModalOpen] = useState(false);
  const [dashboardDefaultTab, setDashboardDefaultTab] = useState<'dashboard' | 'goals' | 'settings' | 'vocabulary' | 'mistakes' | 'dev'>('dashboard');
  const [isDevAdmin, setIsDevAdmin] = useState<boolean>(() => isDevAdminUnlocked());
  const [devEditorTask, setDevEditorTask] = useState<any | null>(null);
  const [devEditorMode, setDevEditorMode] = useState<'exam' | 'coach'>('exam');

  useEffect(() => {
    const syncDevState = () => setIsDevAdmin(isDevAdminUnlocked());
    window.addEventListener('toefl_dev_admin_changed', syncDevState);
    window.addEventListener('storage', syncDevState);
    return () => {
      window.removeEventListener('toefl_dev_admin_changed', syncDevState);
      window.removeEventListener('storage', syncDevState);
    };
  }, []);

  // Dark Mode
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return localStorage.getItem('toefl_dark_mode') === 'true';
  });

  useEffect(() => {
    localStorage.setItem('toefl_dark_mode', darkMode ? 'true' : 'false');
  }, [darkMode]);



  // Listen for API key updates to reset any quota backoff timer
  useEffect(() => {
    const handleKeyChange = () => {
      quotaExhaustedUntilRef.current = 0;
      failedRecentlyRef.current = {};
      setGenerationError(null);
    };
    window.addEventListener('apiKeyUpdated', handleKeyChange);
    return () => window.removeEventListener('apiKeyUpdated', handleKeyChange);
  }, []);

  // Writing Task Countdown Timer (Write an Email = 07:00 [420s], Academic Discussion = 10:00 [600s])
  const [isWritingTimerEnabled, setIsWritingTimerEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('toefl_writing_timer_enabled') !== 'false';
    } catch {
      return true;
    }
  });
  const [isWritingTimerRunning, setIsWritingTimerRunning] = useState<boolean>(() => isWritingTimerEnabled);
  const [writingTimerSeconds, setWritingTimerSeconds] = useState<number>(420);

  useEffect(() => {
    try {
      localStorage.setItem('toefl_writing_timer_enabled', isWritingTimerEnabled ? 'true' : 'false');
    } catch {}
  }, [isWritingTimerEnabled]);

  // Auto-adjust Writing timer mode when switching between Exam Mode and Coach Mode
  useEffect(() => {
    if (practiceMode === 'coach') {
      setIsWritingTimerEnabled(false);
      setIsWritingTimerRunning(false);
    } else {
      setIsWritingTimerEnabled(true);
      if (currentTaskType === 'write-email' || currentTaskType === 'academic-discussion') {
        setIsWritingTimerRunning(true);
      }
    }
  }, [practiceMode]);

  // Auto-start Writing countdown timer whenever switching to Write an Email or Academic Discussion
  useEffect(() => {
    if (currentTaskType === 'write-email') {
      setWritingTimerSeconds(420);
      setIsWritingTimerRunning(practiceMode === 'coach' ? false : isWritingTimerEnabled);
    } else if (currentTaskType === 'academic-discussion') {
      setWritingTimerSeconds(600);
      setIsWritingTimerRunning(practiceMode === 'coach' ? false : isWritingTimerEnabled);
    } else {
      setIsWritingTimerRunning(false);
    }
  }, [currentTaskType, isWritingTimerEnabled, practiceMode]);

  useEffect(() => {
    let timer: any = null;
    const isTimedWritingTask = currentTaskType === 'write-email' || currentTaskType === 'academic-discussion';
    if (isTimedWritingTask && isWritingTimerEnabled && isWritingTimerRunning && writingTimerSeconds > 0) {
      timer = setInterval(() => {
        setWritingTimerSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [currentTaskType, isWritingTimerEnabled, isWritingTimerRunning, writingTimerSeconds]);
  
  // Settings & active-task background prefetch progress
  const [enablePrefetching, setEnablePrefetching] = useState<boolean>(() => {
    const saved = localStorage.getItem('toefl_enable_prefetching');
    return saved === null ? true : saved === 'true';
  });

  const [prefetchProgress, setPrefetchProgress] = useState<{
    current: number;
    total: number;
    status: 'idle' | 'running' | 'completed' | 'no_key' | 'error';
    taskType: string;
  }>({
    current: 0,
    total: 3,
    status: 'idle',
    taskType: currentTaskType,
  });

  const [prefetchBatchCount, setPrefetchBatchCount] = useState<number>(0);

  useEffect(() => {
    localStorage.setItem('toefl_enable_prefetching', enablePrefetching ? 'true' : 'false');
  }, [enablePrefetching]);

  useEffect(() => {
    const handlePrefetchChange = () => {
      const saved = localStorage.getItem('toefl_enable_prefetching');
      setEnablePrefetching(saved === null ? true : saved === 'true');
    };
    window.addEventListener('prefetchSettingChanged', handlePrefetchChange);
    return () => window.removeEventListener('prefetchSettingChanged', handlePrefetchChange);
  }, []);

  // Keyboard shortcut: 'N' for next task
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        handleNextQuestion(currentTaskType);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentTaskType]);

  // Next item in curated pool (prioritizing unpracticed questions first)
  const handleNextCurated = (type: TaskTypeId) => {
    const loadedPool = getLoadedCuratedTasks(type, level, topic, practiceMode);
    const completedSet = new Set(getCompletedQuestionIds());
    let max = loadedPool.length;
    if (max === 0) {
      if (practiceMode === 'coach') {
        const coachKey = type.replace(/-/g, '_');
        const coachList = COACH_CURATED_BANK[coachKey] || COACH_CURATED_BANK[type] || [];
        max = coachList.length || 1;
      } else {
        if (type === 'complete-words') max = CURATED_COMPLETE_WORDS.length;
        if (type === 'reading-passage') max = CURATED_READING_PASSAGES.length;
        if (type === 'listening-dialogue') max = CURATED_LISTENING.length;
        if (type === 'listen-repeat') max = CURATED_LISTEN_REPEAT.length;
        if (type === 'speaking-interview') max = CURATED_SPEAKING_INTERVIEWS.length;
        if (type === 'build-sentence') max = CURATED_BUILD_SENTENCES.length;
        if (type === 'write-email') max = CURATED_WRITE_EMAILS.length;
        if (type === 'academic-discussion') max = CURATED_ACADEMIC_DISCUSSIONS.length;
      }
    }

    // Clear custom task for this type so next curated item shows
    setCustomTasks((prev) => {
      const next = { ...prev };
      delete next[type];
      return next;
    });

    setCuratedIndices((prev) => {
      const current = prev[type] || 0;
      if (max <= 1) return { ...prev, [type]: 0 };

      if (loadedPool.length > 1) {
        const unpracticedIndices: number[] = [];
        for (let i = 0; i < loadedPool.length; i++) {
          if (i !== current % loadedPool.length && !isQuestionCompleted(loadedPool[i], completedSet)) {
            unpracticedIndices.push(i);
          }
        }
        if (unpracticedIndices.length > 0) {
          const chosen = unpracticedIndices[Math.floor(Math.random() * unpracticedIndices.length)];
          return { ...prev, [type]: chosen };
        }
      }

      let next;
      do {
        next = Math.floor(Math.random() * max);
      } while (next === current);
      return { ...prev, [type]: next };
    });
  };

  // Serve a random question: always prioritizing unpracticed questions in the filtered bank first
  const handleNextQuestion = async (type: TaskTypeId) => {
    setReportedQuestionId(null);
    setReportError(null);

    const concreteLevel = isValidLevel(level) ? level : 'intermediate';
    const concreteTopic = isValidAcademicTopic(topic) ? topic : 'science-tech';

    // 0. Serve from prefetched queue if available!
    if (getPrefetchCount(type, practiceMode, prefetchedQueueRef.current) > 0) {
      const { item: readyTask, updatedQueue } = popPrefetchedTask(
        prefetchedQueueRef.current,
        type,
        concreteLevel,
        concreteTopic,
        practiceMode
      );
      if (readyTask) {
        prefetchedQueueRef.current = updatedQueue;
        setPrefetchedQueue(updatedQueue);
        setCustomTasks((prev) => ({
          ...prev,
          [type]: normalizeTaskData(readyTask, type),
        }));
        if (readyTask.modelUsed) setLastModelUsed(readyTask.modelUsed);
        setLastGenerationWasInstant(true);
        setGenerationSuccess(true);
        setTimeout(() => setGenerationSuccess(false), 3000);
        // Immediately trigger background refill for the consumed task
        setTimeout(() => {
          runCurrentTaskPrefetch();
        }, 50);
        saveVerifiedQuestion(
          {
            taskType: type,
            level: concreteLevel,
            topic: concreteTopic,
            content: readyTask,
            audioUrl: readyTask.audioUrl || null,
            audioClips: readyTask.audioClips || null,
            source: 'ai',
            generatedBy: displayName || getScholarUsername(),
          },
          practiceMode
        )
          .then(() => getQuestionBankStats(practiceMode).then(setBankStats))
          .catch(() => {});
        return;
      }
    }

    const completedSet = new Set(getCompletedQuestionIds());
    const loadedPool = getLoadedCuratedTasks(type, level, topic, practiceMode);
    const activeId = activeTask?.id || (activeTask as any)?.questionDocId;
    const activeTitle = (activeTask as any)?.title;

    const unpracticedPool = loadedPool.filter(
      (q) =>
        !isQuestionCompleted(q, completedSet) &&
        (!activeId || (q.id !== activeId && q.questionDocId !== activeId)) &&
        (!activeTitle || q.title !== activeTitle)
    );

    // 1. If we have unpracticed questions in the local/synced filtered bank, pick one immediately
    if (unpracticedPool.length > 0) {
      const chosen = unpracticedPool[Math.floor(Math.random() * unpracticedPool.length)];
      setTierNotice(null);
      setCustomTasks((prev) => ({
        ...prev,
        [type]: normalizeTaskData(chosen, type),
      }));
      return;
    }

    // 2. Otherwise query shared bank for any unseen question
    const hasFilter = level !== 'all' || topic !== 'all';
    const shouldQueryBank = hasFilter || Math.random() < 0.6;

    if (shouldQueryBank) {
      try {
        const shared = await fetchRandomSharedQuestion(type, level, topic, practiceMode);
        if (shared && !isQuestionCompleted(shared, completedSet)) {
          if (shared.tier && shared.tier !== 'exact') {
            const lvlLabel = level !== 'all' && isValidLevel(level) ? LEVEL_LABELS[level] : level;
            const topLabel = topic !== 'all' && isValidAcademicTopic(topic) ? TOPIC_LABELS[topic] : topic;
            setTierNotice(`No exact match for ${lvlLabel} in ${topLabel}, showing a nearby question.`);

            triggerBackgroundPrefetchIfNeeded(
              type,
              level,
              topic,
              async (tType, lvl, top) => {
                const resp = await safeFetchJson('/api/generate-task', {
                  method: 'POST',
                  headers: getApiHeaders(),
                  body: JSON.stringify({
                    taskType: tType,
                    level: lvl,
                    topic: top,
                    coachMode: practiceMode === 'coach',
                  }),
                });
                return resp.success && resp.data ? [resp.data] : [];
              },
              practiceMode
            );
          } else {
            setTierNotice(null);
          }

          setCustomTasks((prev) => ({
            ...prev,
            [type]: normalizeTaskData(shared, type),
          }));
          return;
        }
      } catch (err) {
        console.warn('Shared question bank query failed, falling back to curated:', err);
      }
    }

    setTierNotice(null);
    handleNextCurated(type);
  };

  const handleReportQuestion = async (questionDocId: string) => {
    setReportError(null);
    markReportedByMe(questionDocId);
    setReportedQuestionId(questionDocId);
    if (!user) {
      return;
    }
    try {
      await reportSharedQuestion(questionDocId, user.uid);
      const currentTask = customTasks[currentTaskType];
      if (currentTask) {
        const nextReportCount = (currentTask.reportCount || 0) + 1;
        setCustomTasks((prev) => ({
          ...prev,
          [currentTaskType]: {
            ...prev[currentTaskType],
            reportCount: nextReportCount,
          },
        }));
        if (nextReportCount >= 3) {
          setTimeout(() => {
            handleNextQuestion(currentTaskType);
          }, 800);
        }
      }
    } catch (err: any) {
      console.warn('Report saved locally:', err?.message || err);
    }
  };

  useEffect(() => {
    const onReportEvent = (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      const docId = detail?.questionDocId || detail?.questionKey;
      if (docId) {
        handleReportQuestion(String(docId));
      }
    };

    const onDevEditEvent = (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      const targetTask = detail?.task || activeTask;
      if (targetTask) {
        setDevEditorMode(detail?.mode || practiceMode);
        setDevEditorTask({
          ...targetTask,
          taskType: targetTask.taskType || currentTaskType,
        });
      }
    };

    const onDevDeleteEvent = async (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      const targetTask = detail?.task || activeTask;
      const qId = String(detail?.questionDocId || detail?.questionKey || targetTask?.questionDocId || targetTask?.id || '');
      await deleteQuestionFromBank(qId, practiceMode, targetTask);
      const updatedStats = await getQuestionBankStats(practiceMode);
      setBankStats(updatedStats);
      setSharedBankNotice('🗑️ Question permanently deleted from bank.');
      setTimeout(() => setSharedBankNotice(null), 3500);
      handleNextQuestion(currentTaskType);
    };

    const onBankUpdated = () => {
      getQuestionBankStats(practiceMode).then(setBankStats).catch(() => {});
    };

    window.addEventListener('toefl_report_active_question', onReportEvent);
    window.addEventListener('toefl_dev_edit_question', onDevEditEvent);
    window.addEventListener('toefl_dev_delete_question', onDevDeleteEvent);
    window.addEventListener('toefl_bank_updated', onBankUpdated);
    return () => {
      window.removeEventListener('toefl_report_active_question', onReportEvent);
      window.removeEventListener('toefl_dev_edit_question', onDevEditEvent);
      window.removeEventListener('toefl_dev_delete_question', onDevDeleteEvent);
      window.removeEventListener('toefl_bank_updated', onBankUpdated);
    };
  }, [currentTaskType, user, customTasks, practiceMode]);

  // Smart Section-Aware Prefetch Runner:
  // Ensures every task in sectionTasks has at least 1 prefetched question ready,
  // and immediately refills any consumed task when liveReadyCount < totalInSection.
  const runCurrentTaskPrefetch = React.useCallback(
    async (forceExtraForActiveTask: boolean = false) => {
      if (isMockTest) return;

      if (!enablePrefetching) {
        isSectionPrefetchRunningRef.current = false;
        setPrefetchProgress({
          current: 0,
          total: totalInSection,
          status: 'idle',
          taskType: currentTaskType,
        });
        return;
      }

      if (!hasAnyProviderKey()) {
        isSectionPrefetchRunningRef.current = false;
        setPrefetchProgress({
          current: 0,
          total: totalInSection,
          status: 'no_key',
          taskType: currentTaskType,
        });
        return;
      }

      // Avoid duplicate concurrent runs unless explicitly forced via +1 More
      if (isSectionPrefetchRunningRef.current && !forceExtraForActiveTask) {
        return;
      }

      const concreteLevel = isValidLevel(level) ? level : 'intermediate';
      const concreteTopic = isValidAcademicTopic(topic) ? topic : 'science-tech';
      const targetMode = practiceMode;

      const countInQueue = (tId: string) => {
        const items = prefetchedQueueRef.current[tId] || [];
        return items.filter(
          (item) => matchesLevelFilter(item, level) && matchesTopicFilter(item, topic)
        ).length;
      };

      const missingTasks = sectionTasks.filter((tId) => countInQueue(tId) === 0);
      if (missingTasks.includes(currentTaskType)) {
        missingTasks.sort((a, b) => (a === currentTaskType ? -1 : b === currentTaskType ? 1 : 0));
      }

      let tasksToFetch: string[] = [];
      if (missingTasks.length > 0) {
        tasksToFetch = missingTasks;
      } else if (forceExtraForActiveTask) {
        tasksToFetch = [currentTaskType];
      } else {
        isSectionPrefetchRunningRef.current = false;
        setPrefetchProgress({
          current: totalInSection,
          total: totalInSection,
          status: 'completed',
          taskType: currentTaskType,
        });
        return;
      }

      const runId = ++prefetchRunIdRef.current;
      isSectionPrefetchRunningRef.current = true;

      const computeLiveReadyFromRef = () =>
        sectionTasks.filter((tId) => countInQueue(tId) > 0).length;

      setPrefetchProgress({
        current: computeLiveReadyFromRef(),
        total: totalInSection,
        status: 'running',
        taskType: tasksToFetch[0],
      });

      try {
        const fetchJobs = tasksToFetch.map((taskToFetch) => async () => {
          if (prefetchRunIdRef.current !== runId) return;

          setPrefetchProgress({
            current: computeLiveReadyFromRef(),
            total: totalInSection,
            status: 'running',
            taskType: taskToFetch,
          });

          let json: any = null;
          try {
            json = await callBackendGenerate(
              taskToFetch,
              concreteLevel,
              concreteTopic,
              targetMode === 'coach'
            );
          } catch {
            json = null;
          }

          if (prefetchRunIdRef.current !== runId) return;

          // Retry once after 1500ms if first attempt failed or returned fallback
          if (!json || !json.success || !json.data || json.data.isFallback) {
            await new Promise((res) => setTimeout(res, 1500));
            if (prefetchRunIdRef.current !== runId) return;
            try {
              json = await callBackendGenerate(
                taskToFetch,
                concreteLevel,
                concreteTopic,
                targetMode === 'coach'
              );
            } catch {
              json = null;
            }
          }

          if (prefetchRunIdRef.current !== runId) return;

          if (json && json.success && json.data && !json.data.isFallback) {
            const userUsername = getScholarUsername();
            const itemToSave = normalizeTaskData(json.data, taskToFetch);
            itemToSave.createdBy = itemToSave.createdBy || userUsername;
            itemToSave.generatedBy = itemToSave.generatedBy || userUsername;

            await saveQuestionToSharedBank({
              taskType: taskToFetch,
              level: concreteLevel,
              topic: concreteTopic,
              content: itemToSave,
              mode: targetMode,
              source: 'ai',
              audioUrl: itemToSave.audioUrl || null,
              audioClips: itemToSave.audioClips || null,
            });
            incrementAiGeneratedCount(1);

            if (prefetchRunIdRef.current !== runId) return;

            const prefetchedItem: PrefetchedItem = {
              ...itemToSave,
              level: concreteLevel,
              topic: concreteTopic,
              id: itemToSave.id || `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              isPrefetched: true,
              createdAt: Date.now(),
              source: 'ai',
              createdBy: userUsername,
              generatedBy: userUsername,
            };

            const prevQueue = prefetchedQueueRef.current;
            const currentItems = prevQueue[taskToFetch] || [];
            const nextQueue: PrefetchQueue = {
              ...prevQueue,
              [taskToFetch]: [...currentItems, prefetchedItem].slice(-2),
            };
            prefetchedQueueRef.current = nextQueue;
            savePrefetchQueueToStorage(nextQueue, targetMode);
            setPrefetchedQueue(nextQueue);

            const updatedReady = computeLiveReadyFromRef();
            setPrefetchProgress({
              current: updatedReady,
              total: totalInSection,
              status: updatedReady >= totalInSection ? 'completed' : 'running',
              taskType: taskToFetch,
            });

            syncCuratedQuestionBank(targetMode)
              .then((updatedStats) => {
                if (prefetchRunIdRef.current === runId) {
                  setBankStats(updatedStats);
                }
              })
              .catch(() => {});
          }
        });

        await runWithDynamicKeyPool(fetchJobs);
      } catch (err) {
        console.warn('Section prefetch failed:', err);
      } finally {
        if (prefetchRunIdRef.current === runId) {
          isSectionPrefetchRunningRef.current = false;
          const finalReady = computeLiveReadyFromRef();
          setPrefetchProgress({
            current: finalReady,
            total: totalInSection,
            status: finalReady >= totalInSection ? 'completed' : 'error',
            taskType: currentTaskType,
          });
        }
      }
    },
    [
      isMockTest,
      enablePrefetching,
      totalInSection,
      currentTaskType,
      level,
      topic,
      practiceMode,
      sectionTasks,
    ]
  );

  // Cancel any in-flight run when section, level, topic, mode, or prefetch toggle changes
  useEffect(() => {
    prefetchRunIdRef.current++;
    isSectionPrefetchRunningRef.current = false;
  }, [activeSection, level, topic, practiceMode, enablePrefetching]);

  // Automatically trigger prefetch whenever any tab in the current section has 0 prefetched questions (liveReadyCount < totalInSection)
  // or when the user clicks "+1 More" (prefetchBatchCount increments)
  useEffect(() => {
    const isManualExtra = prefetchBatchCount > lastHandledBatchCountRef.current;
    if (isManualExtra) {
      lastHandledBatchCountRef.current = prefetchBatchCount;
      runCurrentTaskPrefetch(true);
      return;
    }

    if (!enablePrefetching || isMockTest) {
      return;
    }

    if (liveReadyCount < totalInSection) {
      const delayMs = prefetchProgress.status === 'error' ? 4000 : 250;
      const timer = setTimeout(() => {
        runCurrentTaskPrefetch(false);
      }, delayMs);
      return () => clearTimeout(timer);
    } else if (prefetchProgress.status !== 'running') {
      setPrefetchProgress((prev) =>
        prev.status === 'completed' && prev.current === totalInSection && prev.total === totalInSection
          ? prev
          : {
              current: totalInSection,
              total: totalInSection,
              status: 'completed',
              taskType: currentTaskType,
            }
      );
    }
  }, [
    activeSection,
    level,
    topic,
    practiceMode,
    enablePrefetching,
    prefetchBatchCount,
    isMockTest,
    liveReadyCount,
    totalInSection,
    prefetchProgress.status,
    runCurrentTaskPrefetch,
    currentTaskType,
  ]);

  // Sync / filter queue when difficulty level or academic topic changes
  useEffect(() => {
    setPrefetchedQueue((prev) => {
      let changed = false;
      const next: PrefetchQueue = {};
      for (const [k, items] of Object.entries(prev)) {
        if (!Array.isArray(items)) continue;
        const matching = items.filter((item) => matchesLevelFilter(item, level) && matchesTopicFilter(item, topic));
        if (matching.length !== items.length) {
          changed = true;
        }
        if (matching.length > 0) {
          next[k] = matching;
        }
      }
      if (changed) {
        savePrefetchQueueToStorage(next, practiceMode);
        return next;
      }
      return prev;
    });
    // Ensure active customTask respects newly selected filter
    setCustomTasks((prev) => {
      const current = prev[currentTaskType];
      if (!current) return prev;
      if (matchesLevelFilter(current, level) && matchesTopicFilter(current, topic)) {
        return prev;
      }
      const copy = { ...prev };
      delete copy[currentTaskType];
      return copy;
    });
  }, [level, topic, currentTaskType, practiceMode]);

  useEffect(() => {
    const handleKeyReset = () => {
      quotaExhaustedUntilRef.current = 0;
      failedRecentlyRef.current = {};
    };
    window.addEventListener('apiKeyUpdated', handleKeyReset);
    return () => window.removeEventListener('apiKeyUpdated', handleKeyReset);
  }, []);

  // Generate fresh task: Instant swap if ready in background queue, or fetch on demand
  const handleGenerateNewAiTask = async () => {
    markUserAiRequest();
    const concreteLevel = isValidLevel(level) ? level : 'intermediate';
    const concreteTopic = isValidAcademicTopic(topic) ? topic : 'science-tech';

    // 1. Instant delivery if pre-fetched question is ready in the queue!
    if (getPrefetchCount(currentTaskType, practiceMode, prefetchedQueueRef.current) > 0) {
      const { item: readyTask, updatedQueue } = popPrefetchedTask(
        prefetchedQueueRef.current,
        currentTaskType,
        concreteLevel,
        concreteTopic,
        practiceMode
      );
      if (readyTask) {
        prefetchedQueueRef.current = updatedQueue;
        setPrefetchedQueue(updatedQueue);

        // Instantly activate
        setCustomTasks((prev) => ({
          ...prev,
          [currentTaskType]: normalizeTaskData(readyTask, currentTaskType),
        }));

        if (readyTask.modelUsed) {
          setLastModelUsed(readyTask.modelUsed);
        }

        setGenerationError(null);
        setLastGenerationWasInstant(true);
        setGenerationSuccess(true);
        setTimeout(() => setGenerationSuccess(false), 3000);

        // Immediately trigger background refill for the consumed task
        setTimeout(() => {
          runCurrentTaskPrefetch();
        }, 50);

        saveVerifiedQuestion(
          {
            taskType: currentTaskType,
            level: concreteLevel,
            topic: concreteTopic,
            content: readyTask,
            audioUrl: readyTask.audioUrl || null,
            audioClips: readyTask.audioClips || null,
            source: 'ai',
            generatedBy: displayName || getScholarUsername(),
          },
          practiceMode
        )
          .then(() => getQuestionBankStats(practiceMode).then(setBankStats))
          .catch(() => {});

        return;
      }
    }

    // 2. Standard fetch if queue was empty
    setIsGenerating(true);
    setGenerationError(null);
    setGenerationSuccess(false);
    setLastGenerationWasInstant(false);

    try {
      const json = await safeFetchJson('/api/generate-task', {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          taskType: currentTaskType,
          level: concreteLevel,
          topic: concreteTopic,
          coachMode: practiceMode === 'coach',
          promptData: readingSkillFocus !== 'all' ? { questionSkillFocus: readingSkillFocus } : undefined,
        }),
      });

      if (!json.success) {
        throw new Error(json.error || 'Generation failed');
      }

      if (json.data.isFallback) {
        const reason = json.data.fallbackReason || 'model unavailable';
        const isQuota = Boolean(json.data.isQuotaExhausted) || reason.toLowerCase().includes('quota') || reason.toLowerCase().includes('429');
        if (isQuota) {
          const pause = evaluateRateLimitPause(json.data.rateLimit, Date.now()); setRateLimitPauseState(pause); quotaExhaustedUntilRef.current = pause.resumeAt;
        }
        setGenerationError(
          reason && !reason.toLowerCase().includes('unknown')
            ? `AI notice: ${reason}. Showing an authentic curated TOEFL question instead.`
            : "AI service rate limit reached or model busy. Practicing with an authentic ETS TOEFL curated question."
        );
        handleNextCurated(currentTaskType);
        setIsGenerating(false);
        return;
      }

      if (json.data.modelUsed) {
        setLastModelUsed(json.data.modelUsed);
      }

      const newTask: any = normalizeTaskData({
        ...json.data,
        level: concreteLevel,
        topic: concreteTopic,
        id: `ai-${Date.now()}`,
      }, currentTaskType);

      try {
        const docId = await saveVerifiedQuestion(
          {
            taskType: currentTaskType,
            level: concreteLevel,
            topic: concreteTopic,
            content: newTask,
            source: 'ai',
            generatedBy: displayName || getScholarUsername(),
          },
          practiceMode
        );
        if (docId) {
          newTask.questionDocId = docId;
          newTask.createdByName = displayName || 'Anonymous Scholar';
          newTask.createdByUid = user?.uid || 'anonymous';
          newTask.isSharedBank = true;
          setSharedBankNotice(
            practiceMode === 'coach'
              ? 'Added to the isolated Coach & Marathon bank'
              : 'Added to the shared question bank'
          );
          setTimeout(() => setSharedBankNotice(null), 4000);
          getQuestionBankStats(practiceMode).then(setBankStats).catch(() => {});
        }
      } catch (e: any) {
        console.warn('Failed to save to shared question bank:', e?.message || e);
      }

      setCustomTasks((prev) => ({
        ...prev,
        [currentTaskType]: newTask,
      }));
      incrementAiGeneratedCount(1);
      setLastGenerationWasInstant(false);
      setGenerationSuccess(true);
      setTimeout(() => setGenerationSuccess(false), 3000);
    } catch (err: any) {
      console.warn('AI generation notice:', err?.message || err);
      const rawMsg = err.message || 'unknown error';
      const isQuota = rawMsg.toLowerCase().includes('quota') || rawMsg.toLowerCase().includes('429');
      if (isQuota) {
        const pause = evaluateRateLimitPause(err, Date.now()); setRateLimitPauseState(pause); quotaExhaustedUntilRef.current = pause.resumeAt;
      }
      setGenerationError(
        rawMsg && !rawMsg.toLowerCase().includes('unknown')
          ? `AI notice: ${rawMsg}. Showing an authentic curated question instead.`
          : "AI service rate limit reached or model busy. Practicing with an authentic ETS TOEFL curated question."
      );
      handleNextCurated(currentTaskType);
    } finally {
      setIsGenerating(false);
    }
  };

  // Resolve current active task data (hide questions with reportCount >= 3)
  const activeTask = React.useMemo(() => {
    let task = null;
    if (customTasks[currentTaskType]) {
      const t = customTasks[currentTaskType];
      if (!t.reportCount || t.reportCount < 3) {
        task = t;
      }
    }

    if (!task) {
      const loadedTasks = getLoadedCuratedTasks(currentTaskType, level, topic, practiceMode);
      const idx = curatedIndices[currentTaskType] || 0;
      if (loadedTasks && loadedTasks.length > 0) {
        task = loadedTasks[idx % loadedTasks.length];
      } else {
        const allSectionTasks = getLoadedCuratedTasks(currentTaskType, 'all', 'all', practiceMode);
        const levelMatches = allSectionTasks.filter((t) => matchesLevelFilter(t, level));
        const topicMatches = allSectionTasks.filter((t) => matchesTopicFilter(t, topic));
        const closestPool =
          levelMatches.length > 0
            ? levelMatches
            : topicMatches.length > 0
            ? topicMatches
            : allSectionTasks;

        if (closestPool.length > 0) {
          task = closestPool[idx % closestPool.length];
        } else if (practiceMode === 'coach') {
          const coachKey = currentTaskType.replace(/-/g, '_');
          const coachList = COACH_CURATED_BANK[coachKey] || COACH_CURATED_BANK[currentTaskType] || [];
          if (coachList.length > 0) {
            task = coachList[idx % coachList.length];
          }
        }

        if (!task) {
          switch (currentTaskType) {
            case 'complete-words':
              task = CURATED_COMPLETE_WORDS[idx % CURATED_COMPLETE_WORDS.length];
              break;
            case 'reading-passage':
            case 'reading-academic':
              task = CURATED_READING_PASSAGES[idx % CURATED_READING_PASSAGES.length];
              break;
            case 'listening-dialogue':
              task = CURATED_LISTENING[idx % CURATED_LISTENING.length];
              break;
            case 'listen-repeat':
              task = CURATED_LISTEN_REPEAT[idx % CURATED_LISTEN_REPEAT.length];
              break;
            case 'speaking-interview':
              task = CURATED_SPEAKING_INTERVIEWS[idx % CURATED_SPEAKING_INTERVIEWS.length];
              break;
            case 'build-sentence':
              task = CURATED_BUILD_SENTENCES[idx % CURATED_BUILD_SENTENCES.length];
              break;
            case 'write-email':
              task = CURATED_WRITE_EMAILS[idx % CURATED_WRITE_EMAILS.length];
              break;
            case 'academic-discussion':
            default:
              task = CURATED_ACADEMIC_DISCUSSIONS[idx % CURATED_ACADEMIC_DISCUSSIONS.length];
              break;
          }
        }
      }
    }

    return normalizeTaskData(task, currentTaskType);
  }, [customTasks, currentTaskType, level, topic, curatedIndices, practiceMode]);

  const handlePreCacheAudio = async () => {
    if (!isAudioSection || isPreCachingAudio) return;
    setIsPreCachingAudio(true);

    // Build target list: current active question + the next 2 unpracticed questions in the current section
    const targets: Array<{ task: any; taskType: string }> = [];
    const seenIdsOrTitles = new Set<string>();
    const completedSet = new Set(completedQuestionIds);

    const addTargetIfUnique = (q: any, tType: string) => {
      if (!q || targets.length >= 3) return;
      const key = String(q.id || q.questionDocId || q.title || '').trim();
      if (key && seenIdsOrTitles.has(key)) return;
      if (key) seenIdsOrTitles.add(key);
      targets.push({ task: normalizeTaskData(q, tType), taskType: tType });
    };

    // 1. Current active question
    if (activeTask) {
      addTargetIfUnique(activeTask, currentTaskType);
    }

    // 2. Next unpracticed questions in currentTaskType (prefetched queue + curated/bank pool)
    const prefetchedForCurrent = prefetchedQueueRef.current[currentTaskType] || [];
    for (const pq of prefetchedForCurrent) {
      if (targets.length >= 3) break;
      if (!isQuestionCompleted(pq, completedSet)) {
        addTargetIfUnique(pq, currentTaskType);
      }
    }

    const filteredPool = getLoadedCuratedTasks(currentTaskType, level, topic, practiceMode);
    const fullPool = getLoadedCuratedTasks(currentTaskType, 'all', 'all', practiceMode);
    const pool = filteredPool.length > 0 ? filteredPool : fullPool;
    const startIdx = (curatedIndices[currentTaskType] || 0) + 1;

    for (let offset = 0; offset < pool.length && targets.length < 3; offset++) {
      const candidate = pool[(startIdx + offset) % pool.length];
      if (!isQuestionCompleted(candidate, completedSet)) {
        addTargetIfUnique(candidate, currentTaskType);
      }
    }

    // 3. If still < 3, check other task types in the current section
    for (const secTaskType of sectionTasks) {
      if (targets.length >= 3) break;
      if (secTaskType === currentTaskType) continue;
      const secPool = getLoadedCuratedTasks(secTaskType, 'all', 'all', practiceMode);
      for (const candidate of secPool) {
        if (targets.length >= 3) break;
        if (!isQuestionCompleted(candidate, completedSet)) {
          addTargetIfUnique(candidate, secTaskType);
        }
      }
    }

    // Fallback: if all questions were practiced, still take next questions from pool up to 3
    for (let offset = 0; offset < pool.length && targets.length < 3; offset++) {
      const candidate = pool[(startIdx + offset) % pool.length];
      addTargetIfUnique(candidate, currentTaskType);
    }

    const totalToCache = Math.max(1, targets.length);
    setPreCacheStatus(`🔊 Pre-Caching 1/${totalToCache}...`);

    try {
      await preCacheTargetQuestionsAudio(targets, (progress) => {
        setPreCacheStatus(progress.statusText);
      });
    } finally {
      setIsPreCachingAudio(false);
    }
  };

  return (
    <div className={`min-h-screen font-sans antialiased selection:bg-teal-200 selection:text-teal-950 flex flex-col motion-reduce:transition-none ${darkMode ? 'dark bg-slate-950 text-slate-100' : 'bg-[#fafaf8] text-slate-900'}`}>
      {/* Top Bar Contract: 3 Zones (Wordmark - 4 Nav Links - 1 Action CTA) */}
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur-xs sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Bespoke 4-Skill Studio Crest & Wordmark */}
          <a
            href="/"
            className="hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
            title="TOEFL Prep Studio — Home"
          >
            <StudioWordmark />
          </a>

          {/* Zone 2: Clean text navigation links */}
          <nav className="hidden md:flex items-center gap-6 text-xs sm:text-sm font-medium text-slate-600">
            <button
              onClick={() => {
                setIsMockTest(false);
                setCurrentTaskType('complete-words');
              }}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                !isMockTest && activeSection === 'Reading' ? 'text-teal-800 font-semibold' : ''
              }`}
            >
              Reading
            </button>
            <button
              onClick={() => {
                setIsMockTest(false);
                setCurrentTaskType('listening-choose-response');
              }}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                !isMockTest && activeSection === 'Listening' ? 'text-teal-800 font-semibold' : ''
              }`}
            >
              Listening
            </button>
            <button
              onClick={() => {
                setIsMockTest(false);
                setCurrentTaskType('build-sentence');
              }}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                !isMockTest && activeSection === 'Writing' ? 'text-teal-800 font-semibold' : ''
              }`}
            >
              Writing
            </button>
            <button
              onClick={() => {
                setIsMockTest(false);
                setCurrentTaskType('listen-repeat');
              }}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                !isMockTest && activeSection === 'Speaking' ? 'text-teal-800 font-semibold' : ''
              }`}
            >
              Speaking
            </button>
            <button
              onClick={() => setIsRubricsOpen(true)}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 text-slate-500 cursor-pointer"
            >
              Scoring Rubrics
            </button>
            <button
              onClick={() => setIsMockTest(true)}
              className={`transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isMockTest
                  ? 'text-rose-700 font-bold'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              Full Mock Test
            </button>
          </nav>

          {/* Zone 3: Right actions (Dev Admin Badge, Score History, Dashboard, System Status, Theme Toggle) */}
          <div className="flex items-center gap-2.5 shrink-0">
            {isDevAdmin && (
              <button
                type="button"
                onClick={() => {
                  setDashboardDefaultTab('dev');
                  setIsDashboardOpen(true);
                }}
                title="Developer Admin Mode Active — Open Dev Console"
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-bold text-amber-300 bg-slate-900 hover:bg-slate-800 border border-amber-500/40 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-2xs"
              >
                <span>🛠️ DEV ADMIN</span>
              </button>
            )}
            <button
              onClick={() => setIsHistoryOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <BarChart2 className="w-3.5 h-3.5" />
              <span>Score History</span>
            </button>
            <button
              onClick={() => {
                setDashboardDefaultTab('dashboard');
                setIsDashboardOpen(true);
              }}
              aria-label="Open Dashboard"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <BarChart2 className="w-3.5 h-3.5" />
              <span>Dashboard</span>
            </button>
            <button
              onClick={() => setIsStatusModalOpen(true)}
              aria-label="Live System Status"
              title="Live System Status (Network, Generation, Transcriber)"
              className="p-2 rounded-lg text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer"
            >
              <Activity className="w-4 h-4 text-teal-700" />
            </button>
            <button
              onClick={() => setDarkMode(prev => !prev)}
              aria-label="Toggle Dark Mode"
              className="p-2 rounded-lg text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer"
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-700" />}
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex-1 w-full space-y-6">
        {!isMockTest && (
          <>
            {/* Workspace Controls Deck: Task Type Segmented Bar */}
            <section aria-label="Task Selection Bar" className="space-y-3">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <div
                    role="group"
                    aria-label="Practice Mode Switcher"
                    className="inline-flex items-center p-1 bg-slate-200/90 rounded-xl border border-slate-300/70 shadow-2xs"
                  >
                    <button
                      type="button"
                      onClick={() => setPracticeMode('exam')}
                      className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                        practiceMode === 'exam'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                      title="Official 2026 ETS Exam Simulation Mode (strict timers, official item counts, isolated Exam question bank)"
                    >
                      <span>🎯 Official Exam Mode</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsMockTest(false);
                        setPracticeMode('coach');
                      }}
                      className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                        practiceMode === 'coach'
                          ? 'bg-indigo-600 text-white shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                      title="Coach & Marathon Mode (extended question volume, interactive hints, grammar & writing blueprints, audio speed control, isolated Coach question bank)"
                    >
                      <span>🎓 Coach &amp; Marathon Mode</span>
                    </button>
                  </div>
                  <span className="text-xs text-slate-500 hidden lg:inline">
                    {practiceMode === 'coach'
                      ? 'Extended marathon volume, step-by-step hints, writing & speaking blueprints, and isolated Coach bank'
                      : 'Select task format from official 2026 TOEFL iBT test specifications:'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">Current Section:</span>
                  <span className="text-xs font-semibold text-teal-800 uppercase tracking-wider">
                    {activeSection}
                  </span>
                </div>
              </div>

              {practiceMode === 'coach' && !isMockTest && (
                <div className="px-3.5 py-2 bg-indigo-50/90 border border-indigo-200 rounded-xl flex items-center justify-between gap-3 flex-wrap text-xs text-indigo-950">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 bg-indigo-600 text-white font-bold rounded-md text-[10px] uppercase tracking-wider">
                      Coach &amp; Marathon Bank
                    </span>
                    <span className="font-medium">
                      Zero overlap with Exam Mode questions · Extended item counts · Interactive hints &amp; Band 6.0 blueprints enabled
                    </span>
                  </div>
                </div>
              )}

              {/* Section-Filtered Task Format Selector Bar */}
              <div className="p-1 bg-slate-200/80 rounded-xl flex items-center gap-1.5 flex-wrap">
                {TASK_DEFINITIONS.filter((td) => td.section === activeSection).map((td) => {
                  const isActive =
                    !isMockTest &&
                    (currentTaskType === td.id ||
                      (td.id === 'reading-academic' && currentTaskType === 'reading-passage') ||
                      (td.id === 'listening-dialogue' && currentTaskType === 'listening-conversation') ||
                      (td.id === 'listening-academic-talk' && currentTaskType === 'listening-lecture'));
                  const readyCount = getPrefetchCount(td.id, practiceMode);
                  const isReady = readyCount > 0;
                  const cleanLabel = td.name.replace(/^[RLWS]\s*[·•.]\s*/i, '').trim();
                  return (
                    <button
                      key={td.id}
                      data-active={isActive ? 'true' : 'false'}
                      onClick={() => {
                        setIsMockTest(false);
                        setCurrentTaskType(td.id);
                        setGenerationError(null);
                      }}
                      className={`flex-1 sm:flex-initial px-4 py-2 text-xs font-medium rounded-lg transition-all whitespace-nowrap cursor-pointer flex items-center justify-center gap-1.5 ${
                        isActive
                          ? 'bg-white text-slate-950 font-bold shadow-xs'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                      }`}
                    >
                      <span className="text-slate-400 font-normal text-[11px]">{td.section.slice(0, 1)} ·</span>
                      <span>{cleanLabel}</span>
                      {isReady && (
                        <span
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-bold text-emerald-800 bg-emerald-100 rounded-full"
                          title={`${readyCount} instant question${readyCount > 1 ? 's' : ''} pre-fetched and ready`}
                        >
                          <span>⚡</span>
                          {readyCount > 1 && <span>{readyCount}</span>}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Generator Controls Strip */}
            <section
              aria-label="Practice Parameters"
              className="space-y-2"
            >
              <div
                className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs flex flex-col md:flex-row items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3 flex-wrap w-full md:w-auto">
                  <div className="flex items-center gap-2">
                    <label htmlFor="select-level" className="text-xs text-slate-500 font-medium">
                      Proficiency Level:
                    </label>
                    <select
                      id="select-level"
                      value={level}
                      onChange={(e) => setLevel(e.target.value)}
                      className="text-xs bg-slate-50 border border-slate-200 text-slate-800 rounded-lg px-2.5 py-1.5 font-medium outline-hidden focus:border-teal-600"
                    >
                      <option value="all">All Levels</option>
                      {LEVELS.map((lvl) => (
                        <option key={lvl} value={lvl}>
                          {LEVEL_LABELS[lvl]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-center gap-2">
                    <label htmlFor="select-topic" className="text-xs text-slate-500 font-medium">
                      Academic Topic:
                    </label>
                    <select
                      id="select-topic"
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      className="text-xs bg-slate-50 border border-slate-200 text-slate-800 rounded-lg px-2.5 py-1.5 font-medium outline-hidden focus:border-teal-600"
                    >
                      <option value="all">All Topics</option>
                      {ACADEMIC_TOPICS.map((top) => (
                        <option key={top} value={top}>
                          {TOPIC_LABELS[top]}
                        </option>
                      ))}
                    </select>
                  </div>

                  {(currentTaskType === 'reading-academic' || currentTaskType === 'daily-life' || currentTaskType === 'reading-passage') && (
                    <div className="flex items-center gap-2">
                      <label htmlFor="select-skill-focus" className="text-xs text-teal-800 font-semibold flex items-center gap-1">
                        <Target className="w-3.5 h-3.5 text-teal-700" />
                        <span>Skill Focus:</span>
                      </label>
                      <select
                        id="select-skill-focus"
                        value={readingSkillFocus}
                        onChange={(e) => setReadingSkillFocus(e.target.value as ReadingQuestionSkill)}
                        className="text-xs bg-teal-50 border border-teal-200 text-teal-900 rounded-lg px-2.5 py-1.5 font-semibold outline-hidden focus:border-teal-700 cursor-pointer"
                      >
                        {READING_SKILL_OPTIONS.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {(() => {
                    const loadedAllForSection = getLoadedCuratedTasks(currentTaskType, 'all', 'all', practiceMode);
                    const sectionTotalCount = bankStats?.countsPerTaskType?.[currentTaskType] || loadedAllForSection.length || (practiceMode === 'coach' ? 2 : 10);
                    const exactFilterMatches = getFilteredBankTasks(currentTaskType, level, topic, practiceMode);
                    const poolForPracticed = exactFilterMatches.length > 0 ? exactFilterMatches : loadedAllForSection;
                    const completedSet = new Set(completedQuestionIds);
                    const practicedCount = poolForPracticed.filter((q) => isQuestionCompleted(q, completedSet)).length;
                    return (
                      <span className="text-[11px] text-slate-500 font-medium hidden sm:inline-flex items-center gap-1.5">
                        <Database className="w-3 h-3 text-teal-700 shrink-0" />
                        <span>
                          {exactFilterMatches.length > 0
                            ? `${exactFilterMatches.length}/${sectionTotalCount} in ${practiceMode === 'coach' ? 'coach bank' : 'bank'}`
                            : `0 exact filter matches (showing closest from ${sectionTotalCount} in ${practiceMode === 'coach' ? 'coach bank' : 'section'})`}
                        </span>
                        <span className="text-slate-300" aria-hidden="true">·</span>
                        <span className="text-emerald-700 font-semibold">
                          ✓ {practicedCount} practiced
                        </span>
                      </span>
                    );
                  })()}
                </div>

                <div className="flex items-center gap-2.5 w-full md:w-auto justify-end flex-wrap">
                  {/* Prefetch Control Group */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setEnablePrefetching((prev) => !prev)}
                      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg transition-all cursor-pointer whitespace-nowrap ${
                        enablePrefetching
                          ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
                          : 'bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200'
                      }`}
                      title="Toggle background question prefetching for the active task"
                    >
                      <span>{enablePrefetching ? '⚡ Prefetch: ON' : '⚪ Prefetch: OFF'}</span>
                    </button>

                    {enablePrefetching && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        {!hasAnyProviderKey() ? (
                          <span className="px-2.5 py-2 bg-amber-50 text-amber-800 border border-amber-200 text-xs font-medium rounded-lg whitespace-nowrap">
                            Key Required for Prefetch
                          </span>
                        ) : prefetchProgress.status === 'running' || liveReadyCount < totalInSection ? (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="flex items-center gap-1.5 px-2.5 py-2 bg-teal-50 text-teal-800 border border-teal-200 text-xs font-semibold rounded-lg whitespace-nowrap">
                              <span className="animate-spin inline-block w-3 h-3 border-2 border-teal-600 border-t-transparent rounded-full"></span>
                              <span>⏳ Prefetching {liveReadyCount}/{totalInSection}...</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => setPrefetchBatchCount((prev) => prev + 1)}
                              className="px-2.5 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 hover:border-slate-300 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1 cursor-pointer whitespace-nowrap shadow-2xs"
                              title={`Prefetch +1 more question for ${activeSection}`}
                            >
                              <span>↻ +1 More</span>
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="px-2.5 py-2 bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs font-semibold rounded-lg flex items-center gap-1 whitespace-nowrap">
                              <span>✅ {liveReadyCount}/{totalInSection} Ready</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => setPrefetchBatchCount((prev) => prev + 1)}
                              className="px-2.5 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 hover:border-slate-300 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1 cursor-pointer whitespace-nowrap shadow-2xs"
                              title={`Prefetch +1 more question for ${activeSection}`}
                            >
                              <span>↻ +1 More</span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {isAudioSection && (
                    <button
                      type="button"
                      onClick={handlePreCacheAudio}
                      disabled={isPreCachingAudio}
                      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-75 ${
                        preCacheStatus && (preCacheStatus.startsWith('✅') || preCacheStatus.includes('0ms ready'))
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-300'
                          : 'bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 shadow-2xs'
                      }`}
                      title="Pre-cache high-fidelity voices for the active question + next 2 unpracticed questions into IndexedDB (toefl_tts_audio_cache) for 0ms offline playback"
                    >
                      <Volume2 className={`w-3.5 h-3.5 ${isPreCachingAudio ? 'animate-pulse text-teal-600' : 'text-teal-700'}`} />
                      <span>
                        {isPreCachingAudio
                          ? preCacheStatus || '🔊 Pre-Caching 1/3...'
                          : preCacheStatus && preCacheStatus.startsWith('✅')
                          ? preCacheStatus
                          : 'Pre-Cache Audio'}
                      </span>
                    </button>
                  )}

                  <button
                    onClick={() => handleNextQuestion(currentTaskType)}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    title="Load next question from shared question bank or curated pool"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
                    <span>Next Question</span>
                  </button>

                  <button
                    onClick={handleGenerateNewAiTask}
                    disabled={isGenerating}
                    className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 rounded-lg shadow-xs transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      hasReadyTask(prefetchedQueue, currentTaskType, level, topic)
                        ? 'bg-emerald-700 hover:bg-emerald-800 ring-2 ring-emerald-500/20'
                        : 'bg-teal-800 hover:bg-teal-900'
                    }`}
                    title={
                      hasReadyTask(prefetchedQueue, currentTaskType, level, topic)
                        ? 'Instant generation from background cache'
                        : 'Generate customized TOEFL item with AI'
                    }
                  >
                    <Sparkles className="w-3.5 h-3.5 text-teal-300" />
                    <span>
                      {isGenerating
                        ? 'Generating Question...'
                        : hasReadyTask(prefetchedQueue, currentTaskType, level, topic)
                        ? 'Generate New (Instant ⚡)'
                        : 'Generate New with AI'}
                    </span>
                  </button>
                </div>

                {rateLimitPauseState && Date.now() < rateLimitPauseState.resumeAt && (() => {
                  const remainingSec = Math.max(1, Math.ceil((rateLimitPauseState.resumeAt - Date.now()) / 1000));
                  const remainingMin = Math.ceil(remainingSec / 60);
                  const msg = rateLimitPauseState.kind === 'per-day'
                    ? `Prefetch paused: daily quota reached, retrying in ${remainingMin}m`
                    : `Prefetch paused: rate limited, retrying in ${remainingSec}s`;
                  return (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-lg flex items-center gap-2 mt-2 w-full md:w-auto">
                      <span>{msg}</span>
                      <button
                        onClick={() => {
                          setRateLimitPauseState(null);
                          quotaExhaustedUntilRef.current = 0;
                        }}
                        className="font-semibold text-teal-800 hover:text-teal-950 underline cursor-pointer"
                      >
                        Resume prefetch now
                      </button>
                    </div>
                  );
                })()}
              </div>
            </section>
          </>
        )}

        {generationError && (
          (generationError.toLowerCase().includes('no api key') ||
           generationError.toLowerCase().includes('invalid api key') ||
           generationError.toLowerCase().includes('api key not valid') ||
           generationError.toLowerCase().includes('add yours in dashboard') ||
           generationError.toLowerCase().includes('settings & api key')) ? (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2 text-amber-900 relative">
              <button
                onClick={() => setGenerationError(null)}
                className="absolute top-3 right-3 text-amber-600 hover:text-amber-800 p-1 rounded-md cursor-pointer transition-colors"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2 font-semibold text-sm pr-6">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>Add your free API key to use AI features</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
                <button
                  onClick={() => {
                    setDashboardDefaultTab('settings');
                    setIsDashboardOpen(true);
                  }}
                  className="px-3 py-1.5 bg-teal-800 hover:bg-teal-900 text-white font-semibold rounded-lg transition-colors cursor-pointer"
                >
                  Configure API Key
                </button>
                <span className="text-slate-500 font-medium">Supports Gemini, NVIDIA, Groq, OpenRouter, and custom keys</span>
              </div>
            </div>
          ) : (generationError.toLowerCase().includes('quota') ||
               generationError.toLowerCase().includes('rate limit') ||
               generationError.toLowerCase().includes('429') ||
               generationError.toLowerCase().includes('resource_exhausted')) ? (
            <div className="p-4 bg-amber-50 border border-amber-300 rounded-xl space-y-2.5 text-amber-950 relative shadow-xs">
              <button
                onClick={() => setGenerationError(null)}
                className="absolute top-3 right-3 text-amber-600 hover:text-amber-800 p-1 rounded-md cursor-pointer transition-colors"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2 font-bold text-sm text-amber-900 pr-6">
                <AlertCircle className="w-4.5 h-4.5 text-amber-600 shrink-0" />
                <span>API Quota Limit Reached (Fallback Models Attempted)</span>
              </div>
              <p className="text-xs text-amber-800 leading-relaxed">
                {generationError}
              </p>
              <div className="p-2.5 bg-white/80 rounded-lg border border-amber-200 text-xs space-y-1.5">
                <div className="font-semibold text-slate-700">Quick options:</div>
                <div className="text-slate-600">
                  1. <strong>Wait for reset:</strong> Free minute quotas reset in 1-2 minutes; daily quotas reset in 1 hour or at midnight UTC.
                </div>
                <div className="text-slate-600 flex items-center flex-wrap gap-2">
                  <span>2. <strong>Switch to another free API key:</strong></span>
                  <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-teal-700 font-bold underline hover:text-teal-900">OpenRouter (Free)</a>
                  <span>·</span>
                  <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="text-teal-700 font-bold underline hover:text-teal-900">Groq (Free)</a>
                  <span>·</span>
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-teal-700 font-bold underline hover:text-teal-900">Gemini (Free)</a>
                  <span>·</span>
                  <a href="https://build.nvidia.com" target="_blank" rel="noreferrer" className="text-teal-700 font-bold underline hover:text-teal-900">NVIDIA (Free)</a>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
                <button
                  onClick={() => {
                    setGenerationError(null);
                    setRateLimitPauseState(null);
                    quotaExhaustedUntilRef.current = 0;
                    handleGenerateNewAiTask();
                  }}
                  className="px-3.5 py-1.5 bg-amber-700 hover:bg-amber-800 text-white font-semibold rounded-lg transition-colors cursor-pointer shadow-2xs flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Retry with AI Now
                </button>
                <button
                  onClick={() => {
                    setDashboardDefaultTab('settings');
                    setIsDashboardOpen(true);
                  }}
                  className="px-3.5 py-1.5 bg-teal-800 hover:bg-teal-900 text-white font-semibold rounded-lg transition-colors cursor-pointer shadow-2xs"
                >
                  Open API Settings
                </button>
                <button
                  onClick={() => setGenerationError(null)}
                  className="px-3 py-1.5 bg-white border border-amber-300 hover:bg-amber-100 text-amber-900 font-medium rounded-lg transition-colors cursor-pointer"
                >
                  Dismiss &amp; Use Curated Tasks
                </button>
              </div>
            </div>
          ) : (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2 text-amber-900 relative">
              <button
                onClick={() => setGenerationError(null)}
                className="absolute top-3 right-3 text-amber-600 hover:text-amber-800 p-1 rounded-md cursor-pointer transition-colors"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2 font-semibold text-sm pr-6">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>{generationError}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
                <button
                  onClick={() => {
                    setDashboardDefaultTab('settings');
                    setIsDashboardOpen(true);
                  }}
                  className="px-3 py-1.5 bg-teal-800 hover:bg-teal-900 text-white font-semibold rounded-lg transition-colors cursor-pointer"
                >
                  Dashboard &gt; API Key
                </button>
                <button
                  onClick={() => setGenerationError(null)}
                  className="px-3 py-1.5 bg-white border border-amber-300 hover:bg-amber-100 text-amber-800 font-medium rounded-lg transition-colors cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )
        )}

        {sharedBankNotice && (
          <div className="bg-teal-50 border border-teal-200 rounded-xl p-3 text-xs text-teal-800 flex items-center justify-between animate-in fade-in">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0" />
              <span>{sharedBankNotice}</span>
            </div>
          </div>
        )}

        {tierNotice && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 flex items-center justify-between animate-in fade-in">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>{tierNotice}</span>
            </div>
            <button
              onClick={() => setTierNotice(null)}
              className="text-amber-600 hover:text-amber-800 p-0.5 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {generationSuccess && (
          <div className="bg-teal-50 border border-teal-200 rounded-xl p-3 text-xs text-teal-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0" />
              <span>
                {lastGenerationWasInstant
                  ? '⚡ Question loaded instantly from background cache!'
                  : 'Successfully generated with AI'}
              </span>
            </div>
            {lastModelUsed && (
              <span className="text-[10px] bg-teal-100 text-teal-900 px-2 py-0.5 rounded-full font-mono">
                Generated with {lastModelUsed}
              </span>
            )}
          </div>
        )}

        {/* Global Select-to-Save Vocabulary Handler */}
        <SelectionHandler taskType={currentTaskType} />

        {/* Interactive Task Stage */}
        <section aria-label="Interactive Task Workspace" className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-xs">
          {isMockTest ? (
            <Suspense fallback={null}>
              <MockTestView />
            </Suspense>
          ) : (
            <>
              {reportError && (
                <div className="mb-4 p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-xs flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span>{reportError}</span>
                  </div>
                  <button onClick={() => setReportError(null)} className="text-rose-600 hover:text-rose-800 p-0.5 cursor-pointer">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {currentTaskType === 'complete-words' && (
                <CompleteWordsView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as CompleteWordsTask}
                  coachMode={practiceMode === 'coach'}
                  wordWrapperClassName="inline-flex items-baseline whitespace-nowrap"
                  blankInputClassName="text-base font-semibold"
                  onComplete={() => markQuestionCompleted(activeTask)}
                  onNextTask={() => handleNextQuestion('complete-words')}
                />
              )}

              {currentTaskType === 'daily-life' && (
                <DailyLifeView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as any}
                  coachMode={practiceMode === 'coach'}
                  skillFocus={readingSkillFocus}
                  leftColumnClassName="lg:sticky lg:top-6 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"
                  rightColumnClassName="lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-2 scroll-smooth"
                  footerBarClassName="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200"
                  onComplete={() => markQuestionCompleted(activeTask)}
                  onNextTask={() => handleNextQuestion('daily-life')}
                />
              )}

              {(currentTaskType === 'reading-academic' || currentTaskType === 'reading-passage') && (
                <ReadingPassageView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as ReadingPassageTask}
                  coachMode={practiceMode === 'coach'}
                  skillFocus={readingSkillFocus}
                  leftColumnClassName="lg:sticky lg:top-6 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"
                  rightColumnClassName="lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-2 scroll-smooth"
                  footerBarClassName="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200"
                  onComplete={() => markQuestionCompleted(activeTask)}
                  onNextTask={() => handleNextQuestion(currentTaskType)}
                />
              )}

              {currentTaskType === 'listening-choose-response' && (
                <ListeningChooseResponseView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as any}
                  coachMode={practiceMode === 'coach'}
                  onComplete={() => markQuestionCompleted(activeTask)}
                  onNextTask={() => handleNextQuestion('listening-choose-response')}
                />
              )}

              {(currentTaskType === 'listening-dialogue' || currentTaskType === 'listening-conversation') && (
                <ListeningDialogueView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as ListeningTask}
                  coachMode={practiceMode === 'coach'}
                  leftColumnClassName="lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"
                  rightColumnClassName="lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-2 scroll-smooth"
                  footerBarClassName="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200"
                  excerptBadgeLabel="🎧 Listen again to part of the conversation"
                  onComplete={() => markQuestionCompleted(activeTask)}
                  onNextTask={() => handleNextQuestion(currentTaskType)}
                />
              )}

              {currentTaskType === 'listening-announcement' && (
                <ListeningAnnouncementView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as any}
                  coachMode={practiceMode === 'coach'}
                  leftColumnClassName="lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"
                  rightColumnClassName="lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-2 scroll-smooth"
                  footerBarClassName="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200"
                  onComplete={() => markQuestionCompleted(activeTask)}
                  onNextTask={() => handleNextQuestion('listening-announcement')}
                />
              )}

              {(currentTaskType === 'listening-academic-talk' || currentTaskType === 'listening-lecture') && (
                <ListeningAcademicTalkView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as any}
                  coachMode={practiceMode === 'coach'}
                  leftColumnClassName="lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"
                  rightColumnClassName="lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-2 scroll-smooth"
                  footerBarClassName="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200"
                  excerptBadgeLabel="🎧 Listen again to part of the talk"
                  onComplete={() => markQuestionCompleted(activeTask)}
                  onNextTask={() => handleNextQuestion(currentTaskType)}
                />
              )}

              {currentTaskType === 'build-sentence' && (
                <BuildSentenceView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as BuildSentenceTask}
                  coachMode={practiceMode === 'coach'}
                  onComplete={() => markQuestionCompleted(activeTask)}
                  onNextTask={() => handleNextQuestion(currentTaskType)}
                />
              )}

              {currentTaskType === 'write-email' && (
                <WriteEmailView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as WriteEmailTask}
                  coachMode={practiceMode === 'coach'}
                  spellCheck={false}
                  annotatedReviewTitle="Annotated Response Review (Errors & Wording Highlights)"
                  localGraderLabel="⚡ Instant Local Grader"
                  aiGraderLabel="✨ Deep AI Grader"
                  apiKeyPromptText="Want deeper semantic AI grading? Add a free Groq/Gemini key in Settings"
                  isWritingTimerEnabled={isWritingTimerEnabled}
                  onToggleWritingTimer={(enabled) => {
                    setIsWritingTimerEnabled(enabled);
                    if (enabled) {
                      if (writingTimerSeconds <= 0) setWritingTimerSeconds(420);
                      setIsWritingTimerRunning(true);
                    } else {
                      setIsWritingTimerRunning(false);
                    }
                  }}
                  isWritingTimerRunning={isWritingTimerRunning}
                  onChangeWritingTimerRunning={setIsWritingTimerRunning}
                  writingTimerSeconds={writingTimerSeconds}
                  onChangeWritingTimerSeconds={setWritingTimerSeconds}
                  onComplete={() => markQuestionCompleted(activeTask)}
                  onNextTask={() => handleNextQuestion(currentTaskType)}
                  onOpenApiKeySettings={() => {
                    setDashboardDefaultTab('settings');
                    setIsDashboardOpen(true);
                  }}
                />
              )}

              {currentTaskType === 'academic-discussion' && (
                <AcademicDiscussionView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as AcademicDiscussionTask}
                  coachMode={practiceMode === 'coach'}
                  spellCheck={false}
                  annotatedReviewTitle="Annotated Response Review (Errors & Wording Highlights)"
                  localGraderLabel="⚡ Instant Local Grader"
                  aiGraderLabel="✨ Deep AI Grader"
                  apiKeyPromptText="Want deeper semantic AI grading? Add a free Groq/Gemini key in Settings"
                  isWritingTimerEnabled={isWritingTimerEnabled}
                  onToggleWritingTimer={(enabled) => {
                    setIsWritingTimerEnabled(enabled);
                    if (enabled) {
                      if (writingTimerSeconds <= 0) setWritingTimerSeconds(600);
                      setIsWritingTimerRunning(true);
                    } else {
                      setIsWritingTimerRunning(false);
                    }
                  }}
                  isWritingTimerRunning={isWritingTimerRunning}
                  onChangeWritingTimerRunning={setIsWritingTimerRunning}
                  writingTimerSeconds={writingTimerSeconds}
                  onChangeWritingTimerSeconds={setWritingTimerSeconds}
                  onComplete={() => markQuestionCompleted(activeTask)}
                  onNextTask={() => handleNextQuestion(currentTaskType)}
                  onOpenApiKeySettings={() => {
                    setDashboardDefaultTab('settings');
                    setIsDashboardOpen(true);
                  }}
                />
              )}

              {currentTaskType === 'listen-repeat' && (
                <ListenRepeatView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as ListenRepeatTask}
                  coachMode={practiceMode === 'coach'}
                  activeCardHighlightClass="ring-2 ring-emerald-500 shadow-md"
                  onComplete={() => {
                    markQuestionCompleted(activeTask);
                    document.getElementById('listen-repeat-cumulative-result')?.scrollIntoView({
                      behavior: 'smooth',
                      block: 'center',
                    });
                  }}
                  onNextTask={() => handleNextQuestion(currentTaskType)}
                />
              )}

              {currentTaskType === 'speaking-interview' && (
                <SpeakingInterviewView
                  key={`${practiceMode}-${activeTask.id || (activeTask as any).title}-${taskResetNonce}`}
                  task={activeTask as SpeakingInterviewTask}
                  coachMode={practiceMode === 'coach'}
                  activeCardHighlightClass="ring-2 ring-emerald-500 shadow-md"
                  localGraderLabel="⚡ Instant Local Grader"
                  aiGraderLabel="✨ Deep AI Grader"
                  apiKeyPromptText="Want deeper semantic AI grading? Add a free Groq/Gemini key in Settings"
                  onComplete={() => {
                    markQuestionCompleted(activeTask);
                    document.getElementById('interview-evaluation-result')?.scrollIntoView({
                      behavior: 'smooth',
                      block: 'center',
                    });
                  }}
                  onNextTask={() => handleNextQuestion('speaking-interview')}
                  onOpenApiKeySettings={() => {
                    setDashboardDefaultTab('settings');
                    setIsDashboardOpen(true);
                  }}
                />
              )}
            </>
          )}
        </section>
      </main>

      {/* Footer following anti-slop rules: quiet, clean links and copyright */}
      <footer className="border-t border-slate-200 bg-white mt-12 py-6 text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span>TOEFL Prep Studio</span>
            <span aria-hidden="true">·</span>
            <span>ETS-Format Practice Suite</span>
            <span aria-hidden="true">·</span>
            <span>Local Browser Simulation</span>
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <button
              onClick={() => setIsRubricsOpen(true)}
              className="hover:text-slate-900 transition-colors cursor-pointer"
            >
              Scoring Rubric Reference
            </button>
            <button
              onClick={() => setIsHistoryOpen(true)}
              className="hover:text-slate-900 transition-colors cursor-pointer"
            >
              View Analytics
            </button>
            <GlobalReportButton />
          </div>
        </div>
      </footer>

      {/* Diagnostic Voice Fallback Toast */}
      <VoiceDiagnosticToast
        onOpenSettings={() => {
          setDashboardDefaultTab('settings');
          setIsDashboardOpen(true);
        }}
      />

      {/* Modals */}
      <RubricGuideModal isOpen={isRubricsOpen} onClose={() => setIsRubricsOpen(false)} />
      <SystemStatusModal isOpen={isStatusModalOpen} onClose={() => setIsStatusModalOpen(false)} />
      <DevQuestionEditorModal
        isOpen={Boolean(devEditorTask)}
        task={devEditorTask}
        mode={devEditorMode}
        onClose={() => setDevEditorTask(null)}
        onSaved={(updated) => {
          const targetType = (updated.taskType || currentTaskType) as TaskTypeId;
          setCustomTasks((prev) => ({
            ...prev,
            [targetType]: normalizeTaskData({ ...updated, isManualDevEdit: true }, targetType),
          }));
          setTaskResetNonce((n) => n + 1);
          getQuestionBankStats(practiceMode).then(setBankStats).catch(() => {});
          setSharedBankNotice('Question changes saved to IndexedDB & Firestore!');
          setTimeout(() => setSharedBankNotice(null), 3500);
        }}
        onDeleted={() => {
          getQuestionBankStats(practiceMode).then(setBankStats).catch(() => {});
          setSharedBankNotice('🗑️ Question permanently deleted from bank.');
          setTimeout(() => setSharedBankNotice(null), 3500);
          handleNextQuestion(currentTaskType);
        }}
      />

      <Suspense fallback={null}>
        <PerformanceHistoryModal
          isOpen={isHistoryOpen}
          onClose={() => setIsHistoryOpen(false)}
          onResetProgress={handleResetAllProgress}
        />
        <DashboardModal 
          isOpen={isDashboardOpen} 
          onClose={() => setIsDashboardOpen(false)} 
          defaultTab={dashboardDefaultTab}
          currentTaskType={currentTaskType}
          practiceMode={practiceMode}
          openHistory={() => { setIsDashboardOpen(false); setIsHistoryOpen(true); }}
          openRubrics={() => { setIsDashboardOpen(false); setIsRubricsOpen(true); }}
          onResetProgress={handleResetAllProgress}
          onNavigateToTask={(target) => {
            setIsDashboardOpen(false);
            const lower = (target || '').toLowerCase();
            if (lower === 'speaking' || lower === 'speaking-interview') {
              setCurrentTaskType('speaking-interview');
            } else if (lower === 'listening' || lower === 'listening-dialogue') {
              setCurrentTaskType('listening-dialogue');
            } else if (lower === 'listen-repeat') {
              setCurrentTaskType('listen-repeat');
            } else if (lower === 'writing' || lower === 'academic-discussion') {
              setCurrentTaskType('academic-discussion');
            } else if (lower === 'write-email') {
              setCurrentTaskType('write-email');
            } else if (lower === 'build-sentence') {
              setCurrentTaskType('build-sentence');
            } else if (lower === 'reading' || lower === 'reading-passage') {
              setCurrentTaskType('reading-passage');
            } else if (lower === 'complete-words') {
              setCurrentTaskType('complete-words');
            }
          }}
        />
      </Suspense>
    </div>
  );
}
