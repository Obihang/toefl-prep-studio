import React, { useState, useEffect } from 'react';
import {
  X,
  LayoutDashboard,
  Target,
  Settings,
  BookOpen,
  AlertCircle,
  Terminal,
} from 'lucide-react';
import { OverviewTab } from './dashboard/OverviewTab';
import { GoalsTab } from './dashboard/GoalsTab';
import { VocabularyTab } from './dashboard/VocabularyTab';
import { MistakesTab } from './dashboard/MistakesTab';
import { SettingsTab } from './dashboard/SettingsTab';
import { DevConsoleTab } from './dashboard/DevConsoleTab';
import {
  getUserStats,
  getCompletedDays,
  getPracticeHistory,
  calculateToeflEstimate,
  convertScaledToBand6,
} from '../../utils/scoreTracker';
import { getVocabularyWords, saveVocabularyWord as saveVocabRemote, deleteVocabularyWord as deleteVocabRemote, VocabularyWord } from '../../utils/vocabulary';
import { getVocabularyList, saveVocabularyWord as saveVocabLocal, removeVocabularyWord as removeVocabLocal } from '../../utils/vocabularyStore';
import { getQuestionCountsPerTaskType, isDevAdminUnlocked } from '../../utils/questionBankStorage';
import { getMockExamSetsCount, getExamHistory, clearExamHistory, FullMockExamResult } from '../../utils/examStorage';

export type DashboardTabType = 'dashboard' | 'goals' | 'settings' | 'vocabulary' | 'mistakes' | 'dev';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  openHistory: () => void;
  openRubrics: () => void;
  defaultTab?: DashboardTabType;
  currentTaskType?: string;
  practiceMode?: 'exam' | 'coach';
  onNavigateToTask?: (sectionOrTask: string) => void;
  onResetProgress?: () => void;
}

export const DashboardModal: React.FC<Props> = ({
  isOpen,
  onClose,
  openHistory,
  openRubrics,
  defaultTab = 'dashboard',
  currentTaskType,
  practiceMode = 'exam',
  onNavigateToTask,
  onResetProgress,
}) => {
  const [activeTab, setActiveTab] = useState<DashboardTabType>(defaultTab || 'dashboard');
  const [isDevAdmin, setIsDevAdmin] = useState<boolean>(() => isDevAdminUnlocked());
  const [stats, setStats] = useState<any>(null);
  const [practiceHistory, setPracticeHistory] = useState<any[]>(() => getPracticeHistory());
  const [examHistory, setExamHistory] = useState<FullMockExamResult[]>(() => getExamHistory());
  const [completedDays, setCompletedDays] = useState<string[]>([]);
  const [vocab, setVocab] = useState<VocabularyWord[]>([]);

  useEffect(() => {
    const syncDev = () => {
      const unlocked = isDevAdminUnlocked();
      setIsDevAdmin(unlocked);
      if (!unlocked && activeTab === 'dev') {
        setActiveTab('settings');
      }
    };
    window.addEventListener('toefl_dev_admin_changed', syncDev);
    window.addEventListener('storage', syncDev);
    return () => {
      window.removeEventListener('toefl_dev_admin_changed', syncDev);
      window.removeEventListener('storage', syncDev);
    };
  }, [activeTab]);

  // Dedicated Goals State
  const [targetScoreInput, setTargetScoreInput] = useState('100');
  const [testDateInput, setTestDateInput] = useState('');
  const [weeklyGoalInput, setWeeklyGoalInput] = useState(5);
  const [goalsSavedSuccess, setGoalsSavedSuccess] = useState(false);

  // New Word Form
  const [newWord, setNewWord] = useState('');
  const [newDef, setNewDef] = useState('');

  const [questionCounts, setQuestionCounts] = useState<Record<string, number>>({
    'complete-words': 0,
    'daily-life': 0,
    'reading-academic': 0,
    'reading-passage': 0,
    'listening-choose-response': 0,
    'listening-dialogue': 0,
    'listening-announcement': 0,
    'listening-academic-talk': 0,
    'build-sentence': 0,
    'write-email': 0,
    'academic-discussion': 0,
    'listen-repeat': 0,
    'speaking-interview': 0,
  });
  const [loadingQuestionCounts, setLoadingQuestionCounts] = useState(false);
  const [mockExamSetsCount, setMockExamSetsCount] = useState<number>(3);
  const [examBankTotal, setExamBankTotal] = useState<number>(0);
  const [coachBankTotal, setCoachBankTotal] = useState<number>(0);

  useEffect(() => {
    if (defaultTab) {
      setActiveTab(defaultTab);
    }
  }, [defaultTab]);

  useEffect(() => {
    let mounted = true;
    setLoadingQuestionCounts(true);
    Promise.all([
      getQuestionCountsPerTaskType(practiceMode),
      getQuestionCountsPerTaskType('exam'),
      getQuestionCountsPerTaskType('coach'),
      getMockExamSetsCount(),
    ])
      .then(([counts, examCounts, coachCounts, setsCount]) => {
        if (mounted) {
          setQuestionCounts(counts);
          setExamBankTotal(Object.values(examCounts).reduce((a, b) => a + b, 0));
          setCoachBankTotal(Object.values(coachCounts).reduce((a, b) => a + b, 0));
          setMockExamSetsCount(setsCount);
          setLoadingQuestionCounts(false);
        }
      })
      .catch(() => {
        if (mounted) setLoadingQuestionCounts(false);
      });
    return () => {
      mounted = false;
    };
  }, [isOpen, activeTab, practiceMode]);

  useEffect(() => {
    const loadUserData = () => {
      if (isOpen) {
        setPracticeHistory(getPracticeHistory());
        setExamHistory(getExamHistory());
        setStats(getUserStats());
        getCompletedDays().then(setCompletedDays).catch(() => setCompletedDays([]));
        
        getVocabularyWords().then((remoteWords) => {
          const localItems = getVocabularyList();
          const mergedMap = new Map<string, VocabularyWord>();

          localItems.forEach((lw) => {
            mergedMap.set(lw.word.toLowerCase(), {
              id: lw.id,
              userId: 'local',
              word: lw.word,
              definition: lw.definition || '',
              context: lw.contextSentence || '',
              taskType: lw.section || 'general',
              leitnerBox: 1,
              nextReviewDate: new Date(),
              createdAt: lw.timestamp,
            });
          });

          remoteWords.forEach((rw) => {
            mergedMap.set(rw.word.toLowerCase(), rw);
          });

          setVocab(Array.from(mergedMap.values()));
        }).catch(() => {
          const localItems = getVocabularyList();
          setVocab(localItems.map((lw) => ({
            id: lw.id,
            userId: 'local',
            word: lw.word,
            definition: lw.definition || '',
            context: lw.contextSentence || '',
            taskType: lw.section || 'general',
            leitnerBox: 1,
            nextReviewDate: new Date(),
            createdAt: lw.timestamp,
          })));
        });

        const storedTarget = localStorage.getItem('toefl_target_score') || '100';
        const storedDate = localStorage.getItem('toefl_test_date') || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
        const storedWeekly = parseInt(localStorage.getItem('WEEKLY_GOAL') || '5', 10);
        setTargetScoreInput(storedTarget);
        setTestDateInput(storedDate);
        setWeeklyGoalInput(isNaN(storedWeekly) ? 5 : storedWeekly);
        setGoalsSavedSuccess(false);
      }
    };

    loadUserData();
    window.addEventListener('toefl_user_changed', loadUserData);
    window.addEventListener('toefl_vocab_updated', loadUserData);
    window.addEventListener('toefl_progress_reset', loadUserData);
    window.addEventListener('toefl_exam_history_updated', loadUserData);
    return () => {
      window.removeEventListener('toefl_user_changed', loadUserData);
      window.removeEventListener('toefl_vocab_updated', loadUserData);
      window.removeEventListener('toefl_progress_reset', loadUserData);
      window.removeEventListener('toefl_exam_history_updated', loadUserData);
    };
  }, [isOpen]);

  const targetScoreNum = parseInt(targetScoreInput, 10) || 100;
  const toeflEstimate = calculateToeflEstimate(practiceHistory);
  const readinessPct = Math.min(100, Math.round((toeflEstimate.overallScore / (targetScoreNum || 120)) * 100));
  const scoreGap = Math.max(0, targetScoreNum - toeflEstimate.overallScore);

  const daysUntilTest = testDateInput
    ? Math.ceil((new Date(testDateInput).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  const weeklyCompleted = practiceHistory.length === 0 ? 0 : (stats?.weeklyCompleted || practiceHistory.length);
  const sectionTargetScore = Math.round(targetScoreNum / 4);
  const totalBankCount = Object.values(questionCounts).reduce((a, b) => a + b, 0);

  const handleSaveGoals = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('toefl_target_score', targetScoreInput);
    localStorage.setItem('toefl_test_date', testDateInput);
    localStorage.setItem('WEEKLY_GOAL', weeklyGoalInput.toString());
    setGoalsSavedSuccess(true);
    setTimeout(() => setGoalsSavedSuccess(false), 3000);
  };

  const handleAddVocab = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWord.trim() || !newDef.trim()) return;
    saveVocabLocal(newWord.trim(), undefined, newDef.trim(), 'Manual');
    await saveVocabRemote(newWord.trim(), newDef.trim());
    setNewWord('');
    setNewDef('');
    window.dispatchEvent(new CustomEvent('toefl_vocab_updated'));
  };

  const handleDeleteVocab = async (id: string, word?: string) => {
    removeVocabLocal(word || id);
    await deleteVocabRemote(id);
    window.dispatchEvent(new CustomEvent('toefl_vocab_updated'));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header - flex-shrink-0 */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-teal-100 rounded-xl text-teal-700">
              <LayoutDashboard className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Scholar Dashboard</h2>
              <p className="text-xs text-slate-500">Track performance, manage study goals, and configure preferences</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden md:flex items-center gap-1.5 mr-2">
              <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-teal-50 text-teal-800 border border-teal-200">
                🎯 Exam Bank: {examBankTotal || totalBankCount}
              </span>
              <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-800 border border-indigo-200">
                🎓 Coach Bank: {coachBankTotal}
              </span>
              <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
                📚 Full Mock Exam Sets: {mockExamSetsCount} Sets
              </span>
            </div>
            <button 
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tabs Bar - flex-shrink-0, sticky, solid background, z-20, pb-2 so bottom labels/focus rings are never clipped */}
        <div className="flex border-b border-slate-200 px-6 bg-white gap-6 overflow-x-auto scrollbar-none flex-shrink-0 sticky top-0 z-20 pt-1 pb-2 shadow-2xs">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'dashboard'
                ? 'border-teal-600 text-teal-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <LayoutDashboard className="w-4 h-4" /> Overview &amp; Stats
          </button>
          
          <button
            onClick={() => setActiveTab('goals')}
            className={`py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'goals'
                ? 'border-teal-600 text-teal-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Target className="w-4 h-4 text-teal-600" />
            <span>Study Goals</span>
            <span className="text-[10px] bg-teal-100 text-teal-800 font-bold px-1.5 py-0.5 rounded-full">
              {totalBankCount > 0 ? String(totalBankCount) : '120'}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('settings')}
            className={`py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'settings'
                ? 'border-teal-600 text-teal-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Settings className="w-4 h-4" /> Settings
          </button>

          <button
            onClick={() => setActiveTab('vocabulary')}
            className={`py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'vocabulary'
                ? 'border-teal-600 text-teal-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <BookOpen className="w-4 h-4" /> Vocabulary Bank ({vocab.length})
          </button>
          
          <button
            onClick={() => setActiveTab('mistakes')}
            className={`py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'mistakes'
                ? 'border-teal-600 text-teal-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <AlertCircle className="w-4 h-4" /> Mistake Notebook
          </button>

          {isDevAdmin && (
            <button
              onClick={() => setActiveTab('dev')}
              className={`py-2.5 text-sm font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                activeTab === 'dev'
                  ? 'border-amber-500 text-slate-900'
                  : 'border-transparent text-amber-700 hover:text-slate-900'
              }`}
            >
              <Terminal className="w-4 h-4 text-amber-600" />
              <span>🛠️ Dev Console</span>
            </button>
          )}
        </div>

        {/* Content Body - flex-1, min-h-0, overflow-y-auto */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6 bg-slate-50/30">
          {activeTab === 'dashboard' && (
            <OverviewTab
              toeflEstimate={toeflEstimate}
              stats={stats}
              history={practiceHistory}
              examHistory={examHistory}
              completedDays={completedDays}
              vocab={vocab}
              onOpenTask={(target) => {
                onClose();
                onNavigateToTask?.(target);
              }}
              onOpenHistory={openHistory}
              onSwitchTab={(tab) => setActiveTab(tab)}
              onResetProgress={() => {
                clearExamHistory();
                onResetProgress?.();
                setPracticeHistory([]);
                setExamHistory([]);
                setStats(null);
                setCompletedDays([]);
              }}
              studyGoals={{
                targetScore: targetScoreNum,
                testDate: testDateInput,
                weeklyGoal: weeklyGoalInput,
              }}
            />
          )}
          {activeTab === 'goals' && (
            <GoalsTab
              targetScoreNum={targetScoreNum}
              convertScaledToBand6={convertScaledToBand6}
              toeflEstimate={toeflEstimate}
              readinessPct={readinessPct}
              scoreGap={scoreGap}
              daysUntilTest={daysUntilTest}
              testDateInput={testDateInput}
              weeklyGoalInput={weeklyGoalInput}
              weeklyCompleted={weeklyCompleted}
              completedDays={completedDays}
              sectionTargetScore={sectionTargetScore}
              loadingQuestionCounts={loadingQuestionCounts}
              questionCounts={questionCounts}
              goalsSavedSuccess={goalsSavedSuccess}
              targetScoreInput={targetScoreInput}
              setTargetScoreInput={setTargetScoreInput}
              setTestDateInput={setTestDateInput}
              setWeeklyGoalInput={setWeeklyGoalInput}
              handleSaveGoals={handleSaveGoals}
              mockExamSetsCount={mockExamSetsCount}
              examBankTotal={examBankTotal}
              coachBankTotal={coachBankTotal}
            />
          )}
          {activeTab === 'settings' && (
            <SettingsTab
              currentTaskType={currentTaskType}
              practiceMode={practiceMode}
              onOpenDevConsole={() => setActiveTab('dev')}
            />
          )}
          {activeTab === 'vocabulary' && (
            <VocabularyTab
              vocab={vocab}
              newWord={newWord}
              newDef={newDef}
              setNewWord={setNewWord}
              setNewDef={setNewDef}
              handleAddVocab={handleAddVocab}
              handleDeleteVocab={handleDeleteVocab}
            />
          )}
          {activeTab === 'mistakes' && <MistakesTab />}
          {activeTab === 'dev' && isDevAdmin && (
            <DevConsoleTab
              practiceMode={practiceMode}
              currentTaskType={currentTaskType}
              onOpenDevConsoleQuestionEditor={(task, mode) => {
                onClose();
                window.dispatchEvent(
                  new CustomEvent('toefl_dev_edit_question', {
                    detail: {
                      questionKey: task?.questionDocId || task?.id,
                      questionDocId: task?.questionDocId || task?.id,
                      task,
                      mode,
                    },
                  })
                );
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
