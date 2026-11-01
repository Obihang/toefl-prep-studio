import React, { useState, useEffect, useMemo } from 'react';
import { Target, Trophy, Flame, CheckCircle2, Circle, ArrowRight, Play, Sparkles, Clock, AlertTriangle, BookOpen, FileText, ChevronDown, ChevronUp, Award, Trash2 } from 'lucide-react';
import { PracticeRecord, getUserStats, convertScaledToBand6, calculateMyBestScores, getCompletedQuestionIds, clearAllUserProgress } from '../../../utils/scoreTracker';
import { getExamHistory, clearExamHistory, FullMockExamResult } from '../../../utils/examStorage';
import { getMistakesList } from '../../../utils/mistakesTracker';
import { HighlightedText } from '../../shared/FeedbackComparison';
import { streak } from '../../../utils/dashboardStats';
import {
  generateDailyPlan,
  toggleTaskCompletion,
  DailyStudyPlan,
  StudyPlanTask,
  StudyGoals,
} from '../../../utils/studyPlanGenerator';
import { ScoreTrendChart } from './charts/ScoreTrendChart';
import { SectionAveragesChart } from './charts/SectionAveragesChart';
import { WeeklyActivityChart } from './charts/WeeklyActivityChart';
import { StreakCalendarChart } from './charts/StreakCalendarChart';

interface OverviewTabProps {
  toeflEstimate: { overallScore: number; cefrCode: string; overallBand6: number };
  stats: any;
  history?: PracticeRecord[];
  examHistory?: FullMockExamResult[];
  completedDays?: string[];
  weakAreas?: Array<{ topic: string; errorCount: number; section: string }>;
  onOpenTask?: (taskType: string) => void;
  onOpenHistory?: () => void;
  onSwitchTab?: (tab: 'dashboard' | 'goals' | 'settings' | 'vocabulary' | 'mistakes') => void;
  onResetProgress?: () => void;
  vocab?: any[];
  mistakes?: any[];
  studyGoals?: StudyGoals;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  toeflEstimate,
  stats,
  history = [],
  examHistory: examHistoryProp,
  completedDays = [],
  weakAreas = [],
  onOpenTask,
  onOpenHistory,
  onSwitchTab,
  onResetProgress,
  vocab = [],
  mistakes = [],
  studyGoals,
}) => {
  const targetScore = stats?.targetScore || 100;
  const scoreGap = Math.max(0, targetScore - toeflEstimate.overallScore);
  const st = streak(completedDays);
  const weeklyCompleted = history.length === 0 ? 0 : (stats?.weeklyCompleted || history.length);
  const weeklyGoal = parseInt(localStorage.getItem('WEEKLY_GOAL') || '5', 10);
  const myBest = calculateMyBestScores(history);
  const examHistory = useMemo(
    () => (Array.isArray(examHistoryProp) ? examHistoryProp : getExamHistory()),
    [examHistoryProp]
  );

  const bestMockExam = useMemo(() => {
    if (examHistory.length === 0) return null;
    let best = examHistory[0];
    for (const item of examHistory) {
      if (
        item.totalScore120 > best.totalScore120 ||
        (item.totalScore120 === best.totalScore120 && item.overallBand6 > best.overallBand6)
      ) {
        best = item;
      }
    }
    return best;
  }, [examHistory]);

  const [dailyPlan, setDailyPlan] = useState<DailyStudyPlan>(() =>
    generateDailyPlan(history, mistakes, vocab, studyGoals)
  );
  const [expandedAttemptId, setExpandedAttemptId] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [historyModeTab, setHistoryModeTab] = useState<'section_practice' | 'full_mock'>('section_practice');

  useEffect(() => {
    const updatePlan = () => {
      setDailyPlan(generateDailyPlan(history, mistakes, vocab, studyGoals));
    };
    updatePlan();
    window.addEventListener('toefl_daily_plan_updated', updatePlan);
    window.addEventListener('toefl_user_changed', updatePlan);
    return () => {
      window.removeEventListener('toefl_daily_plan_updated', updatePlan);
      window.removeEventListener('toefl_user_changed', updatePlan);
    };
  }, [history, mistakes, vocab, studyGoals]);

  const handleTaskClick = (item: StudyPlanTask) => {
    if (item.type === 'practice') {
      onOpenTask?.(item.taskType || item.targetSection.toLowerCase());
    } else if (item.type === 'review') {
      if (item.targetSection === 'Mistakes' || item.taskType === 'mistakes') {
        onSwitchTab?.('mistakes');
      } else if (item.targetSection === 'Vocabulary' || item.taskType === 'vocabulary') {
        onSwitchTab?.('vocabulary');
      }
    }
  };

  const handleToggleCheck = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    const updated = toggleTaskCompletion(taskId);
    if (updated) setDailyPlan(updated);
  };

  const completedCount = dailyPlan.tasks.filter((t) => t.isCompleted).length;
  const totalCount = dailyPlan.tasks.length;
  const weakestInfo = dailyPlan.weakestSection;

  const recentAttemptsList = [...history]
    .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
    .slice(0, 10);

  return (
    <div className="space-y-6">
      {/* 1. Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Projected Score */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-1">
          <p className="text-xs font-semibold text-slate-500">Projected Score (Avg)</p>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-extrabold text-teal-900">{toeflEstimate.overallScore}</p>
            <span className="text-xs text-slate-400">/ 120</span>
          </div>
          <span className="inline-block text-[10px] font-bold text-teal-800 bg-teal-50 px-2 py-0.5 rounded-full">
            {toeflEstimate.cefrCode} Level (Band {toeflEstimate.overallBand6.toFixed(1)})
          </span>
        </div>

        {/* Gap to Target */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-1">
          <p className="text-xs font-semibold text-slate-500">Gap to Target ({targetScore})</p>
          <p className="text-2xl font-extrabold text-slate-900 mt-1">
            {scoreGap === 0 ? 'Goal Met! 🎉' : `-${scoreGap} pts`}
          </p>
          <p className="text-[10px] text-slate-400">Target benchmark: {targetScore}</p>
        </div>

        {/* Current & Best Streak */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-1">
          <p className="text-xs font-semibold text-slate-500">Streak</p>
          <div className="flex items-baseline gap-1 text-2xl font-extrabold text-amber-600">
            <Flame className="w-5 h-5 fill-amber-500 text-amber-500" />
            <span>{st.current}</span>
            <span className="text-xs font-normal text-slate-400">days (best: {st.best})</span>
          </div>
          <p className="text-[10px] text-slate-400">Keep your daily habit alive</p>
        </div>

        {/* Weekly Goal Progress */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-1">
          <p className="text-xs font-semibold text-slate-500">Weekly Goal</p>
          <p className="text-2xl font-extrabold text-teal-900 mt-1">{weeklyCompleted} / {weeklyGoal}</p>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-2">
            <div
              className="h-full bg-teal-700 rounded-full"
              style={{ width: `${Math.min(100, (weeklyCompleted / (weeklyGoal || 1)) * 100)}%` }}
            />
          </div>
        </div>

        {/* Tests Completed */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-1">
          <p className="text-xs font-semibold text-slate-500">Tests Completed</p>
          <p className="text-2xl font-extrabold text-slate-900 mt-1">{stats?.completedTests || history.length || 0}</p>
          <p className="text-[10px] text-slate-400">Practice sessions logged</p>
        </div>
      </div>

      {/* 1b. Official ETS MyBest® Scores (Superscore) Summary Card */}
      <div className="bg-gradient-to-r from-emerald-950 via-teal-900 to-slate-900 text-white rounded-2xl p-4 sm:p-5 border border-teal-700/50 shadow-sm space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-teal-800/60 pb-2.5">
          <div className="flex items-center gap-2">
            <Trophy className="w-5 h-5 text-amber-400 shrink-0" />
            <div>
              <h4 className="text-sm font-bold tracking-tight flex items-center gap-2">
                MyBest® Scores (Official ETS Superscore)
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-400/30">
                  Band 1.0–6.0 & 0–120
                </span>
              </h4>
              <p className="text-[11px] text-teal-200/80">
                Highest section scores achieved across all your Reading, Listening, Speaking, and Writing sessions
              </p>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-lg bg-white/10 text-xs font-mono font-bold text-teal-200 border border-white/15">
            CEFR {myBest.cefrCode} ({myBest.cefrLevel})
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="bg-white/10 border border-white/15 rounded-xl p-3 text-center col-span-2 sm:col-span-1 flex flex-col justify-center">
            <div className="text-[10px] text-amber-300 uppercase font-bold tracking-wider">MyBest® Overall</div>
            <div className="text-2xl font-mono font-extrabold text-white mt-0.5">
              {myBest.hasAnyAttempts ? `${myBest.overallBand6.toFixed(1)} / 6.0` : '—'}
            </div>
            <div className="text-[11px] text-teal-200 font-mono">
              {myBest.hasAnyAttempts ? `${myBest.totalScaled120} / 120 Scaled` : 'No scores yet'}
            </div>
          </div>

          {([
            { label: 'Reading', data: myBest.reading },
            { label: 'Listening', data: myBest.listening },
            { label: 'Speaking', data: myBest.speaking },
            { label: 'Writing', data: myBest.writing },
          ] as const).map(({ label, data }) => (
            <div key={label} className="bg-slate-900/55 border border-teal-800/60 rounded-xl p-3 text-center">
              <div className="text-[11px] text-teal-200 font-semibold">{label}</div>
              <div className="text-lg font-mono font-bold text-white mt-0.5">
                {data.attemptsCount > 0 ? `Band ${data.bandScore6.toFixed(1)}` : '—'}
              </div>
              <div className="text-[10px] text-teal-300/90 font-mono">
                {data.attemptsCount > 0 ? `${data.scaledScore30}/30 Scaled` : 'Not practiced'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 2. Today's Plan & Weak Areas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Today's Plan */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-slate-900 text-sm flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-teal-700" />
              Today's Plan
            </h4>
            <div className="flex items-center gap-2">
              {dailyPlan.urgent && (
                <span className="text-[10px] bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Sprint Mode ({dailyPlan.daysUntilTest}d)
                </span>
              )}
              <span className="text-[10px] bg-teal-50 text-teal-800 px-2 py-0.5 rounded-full font-semibold">
                {completedCount}/{totalCount} Completed
              </span>
            </div>
          </div>

          <div className="space-y-3">
            {dailyPlan.tasks.map((item) => (
              <div
                key={item.id}
                onClick={() => handleTaskClick(item)}
                className={`p-3.5 border rounded-xl flex items-center justify-between gap-3 transition-colors cursor-pointer group ${
                  item.isCompleted
                    ? 'bg-slate-50/70 border-slate-200 text-slate-400'
                    : 'bg-white hover:bg-teal-50/40 border-slate-200 hover:border-teal-300 shadow-2xs'
                }`}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <button
                    onClick={(e) => handleToggleCheck(e, item.id)}
                    className="mt-0.5 text-slate-400 hover:text-teal-700 transition-colors cursor-pointer shrink-0"
                    title={item.isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                  >
                    {item.isCompleted ? (
                      <CheckCircle2 className="w-4 h-4 text-teal-700 fill-teal-50" />
                    ) : (
                      <Circle className="w-4 h-4 text-slate-300 group-hover:text-teal-600" />
                    )}
                  </button>
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <h5
                        className={`font-bold text-xs truncate ${
                          item.isCompleted
                            ? 'line-through text-slate-400'
                            : 'text-slate-900 group-hover:text-teal-900'
                        }`}
                      >
                        {item.title}
                      </h5>
                      <span
                        className={`text-[9px] font-semibold px-1.5 py-0.2 rounded-md shrink-0 uppercase tracking-wider ${
                          item.type === 'practice'
                            ? 'bg-teal-100 text-teal-800'
                            : 'bg-indigo-100 text-indigo-800'
                        }`}
                      >
                        {item.type}
                      </span>
                    </div>
                    <p className={`text-[11px] leading-tight ${item.isCompleted ? 'text-slate-400' : 'text-slate-500'}`}>
                      {item.description}
                    </p>
                  </div>
                </div>

                <div className="p-2 bg-slate-50 rounded-lg border border-slate-200 text-teal-700 group-hover:bg-teal-700 group-hover:text-white group-hover:border-teal-700 transition-colors shrink-0">
                  {item.type === 'practice' ? (
                    <Play className="w-3.5 h-3.5 fill-current" />
                  ) : item.taskType === 'vocabulary' ? (
                    <BookOpen className="w-3.5 h-3.5" />
                  ) : (
                    <ArrowRight className="w-3.5 h-3.5" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Weak Areas */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-slate-900 text-sm flex items-center gap-2">
              <Target className="w-4 h-4 text-teal-700" />
              Identified Weak Areas
            </h4>
            <span className="text-xs font-semibold text-slate-500">
              {weakestInfo.hasHistory ? 'Calibrated Diagnosis' : 'Baseline Suggestion'}
            </span>
          </div>

          {/* Primary Weakest Section Card */}
          <div className="p-4 bg-teal-50/50 border border-teal-200 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-teal-900 bg-teal-100 px-2.5 py-0.5 rounded-md">
                  {weakestInfo.section}
                </span>
                <span className="text-xs font-bold text-teal-800">
                  Avg: {weakestInfo.avgScaled.toFixed(1)} / 30 · Band {weakestInfo.avgBand.toFixed(1)}
                </span>
              </div>
              <span className="text-[10px] text-teal-700 font-semibold bg-white border border-teal-200 px-2 py-0.5 rounded-full">
                Lowest Section
              </span>
            </div>

            <p className="text-xs text-slate-700 leading-relaxed font-medium">
              {weakestInfo.tip}
            </p>

            <button
              onClick={() => onOpenTask?.(weakestInfo.section.toLowerCase())}
              className="w-full py-2 bg-teal-800 hover:bg-teal-900 text-white text-xs font-bold rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-2 shadow-2xs"
            >
              <span>Practice {weakestInfo.section} Now</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Additional granular weak areas if detected */}
          {weakAreas.length > 0 && (
            <div className="space-y-2 pt-1">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                Specific Topic Focus Areas ({weakAreas.length})
              </p>
              <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
                {weakAreas.map((w, idx) => (
                  <div key={idx} className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between gap-3 text-xs">
                    <div>
                      <span className="text-[9px] font-bold uppercase text-slate-600 bg-slate-200/60 px-1.5 py-0.5 rounded">
                        {w.section}
                      </span>
                      <p className="font-semibold text-slate-800 mt-0.5">{w.topic}</p>
                    </div>
                    <button
                      onClick={() => onOpenTask?.(w.section.toLowerCase())}
                      className="px-2.5 py-1 bg-white hover:bg-teal-50 border border-slate-200 text-teal-800 font-semibold rounded-md transition-colors cursor-pointer shrink-0 flex items-center gap-1"
                    >
                      <span>Drill</span>
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 3. Charts: Score Trend & Section Averages */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ScoreTrendChart history={history} />
        <SectionAveragesChart history={history} />
      </div>

      {/* 4. Weekly Activity & Streak Calendar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <WeeklyActivityChart history={history} />
        <StreakCalendarChart completedDays={completedDays} />
      </div>

      {/* 5. Recent Attempts (2-Tab Switcher: Section Practice History vs Full Mock Exam History) */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="font-bold text-slate-900 text-sm">Official Score History</h4>
            <p className="text-xs text-slate-500">
              Strictly separated 🎯 Section Practice (Exam Mode) and 🏆 Full Mock Exam records (Coach Mode excluded)
            </p>
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            {(history.length > 0 || examHistory.length > 0 || mistakes.length > 0 || getMistakesList().length > 0 || getCompletedQuestionIds().length > 0) && (
              confirmingReset ? (
                <div className="flex items-center gap-1.5 bg-rose-50 border border-rose-200 px-2.5 py-1 rounded-lg text-xs">
                  <span className="text-rose-800 font-semibold">Confirm Reset Everything?</span>
                  <button
                    type="button"
                    onClick={() => {
                      clearExamHistory();
                      if (onResetProgress) {
                        onResetProgress();
                      } else {
                        clearAllUserProgress();
                      }
                      setConfirmingReset(false);
                    }}
                    className="px-2 py-0.5 font-bold bg-rose-600 text-white rounded hover:bg-rose-700 transition-colors cursor-pointer"
                  >
                    Yes, Clear All
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingReset(false)}
                    className="px-1.5 py-0.5 text-slate-600 hover:text-slate-900 font-medium transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingReset(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>🗑️ Reset All Scores &amp; History</span>
                </button>
              )
            )}
            {onOpenHistory && (
              <button
                onClick={onOpenHistory}
                className="text-xs font-bold text-teal-700 hover:text-teal-900 flex items-center gap-1 cursor-pointer"
              >
                <span>View Score History</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* 2-Tab Switcher */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 bg-slate-100 p-1 rounded-xl border border-slate-200">
          <button
            type="button"
            onClick={() => setHistoryModeTab('section_practice')}
            className={`py-2 px-3 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center justify-center gap-2 ${
              historyModeTab === 'section_practice'
                ? 'bg-white text-teal-900 shadow-2xs border border-teal-200/80'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span>🎯 Section Practice History (Exam Mode)</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-teal-50 text-teal-800 border border-teal-200">
              {history.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setHistoryModeTab('full_mock')}
            className={`py-2 px-3 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center justify-center gap-2 ${
              historyModeTab === 'full_mock'
                ? 'bg-white text-teal-900 shadow-2xs border border-teal-200/80'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span>🏆 Full Mock Exam History</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-amber-50 text-amber-900 border border-amber-200">
              {examHistory.length}
            </span>
          </button>
        </div>

        {historyModeTab === 'section_practice' ? (
          recentAttemptsList.length === 0 ? (
            <div className="h-28 flex flex-col items-center justify-center text-xs text-slate-400">
              <Clock className="w-6 h-6 text-slate-300 mb-1" />
              <span>No Official Exam Mode section practice attempts recorded yet.</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-100 text-slate-400 font-semibold">
                    <th className="pb-2">Date</th>
                    <th className="pb-2">Section</th>
                    <th className="pb-2">Task</th>
                    <th className="pb-2 text-right">Score</th>
                    <th className="pb-2 text-right">Saved Response</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {recentAttemptsList.map((att, idx) => {
                    const scaled30 = typeof att.scaledScore30 === 'number' ? att.scaledScore30 : Math.min(30, Number(att.score || 0));
                    const band6 = att.bandScore6 ?? convertScaledToBand6(scaled30, att.section);
                    const rowKey = att.id || `att-${idx}`;
                    const hasSavedResponse = Boolean(att.studentResponse && att.studentResponse.trim().length > 0);
                    const isExpanded = expandedAttemptId === rowKey;
                    const grammarErrors = Array.isArray(att.grammarErrors) ? att.grammarErrors : [];
                    return (
                      <React.Fragment key={rowKey}>
                        <tr className="hover:bg-slate-50/60 transition-colors">
                          <td className="py-2.5 text-slate-500">{new Date(att.date || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                          <td className="py-2.5 font-semibold text-slate-800">{att.section}</td>
                          <td className="py-2.5 text-slate-600 truncate max-w-xs">{att.taskTitle || att.taskType}</td>
                          <td className="py-2.5 text-right font-bold text-teal-900 font-mono">
                            Band {band6.toFixed(1)} · {scaled30} / 30
                          </td>
                          <td className="py-2.5 text-right whitespace-nowrap pl-2">
                            {hasSavedResponse ? (
                              <button
                                type="button"
                                onClick={() => setExpandedAttemptId(isExpanded ? null : rowKey)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md transition-colors cursor-pointer"
                              >
                                <FileText className="w-3 h-3 text-teal-700" />
                                <span>{isExpanded ? 'Hide Saved Response' : '📄 View Saved Response'}</span>
                                {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                              </button>
                            ) : (
                              <span className="text-[11px] text-slate-300">—</span>
                            )}
                          </td>
                        </tr>
                        {hasSavedResponse && isExpanded && (
                          <tr className="bg-slate-50/80">
                            <td colSpan={5} className="p-4 border-t border-slate-100">
                              <div className="space-y-4">
                                {att.feedbackSummary && (
                                  <div className="text-xs text-slate-700 bg-white border border-slate-200 rounded-lg p-3 leading-relaxed">
                                    <span className="font-bold text-slate-900 mr-1.5">Evaluation Summary:</span>
                                    {att.feedbackSummary}
                                  </div>
                                )}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                  <div className="space-y-1.5">
                                    <h5 className="text-[11px] font-bold uppercase tracking-wider text-slate-800">
                                      Your Saved Response {grammarErrors.length > 0 ? `(${grammarErrors.length} Highlighted Fixes)` : ''}
                                    </h5>
                                    <div className="p-3.5 bg-white border border-slate-200 rounded-lg text-xs leading-relaxed text-slate-900 whitespace-pre-line">
                                      <HighlightedText text={att.studentResponse || ''} corrections={grammarErrors as any} />
                                    </div>
                                  </div>
                                  {att.modelAnswer && (
                                    <div className="space-y-1.5">
                                      <h5 className="text-[11px] font-bold uppercase tracking-wider text-teal-800 flex items-center gap-1">
                                        <Award className="w-3.5 h-3.5 text-teal-600" />
                                        <span>Band 6.0 Model Answer</span>
                                      </h5>
                                      <div className="p-3.5 bg-teal-50/50 border border-teal-200 rounded-lg text-xs leading-relaxed text-teal-950 whitespace-pre-line">
                                        {att.modelAnswer}
                                      </div>
                                    </div>
                                  )}
                                </div>
                                {grammarErrors.length > 0 && (
                                  <div className="space-y-2">
                                    <h6 className="text-[11px] font-bold uppercase tracking-wider text-slate-700">
                                      Grammar &amp; Wording Fixes ({grammarErrors.length})
                                    </h6>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      {grammarErrors.map((err, i) => (
                                        <div key={i} className="p-2.5 bg-white border border-slate-200 rounded-lg text-xs space-y-1">
                                          <div className="flex items-baseline flex-wrap gap-1.5">
                                            <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-900 line-through font-semibold">
                                              &ldquo;{err.original}&rdquo;
                                            </span>
                                            <span className="text-slate-400 font-bold">→</span>
                                            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold">
                                              &ldquo;{err.corrected}&rdquo;
                                            </span>
                                          </div>
                                          <p className="text-[11px] text-slate-600 leading-snug">{err.explanation}</p>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <div className="space-y-4">
            {/* Full Mock Exam MyBest® Summary Banner */}
            <div className="p-4 bg-gradient-to-r from-slate-900 via-teal-950 to-emerald-950 text-white rounded-xl flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Trophy className="w-5 h-5 text-amber-400 shrink-0" />
                <div>
                  <div className="text-xs font-bold text-amber-300 uppercase tracking-wider">
                    Full Mock Exam MyBest® Overall Band &amp; Total Score
                  </div>
                  <div className="text-xs text-teal-200/90">
                    {bestMockExam
                      ? `${bestMockExam.setTitle} · CEFR ${bestMockExam.cefrCode} (${bestMockExam.cefrName})`
                      : 'Complete a 4-section Full Mock Exam to record your official mock test score'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="px-3 py-1.5 bg-white/10 border border-white/15 rounded-lg text-right font-mono">
                  <div className="text-sm font-extrabold text-white">
                    {bestMockExam ? `Band ${bestMockExam.overallBand6.toFixed(1)} / 6.0` : '—'}
                  </div>
                  <div className="text-[11px] text-teal-200">
                    {bestMockExam ? `${bestMockExam.totalScore120} / 120 Total` : 'No Mock Exams'}
                  </div>
                </div>
              </div>
            </div>

            {examHistory.length === 0 ? (
              <div className="h-28 flex flex-col items-center justify-center text-xs text-slate-400">
                <Clock className="w-6 h-6 text-slate-300 mb-1" />
                <span>No Full Mock Exams completed yet.</span>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 text-slate-400 font-semibold">
                      <th className="pb-2">Date</th>
                      <th className="pb-2">Mock Set Title</th>
                      <th className="pb-2 text-center">Overall Band</th>
                      <th className="pb-2 text-center">CEFR</th>
                      <th className="pb-2 text-center">Total Scaled</th>
                      <th className="pb-2 text-center">Reading</th>
                      <th className="pb-2 text-center">Listening</th>
                      <th className="pb-2 text-center">Writing</th>
                      <th className="pb-2 text-center">Speaking</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {examHistory.map((exam) => (
                      <tr key={exam.id} className="hover:bg-slate-50/60 transition-colors">
                        <td className="py-2.5 text-slate-500 whitespace-nowrap font-mono">
                          {new Date(exam.date || exam.completedAt).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </td>
                        <td className="py-2.5 font-semibold text-slate-900 max-w-xs truncate" title={exam.setTitle}>
                          {exam.setTitle}
                        </td>
                        <td className="py-2.5 text-center font-mono font-bold text-teal-800 whitespace-nowrap">
                          Band {Number(exam.overallBand6 || 1).toFixed(1)} / 6.0
                        </td>
                        <td className="py-2.5 text-center whitespace-nowrap">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-50 text-teal-800 border border-teal-200">
                            {exam.cefrCode}
                          </span>
                        </td>
                        <td className="py-2.5 text-center font-mono font-extrabold text-slate-900 whitespace-nowrap">
                          {exam.totalScore120} / 120
                        </td>
                        <td className="py-2.5 text-center font-mono text-slate-700 whitespace-nowrap">
                          {exam.sectionScores?.Reading ?? 0} / 30
                        </td>
                        <td className="py-2.5 text-center font-mono text-slate-700 whitespace-nowrap">
                          {exam.sectionScores?.Listening ?? 0} / 30
                        </td>
                        <td className="py-2.5 text-center font-mono text-slate-700 whitespace-nowrap">
                          {exam.sectionScores?.Writing ?? 0} / 30
                        </td>
                        <td className="py-2.5 text-center font-mono text-slate-700 whitespace-nowrap">
                          {exam.sectionScores?.Speaking ?? 0} / 30
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
