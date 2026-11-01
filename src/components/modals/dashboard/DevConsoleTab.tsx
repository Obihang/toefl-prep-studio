import React, { useState, useEffect, useMemo } from 'react';
import {
  Users,
  Search,
  RefreshCw,
  Edit3,
  Trash2,
  CheckCircle2,
  Sparkles,
  Award,
  Clock,
  Database,
  Flag,
  Lock,
  Activity,
  Download,
  Layers,
  Zap,
  Check,
  X,
} from 'lucide-react';
import {
  AppUserRecord,
  ReportedItemRecord,
  fetchAllAppUsers,
  fetchAllReportedQuestions,
  resolveOrDeleteReport,
  getLoadedCuratedTasks,
  deleteQuestionFromBank,
  ALL_TASK_TYPES,
  lockDevAdmin,
  saveQuestionToSharedBank,
  exportFullDatabaseBackupJson,
  scanAndRemoveDuplicates,
  repairAndAuditQuestionBank,
  reSyncAllShards,
  canonicalizeTaskType,
  incrementAiGeneratedCount,
} from '../../../utils/questionBankStorage';
import {
  getProviderPoolStatus,
  resetAllProviderCooldowns,
  ProviderPoolStatusItem,
  callBackendGenerate,
  runWithDynamicKeyPool,
} from '../../../services/geminiService';
import {
  syncAndGetMockExamSets,
  deleteMockExamSet,
  updateMockExamSetTitle,
} from '../../../utils/examStorage';
import { MockExamSet } from '../../../utils/mockExamSetsBank';
import { normalizeTaskData } from '../../../utils/taskNormalizer';
import { TASK_DEFINITIONS } from '../../../types/taskTypes';
import {
  LEVEL_LABELS,
  TOPIC_LABELS,
  LEVELS,
  ACADEMIC_TOPICS,
  isValidLevel,
  isValidAcademicTopic,
} from '../../../constants/filters';

interface DevConsoleTabProps {
  practiceMode?: 'exam' | 'coach';
  currentTaskType?: string;
  onOpenDevConsoleQuestionEditor?: (task: any, mode: 'exam' | 'coach') => void;
  onBankModified?: () => void;
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return 'Unknown';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'Just now';
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

const SECTION_TASKS_MAP: Record<string, string[]> = {
  Reading: ['complete-words', 'daily-life', 'reading-academic'],
  Listening: [
    'listening-choose-response',
    'listening-dialogue',
    'listening-announcement',
    'listening-academic-talk',
  ],
  Writing: ['build-sentence', 'write-email', 'academic-discussion'],
  Speaking: ['listen-repeat', 'speaking-interview'],
};

function inferSectionFromTaskType(taskType?: string): 'Reading' | 'Listening' | 'Writing' | 'Speaking' {
  const canonical = canonicalizeTaskType(taskType || 'complete-words');
  for (const [sec, list] of Object.entries(SECTION_TASKS_MAP)) {
    if (list.includes(canonical)) {
      return sec as 'Reading' | 'Listening' | 'Writing' | 'Speaking';
    }
  }
  return 'Reading';
}

export const DevConsoleTab: React.FC<DevConsoleTabProps> = ({
  practiceMode = 'exam',
  currentTaskType = 'complete-words',
  onOpenDevConsoleQuestionEditor,
  onBankModified,
}) => {
  const [users, setUsers] = useState<AppUserRecord[]>([]);
  const [reports, setReports] = useState<ReportedItemRecord[]>([]);
  const [mockSets, setMockSets] = useState<MockExamSet[]>([]);
  const [loadingUsers, setLoadingUsers] = useState<boolean>(true);
  const [loadingReports, setLoadingReports] = useState<boolean>(true);
  const [userSearch, setUserSearch] = useState<string>('');

  // 1. Live Multi-Key Worker Pool Monitor State
  const [poolStatus, setPoolStatus] = useState<ProviderPoolStatusItem[]>(() =>
    getProviderPoolStatus()
  );

  // 2. Admin Bulk AI Seeder State
  const activeSectionName = useMemo(
    () => inferSectionFromTaskType(currentTaskType),
    [currentTaskType]
  );
  const [seederTargetMode, setSeederTargetMode] = useState<'exam' | 'coach'>(practiceMode);
  const [seederScope, setSeederScope] = useState<'current_section' | 'all_12'>('current_section');
  const [seederCountPerTask, setSeederCountPerTask] = useState<1 | 2>(1);
  const [seederRunning, setSeederRunning] = useState<boolean>(false);
  const [seederProgress, setSeederProgress] = useState<{
    done: number;
    total: number;
    saved: number;
    currentLabel: string;
  }>({ done: 0, total: 0, saved: 0, currentLabel: '' });

  // 3. Database Browser, Search & 1-Click Delete/Edit State
  const [managerMode, setManagerMode] = useState<'exam' | 'coach' | 'mock_sets'>(practiceMode);
  const [managerTaskFilter, setManagerTaskFilter] = useState<string>('all');
  const [managerSearch, setManagerSearch] = useState<string>('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingMockSetId, setEditingMockSetId] = useState<string | null>(null);
  const [editingMockSetTitle, setEditingMockSetTitle] = useState<string>('');

  // 4. Backup & Duplicate Scanner State
  const [exportingBackup, setExportingBackup] = useState<boolean>(false);
  const [scanningDuplicates, setScanningDuplicates] = useState<boolean>(false);

  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState<number>(0);

  const showBanner = (msg: string, ms: number = 4500) => {
    setStatusBanner(msg);
    setTimeout(() => {
      setStatusBanner((prev) => (prev === msg ? null : prev));
    }, ms);
  };

  // Subscribe to live API Key Pool status
  useEffect(() => {
    const refreshPool = () => setPoolStatus(getProviderPoolStatus());
    refreshPool();
    const interval = setInterval(refreshPool, 1000);
    window.addEventListener('toefl_pool_status_updated', refreshPool);
    window.addEventListener('apiKeyUpdated', refreshPool);
    return () => {
      clearInterval(interval);
      window.removeEventListener('toefl_pool_status_updated', refreshPool);
      window.removeEventListener('apiKeyUpdated', refreshPool);
    };
  }, []);

  const loadDirectoryAndReports = async () => {
    setLoadingUsers(true);
    setLoadingReports(true);
    try {
      const [fetchedUsers, fetchedReports, fetchedMockSets] = await Promise.all([
        fetchAllAppUsers(),
        fetchAllReportedQuestions(),
        syncAndGetMockExamSets(),
      ]);
      setUsers(fetchedUsers);
      setReports(fetchedReports);
      setMockSets(fetchedMockSets);
    } finally {
      setLoadingUsers(false);
      setLoadingReports(false);
    }
  };

  useEffect(() => {
    loadDirectoryAndReports();
  }, [refreshTick]);

  useEffect(() => {
    const onBankChange = () => setRefreshTick((t) => t + 1);
    window.addEventListener('toefl_bank_updated', onBankChange);
    window.addEventListener('toefl_mock_sets_updated', onBankChange);
    return () => {
      window.removeEventListener('toefl_bank_updated', onBankChange);
      window.removeEventListener('toefl_mock_sets_updated', onBankChange);
    };
  }, []);

  const configuredProvidersCount = useMemo(
    () => poolStatus.filter((p) => p.configured).length,
    [poolStatus]
  );

  // Admin Bulk AI Seeder Handler
  const handleRunBulkSeeder = async () => {
    if (seederRunning) return;
    const taskTypesToSeed =
      seederScope === 'current_section'
        ? SECTION_TASKS_MAP[activeSectionName] || SECTION_TASKS_MAP.Reading
        : ALL_TASK_TYPES;

    const totalJobs = taskTypesToSeed.length * seederCountPerTask;
    setSeederRunning(true);
    setSeederProgress({
      done: 0,
      total: totalJobs,
      saved: 0,
      currentLabel: 'Initializing multi-key worker pool...',
    });

    let completedCount = 0;
    let savedCount = 0;

    const jobs = [];
    for (const tId of taskTypesToSeed) {
      const taskDef = TASK_DEFINITIONS.find((d) => d.id === tId);
      const taskLabel = taskDef?.name || tId;

      for (let i = 0; i < seederCountPerTask; i++) {
        const pickedLevel = LEVELS[(i + tId.length) % LEVELS.length] || 'upper-intermediate';
        const pickedTopic =
          ACADEMIC_TOPICS[(i * 3 + tId.length) % ACADEMIC_TOPICS.length] || 'natural-sciences';

        jobs.push(async () => {
          setSeederProgress((prev) => ({
            ...prev,
            currentLabel: `Generating ${taskLabel} (${LEVEL_LABELS[pickedLevel] || pickedLevel})...`,
          }));
          try {
            const resp = await callBackendGenerate(
              tId,
              pickedLevel,
              pickedTopic,
              seederTargetMode
            );
            if (resp && resp.success && resp.data && !resp.data.isFallback) {
              const normalized = normalizeTaskData(resp.data, tId) as any;
              normalized.level = pickedLevel;
              normalized.difficulty = pickedLevel;
              normalized.topic = pickedTopic;
              normalized.mode = seederTargetMode;
              normalized.createdBy = 'Obi';
              normalized.generatedBy = 'Obi';

              await saveQuestionToSharedBank(
                {
                  taskType: tId,
                  level: pickedLevel,
                  topic: pickedTopic,
                  content: normalized,
                  source: 'ai',
                  generatedBy: 'Obi',
                  mode: seederTargetMode,
                },
                seederTargetMode
              );
              incrementAiGeneratedCount(1);
              savedCount++;
            }
          } catch (err) {
            console.warn(`[AdminBulkSeeder] Failed to seed ${tId}:`, err);
          } finally {
            completedCount++;
            setSeederProgress({
              done: completedCount,
              total: totalJobs,
              saved: savedCount,
              currentLabel:
                completedCount >= totalJobs
                  ? `Completed! Saved ${savedCount}/${totalJobs} new AI questions.`
                  : `Seeded ${completedCount}/${totalJobs} (${taskLabel})...`,
            });
          }
        });
      }
    }

    try {
      await runWithDynamicKeyPool(jobs);
      setRefreshTick((t) => t + 1);
      onBankModified?.();
      window.dispatchEvent(new CustomEvent('toefl_bank_updated'));
      showBanner(
        `Bulk AI Seeder finished: ${savedCount} new ${
          seederTargetMode === 'coach' ? 'Coach Mode' : 'Exam Mode'
        } questions generated and saved to Firestore & IndexedDB!`
      );
    } finally {
      setSeederRunning(false);
    }
  };

  // Backup Export Handler
  const handleExportBackup = async () => {
    if (exportingBackup) return;
    setExportingBackup(true);
    try {
      const jsonStr = await exportFullDatabaseBackupJson(mockSets);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStamp = new Date().toISOString().split('T')[0];
      a.href = url;
      a.download = `toefl-prep-studio-backup-${dateStamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showBanner('Exported full database backup (.json) for Exam Bank, Coach Bank, and Mock Exam Sets!');
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setExportingBackup(false);
    }
  };

  // Repair, Audit & Duplicate Scanner Handler
  const handleScanDuplicates = async () => {
    if (scanningDuplicates) return;
    setScanningDuplicates(true);
    try {
      const res = await repairAndAuditQuestionBank('both');
      setRefreshTick((t) => t + 1);
      onBankModified?.();
      showBanner(
        `🛠️ Bank Repair & Audit Complete — Scanned: ${res.scanned} | Repaired: ${res.repaired} | Duplicates Removed: ${res.duplicatesRemoved} | Corrupted Purged: ${res.corruptedPurged} | Total Clean: ${res.totalClean}`
      );
    } finally {
      setScanningDuplicates(false);
    }
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q)
    );
  }, [users, userSearch]);

  const activeTodayCount = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return users.filter((u) => u.lastActiveAt >= oneDayAgo).length;
  }, [users]);

  const totalPracticedAcrossUsers = useMemo(
    () => users.reduce((acc, u) => acc + (u.questionsPracticed || 0), 0),
    [users]
  );

  const totalGeneratedAcrossUsers = useMemo(
    () => users.reduce((acc, u) => acc + (u.questionsGenerated || 0), 0),
    [users]
  );

  const allBankQuestions = useMemo(() => {
    if (managerMode === 'mock_sets') return [];
    const targetTypes =
      managerTaskFilter === 'all' ? ALL_TASK_TYPES : [managerTaskFilter];
    const items: any[] = [];
    for (const tId of targetTypes) {
      const list = getLoadedCuratedTasks(tId, 'all', 'all', managerMode);
      for (const q of list) {
        items.push({ ...q, taskType: q.taskType || tId });
      }
    }
    const qStr = managerSearch.trim().toLowerCase();
    if (!qStr) return items.slice(0, 100);
    return items
      .filter((item) => {
        const title = String(item.title || item.topic || '').toLowerCase();
        const id = String(item.id || item.questionDocId || '').toLowerCase();
        const taskTypeStr = String(item.taskType || '').toLowerCase();
        const author = String(item.createdBy || item.generatedBy || 'Obi').toLowerCase();
        const body = String(
          item.passage || item.text || item.script || item.professorPrompt || ''
        ).toLowerCase();
        return (
          title.includes(qStr) ||
          id.includes(qStr) ||
          taskTypeStr.includes(qStr) ||
          author.includes(qStr) ||
          body.includes(qStr)
        );
      })
      .slice(0, 100);
  }, [managerMode, managerTaskFilter, managerSearch, refreshTick]);

  const filteredMockSets = useMemo(() => {
    const qStr = managerSearch.trim().toLowerCase();
    if (!qStr) return mockSets;
    return mockSets.filter(
      (s) =>
        s.title.toLowerCase().includes(qStr) ||
        s.id.toLowerCase().includes(qStr) ||
        String(s.source || '').toLowerCase().includes(qStr)
    );
  }, [mockSets, managerSearch]);

  const handleDeleteQuestion = async (q: any) => {
    if (managerMode === 'mock_sets') return;
    const qId = String(q.questionDocId || q.id || '');
    await deleteQuestionFromBank(qId, managerMode, q);
    setConfirmDeleteId(null);
    showBanner(
      `Deleted question "${q.title || qId}" from ${
        managerMode === 'coach' ? 'Coach' : 'Exam'
      } Bank.`
    );
    setRefreshTick((t) => t + 1);
    onBankModified?.();
  };

  const handleDeleteMockSet = async (set: MockExamSet) => {
    await deleteMockExamSet(set.id);
    setConfirmDeleteId(null);
    showBanner(`Deleted Full Mock Exam Set "${set.title}" (${set.id}).`);
    setRefreshTick((t) => t + 1);
    onBankModified?.();
  };

  const handleSaveMockSetTitle = async (setId: string) => {
    if (!editingMockSetTitle.trim()) return;
    await updateMockExamSetTitle(setId, editingMockSetTitle.trim());
    setEditingMockSetId(null);
    showBanner(`Updated Mock Exam Set title to "${editingMockSetTitle.trim()}".`);
    setRefreshTick((t) => t + 1);
  };

  const handleResolveReport = async (rep: ReportedItemRecord) => {
    await resolveOrDeleteReport(rep.id, rep.type);
    setReports((prev) => prev.filter((r) => r.id !== rep.id));
    showBanner('Report dismissed and marked as resolved.');
  };

  return (
    <div className="space-y-6">
      {/* Top Dev Admin Status Bar + Backup & Duplicate Tools */}
      <div className="p-4 bg-slate-900 text-white rounded-2xl border border-slate-800 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 shadow-md">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/30 flex items-center justify-center text-lg shrink-0">
            🛠️
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-white">Developer Admin Console</h3>
              <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-full">
                @Obi / @Obihang Unlocked
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Multi-Key Pool Monitor, Bulk AI Seeder, Database Inspector, Backup Export, and User Reports Inbox
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap self-end lg:self-center">
          <button
            type="button"
            onClick={handleExportBackup}
            disabled={exportingBackup}
            className="px-3 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{exportingBackup ? 'Exporting...' : '📥 Export Database Backup (.json)'}</span>
          </button>

          <button
            type="button"
            onClick={handleScanDuplicates}
            disabled={scanningDuplicates}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs"
          >
            <Layers className="w-3.5 h-3.5" />
            <span>{scanningDuplicates ? 'Scanning...' : '🧹 Scan & Remove Duplicates'}</span>
          </button>

          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${
                loadingUsers ? 'animate-spin text-teal-400' : 'text-teal-400'
              }`}
            />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            onClick={() => lockDevAdmin()}
            title="Lock Developer Mode"
            className="px-3 py-1.5 bg-rose-950/80 hover:bg-rose-900 text-rose-200 border border-rose-800 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>Lock</span>
          </button>
        </div>
      </div>

      {statusBanner && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-semibold text-emerald-900 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{statusBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusBanner(null)}
            className="text-emerald-700 hover:text-emerald-900 text-xs font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* TOOL 1: Live Multi-Key Worker Pool & Quota Monitor */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Activity className="w-4 h-4 text-teal-700" />
              <span>⚡ Live Multi-Key Worker Pool &amp; Quota Monitor ({configuredProvidersCount}/8 Configured)</span>
            </h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Real-time concurrency, cooldown timers, and session request volume across all 8 AI providers
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              resetAllProviderCooldowns();
              setPoolStatus(getProviderPoolStatus());
              showBanner('All provider rate-limit cooldowns have been reset to Idle!');
            }}
            className="px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors self-start sm:self-center"
          >
            <span>↻ Reset All Cooldowns</span>
          </button>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-xl">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
                <th className="py-2.5 px-3">Provider</th>
                <th className="py-2.5 px-3">API Key</th>
                <th className="py-2.5 px-3">Current State</th>
                <th className="py-2.5 px-3 text-right">In-Flight</th>
                <th className="py-2.5 px-3 text-right">Cooldown Left</th>
                <th className="py-2.5 px-3 text-right">Requests Served (Session)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {poolStatus.map((item) => (
                <tr key={item.provider} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-2 px-3 font-bold text-slate-900">{item.name}</td>
                  <td className="py-2 px-3 font-mono text-[11px] text-slate-500">
                    {item.maskedKey}
                  </td>
                  <td className="py-2 px-3">
                    {item.state === 'Idle' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        Idle
                      </span>
                    )}
                    {item.state === 'Busy' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-teal-50 text-teal-800 border border-teal-200">
                        <span className="w-1.5 h-1.5 rounded-full bg-teal-500 animate-ping" />
                        Busy ({item.inFlightCount})
                      </span>
                    )}
                    {item.state === 'Cooldown' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
                        ⏳ Cooldown ({item.remainingCooldownSeconds}s)
                      </span>
                    )}
                    {item.state === 'Unconfigured' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-500">
                        Unconfigured
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right font-mono font-bold text-slate-800">
                    {item.inFlightCount}
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-slate-600">
                    {item.remainingCooldownSeconds > 0
                      ? `${item.remainingCooldownSeconds}s`
                      : '—'}
                  </td>
                  <td className="py-2 px-3 text-right font-mono font-bold text-teal-800">
                    {item.requestsServed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* TOOL 2: Admin Bulk AI Seeder ("Auto-Populate Database") */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-600" />
              <span>🚀 Admin Bulk AI Seeder ("Auto-Populate Database")</span>
            </h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Uses `runWithDynamicKeyPool` across all healthy API keys in parallel to generate and save verified questions directly to Firestore &amp; IndexedDB
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Target Database */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wider block">
              1. Target Database
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                disabled={seederRunning}
                onClick={() => setSeederTargetMode('exam')}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold cursor-pointer border transition-colors ${
                  seederTargetMode === 'exam'
                    ? 'bg-teal-700 text-white border-teal-800'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                🎯 Exam Mode Bank
              </button>
              <button
                type="button"
                disabled={seederRunning}
                onClick={() => setSeederTargetMode('coach')}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold cursor-pointer border transition-colors ${
                  seederTargetMode === 'coach'
                    ? 'bg-indigo-600 text-white border-indigo-700'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                🎓 Coach &amp; Marathon
              </button>
            </div>
          </div>

          {/* Scope */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wider block">
              2. Task Scope
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                disabled={seederRunning}
                onClick={() => setSeederScope('current_section')}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold cursor-pointer border transition-colors ${
                  seederScope === 'current_section'
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                Current ({activeSectionName})
              </button>
              <button
                type="button"
                disabled={seederRunning}
                onClick={() => setSeederScope('all_12')}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold cursor-pointer border transition-colors ${
                  seederScope === 'all_12'
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                All 12 Task Types
              </button>
            </div>
          </div>

          {/* Count */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wider block">
              3. Batch Count
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                disabled={seederRunning}
                onClick={() => setSeederCountPerTask(1)}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold cursor-pointer border transition-colors ${
                  seederCountPerTask === 1
                    ? 'bg-amber-600 text-white border-amber-700'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                +1 per task
              </button>
              <button
                type="button"
                disabled={seederRunning}
                onClick={() => setSeederCountPerTask(2)}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold cursor-pointer border transition-colors ${
                  seederCountPerTask === 2
                    ? 'bg-amber-600 text-white border-amber-700'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                +2 per task
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-1">
          <div className="text-xs text-slate-600">
            {seederRunning || seederProgress.total > 0 ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 font-semibold text-slate-800">
                  {seederRunning && (
                    <RefreshCw className="w-3.5 h-3.5 text-teal-600 animate-spin shrink-0" />
                  )}
                  <span>{seederProgress.currentLabel}</span>
                  <span className="font-mono text-teal-700">
                    ({seederProgress.done}/{seederProgress.total} • {seederProgress.saved} saved)
                  </span>
                </div>
                <div className="w-full sm:w-80 h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-teal-600 transition-all duration-300"
                    style={{
                      width: `${
                        seederProgress.total > 0
                          ? Math.round((seederProgress.done / seederProgress.total) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            ) : (
              <span>
                Ready to generate{' '}
                <strong>
                  {(seederScope === 'current_section'
                    ? (SECTION_TASKS_MAP[activeSectionName] || []).length
                    : 12) * seederCountPerTask}{' '}
                  questions
                </strong>{' '}
                into{' '}
                <strong>
                  {seederTargetMode === 'coach' ? 'Coach & Marathon Bank' : 'Exam Mode Bank'}
                </strong>
                .
              </span>
            )}
          </div>

          <button
            type="button"
            disabled={seederRunning || configuredProvidersCount === 0}
            onClick={handleRunBulkSeeder}
            className="px-4 py-2 bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors shadow-xs shrink-0"
          >
            <Sparkles className="w-4 h-4 text-amber-300" />
            <span>
              {seederRunning
                ? `Seeding ${seederProgress.done}/${seederProgress.total}...`
                : '⚡ Auto-Populate Database Now'}
            </span>
          </button>
        </div>
      </div>

      {/* TOOL 3: Database Browser, Search & 1-Click Delete/Edit (Exam, Coach, and Mock Sets) */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Database className="w-4 h-4 text-teal-700" />
              <span>🔍 Database Inspector &amp; 1-Click Delete/Edit (`Exam`, `Coach`, &amp; `Mock Sets`)</span>
            </h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Filter by bank, search by title/taskType/@createdBy, and edit or delete any question or Full Mock Exam Set
            </p>
          </div>

          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200 flex-wrap">
            <button
              type="button"
              onClick={() => setManagerMode('exam')}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer transition-colors ${
                managerMode === 'exam'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              🎯 Exam Bank
            </button>
            <button
              type="button"
              onClick={() => setManagerMode('coach')}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer transition-colors ${
                managerMode === 'coach'
                  ? 'bg-indigo-600 text-white shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              🎓 Coach Bank
            </button>
            <button
              type="button"
              onClick={() => setManagerMode('mock_sets')}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer transition-colors ${
                managerMode === 'mock_sets'
                  ? 'bg-emerald-700 text-white shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              📚 Full Mock Sets ({mockSets.length})
            </button>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row gap-2.5">
          {managerMode !== 'mock_sets' && (
            <select
              value={managerTaskFilter}
              onChange={(e) => setManagerTaskFilter(e.target.value)}
              className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-semibold text-slate-800 outline-hidden focus:border-teal-600"
            >
              <option value="all">All 12 Task Types</option>
              {TASK_DEFINITIONS.map((td) => (
                <option key={td.id} value={td.id}>
                  {td.name}
                </option>
              ))}
            </select>
          )}

          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={managerSearch}
              onChange={(e) => setManagerSearch(e.target.value)}
              placeholder={
                managerMode === 'mock_sets'
                  ? 'Search Full Mock Exam Sets by title or ID...'
                  : 'Search by question title, taskType, ID, @createdBy, or passage text...'
              }
              className="w-full pl-8 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-hidden focus:border-teal-600"
            />
          </div>
        </div>

        {/* List View */}
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
          {managerMode === 'mock_sets' ? (
            filteredMockSets.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                No Full Mock Exam Sets match your search.
              </div>
            ) : (
              filteredMockSets.map((set) => {
                const isConfirming = confirmDeleteId === set.id;
                const isEditingTitle = editingMockSetId === set.id;
                return (
                  <div
                    key={set.id}
                    className="p-3 bg-slate-50/70 hover:bg-slate-50 border border-slate-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition-colors"
                  >
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="px-2 py-0.5 bg-emerald-100 text-emerald-900 rounded font-bold text-[10px]">
                          Full Mock Exam Set
                        </span>
                        <span className="px-2 py-0.5 bg-white border border-slate-200 rounded text-[10px] font-semibold text-slate-700">
                          {set.source === 'curated_mock' ? 'Official Curated' : 'AI Generated'}
                        </span>
                        <span className="px-2 py-0.5 bg-amber-50 text-amber-900 border border-amber-200 rounded font-mono text-[10px]">
                          @{set.source === 'curated_mock' ? 'Obi' : 'Obihang'}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400">
                          ID: {set.id}
                        </span>
                      </div>

                      {isEditingTitle ? (
                        <div className="flex items-center gap-1.5 pt-1">
                          <input
                            type="text"
                            value={editingMockSetTitle}
                            onChange={(e) => setEditingMockSetTitle(e.target.value)}
                            className="flex-1 px-2.5 py-1 text-xs bg-white border border-teal-500 rounded-lg font-bold text-slate-900 outline-hidden"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveMockSetTitle(set.id)}
                            className="px-2.5 py-1 bg-teal-700 hover:bg-teal-800 text-white rounded-lg text-[11px] font-bold inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="w-3 h-3" /> Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingMockSetId(null)}
                            className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <div className="font-bold text-slate-900 truncate">{set.title}</div>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMockSetId(set.id);
                          setEditingMockSetTitle(set.title);
                        }}
                        className="px-2.5 py-1.5 bg-white hover:bg-teal-50 text-slate-700 hover:text-teal-800 border border-slate-200 hover:border-teal-300 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer transition-colors"
                      >
                        <Edit3 className="w-3 h-3 text-teal-700" />
                        <span>✏️ Edit</span>
                      </button>

                      {!isConfirming ? (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(set.id)}
                          className="px-2.5 py-1.5 bg-white hover:bg-rose-50 text-rose-700 border border-slate-200 hover:border-rose-300 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>🗑️ Delete</span>
                        </button>
                      ) : (
                        <div className="inline-flex items-center gap-1 bg-rose-950 text-white px-2 py-1 rounded-lg text-[11px] font-bold">
                          <span>Delete Set?</span>
                          <button
                            type="button"
                            onClick={() => handleDeleteMockSet(set)}
                            className="px-1.5 py-0.5 bg-rose-600 hover:bg-rose-500 rounded text-[10px] cursor-pointer"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-[10px] cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )
          ) : allBankQuestions.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              No questions match your current filter.
            </div>
          ) : (
            allBankQuestions.map((q, idx) => {
              const qId = String(q.questionDocId || q.id || `idx-${idx}`);
              const taskDef = TASK_DEFINITIONS.find((t) => t.id === q.taskType);
              const lvl = String(q.level || q.difficulty || 'intermediate').toLowerCase();
              const top = String(q.topic || 'science-tech').toLowerCase();
              const creatorName = String(
                q.createdBy || q.generatedBy || 'Obi'
              ).replace(/^@+/, '');
              const isConfirming = confirmDeleteId === qId;

              return (
                <div
                  key={`${qId}-${idx}`}
                  className="p-3 bg-slate-50/70 hover:bg-slate-50 border border-slate-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition-colors"
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="px-2 py-0.5 bg-teal-100 text-teal-900 rounded font-bold text-[10px]">
                        {taskDef?.name || q.taskType}
                      </span>
                      <span className="px-2 py-0.5 bg-white border border-slate-200 rounded text-[10px] font-semibold text-slate-700">
                        {isValidLevel(lvl) ? LEVEL_LABELS[lvl] : lvl}
                      </span>
                      <span className="px-2 py-0.5 bg-white border border-slate-200 rounded text-[10px] font-medium text-slate-600">
                        {isValidAcademicTopic(top) ? TOPIC_LABELS[top] : top}
                      </span>
                      <span className="px-2 py-0.5 bg-amber-50 text-amber-900 border border-amber-200 rounded font-mono text-[10px] font-semibold">
                        @{creatorName}
                      </span>
                      <span className="text-[10px] font-mono text-slate-400 truncate max-w-[160px]">
                        ID: {qId}
                      </span>
                    </div>
                    <div className="font-bold text-slate-900 truncate">
                      {q.title ||
                        q.passage?.slice(0, 75) ||
                        q.text?.slice(0, 75) ||
                        q.script?.slice(0, 75) ||
                        'TOEFL Practice Item'}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        if (onOpenDevConsoleQuestionEditor) {
                          onOpenDevConsoleQuestionEditor(q, managerMode);
                        } else {
                          window.dispatchEvent(
                            new CustomEvent('toefl_dev_edit_question', {
                              detail: {
                                questionKey: qId,
                                questionDocId: qId,
                                task: q,
                                mode: managerMode,
                              },
                            })
                          );
                        }
                      }}
                      className="px-2.5 py-1.5 bg-white hover:bg-teal-50 text-slate-700 hover:text-teal-800 border border-slate-200 hover:border-teal-300 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Edit3 className="w-3 h-3 text-teal-700" />
                      <span>✏️ Edit</span>
                    </button>

                    {!isConfirming ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(qId)}
                        className="px-2.5 py-1.5 bg-white hover:bg-rose-50 text-rose-700 border border-slate-200 hover:border-rose-300 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>🗑️ Delete</span>
                      </button>
                    ) : (
                      <div className="inline-flex items-center gap-1 bg-rose-950 text-white px-2 py-1 rounded-lg text-[11px] font-bold">
                        <span>Delete?</span>
                        <button
                          type="button"
                          onClick={() => handleDeleteQuestion(q)}
                          className="px-1.5 py-0.5 bg-rose-600 hover:bg-rose-500 rounded text-[10px] cursor-pointer"
                        >
                          Yes
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-[10px] cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* TOOL 5: User Reports & Feedback Inbox (`reports` & `questionReports` collections) */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3 shadow-2xs">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Flag className="w-4 h-4 text-rose-600" />
              <span>📬 User Reports &amp; Feedback Inbox ({reports.length})</span>
            </h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Live items from Firestore `reports` and `questionReports` collections — inspect reported questions or resolve issues
            </p>
          </div>
        </div>

        {loadingReports ? (
          <p className="text-xs text-slate-400 py-3">Loading reports...</p>
        ) : reports.length === 0 ? (
          <div className="p-4 bg-slate-50 border border-slate-200/70 rounded-xl text-xs text-slate-500 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Zero unresolved user reports! All questions and feedback queues are clean.</span>
          </div>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {reports.map((rep) => (
              <div
                key={rep.id}
                className="p-3 bg-rose-50/50 border border-rose-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-rose-900">@{rep.username || 'Scholar'}</span>
                    <span className="px-1.5 py-0.5 bg-rose-100 text-rose-800 rounded text-[10px] font-bold">
                      {rep.type === 'question_report' ? 'Question Flag' : 'User Feedback'}
                    </span>
                    {rep.questionId && (
                      <span className="px-1.5 py-0.5 bg-white border border-rose-200 rounded font-mono text-[10px] text-slate-700">
                        Question ID: {rep.questionId}
                      </span>
                    )}
                    <span className="text-[10px] text-slate-400">
                      {formatRelativeTime(rep.createdAt)}
                    </span>
                  </div>
                  <p className="text-slate-800 font-medium">{rep.text}</p>
                  {rep.context && (
                    <p className="text-[10px] text-slate-500 font-mono">{rep.context}</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {rep.questionId && (
                    <button
                      type="button"
                      onClick={() => {
                        if (managerMode === 'mock_sets') setManagerMode('exam');
                        setManagerTaskFilter('all');
                        setManagerSearch(rep.questionId || '');
                      }}
                      className="px-2.5 py-1 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-lg text-[11px] font-semibold cursor-pointer"
                    >
                      🔍 Find in Bank
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleResolveReport(rep)}
                    className="px-2.5 py-1 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-[11px] font-semibold cursor-pointer"
                  >
                    🗑️ Dismiss / Resolve
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Applet Users Directory */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Users className="w-4 h-4 text-teal-700" />
              <span>👥 Applet Users Directory (Firestore `app_users`)</span>
            </h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Real-time directory of every scholar who has used TOEFL Prep Studio
            </p>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Filter by @username or ID..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-hidden focus:border-teal-600"
            />
          </div>
        </div>

        {/* Summary KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-xl">
            <div className="text-[11px] font-semibold text-slate-500">Total Unique Users</div>
            <div className="text-xl font-bold text-slate-900 mt-0.5">{users.length}</div>
          </div>
          <div className="p-3 bg-emerald-50/70 border border-emerald-200/80 rounded-xl">
            <div className="text-[11px] font-semibold text-emerald-800">Active Today (24h)</div>
            <div className="text-xl font-bold text-emerald-900 mt-0.5">{activeTodayCount}</div>
          </div>
          <div className="p-3 bg-teal-50/70 border border-teal-200/80 rounded-xl">
            <div className="text-[11px] font-semibold text-teal-800">Questions Practiced</div>
            <div className="text-xl font-bold text-teal-900 mt-0.5">{totalPracticedAcrossUsers}</div>
          </div>
          <div className="p-3 bg-amber-50/70 border border-amber-200/80 rounded-xl">
            <div className="text-[11px] font-semibold text-amber-800">AI Questions Generated</div>
            <div className="text-xl font-bold text-amber-900 mt-0.5">{totalGeneratedAcrossUsers}</div>
          </div>
        </div>

        {/* Users Table */}
        <div className="overflow-x-auto border border-slate-200 rounded-xl">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
                <th className="py-2.5 px-3">Scholar (@username)</th>
                <th className="py-2.5 px-3">Last Active</th>
                <th className="py-2.5 px-3 text-right">Questions Practiced</th>
                <th className="py-2.5 px-3 text-right">AI Generated</th>
                <th className="py-2.5 px-3 text-right">Best Band Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loadingUsers && users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-400">
                    Loading user directory...
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-400">
                    No matching users found.
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const isOnline = Date.now() - u.lastActiveAt < 15 * 60 * 1000;
                  const cleanLower = u.username.toLowerCase();
                  const isCreator = cleanLower === 'obi' || cleanLower === 'obihang';
                  return (
                    <tr key={u.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-2.5 px-3 font-semibold text-slate-900">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              isOnline ? 'bg-emerald-500' : 'bg-slate-300'
                            }`}
                            title={isOnline ? 'Active recently' : 'Offline'}
                          />
                          <span className="font-mono text-teal-900">@{u.username}</span>
                          {isCreator && (
                            <span className="px-1.5 py-0.5 text-[9px] font-bold bg-amber-100 text-amber-900 border border-amber-300 rounded">
                              🛠️ ADMIN
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono pl-4">
                          ID: {u.id.slice(0, 14)}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-slate-600">
                        <div className="font-semibold text-slate-800 flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-400" />
                          <span>{formatRelativeTime(u.lastActiveAt)}</span>
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {new Date(u.lastActiveAt).toLocaleString()}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-800">
                        {u.questionsPracticed || 0}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-semibold text-amber-800">
                        <span className="inline-flex items-center gap-1">
                          <Sparkles className="w-3 h-3 text-amber-500" />
                          {u.questionsGenerated || 0}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        {u.myBestBand && u.myBestBand > 0 ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-teal-50 text-teal-800 border border-teal-200">
                            <Award className="w-3 h-3 text-teal-600" />
                            Band {u.myBestBand.toFixed(1)}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
