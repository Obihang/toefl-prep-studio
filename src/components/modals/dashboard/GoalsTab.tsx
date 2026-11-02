import React from 'react';
import { Target, Trophy, Zap, TrendingUp, Calendar, Flame, CheckCircle2, Settings, Layers, ArrowRight } from 'lucide-react';
import { TASK_DEFINITIONS } from '../../../types/taskTypes';
import { CURATED_MOCK_EXAM_SETS } from '../../../utils/mockExamSetsBank';

interface GoalsTabProps {
  targetScoreNum: number;
  convertScaledToBand6: (score: number) => number;
  toeflEstimate: { overallScore: number; cefrCode: string; readingScore: number; listeningScore: number; speakingScore: number; writingScore: number };
  readinessPct: number;
  scoreGap: number;
  daysUntilTest: number | null;
  testDateInput: string;
  weeklyGoalInput: number;
  weeklyCompleted: number;
  completedDays: string[];
  sectionTargetScore: number;
  loadingQuestionCounts: boolean;
  questionCounts: Record<string, number>;
  examQuestionCounts?: Record<string, number>;
  coachQuestionCounts?: Record<string, number>;
  selectedBankView?: 'exam' | 'coach' | 'mock';
  onSelectBankView?: (view: 'exam' | 'coach' | 'mock') => void;
  onOpenMockTestCenter?: () => void;
  goalsSavedSuccess: boolean;
  targetScoreInput: string;
  setTargetScoreInput: (val: string) => void;
  setTestDateInput: (val: string) => void;
  setWeeklyGoalInput: (val: number) => void;
  handleSaveGoals: (e: React.FormEvent) => void;
  mockExamSetsCount?: number;
  examBankTotal?: number;
  coachBankTotal?: number;
}

export const GoalsTab: React.FC<GoalsTabProps> = ({
  targetScoreNum,
  convertScaledToBand6,
  toeflEstimate,
  readinessPct,
  scoreGap,
  daysUntilTest,
  testDateInput,
  weeklyGoalInput,
  weeklyCompleted,
  completedDays,
  sectionTargetScore,
  loadingQuestionCounts,
  questionCounts,
  examQuestionCounts,
  coachQuestionCounts,
  selectedBankView = 'exam',
  onSelectBankView,
  onOpenMockTestCenter,
  goalsSavedSuccess,
  targetScoreInput,
  setTargetScoreInput,
  setTestDateInput,
  setWeeklyGoalInput,
  handleSaveGoals,
  mockExamSetsCount = 5,
  examBankTotal,
  coachBankTotal,
}) => {
  const activeCounts =
    selectedBankView === 'coach'
      ? coachQuestionCounts && Object.keys(coachQuestionCounts).length > 0
        ? coachQuestionCounts
        : questionCounts
      : examQuestionCounts && Object.keys(examQuestionCounts).length > 0
      ? examQuestionCounts
      : questionCounts;

  return (
    <div className="space-y-6">
      
      {/* Target Score & Readiness Hero Banner */}
      <div className="bg-gradient-to-br from-teal-900 via-teal-800 to-slate-900 text-white rounded-2xl p-6 shadow-md relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-teal-500/10 rounded-full blur-3xl pointer-events-none" />
        
        <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-teal-700/60 text-teal-200 text-xs font-semibold uppercase tracking-wider">
              <Target className="w-3.5 h-3.5" />
              <span>TOEFL iBT Target Benchmark</span>
            </div>
            <div className="flex items-baseline gap-3">
              <h3 className="text-4xl font-extrabold tracking-tight text-white">{targetScoreNum}</h3>
              <span className="text-xl text-teal-200/80 font-medium">/ 120 points</span>
            </div>
            <p className="text-xs text-teal-200/90 max-w-md">
              Corresponds to TOEFL Band <strong>{convertScaledToBand6(targetScoreNum).toFixed(1)} / 6.0</strong> (
              {targetScoreNum >= 100 ? 'C1 Advanced / Graduate Level' : targetScoreNum >= 80 ? 'B2 Upper-Intermediate / University Entrance' : 'B1 Intermediate'}
              ).
            </p>
          </div>

          {/* Readiness Gauge */}
          <div className="bg-white/10 backdrop-blur-xs border border-white/15 rounded-2xl p-4 w-full md:w-64 space-y-3">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="text-teal-200">Current Projected Score</span>
              <span className="text-white text-base font-bold">{toeflEstimate.overallScore} / 120</span>
            </div>
            
            <div className="h-2.5 bg-black/30 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-amber-400 to-emerald-400 rounded-full transition-all duration-700"
                style={{ width: `${readinessPct}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[11px] text-teal-100">
              <span>{readinessPct}% Target Readiness</span>
              <span className="font-semibold uppercase tracking-wider">{toeflEstimate.cefrCode} Level</span>
            </div>
          </div>
        </div>

        {/* Status Notice */}
        <div className="mt-4 pt-4 border-t border-white/10 flex items-center justify-between text-xs text-teal-100">
          <div className="flex items-center gap-2">
            {scoreGap <= 0 ? (
              <>
                <Trophy className="w-4 h-4 text-amber-300" />
                <span className="font-semibold text-amber-200">Goal Reached! You currently meet your target benchmark.</span>
              </>
            ) : scoreGap <= 6 ? (
              <>
                <Zap className="w-4 h-4 text-amber-300" />
                <span>Within striking distance: Only <strong className="text-white font-bold">{scoreGap} points</strong> to your target goal!</span>
              </>
            ) : (
              <>
                <TrendingUp className="w-4 h-4 text-teal-300" />
                <span>Work toward your goal: <strong className="text-white font-bold">{scoreGap} points</strong> needed to reach {targetScoreNum}.</span>
              </>
            )}
          </div>
          <span className="text-[11px] text-teal-300/80">Based on authentic ETS scoring curves</span>
        </div>
      </div>

      {/* Goal Pillars Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        
        {/* 1. Exam Date Countdown */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-2 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Exam Countdown</span>
            <Calendar className="w-4 h-4 text-teal-700" />
          </div>
          <div className="text-2xl font-bold text-slate-900">
            {daysUntilTest !== null
              ? daysUntilTest > 0
                ? `${daysUntilTest} Days`
                : daysUntilTest === 0
                ? 'Exam Today! 🎯'
                : 'Exam Date Passed'
              : 'Not Scheduled'}
          </div>
          <p className="text-xs text-slate-500">
            {testDateInput ? (
              <>Test Date: <strong className="text-slate-700 font-semibold">{new Date(testDateInput).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</strong></>
            ) : (
              'Set your target test date below'
            )}
          </p>
          <div className="text-[11px] text-teal-800 bg-teal-50 px-2 py-1 rounded-md font-medium">
            {daysUntilTest && daysUntilTest > 0
              ? `Pace: ~${Math.max(2, Math.ceil((weeklyGoalInput * 2) / Math.max(1, daysUntilTest / 7)))} tasks / day recommended`
              : 'Keep a steady 4-day weekly habit'}
          </div>
        </div>

        {/* 2. Weekly Practice Habit */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-2 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Weekly Habit</span>
            <Target className="w-4 h-4 text-teal-700" />
          </div>
          <div className="text-2xl font-bold text-slate-900">
            {weeklyCompleted} / {weeklyGoalInput} Tasks
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${weeklyCompleted >= weeklyGoalInput ? 'bg-emerald-500' : 'bg-teal-700'}`}
              style={{ width: `${Math.min(100, (weeklyCompleted / (weeklyGoalInput || 1)) * 100)}%` }}
            />
          </div>
          <div className="flex justify-between items-center text-[11px] text-slate-400">
            <span>Resets every Sunday</span>
            <span className="font-semibold text-slate-600">
              {weeklyCompleted >= weeklyGoalInput ? 'Weekly Goal Met! 🎉' : `${weeklyGoalInput - weeklyCompleted} left this week`}
            </span>
          </div>
        </div>

        {/* 3. Consistency Streak */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-2 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Study Streak</span>
            <Flame className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-2xl font-bold text-amber-600 flex items-center gap-1.5">
            <span>{completedDays.length}</span>
            <span className="text-sm font-normal text-slate-500">active days</span>
          </div>
          <p className="text-xs text-slate-500">
            Consistent daily practice builds automatic grammar and acoustic pattern recall.
          </p>
          <div className="text-[11px] text-amber-800 bg-amber-50 px-2 py-1 rounded-md font-medium">
            {completedDays.length >= 7 ? '🔥 7+ Day Master Scholar Streak' : 'Target: 5 active days per week'}
          </div>
        </div>
      </div>

      {/* Section-by-Section Score Target Breakdown */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h4 className="font-bold text-slate-900 text-sm">Section Target Parity (Target: {sectionTargetScore}/30 each)</h4>
            <p className="text-xs text-slate-500">Even performance across all four test sections is required for top university cutoffs.</p>
          </div>
          <span className="text-xs font-semibold text-teal-800 bg-teal-50 px-2.5 py-1 rounded-full border border-teal-200">
            Parity Goal: {sectionTargetScore} pts / section
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          
          {/* Reading */}
          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-xs text-slate-800">Reading</span>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${toeflEstimate.readingScore >= sectionTargetScore ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                {toeflEstimate.readingScore >= sectionTargetScore ? 'Met ✅' : `+${sectionTargetScore - toeflEstimate.readingScore} needed`}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-xl font-bold text-slate-900">{toeflEstimate.readingScore}</span>
              <span className="text-xs text-slate-400">Target: {sectionTargetScore}/30</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-tight">C-Test completion &amp; academic passage analysis</p>
          </div>

          {/* Listening */}
          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-xs text-slate-800">Listening</span>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${toeflEstimate.listeningScore >= sectionTargetScore ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                {toeflEstimate.listeningScore >= sectionTargetScore ? 'Met ✅' : `+${sectionTargetScore - toeflEstimate.listeningScore} needed`}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-xl font-bold text-slate-900">{toeflEstimate.listeningScore}</span>
              <span className="text-xs text-slate-400">Target: {sectionTargetScore}/30</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-tight">Campus conversations &amp; lecture comprehension</p>
          </div>

          {/* Speaking */}
          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-xs text-slate-800">Speaking</span>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${toeflEstimate.speakingScore >= sectionTargetScore ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                {toeflEstimate.speakingScore >= sectionTargetScore ? 'Met ✅' : `+${sectionTargetScore - toeflEstimate.speakingScore} needed`}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-xl font-bold text-slate-900">{toeflEstimate.speakingScore}</span>
              <span className="text-xs text-slate-400">Target: {sectionTargetScore}/30</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-tight">Repeat accuracy &amp; structured 45s interview answers</p>
          </div>

          {/* Writing */}
          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-xs text-slate-800">Writing</span>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${toeflEstimate.writingScore >= sectionTargetScore ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                {toeflEstimate.writingScore >= sectionTargetScore ? 'Met ✅' : `+${sectionTargetScore - toeflEstimate.writingScore} needed`}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-xl font-bold text-slate-900">{toeflEstimate.writingScore}</span>
              <span className="text-xs text-slate-400">Target: {sectionTargetScore}/30</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-tight">Sentence syntax &amp; academic forum contributions</p>
          </div>
        </div>
      </div>

      {/* Edit & Customize Goals Form */}
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-teal-100 text-teal-800 rounded-lg">
              <Settings className="w-4 h-4" />
            </div>
            <h4 className="font-bold text-slate-900 text-sm">Configure Study Targets</h4>
          </div>
          {goalsSavedSuccess && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-800 font-semibold bg-emerald-100 px-3 py-1 rounded-full animate-in fade-in">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span>Goals saved successfully!</span>
            </div>
          )}
        </div>

        <form onSubmit={handleSaveGoals} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            
            {/* Target Score Input with Presets */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">Target TOEFL Score (0–120)</label>
              <input
                type="number"
                min="0"
                max="120"
                value={targetScoreInput}
                onChange={(e) => setTargetScoreInput(e.target.value)}
                className="w-full text-sm bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-teal-600 outline-hidden font-bold text-slate-900"
              />
              <div className="flex items-center gap-1 pt-1 flex-wrap">
                {['80', '90', '100', '110'].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setTargetScoreInput(preset)}
                    className={`px-2 py-0.5 text-[10px] font-semibold rounded-md border cursor-pointer transition-colors ${
                      targetScoreInput === preset
                        ? 'bg-teal-800 text-white border-teal-800'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {preset} pts
                  </button>
                ))}
              </div>
            </div>

            {/* Test Date Picker */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">Target Test Date</label>
              <input
                type="date"
                value={testDateInput}
                onChange={(e) => setTestDateInput(e.target.value)}
                className="w-full text-sm bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-teal-600 outline-hidden font-medium text-slate-900"
              />
              <p className="text-[11px] text-slate-400">Updates live exam countdown &amp; study pacing</p>
            </div>

            {/* Weekly Session Goal */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">Weekly Practice Goal (Tasks/Week)</label>
              <input
                type="number"
                min="1"
                max="100"
                value={weeklyGoalInput}
                onChange={(e) => setWeeklyGoalInput(parseInt(e.target.value, 10) || 5)}
                className="w-full text-sm bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-teal-600 outline-hidden font-medium text-slate-900"
              />
              <div className="flex items-center gap-1 pt-1 flex-wrap">
                {[5, 7, 10, 14].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setWeeklyGoalInput(n)}
                    className={`px-2 py-0.5 text-[10px] font-semibold rounded-md border cursor-pointer transition-colors ${
                      weeklyGoalInput === n
                        ? 'bg-teal-800 text-white border-teal-800'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {n} / wk
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              className="px-5 py-2 bg-teal-800 hover:bg-teal-900 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer shadow-xs flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-teal-300" />
              <span>Save Study Goals</span>
            </button>
          </div>
        </form>
      </div>

      {/* Saved Questions Database Statistics */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-2xs mt-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h4 className="font-bold text-slate-900 text-sm flex items-center gap-2">
              <Target className="w-4 h-4 text-teal-700" />
              <span>
                Saved Questions Database Statistics —{' '}
                {selectedBankView === 'coach'
                  ? 'Coach & Marathon Bank'
                  : selectedBankView === 'mock'
                  ? 'Full Mock Exam Sets'
                  : 'Official Exam Mode Bank'}
              </span>
            </h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Click any database partition below to inspect its questions or launch a full-length adaptive mock exam.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => onSelectBankView?.('exam')}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-all shrink-0 cursor-pointer ${
                selectedBankView === 'exam'
                  ? 'bg-teal-700 text-white border-teal-700 ring-2 ring-teal-500/30 shadow-xs'
                  : 'text-teal-800 bg-teal-50 border-teal-200 hover:bg-teal-100'
              }`}
            >
              🎯 Exam Mode Bank: {examBankTotal ?? Object.values(questionCounts).reduce((a, b) => a + b, 0)} Questions
            </button>
            <button
              type="button"
              onClick={() => onSelectBankView?.('coach')}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-all shrink-0 cursor-pointer ${
                selectedBankView === 'coach'
                  ? 'bg-indigo-700 text-white border-indigo-700 ring-2 ring-indigo-500/30 shadow-xs'
                  : 'text-indigo-800 bg-indigo-50 border-indigo-200 hover:bg-indigo-100'
              }`}
            >
              🎓 Coach Mode Bank: {coachBankTotal ?? 120} Questions
            </button>
            <button
              type="button"
              onClick={() => onSelectBankView?.('mock')}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-all shrink-0 cursor-pointer ${
                selectedBankView === 'mock'
                  ? 'bg-emerald-700 text-white border-emerald-700 ring-2 ring-emerald-500/30 shadow-xs'
                  : 'text-emerald-800 bg-emerald-50 border-emerald-200 hover:bg-emerald-100'
              }`}
            >
              📚 Full Mock Exam Sets: {mockExamSetsCount} Sets
            </button>
          </div>
        </div>

        {loadingQuestionCounts ? (
          <div className="text-xs text-slate-400 py-4 text-center">Loading database question counts per question type...</div>
        ) : selectedBankView === 'mock' ? (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-emerald-50/70 border border-emerald-200 rounded-xl p-3.5">
              <div>
                <div className="text-xs font-bold text-emerald-950 flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-emerald-700" />
                  <span>2026 Multistage Adaptive Full-Length Mock Exam Sets ({CURATED_MOCK_EXAM_SETS.length} Curated Sets)</span>
                </div>
                <p className="text-[11px] text-emerald-800 mt-0.5">
                  Each set includes Reading Module 1 + Adaptive Module 2 (Hard/Easy), Listening Module 1 + Adaptive Module 2 (Hard/Easy), Writing (3 tasks), and Speaking (2 tasks).
                </p>
              </div>
              {onOpenMockTestCenter && (
                <button
                  type="button"
                  onClick={onOpenMockTestCenter}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg transition-colors shrink-0 cursor-pointer shadow-2xs"
                >
                  <span>Open Mock Test Center</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {CURATED_MOCK_EXAM_SETS.map((set, idx) => (
                <div
                  key={set.id}
                  className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex flex-col justify-between gap-3 shadow-2xs hover:border-emerald-300 transition-colors"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                        Set #{idx + 1} · Adaptive
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">8 Modules · 4 Sections</span>
                    </div>
                    <div className="text-xs font-bold text-slate-900 pt-0.5">{set.title}</div>
                    {set.subtitle && (
                      <p className="text-[11px] text-slate-600 leading-snug">{set.subtitle}</p>
                    )}
                  </div>
                  {onOpenMockTestCenter && (
                    <div className="pt-1 flex justify-end">
                      <button
                        type="button"
                        onClick={onOpenMockTestCenter}
                        className="text-[11px] font-semibold text-emerald-800 hover:text-emerald-950 flex items-center gap-1 cursor-pointer"
                      >
                        <span>Practice in Mock Test Center</span>
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {TASK_DEFINITIONS.map((def) => {
              const count = activeCounts[def.id] ?? 0;
              const isCoach = selectedBankView === 'coach';
              return (
                <div
                  key={def.id}
                  className={`p-3.5 border rounded-xl flex items-center justify-between shadow-2xs ${
                    isCoach
                      ? 'bg-indigo-50/40 border-indigo-200/80'
                      : 'bg-slate-50 border-slate-200'
                  }`}
                >
                  <div className="space-y-1">
                    <div className="text-xs font-bold text-slate-800">{def.name}</div>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${
                        isCoach
                          ? 'bg-indigo-100 text-indigo-800'
                          : 'bg-teal-100 text-teal-800'
                      }`}
                    >
                      {def.section}
                    </span>
                  </div>
                  <div
                    className={`text-sm font-bold font-mono bg-white px-3 py-1 rounded-lg border shadow-2xs shrink-0 ${
                      isCoach
                        ? 'text-indigo-900 border-indigo-200'
                        : 'text-teal-900 border-teal-200'
                    }`}
                  >
                    {count}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
};
