import React, { useState, useEffect, useRef } from 'react';
import { safeFetchJson } from '../../../utils/apiHelper';
import {
  Mic,
  Key,
  CheckCircle2,
  AlertCircle,
  Volume2,
  Database,
  Trash2,
  Target,
  Download,
  Upload,
  Sparkles,
  HardDrive,
} from 'lucide-react';
import { OfflineTranscriberManager } from '../../shared/OfflineTranscriberManager';
import { useAuth } from '../../../context/AuthContext';
import {
  getStoredApiKey,
  setStoredApiKey,
  disconnectAllApiKeys,
  hasAnyProviderKey,
  ApiProvider,
  PROVIDERS,
  getScholarUsername,
  setScholarUsername,
} from '../../../utils/apiKey';
import { Accordion, AccordionSection } from './Accordion';
import { MicSection } from './MicSection';
import { VoiceAndSpeechSection } from './settings/VoiceAndSpeechSection';
import { getPracticeHistory, resetPracticeHistory } from '../../../utils/scoreTracker';
import { clearVocabularyList } from '../../../utils/vocabularyStore';
import { clearAllMistakes } from '../../../utils/mistakesTracker';
import {
  exportQuestionBankJson,
  purgeLowQualityCache,
  saveVerifiedQuestion,
  syncCuratedQuestionBank,
  reSyncAllShards,
  syncFirestoreGlobalCounts,
  getQuestionBankStats,
  repairQuestionBank,
  isEligibleDevUsername,
  isDevAdminUnlocked,
  unlockDevAdmin,
  lockDevAdmin,
  getDevAdminPin,
  setDevAdminPin,
  syncUserActivityToFirestore,
} from '../../../utils/questionBankStorage';
import { isHighQualityTask } from '../../../utils/questionValidator';
import { getApiHeaders } from '../../../utils/apiKey';
import { TASK_DEFINITIONS } from '../../../types/taskTypes';
import { preCacheSectionAudio } from '../../../utils/audioPrewarmer';

interface SettingsTabProps {
  onConfigureGoals?: () => void;
  currentTaskType?: string;
  practiceMode?: 'exam' | 'coach';
  onOpenDevConsole?: () => void;
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  onConfigureGoals,
  currentTaskType,
  practiceMode = 'exam',
  onOpenDevConsole,
}) => {
  const { user, displayName, setDisplayName } = useAuth();
  const [scholarInput, setScholarInput] = useState('');
  const [dataMessage, setDataMessage] = useState<{ success: boolean; text: string } | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Developer Admin Access state for @Obi / @Obihang
  const [isDevUnlocked, setIsDevUnlocked] = useState<boolean>(() => isDevAdminUnlocked());
  const [devPinInput, setDevPinInput] = useState<string>('');
  const [newPinConfigInput, setNewPinConfigInput] = useState<string>(() => getDevAdminPin());
  const [devMessage, setDevMessage] = useState<{ success: boolean; text: string } | null>(null);

  useEffect(() => {
    const onDevChange = () => setIsDevUnlocked(isDevAdminUnlocked());
    window.addEventListener('toefl_dev_admin_changed', onDevChange);
    return () => window.removeEventListener('toefl_dev_admin_changed', onDevChange);
  }, []);

  // Per-provider keys state
  const [geminiKey, setGeminiKey] = useState('');
  const [groqKey, setGroqKey] = useState('');
  const [openRouterKey, setOpenRouterKey] = useState('');
  const [nvidiaKey, setNvidiaKey] = useState('');
  const [extraKeys, setExtraKeys] = useState<Record<string, string>>({});

  // Auto-Detect expander state
  const [isMoreApisExpanded, setIsMoreApisExpanded] = useState(false);
  const [autoKeyInput, setAutoKeyInput] = useState('');
  const [autoKeyMessage, setAutoKeyMessage] = useState<{ success: boolean; text: string } | null>(null);

  // Test states for each key
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success?: boolean; message?: string }>>({});

  const syncKeys = () => {
    setGeminiKey(getStoredApiKey('gemini') || '');
    setGroqKey(getStoredApiKey('groq') || '');
    setOpenRouterKey(getStoredApiKey('openrouter') || '');
    setNvidiaKey(getStoredApiKey('nvidia') || '');

    const extraProviders: ApiProvider[] = ['openai', 'anthropic', 'openrouter', 'nvidia', 'deepseek', 'xai'];
    const loaded: Record<string, string> = {};
    for (const p of extraProviders) {
      const k = (
        localStorage.getItem(`${p}_api_key`) ||
        getStoredApiKey(p) ||
        ''
      ).trim();
      if (k) {
        loaded[p] = k;
      }
    }
    setExtraKeys(loaded);
  };

  const handleAddAutoDetectedKey = () => {
    const raw = autoKeyInput.trim();
    if (!raw) return;

    let provider: ApiProvider = 'openai';
    if (/^(AIza|AQ)/i.test(raw)) provider = 'gemini';
    else if (/^gsk_/.test(raw)) provider = 'groq';
    else if (/^sk-or-/i.test(raw)) provider = 'openrouter';
    else if (/^nvapi-/i.test(raw)) provider = 'nvidia';
    else if (/^sk-ant-/i.test(raw)) provider = 'anthropic';
    else if (/^xai-/i.test(raw)) provider = 'xai';
    else if (/^ds-/i.test(raw)) provider = 'deepseek';
    else if (/^sk-/.test(raw)) provider = 'openai';

    localStorage.setItem(`${provider}_api_key`, raw);
    setStoredApiKey(raw, provider);

    syncKeys();
    setAutoKeyInput('');
    const providerName = PROVIDERS[provider]?.name || provider.toUpperCase();
    setAutoKeyMessage({ success: true, text: `Detected ${providerName} API Key and saved!` });
    window.dispatchEvent(new CustomEvent('apiKeyUpdated'));
    setTimeout(() => setAutoKeyMessage(null), 4000);
  };

  const handleRemoveExtraKey = (p: ApiProvider) => {
    localStorage.removeItem(`${p}_api_key`);
    setStoredApiKey('', p);
    syncKeys();
    window.dispatchEvent(new CustomEvent('apiKeyUpdated'));
  };

  const [bankStats, setBankStats] = useState<{
    totalQuestions: number;
    totalCurated: number;
    countsPerTaskType: Record<string, number>;
  } | null>(null);

  useEffect(() => {
    getQuestionBankStats(practiceMode).then(setBankStats);
  }, [practiceMode]);

  useEffect(() => {
    const currentName = displayName || localStorage.getItem('toefl_display_name') || getScholarUsername();
    setScholarInput(currentName);
    syncKeys();
  }, [displayName]);

  const handleSaveIndividualKey = (targetProvider: ApiProvider, val: string) => {
    setStoredApiKey(val.trim(), targetProvider);
    syncKeys();
    window.dispatchEvent(new CustomEvent('apiKeyUpdated'));
  };

  const handleTestKey = async (targetProvider: ApiProvider, keyVal: string) => {
    if (!keyVal.trim()) return;
    setTestingProvider(targetProvider);
    setTestResults((prev) => {
      const copy = { ...prev };
      delete copy[targetProvider];
      return copy;
    });

    try {
      setStoredApiKey(keyVal.trim(), targetProvider);
      syncKeys();

      const json = await safeFetchJson('/api/test-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': keyVal.trim(),
          'x-api-provider': targetProvider,
        },
        body: JSON.stringify({
          provider: targetProvider,
          apiKey: keyVal.trim(),
        }),
      });

      window.dispatchEvent(new CustomEvent('apiKeyUpdated'));

      if (json.success) {
        setTestResults((prev) => ({
          ...prev,
          [targetProvider]: { success: true, message: json.message || `Connected successfully!` },
        }));
      } else {
        setTestResults((prev) => ({
          ...prev,
          [targetProvider]: { success: false, message: json.error || `Could not verify key.` },
        }));
      }
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [targetProvider]: { success: false, message: err?.message || 'Connection test failed.' },
      }));
    } finally {
      setTestingProvider(null);
    }
  };

  const handleClearKey = (targetProvider: ApiProvider) => {
    setStoredApiKey('', targetProvider);
    syncKeys();
    if (targetProvider === 'gemini') setGeminiKey('');
    if (targetProvider === 'groq') setGroqKey('');
    window.dispatchEvent(new CustomEvent('apiKeyUpdated'));
  };

  const handleDisconnectAll = () => {
    disconnectAllApiKeys();
    syncKeys();
    setDataMessage({ success: true, text: 'All API keys removed from browser localStorage.' });
    setTimeout(() => setDataMessage(null), 4000);
  };

  // Data section handlers
  const handleExportData = () => {
    const history = getPracticeHistory();
    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      history,
      targetScore: localStorage.getItem('toefl_target_score'),
      weeklyGoal: localStorage.getItem('WEEKLY_GOAL'),
      testDate: localStorage.getItem('toefl_test_date'),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `toefl_prep_history_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setDataMessage({ success: true, text: 'Study history exported successfully!' });
  };

  const handleImportData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (Array.isArray(parsed.history)) {
          localStorage.setItem('toefl_practice_history', JSON.stringify(parsed.history));
        }
        if (parsed.targetScore) localStorage.setItem('toefl_target_score', parsed.targetScore);
        if (parsed.weeklyGoal) localStorage.setItem('WEEKLY_GOAL', parsed.weeklyGoal);
        if (parsed.testDate) localStorage.setItem('toefl_test_date', parsed.testDate);

        setDataMessage({ success: true, text: 'Study history imported successfully!' });
      } catch {
        setDataMessage({ success: false, text: 'Failed to import JSON: Invalid file format.' });
      }
    };
    reader.readAsText(file);
  };

  const handleResetData = () => {
    resetPracticeHistory();
    clearVocabularyList();
    clearAllMistakes();
    setConfirmingReset(false);
    setDataMessage({ success: true, text: 'All practice history, vocabulary, and records have been reset to absolute zero.' });
  };

  const handleExportQuestionBank = async () => {
    const jsonStr = await exportQuestionBankJson();
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `toefl_question_bank_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setDataMessage({ success: true, text: 'Question bank exported successfully!' });
  };

  const handleSyncAndCleanBank = async () => {
    setDataMessage({ success: true, text: `Re-syncing ${practiceMode === 'coach' ? 'Coach & Marathon' : 'Exam Mode'} question shards & pulling global Firestore questions...` });
    const purgeCount = await purgeLowQualityCache();
    const syncRes = await reSyncAllShards(practiceMode);
    const updated = await getQuestionBankStats(practiceMode);
    setBankStats(updated);
    setDataMessage({
      success: true,
      text: `Re-Sync complete! Pulled ${syncRes.totalQuestions} verified questions globally (purged ${purgeCount} stubs).`,
    });
  };

  const [isRepairingBank, setIsRepairingBank] = useState(false);
  const [repairStatus, setRepairStatus] = useState<string | null>(null);

  const handleRepairBank = async () => {
    if (isRepairingBank) return;
    setIsRepairingBank(true);
    setRepairStatus('Repairing question bank topics and levels...');
    try {
      const res = await repairQuestionBank((processed, fixed) => {
        setRepairStatus(`Scanned ${processed} questions, fixed ${fixed}...`);
      });
      const updated = await getQuestionBankStats(practiceMode);
      setBankStats(updated);
      setDataMessage({
        success: true,
        text: `Bank repair complete! Scanned ${res.totalProcessed} questions and fixed ${res.totalFixed} outdated items.`,
      });
    } catch (err: any) {
      setDataMessage({
        success: false,
        text: err?.message || 'Failed to repair question bank.',
      });
    } finally {
      setIsRepairingBank(false);
      setRepairStatus(null);
    }
  };

  const [isPreCachingAudio, setIsPreCachingAudio] = useState(false);
  const [preCacheAudioStatus, setPreCacheAudioStatus] = useState<string | null>(null);

  const handlePreCacheAllAudio = async () => {
    if (isPreCachingAudio) return;
    setIsPreCachingAudio(true);
    setPreCacheAudioStatus('Caching listening & speaking audio...');
    try {
      await preCacheSectionAudio('Listening', (p) => {
        setPreCacheAudioStatus(`Listening: ${p.statusText}`);
      });
      await preCacheSectionAudio('Speaking', (p) => {
        setPreCacheAudioStatus(`Speaking: ${p.statusText}`);
      });
      setDataMessage({
        success: true,
        text: 'All section audio pre-cached into IndexedDB (0ms ready).',
      });
    } catch {
      setDataMessage({
        success: false,
        text: 'Failed to complete audio pre-caching.',
      });
    } finally {
      setIsPreCachingAudio(false);
      setPreCacheAudioStatus(null);
    }
  };

  const [bulkSeedTaskType, setBulkSeedTaskType] = useState<string>(currentTaskType || 'academic-discussion');
  const [isBulkSeeding, setIsBulkSeeding] = useState(false);
  const [bulkSeedProgress, setBulkSeedProgress] = useState<string | null>(null);

  useEffect(() => {
    if (currentTaskType) {
      setBulkSeedTaskType(currentTaskType);
    }
  }, [currentTaskType]);

  const handleBulkSeedBank = async () => {
    const hasConfiguredKey = hasAnyProviderKey();

    if (!hasConfiguredKey) {
      setDataMessage({
        success: false,
        text: 'Please configure at least one active API key in the "AI provider and API keys" tab above before bulk seeding questions.',
      });
      return;
    }

    if (isBulkSeeding) return;
    setIsBulkSeeding(true);

    const DIVERSE_TARGETS = [
      { level: 'intermediate', topic: 'science-tech' },
      { level: 'upper-intermediate', topic: 'campus-life' },
      { level: 'advanced', topic: 'business-economics' },
      { level: 'upper-intermediate', topic: 'social-sciences' },
      { level: 'advanced', topic: 'arts-humanities' },
    ];

    let successCount = 0;
    const targetTaskName = TASK_DEFINITIONS.find((t) => t.id === bulkSeedTaskType)?.name || bulkSeedTaskType;

    try {
      for (let i = 0; i < DIVERSE_TARGETS.length; i++) {
        const target = DIVERSE_TARGETS[i];
        setBulkSeedProgress(`Generating question ${i + 1}/5: ${target.level} · ${target.topic}...`);

        try {
          const json = await safeFetchJson('/api/generate-task', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify({
              taskType: bulkSeedTaskType,
              level: target.level,
              topic: target.topic,
              coachMode: practiceMode === 'coach',
              promptData: practiceMode === 'coach' ? { coachMode: true, mode: 'coach' } : undefined,
            }),
          });

          if (json.success && json.data && !json.data.isFallback) {
            const generatedData = json.data;
            if (isHighQualityTask(generatedData, bulkSeedTaskType)) {
              await saveVerifiedQuestion({
                taskType: bulkSeedTaskType,
                level: target.level,
                topic: target.topic,
                content: generatedData,
                mode: practiceMode,
              });
              successCount++;
            }
          }
        } catch {}

        if (i < DIVERSE_TARGETS.length - 1) {
          setBulkSeedProgress(`Throttling 2s for rate limits (${i + 1}/5 generated)...`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      const updatedStats = await getQuestionBankStats(practiceMode);
      setBankStats(updatedStats);

      if (successCount > 0) {
        setDataMessage({
          success: true,
          text: `Successfully generated and saved ${successCount}/5 verified questions for "${targetTaskName}" (${practiceMode === 'coach' ? 'Coach Mode' : 'Exam Mode'}) to IndexedDB & Firestore!`,
        });
      } else {
        setDataMessage({
          success: false,
          text: `Bulk generation finished but 0 valid questions were saved (check API quota or key validity).`,
        });
      }
    } catch (err: any) {
      setDataMessage({
        success: false,
        text: `Bulk seeding failed: ${err.message || 'Unknown error'}`,
      });
    } finally {
      setIsBulkSeeding(false);
      setBulkSeedProgress(null);
    }
  };

  const sections: AccordionSection[] = [
    // 1. AI Provider and API Keys
    {
      id: 'ai_provider',
      title: 'AI provider and API keys',
      icon: <Key className="w-4 h-4 text-teal-700" />,
      content: (
        <div className="space-y-4 pt-2">
          {/* Clean Generation/Grading Key Inputs */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h5 className="text-xs font-bold text-slate-800">API Keys (Automatic Load Balancing &amp; Failover)</h5>
              <button
                type="button"
                onClick={handleDisconnectAll}
                className="text-[11px] text-rose-600 hover:text-rose-800 font-semibold flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
                Clear All Keys
              </button>
            </div>

            {/* Google Gemini */}
            <div className="p-3 bg-white border border-slate-200 rounded-xl space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-bold text-slate-800 flex items-center gap-2">
                  Google Gemini API Key
                  {Boolean(geminiKey.trim()) && (
                    <span className="px-2 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-800 rounded-full">
                      Saved ✓
                    </span>
                  )}
                </span>
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="text-teal-700 hover:underline text-[11px]"
                >
                  Get free key
                </a>
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={geminiKey}
                  onChange={(e) => {
                    setGeminiKey(e.target.value);
                    handleSaveIndividualKey('gemini', e.target.value);
                  }}
                  placeholder="AIzaSy... (Gemini 2.5 Flash / Flash Lite)"
                  className="flex-1 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 outline-hidden focus:border-teal-600"
                />
                <button
                  type="button"
                  onClick={() => handleTestKey('gemini', geminiKey)}
                  disabled={testingProvider === 'gemini' || !geminiKey.trim()}
                  className="px-3 py-2 bg-teal-800 hover:bg-teal-900 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition cursor-pointer shrink-0"
                >
                  {testingProvider === 'gemini' ? 'Testing...' : 'Test'}
                </button>
                <button
                  type="button"
                  onClick={() => handleClearKey('gemini')}
                  className="px-2.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer"
                  title="Clear key"
                >
                  Clear
                </button>
              </div>
              {testResults['gemini'] && (
                <p className={`text-[11px] font-medium ${testResults['gemini'].success ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {testResults['gemini'].message}
                </p>
              )}
            </div>

            {/* Groq */}
            <div className="p-3 bg-white border border-slate-200 rounded-xl space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-bold text-slate-800 flex items-center gap-2">
                  Groq API Key (for Question Generation &amp; Grading)
                  {Boolean(groqKey.trim()) && (
                    <span className="px-2 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-800 rounded-full">
                      Saved ✓
                    </span>
                  )}
                </span>
                <a
                  href="https://console.groq.com/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-teal-700 hover:underline text-[11px]"
                >
                  Get free key
                </a>
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={groqKey}
                  onChange={(e) => {
                    setGroqKey(e.target.value);
                    handleSaveIndividualKey('groq', e.target.value);
                  }}
                  placeholder="gsk_..."
                  className="flex-1 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 outline-hidden focus:border-teal-600"
                />
                <button
                  type="button"
                  onClick={() => handleTestKey('groq', groqKey)}
                  disabled={testingProvider === 'groq' || !groqKey.trim()}
                  className="px-3 py-2 bg-teal-800 hover:bg-teal-900 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition cursor-pointer shrink-0"
                >
                  {testingProvider === 'groq' ? 'Testing...' : 'Test'}
                </button>
                <button
                  type="button"
                  onClick={() => handleClearKey('groq')}
                  className="px-2.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer"
                  title="Clear key"
                >
                  Clear
                </button>
              </div>
              {testResults['groq'] && (
                <p className={`text-[11px] font-medium ${testResults['groq'].success ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {testResults['groq'].message}
                </p>
              )}
            </div>

            {/* Add More APIs (Auto-Detect) Expander */}
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setIsMoreApisExpanded(!isMoreApisExpanded)}
                className="w-full py-2.5 px-3.5 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-xl flex items-center justify-between transition cursor-pointer"
              >
                <span className="flex items-center gap-2">
                  <span>➕ Add More APIs (Auto-Detect)</span>
                  {Object.keys(extraKeys).length > 0 && (
                    <span className="px-2 py-0.5 text-[10px] bg-emerald-100 text-emerald-800 font-bold rounded-full">
                      {Object.keys(extraKeys).length} Extra Key{Object.keys(extraKeys).length > 1 ? 's' : ''} Connected
                    </span>
                  )}
                </span>
                <span className="text-slate-500 font-mono text-xs">{isMoreApisExpanded ? '▲' : '▼'}</span>
              </button>

              {isMoreApisExpanded && (
                <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <p className="text-[11px] text-slate-600">
                    Paste any key (OpenAI, Anthropic, OpenRouter, NVIDIA, etc.). Provider prefix will be detected automatically.
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={autoKeyInput}
                      onChange={(e) => setAutoKeyInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddAutoDetectedKey()}
                      placeholder="Paste any API key (OpenAI, Anthropic, OpenRouter, NVIDIA, etc.)"
                      className="flex-1 text-xs font-mono bg-white border border-slate-300 rounded-lg px-3 py-2 outline-hidden focus:border-teal-600"
                    />
                    <button
                      type="button"
                      onClick={handleAddAutoDetectedKey}
                      disabled={!autoKeyInput.trim()}
                      className="px-4 py-2 bg-teal-800 hover:bg-teal-900 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition cursor-pointer shrink-0"
                    >
                      Add
                    </button>
                  </div>

                  {autoKeyMessage && (
                    <p className={`text-[11px] font-medium ${autoKeyMessage.success ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {autoKeyMessage.text}
                    </p>
                  )}

                  {Object.keys(extraKeys).length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Active Extra Providers</span>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(extraKeys).map(([p, k]) => {
                          const pName = PROVIDERS[p as ApiProvider]?.name || p.toUpperCase();
                          return (
                            <span
                              key={p}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full text-xs font-medium"
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              <span>🟢 {pName}</span>
                              <button
                                type="button"
                                onClick={() => handleRemoveExtraKey(p as ApiProvider)}
                                className="ml-1 text-slate-400 hover:text-rose-600 font-bold cursor-pointer transition"
                                title={`Remove ${pName} key`}
                              >
                                [x]
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      ),
    },

    // 2. Offline Speech Transcriber Models
    {
      id: 'offline_whisper',
      title: 'Offline Speech Transcriber Models',
      icon: <HardDrive className="w-4 h-4 text-teal-700" />,
      content: (
        <div className="pt-2">
          <OfflineTranscriberManager />
        </div>
      ),
    },


    // 4. Voice and Speech
    {
      id: 'voice_speech',
      title: 'Voice and speech',
      icon: <Volume2 className="w-4 h-4 text-teal-700" />,
      content: <VoiceAndSpeechSection />,
    },

    // 4. Microphone
    {
      id: 'microphone',
      title: 'Microphone',
      icon: <Mic className="w-4 h-4 text-teal-700" />,
      content: (
        <div className="pt-2">
          <MicSection />
        </div>
      ),
    },

    // 5. Profile
    {
      id: 'profile',
      title: 'Profile',
      icon: <Target className="w-4 h-4 text-teal-700" />,
      content: (
        <div className="space-y-4 pt-2">
          {/* Scholar Username Row */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
            <label className="text-xs font-bold text-slate-800">Scholar Username (@username &amp; Attribution)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={scholarInput}
                onChange={(e) => setScholarInput(e.target.value)}
                onBlur={() => {
                  if (scholarInput.trim()) {
                    setScholarUsername(scholarInput.trim());
                    setDisplayName(scholarInput.trim());
                    syncUserActivityToFirestore({ username: scholarInput.trim() }).catch(() => {});
                  }
                }}
                placeholder="e.g. AlexScholar"
                className="flex-1 text-xs font-medium border border-slate-300 rounded-lg px-3 py-2 bg-white focus:border-teal-600 outline-hidden font-mono"
              />
              <button
                type="button"
                onClick={() => {
                  if (scholarInput.trim()) {
                    setScholarUsername(scholarInput.trim());
                    setDisplayName(scholarInput.trim());
                    syncUserActivityToFirestore({ username: scholarInput.trim() }).catch(() => {});
                    setDataMessage({ success: true, text: 'Scholar username saved successfully!' });
                    setTimeout(() => setDataMessage(null), 3000);
                  }
                }}
                className="px-3 py-2 bg-teal-800 hover:bg-teal-900 text-white rounded-lg text-xs font-semibold transition cursor-pointer"
              >
                Save Name
              </button>
            </div>
            <p className="text-[11px] text-slate-500">Display name and scholar attribution name are unified.</p>
          </div>

          {/* Exclusive Developer Admin Access for @Obi / @Obihang */}
          {isEligibleDevUsername(scholarInput, user?.email) && (
            <div className="p-4 bg-slate-900 text-white border border-slate-800 rounded-xl space-y-3 shadow-sm">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-base">🛠️</span>
                  <div>
                    <h5 className="text-xs font-bold text-white flex items-center gap-2">
                      <span>Developer Admin Access (@Obi / @Obihang)</span>
                      <span
                        className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${
                          isDevUnlocked
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-slate-800 text-slate-400 border border-slate-700'
                        }`}
                      >
                        {isDevUnlocked ? 'UNLOCKED ✓' : 'LOCKED'}
                      </span>
                    </h5>
                    <p className="text-[11px] text-slate-400">
                      Unlock inline Question Edit/Delete controls across all 12 tasks &amp; the Applet Users Directory
                    </p>
                  </div>
                </div>

                {isDevUnlocked && onOpenDevConsole && (
                  <button
                    type="button"
                    onClick={onOpenDevConsole}
                    className="px-3 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs rounded-lg transition cursor-pointer shrink-0"
                  >
                    🛠️ Open Dev Console
                  </button>
                )}
              </div>

              {!isDevUnlocked ? (
                <div className="flex flex-col sm:flex-row gap-2 pt-1">
                  <input
                    type="password"
                    value={devPinInput}
                    onChange={(e) => setDevPinInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const ok = unlockDevAdmin(devPinInput, user?.email);
                        if (ok) {
                          setIsDevUnlocked(true);
                          setDevPinInput('');
                          setDevMessage({ success: true, text: 'Developer Admin Mode unlocked! Persistent across sessions.' });
                        } else {
                          setDevMessage({ success: false, text: 'Invalid developer passcode/PIN.' });
                        }
                      }
                    }}
                    placeholder="Enter Developer PIN / Passcode (default: obi2026)"
                    className="flex-1 text-xs font-mono bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 outline-hidden focus:border-amber-400"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const ok = unlockDevAdmin(devPinInput, user?.email);
                      if (ok) {
                        setIsDevUnlocked(true);
                        setDevPinInput('');
                        setDevMessage({ success: true, text: 'Developer Admin Mode unlocked! Persistent across sessions.' });
                      } else {
                        setDevMessage({ success: false, text: 'Invalid developer passcode/PIN.' });
                      }
                    }}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition cursor-pointer shrink-0"
                  >
                    🔓 Unlock Dev Mode
                  </button>
                </div>
              ) : (
                <div className="pt-2 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2 flex-1">
                    <span className="text-[11px] text-slate-400 whitespace-nowrap">Admin Passcode:</span>
                    <input
                      type="password"
                      value={newPinConfigInput}
                      onChange={(e) => setNewPinConfigInput(e.target.value)}
                      placeholder="Configure PIN (default: obi2026)"
                      className="text-xs font-mono bg-slate-800 border border-slate-700 text-white rounded-lg px-2.5 py-1.5 outline-hidden focus:border-teal-400 w-36"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (newPinConfigInput.trim()) {
                          setDevAdminPin(newPinConfigInput.trim());
                          setDevMessage({ success: true, text: 'Developer Admin PIN updated!' });
                          setTimeout(() => setDevMessage(null), 3000);
                        }
                      }}
                      className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-[11px] font-semibold cursor-pointer"
                    >
                      Save PIN
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      lockDevAdmin();
                      setIsDevUnlocked(false);
                      setDevMessage({ success: true, text: 'Developer Admin Mode locked.' });
                    }}
                    className="px-3 py-1.5 bg-rose-950 hover:bg-rose-900 text-rose-200 border border-rose-800 rounded-lg text-xs font-semibold cursor-pointer self-start sm:self-auto"
                  >
                    🔒 Lock Dev Mode
                  </button>
                </div>
              )}

              {devMessage && (
                <p className={`text-[11px] font-medium ${devMessage.success ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {devMessage.text}
                </p>
              )}
            </div>
          )}
        </div>
      ),
    },

    // 6. Data
    {
      id: 'data',
      title: 'Data & Question Bank',
      icon: <Database className="w-4 h-4 text-teal-700" />,
      content: (
        <div className="space-y-4 pt-2">
          {/* Curated Question Bank Status Banner */}
          <div className="p-3.5 bg-teal-50/80 border border-teal-200 rounded-xl space-y-2.5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-teal-700 shrink-0" />
                <span className="text-xs font-bold text-slate-900">
                  Global bank: {bankStats?.totalQuestions || 0} verified questions ({bankStats?.countsPerTaskType?.[currentTaskType || 'academic-discussion'] || 0} in active section)
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={handleRepairBank}
                  disabled={isRepairingBank}
                  className="px-3 py-1.5 text-xs font-bold bg-slate-800 hover:bg-slate-900 text-teal-300 rounded-lg transition cursor-pointer flex items-center gap-1.5 shadow-2xs disabled:opacity-50"
                  title="Loop through all questions and repair missing/invalid topics and levels"
                >
                  <span>{isRepairingBank ? (repairStatus || 'Repairing...') : '🛠️ Repair question bank'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleSyncAndCleanBank}
                  className="px-3 py-1.5 text-xs font-bold bg-teal-800 hover:bg-teal-900 text-white rounded-lg transition cursor-pointer flex items-center gap-1.5 shadow-2xs"
                >
                  <span>🔄 Re-Sync All Shards</span>
                </button>
              </div>
            </div>
            <p className="text-[11px] text-slate-600">
              All 8 TOEFL task types are deduplicated, synced, and cached in IndexedDB (<code className="font-mono text-teal-800">toefl_question_bank</code>) for 100% offline practice.
            </p>
          </div>

          {/* Primary Action Row: Seed +5 AI Questions & Pre-Cache Audio */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 bg-white border border-slate-200 rounded-xl space-y-2">
              <label className="text-xs font-bold text-slate-800 block">✨ Seed +5 AI Questions</label>
              <div className="flex items-center gap-2">
                <select
                  value={bulkSeedTaskType}
                  onChange={(e) => setBulkSeedTaskType(e.target.value)}
                  disabled={isBulkSeeding}
                  className="flex-1 text-xs border border-slate-300 rounded-lg px-2.5 py-2 bg-slate-50 text-slate-800 font-semibold focus:border-teal-600 outline-hidden cursor-pointer"
                >
                  {TASK_DEFINITIONS.map((td) => (
                    <option key={td.id} value={td.id}>
                      {td.name}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={handleBulkSeedBank}
                  disabled={isBulkSeeding}
                  className="px-3.5 py-2 bg-teal-800 hover:bg-teal-900 text-white rounded-lg text-xs font-semibold transition flex items-center gap-1.5 cursor-pointer disabled:opacity-60 shrink-0"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${isBulkSeeding ? 'animate-spin text-teal-200' : 'text-teal-300'}`} />
                  <span>{isBulkSeeding ? bulkSeedProgress || 'Seeding...' : 'Seed +5'}</span>
                </button>
              </div>
            </div>

            <div className="p-3 bg-white border border-slate-200 rounded-xl flex flex-col justify-between">
              <div>
                <label className="text-xs font-bold text-slate-800 block mb-1">🔊 Audio Pre-Caching</label>
                <p className="text-[11px] text-slate-500">Cache all listening &amp; speaking audio lines into IndexedDB for 0ms playback.</p>
              </div>
              <button
                type="button"
                onClick={handlePreCacheAllAudio}
                disabled={isPreCachingAudio}
                className="mt-2 px-3.5 py-2 bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Volume2 className={`w-3.5 h-3.5 ${isPreCachingAudio ? 'animate-pulse text-teal-600' : 'text-teal-700'}`} />
                <span>{isPreCachingAudio ? (preCacheAudioStatus || 'Caching audio...') : 'Pre-Cache Section Audio'}</span>
              </button>
            </div>
          </div>

          {/* Secondary Footer Row: Export Bank, Export History, Import History, Reset History */}
          <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-2 items-center justify-between">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleExportQuestionBank}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-teal-300 rounded-lg text-xs font-semibold transition flex items-center gap-1 cursor-pointer"
              >
                <Download className="w-3 h-3 text-teal-400" />
                Export Bank (JSON)
              </button>

              <button
                type="button"
                onClick={handleExportData}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-semibold transition flex items-center gap-1 cursor-pointer"
              >
                <Download className="w-3 h-3" />
                Export History
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-semibold transition flex items-center gap-1 cursor-pointer"
              >
                <Upload className="w-3 h-3" />
                Import History
              </button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleImportData}
                accept=".json"
                className="hidden"
              />
            </div>

            {!confirmingReset ? (
              <button
                type="button"
                onClick={() => setConfirmingReset(true)}
                className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-xs font-semibold transition flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3 h-3 text-rose-600" />
                Reset History
              </button>
            ) : (
              <div className="inline-flex items-center gap-1.5 bg-rose-50 border border-rose-300 px-2.5 py-1 rounded-lg text-xs font-semibold text-rose-900">
                <span>Confirm Reset?</span>
                <button
                  type="button"
                  onClick={handleResetData}
                  className="px-2 py-0.5 bg-rose-600 hover:bg-rose-700 text-white rounded font-bold cursor-pointer"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingReset(false)}
                  className="px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {dataMessage && (
            <div
              className={`p-2.5 rounded-lg text-xs font-medium flex items-center gap-2 ${
                dataMessage.success
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-rose-50 text-rose-800 border border-rose-200'
              }`}
            >
              {dataMessage.success ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              )}
              <span>{dataMessage.text}</span>
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Accordion sections={sections} storageKey="dashboard_settings_accordion_open" />
    </div>
  );
};
