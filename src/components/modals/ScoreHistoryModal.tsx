import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  Trash2,
  Award,
  BarChart3,
  TrendingUp,
  Calendar,
  Download,
  Upload,
  Target,
  FileText,
  ChevronDown,
  ChevronUp,
  Trophy,
} from 'lucide-react';
import {
  getPracticeHistory,
  clearPracticeHistory,
  clearAllUserProgress,
  getCompletedQuestionIds,
  calculateToeflEstimate,
  calculateMyBestScores,
  convertScaledToBand6,
  sanitizePracticeRecord,
  getCurrentUserId,
  PracticeRecord,
} from '../../utils/scoreTracker';
import {
  getExamHistory,
  clearExamHistory,
  FullMockExamResult,
} from '../../utils/examStorage';
import { getMistakesList } from '../../utils/mistakesTracker';
import { PerformanceTrendChart } from './history/PerformanceTrendChart';
import { HighlightedText } from '../shared/FeedbackComparison';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onResetProgress?: () => void;
}

export const ScoreHistoryModal: React.FC<Props> = ({ isOpen, onClose, onResetProgress }) => {
  const [historyTab, setHistoryTab] = useState<'section_practice' | 'full_mock'>('section_practice');
  const [history, setHistory] = useState<PracticeRecord[]>([]);
  const [examHistory, setExamHistory] = useState<FullMockExamResult[]>([]);
  const [activeSectionTab, setActiveSectionTab] = useState<'All' | 'Reading' | 'Listening' | 'Speaking' | 'Writing'>('All');
  const [targetScore, setTargetScore] = useState(100);
  const [testDate, setTestDate] = useState<string>('');

  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setHistory(getPracticeHistory());
      setExamHistory(getExamHistory());
      const storedTarget = localStorage.getItem('toefl_target_score');
      if (storedTarget) setTargetScore(Number(storedTarget));
      const storedDate = localStorage.getItem('toefl_test_date');
      if (storedDate) {
        setTestDate(storedDate);
      } else {
        const defaultDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
        setTestDate(defaultDate);
      }
      setStatusMessage(null);
      setConfirmingClear(false);
      setConfirmingReset(false);
    }
  }, [isOpen]);

  useEffect(() => {
    const syncOnReset = () => {
      setHistory(getPracticeHistory());
      setExamHistory(getExamHistory());
      setConfirmingReset(false);
      setConfirmingClear(false);
    };
    window.addEventListener('toefl_progress_reset', syncOnReset);
    window.addEventListener('toefl_exam_history_updated', syncOnReset);
    window.addEventListener('toefl_completed_questions_updated', syncOnReset);
    return () => {
      window.removeEventListener('toefl_progress_reset', syncOnReset);
      window.removeEventListener('toefl_exam_history_updated', syncOnReset);
      window.removeEventListener('toefl_completed_questions_updated', syncOnReset);
    };
  }, []);

  // Highest Full Mock Exam MyBest® Overall Band (1.0–6.0) & Total Score (0–120)
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

  if (!isOpen) return null;

  const stats = calculateToeflEstimate(history);
  const myBest = calculateMyBestScores(history);
  const hasAnyProgress =
    history.length > 0 ||
    examHistory.length > 0 ||
    getCompletedQuestionIds().length > 0 ||
    getMistakesList().length > 0;

  // Countdown days
  const daysToTest = testDate ? Math.ceil((new Date(testDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)) : 30;
  const scoreDiff = targetScore - stats.overallScore;
  const dailyWorkload = daysToTest > 0 ? Math.max(1, Math.ceil(Math.abs(scoreDiff) / (daysToTest * 0.5))) : 2;

  const showNotification = (text: string, type: 'success' | 'error') => {
    setStatusMessage({ text, type });
    setTimeout(() => {
      setStatusMessage(null);
    }, 4000);
  };

  const handleClear = () => {
    clearPracticeHistory();
    clearExamHistory();
    if (onResetProgress) {
      onResetProgress();
    } else {
      clearAllUserProgress();
    }
    setHistory([]);
    setExamHistory([]);
    setConfirmingClear(false);
    setConfirmingReset(false);
    showNotification(
      'All Section Practice scores, Full Mock Exam history, and MyBest® superscores have been reset.',
      'success'
    );
  };

  // Export JSON
  const handleExportJson = () => {
    if (history.length === 0 && examHistory.length === 0) {
      showNotification('No history to export.', 'error');
      return;
    }
    const payload = {
      sectionPracticeHistory: history,
      fullMockExamHistory: examHistory,
    };
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `toefl_practice_history_${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showNotification('Exported JSON history successfully.', 'success');
  };

  // Export CSV
  const handleExportCsv = () => {
    if (history.length === 0) {
      showNotification('No section practice history to export.', 'error');
      return;
    }
    const headers = ['ID', 'Date', 'Section', 'TaskType', 'TaskTitle', 'ScaledScore30', 'BandScore6', 'TimeSpentSeconds'];
    const rows = history.map((r) => [
      r.id,
      r.date,
      r.section,
      r.taskType,
      `"${(r.taskTitle || '').replace(/"/g, '""')}"`,
      r.scaledScore30,
      r.bandScore6 || '',
      r.timeSpentSeconds,
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `toefl_practice_history_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    showNotification('Exported CSV history successfully.', 'success');
  };

  // Import JSON
  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileReader = new FileReader();
    if (e.target.files && e.target.files[0]) {
      fileReader.readAsText(e.target.files[0], 'UTF-8');
      fileReader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target?.result as string);
          if (Array.isArray(parsed)) {
            const sanitized = parsed.map((item) => sanitizePracticeRecord(item).record);
            localStorage.setItem(`toefl_prep_history_${getCurrentUserId()}`, JSON.stringify(sanitized));
            localStorage.setItem('toefl_score_history', JSON.stringify(sanitized));
            setHistory(sanitized);
            showNotification('History imported successfully!', 'success');
          } else if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.sectionPracticeHistory)) {
              const sanitized = parsed.sectionPracticeHistory.map((item: any) => sanitizePracticeRecord(item).record);
              localStorage.setItem(`toefl_prep_history_${getCurrentUserId()}`, JSON.stringify(sanitized));
              localStorage.setItem('toefl_score_history', JSON.stringify(sanitized));
              setHistory(sanitized);
            }
            if (Array.isArray(parsed.fullMockExamHistory)) {
              localStorage.setItem('toefl_exam_history', JSON.stringify(parsed.fullMockExamHistory));
              setExamHistory(parsed.fullMockExamHistory);
            }
            showNotification('History imported successfully!', 'success');
          } else {
            showNotification('Invalid JSON format: expected an array or history object.', 'error');
          }
        } catch {
          showNotification('Failed to parse JSON file.', 'error');
        }
      };
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-200 p-6 sm:p-8 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center shrink-0">
              <BarChart3 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">TOEFL Analytics &amp; Score History</h2>
              <p className="text-xs text-slate-500">
                Strictly isolated Official Exam Mode section practice &amp; Full Mock Exam histories (Coach Mode excluded)
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {hasAnyProgress && (
              confirmingReset ? (
                <div className="flex items-center gap-1.5 bg-rose-50 border border-rose-200 px-2.5 py-1.5 rounded-lg text-xs">
                  <span className="text-rose-800 font-semibold">Confirm Reset Everything?</span>
                  <button
                    type="button"
                    onClick={handleClear}
                    className="px-2.5 py-1 font-bold bg-rose-600 text-white rounded-md hover:bg-rose-700 transition-colors cursor-pointer"
                  >
                    Yes, Clear All
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingReset(false)}
                    className="px-2 py-1 text-slate-600 hover:text-slate-900 font-medium transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingReset(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>🗑️ Reset All Scores &amp; History</span>
                </button>
              )
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 2-Tab Switcher at the top of Score History Modal */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-100 p-1.5 rounded-xl border border-slate-200">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 w-full">
            <button
              type="button"
              onClick={() => setHistoryTab('section_practice')}
              className={`py-2.5 px-4 text-xs sm:text-sm font-bold rounded-lg transition-all cursor-pointer flex items-center justify-center gap-2 ${
                historyTab === 'section_practice'
                  ? 'bg-white text-teal-900 shadow-xs border border-teal-200/80'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>🎯 Section Practice History (Exam Mode)</span>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-teal-50 text-teal-800 border border-teal-200">
                {history.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setHistoryTab('full_mock')}
              className={`py-2.5 px-4 text-xs sm:text-sm font-bold rounded-lg transition-all cursor-pointer flex items-center justify-center gap-2 ${
                historyTab === 'full_mock'
                  ? 'bg-white text-teal-900 shadow-xs border border-teal-200/80'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>🏆 Full Mock Exam History</span>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-amber-50 text-amber-900 border border-amber-200">
                {examHistory.length}
              </span>
            </button>
          </div>
        </div>

        {statusMessage && (
          <div
            className={`p-3 rounded-lg text-xs font-semibold flex items-center justify-between ${
              statusMessage.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                : 'bg-rose-50 text-rose-800 border border-rose-200'
            }`}
          >
            <span>{statusMessage.text}</span>
            <button
              onClick={() => setStatusMessage(null)}
              className="text-slate-400 hover:text-slate-700 ml-2"
            >
              ×
            </button>
          </div>
        )}

        {historyTab === 'section_practice' ? (
          <>
            {/* Official ETS MyBest® Section Scores Card */}
            <div className="bg-gradient-to-r from-emerald-950 via-teal-900 to-slate-900 text-white rounded-2xl p-4 sm:p-5 border border-teal-700/50 shadow-md space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-teal-800/60 pb-2.5">
                <div className="flex items-center gap-2">
                  <Award className="w-5 h-5 text-amber-400 shrink-0" />
                  <div>
                    <h3 className="text-sm font-bold tracking-tight flex items-center gap-2">
                      MyBest® Section Scores (Exam Mode Superscore)
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-400/30">
                        2026 ETS Scale
                      </span>
                    </h3>
                    <p className="text-[11px] text-teal-200/80">
                      Highest section scores across all completed 🎯 Official Exam Mode practice sessions (Coach Mode attempts are excluded)
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-1 rounded-lg bg-white/10 text-xs font-mono font-bold text-teal-200 border border-white/15">
                    CEFR {myBest.cefrCode} ({myBest.cefrLevel})
                  </span>
                </div>
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

            {/* Goal & Countdown Banner */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 flex items-center gap-3">
                <Target className="w-8 h-8 text-teal-700 shrink-0" />
                <div>
                  <div className="text-xs text-teal-700 font-semibold uppercase tracking-wider">Target Score</div>
                  <div className="text-xl font-bold font-mono text-teal-950">{targetScore} / 120</div>
                  <div className="text-[11px] text-teal-600">Current Avg: {stats.overallScore} / 120</div>
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-center gap-3">
                <Calendar className="w-8 h-8 text-blue-700 shrink-0" />
                <div>
                  <div className="text-xs text-blue-700 font-semibold uppercase tracking-wider">Test Countdown</div>
                  <div className="text-xl font-bold font-mono text-blue-950">{daysToTest > 0 ? `${daysToTest} Days` : 'Test Day!'}</div>
                  <div className="text-[11px] text-blue-600">{testDate || 'No date set'}</div>
                </div>
              </div>

              <div className="bg-slate-900 text-white rounded-xl p-4 flex items-center gap-3">
                <TrendingUp className="w-8 h-8 text-teal-400 shrink-0" />
                <div>
                  <div className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Daily Workload</div>
                  <div className="text-xl font-bold font-mono text-teal-400">{dailyWorkload} tasks/day</div>
                  <div className="text-[11px] text-slate-300">Suggested pacing to reach target</div>
                </div>
              </div>
            </div>

            {/* Scaled Score Overview Grid (Rolling Average) */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="bg-slate-900 text-white rounded-xl p-3.5 text-center col-span-2 sm:col-span-1">
                <div className="text-[11px] text-slate-300 uppercase font-medium tracking-wider">Average Band</div>
                <div className="text-2xl font-mono font-bold text-teal-400 mt-0.5">{stats.overallBand6.toFixed(1)} / 6.0</div>
                <div className="text-[10px] text-slate-400 font-mono">({stats.overallScore} / 120 Scaled)</div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                <div className="text-[11px] text-slate-500 font-medium">Reading Avg</div>
                <div className="text-xl font-mono font-bold text-slate-900 mt-0.5">Band {stats.readingBand6.toFixed(1)}</div>
                <div className="text-[10px] text-slate-400">{stats.readingScore}/30 Scaled</div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                <div className="text-[11px] text-slate-500 font-medium">Listening Avg</div>
                <div className="text-xl font-mono font-bold text-slate-900 mt-0.5">Band {stats.listeningBand6.toFixed(1)}</div>
                <div className="text-[10px] text-slate-400">{stats.listeningScore}/30 Scaled</div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                <div className="text-[11px] text-slate-500 font-medium">Speaking Avg</div>
                <div className="text-xl font-mono font-bold text-slate-900 mt-0.5">Band {stats.speakingBand6.toFixed(1)}</div>
                <div className="text-[10px] text-slate-400">{stats.speakingScore}/30 Scaled</div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                <div className="text-[11px] text-slate-500 font-medium">Writing Avg</div>
                <div className="text-xl font-mono font-bold text-slate-900 mt-0.5">Band {stats.writingBand6.toFixed(1)}</div>
                <div className="text-[10px] text-slate-400">{stats.writingScore}/30 Scaled</div>
              </div>
            </div>

            {/* Score Trend Chart Section (Recharts) */}
            <PerformanceTrendChart
              history={history}
              activeSectionTab={activeSectionTab}
              onSectionTabChange={setActiveSectionTab}
              targetScore={targetScore}
            />

            {/* Data Backup & Export Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-600 font-medium">
                Data Management: Backup or restore your history &amp; stats.
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleExportJson}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-teal-700" />
                  <span>Export JSON</span>
                </button>
                <button
                  onClick={handleExportCsv}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-teal-700" />
                  <span>Export CSV</span>
                </button>
                <label className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer">
                  <Upload className="w-3.5 h-3.5 text-teal-700" />
                  <span>Import JSON</span>
                  <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
                </label>
              </div>
            </div>

            {/* Section Practice History Table */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  🎯 Official Exam Mode Section Practice Attempts ({history.length})
                </h3>
                {history.length > 0 && (
                  <div className="flex items-center gap-2">
                    {confirmingClear ? (
                      <div className="flex items-center gap-1.5 bg-rose-50 border border-rose-200 px-2 py-1 rounded-md text-xs">
                        <span className="text-rose-800 text-[11px] font-medium">Clear all?</span>
                        <button
                          onClick={handleClear}
                          className="px-2 py-0.5 font-bold bg-rose-600 text-white rounded hover:bg-rose-700 transition-colors text-[11px] cursor-pointer"
                        >
                          Yes, Clear
                        </button>
                        <button
                          onClick={() => setConfirmingClear(false)}
                          className="px-1.5 py-0.5 text-slate-600 hover:text-slate-900 transition-colors text-[11px] cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmingClear(true)}
                        className="flex items-center gap-1 text-xs text-rose-600 hover:text-rose-800 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Clear History
                      </button>
                    )}
                  </div>
                )}
              </div>

              {history.length === 0 ? (
                <div className="text-center py-10 border border-dashed border-slate-200 rounded-xl text-slate-400 text-xs">
                  No Official Exam Mode section practice attempts recorded yet. Complete a task in 🎯 Official Exam Mode to see your score analysis here!
                </div>
              ) : (
                <div className="border border-slate-200 rounded-xl overflow-hidden max-h-96 overflow-y-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200 sticky top-0 z-10">
                      <tr>
                        <th className="py-2.5 px-3">Date</th>
                        <th className="py-2.5 px-3">Section</th>
                        <th className="py-2.5 px-3">Task Title</th>
                        <th className="py-2.5 px-3 text-center">Band (1-6)</th>
                        <th className="py-2.5 px-3 text-right">Scaled (0-30)</th>
                        <th className="py-2.5 px-3 text-right">Saved Response</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {history.map((rec) => {
                        const scaled30 = typeof rec.scaledScore30 === 'number' ? rec.scaledScore30 : Math.min(30, Number(rec.score || 0));
                        const band = rec.bandScore6 ?? convertScaledToBand6(scaled30, rec.section);
                        const hasSavedResponse = Boolean(rec.studentResponse && rec.studentResponse.trim().length > 0);
                        const isExpanded = expandedRecordId === rec.id;
                        const grammarErrors = Array.isArray(rec.grammarErrors) ? rec.grammarErrors : [];
                        return (
                          <React.Fragment key={rec.id}>
                            <tr className="hover:bg-slate-50/50">
                              <td className="py-2 px-3 text-slate-400 font-mono whitespace-nowrap">
                                {new Date(rec.date).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </td>
                              <td className="py-2 px-3">
                                <span className="font-medium text-slate-900">{rec.section}</span>
                              </td>
                              <td className="py-2 px-3 text-slate-800 truncate max-w-xs">{rec.taskTitle}</td>
                              <td className="py-2 px-3 text-center font-mono font-bold text-teal-700">
                                Band {band.toFixed(1)}
                              </td>
                              <td className="py-2 px-3 text-right font-mono font-medium text-slate-600">
                                {scaled30} / 30
                              </td>
                              <td className="py-2 px-3 text-right whitespace-nowrap">
                                {hasSavedResponse ? (
                                  <button
                                    type="button"
                                    onClick={() => setExpandedRecordId(isExpanded ? null : rec.id)}
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
                                <td colSpan={6} className="p-4 border-t border-slate-200">
                                  <div className="space-y-4">
                                    {rec.feedbackSummary && (
                                      <div className="text-xs text-slate-700 bg-white border border-slate-200 rounded-lg p-3 leading-relaxed">
                                        <span className="font-bold text-slate-900 mr-1.5">Evaluation Summary:</span>
                                        {rec.feedbackSummary}
                                      </div>
                                    )}
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                      <div className="space-y-1.5">
                                        <div className="flex items-center justify-between">
                                          <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-800">
                                            Your Saved Response {grammarErrors.length > 0 ? `(${grammarErrors.length} Highlighted Fixes)` : ''}
                                          </h4>
                                        </div>
                                        <div className="p-3.5 bg-white border border-slate-200 rounded-lg text-xs leading-relaxed text-slate-900 whitespace-pre-line">
                                          <HighlightedText text={rec.studentResponse || ''} corrections={grammarErrors as any} />
                                        </div>
                                      </div>
                                      {rec.modelAnswer && (
                                        <div className="space-y-1.5">
                                          <h4 className="text-[11px] font-bold uppercase tracking-wider text-teal-800 flex items-center gap-1">
                                            <Award className="w-3.5 h-3.5 text-teal-600" />
                                            <span>Band 6.0 Model Answer</span>
                                          </h4>
                                          <div className="p-3.5 bg-teal-50/50 border border-teal-200 rounded-lg text-xs leading-relaxed text-teal-950 whitespace-pre-line">
                                            {rec.modelAnswer}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                    {grammarErrors.length > 0 && (
                                      <div className="space-y-2">
                                        <h5 className="text-[11px] font-bold uppercase tracking-wider text-slate-700">
                                          Grammar &amp; Wording Fixes ({grammarErrors.length})
                                        </h5>
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
              )}
            </div>
          </>
        ) : (
          /* TAB 2: 🏆 Full Mock Exam History */
          <div className="space-y-6">
            {/* Full Mock Exam MyBest® Overall Band (1.0–6.0) & Total Score (0–120) Card */}
            <div className="bg-gradient-to-r from-slate-900 via-teal-950 to-emerald-950 text-white rounded-2xl p-5 border border-teal-700/50 shadow-md space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-teal-800/60 pb-3">
                <div className="flex items-center gap-2.5">
                  <Trophy className="w-5 h-5 text-amber-400 shrink-0" />
                  <div>
                    <h3 className="text-sm font-bold tracking-tight flex items-center gap-2">
                      Full Mock Exam MyBest® Overall Band &amp; Total Score
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-400/30">
                        4-Section Mock Exams
                      </span>
                    </h3>
                    <p className="text-[11px] text-teal-200/80">
                      Highest overall performance achieved across your completed Full-Length 2026 TOEFL iBT® Mock Exams
                    </p>
                  </div>
                </div>
                {bestMockExam && (
                  <span className="px-2.5 py-1 rounded-lg bg-white/10 text-xs font-mono font-bold text-amber-300 border border-white/15">
                    CEFR {bestMockExam.cefrCode} ({bestMockExam.cefrName})
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                <div className="bg-white/10 border border-white/15 rounded-xl p-3 text-center col-span-2 flex flex-col justify-center">
                  <div className="text-[10px] text-amber-300 uppercase font-bold tracking-wider">
                    Highest Full Mock Exam Score
                  </div>
                  <div className="text-2xl font-mono font-extrabold text-white mt-0.5">
                    {bestMockExam ? `Band ${bestMockExam.overallBand6.toFixed(1)} / 6.0` : '—'}
                  </div>
                  <div className="text-xs text-teal-200 font-mono font-bold">
                    {bestMockExam ? `${bestMockExam.totalScore120} / 120 Total Score` : 'No Mock Exams yet'}
                  </div>
                </div>

                {(['Reading', 'Listening', 'Writing', 'Speaking'] as const).map((sec) => {
                  const secScore = bestMockExam ? bestMockExam.sectionScores[sec] : null;
                  const secBand = secScore !== null ? convertScaledToBand6(secScore, sec) : null;
                  return (
                    <div key={sec} className="bg-slate-900/60 border border-teal-800/60 rounded-xl p-3 text-center">
                      <div className="text-[11px] text-teal-200 font-semibold">{sec}</div>
                      <div className="text-base font-mono font-bold text-white mt-0.5">
                        {secBand !== null ? `Band ${secBand.toFixed(1)}` : '—'}
                      </div>
                      <div className="text-[10px] text-teal-300/90 font-mono">
                        {secScore !== null ? `${secScore} / 30` : '—'}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Completed Full Mock Exams Table */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  🏆 Completed Full Mock Tests ({examHistory.length})
                </h3>
              </div>

              {examHistory.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-slate-200 rounded-xl text-slate-400 text-xs space-y-1">
                  <p className="font-semibold text-slate-500">No completed Full Mock Exams yet.</p>
                  <p>Open Full Mock Test in the top navigation bar and complete a 4-section Mock Exam to track your results here!</p>
                </div>
              ) : (
                <div className="border border-slate-200 rounded-xl overflow-hidden max-h-96 overflow-y-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200 sticky top-0 z-10">
                      <tr>
                        <th className="py-2.5 px-3">Date</th>
                        <th className="py-2.5 px-3">Mock Set Title</th>
                        <th className="py-2.5 px-3 text-center">Overall Band</th>
                        <th className="py-2.5 px-3 text-center">CEFR</th>
                        <th className="py-2.5 px-3 text-center">Total Scaled</th>
                        <th className="py-2.5 px-2.5 text-center">Reading</th>
                        <th className="py-2.5 px-2.5 text-center">Listening</th>
                        <th className="py-2.5 px-2.5 text-center">Writing</th>
                        <th className="py-2.5 px-2.5 text-center">Speaking</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {examHistory.map((exam) => (
                        <tr key={exam.id} className="hover:bg-slate-50/70">
                          <td className="py-2.5 px-3 text-slate-400 font-mono whitespace-nowrap">
                            {new Date(exam.date || exam.completedAt).toLocaleDateString([], {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </td>
                          <td className="py-2.5 px-3 font-semibold text-slate-900 max-w-xs truncate" title={exam.setTitle}>
                            {exam.setTitle}
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono font-bold text-teal-800 whitespace-nowrap">
                            Band {Number(exam.overallBand6 || 1).toFixed(1)} / 6.0
                          </td>
                          <td className="py-2.5 px-3 text-center whitespace-nowrap">
                            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-teal-50 text-teal-800 border border-teal-200">
                              {exam.cefrCode}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono font-extrabold text-slate-900 whitespace-nowrap">
                            {exam.totalScore120} / 120
                          </td>
                          <td className="py-2.5 px-2.5 text-center font-mono text-slate-700 whitespace-nowrap">
                            {exam.sectionScores?.Reading ?? 0} / 30
                          </td>
                          <td className="py-2.5 px-2.5 text-center font-mono text-slate-700 whitespace-nowrap">
                            {exam.sectionScores?.Listening ?? 0} / 30
                          </td>
                          <td className="py-2.5 px-2.5 text-center font-mono text-slate-700 whitespace-nowrap">
                            {exam.sectionScores?.Writing ?? 0} / 30
                          </td>
                          <td className="py-2.5 px-2.5 text-center font-mono text-slate-700 whitespace-nowrap">
                            {exam.sectionScores?.Speaking ?? 0} / 30
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end pt-2 border-t border-slate-100">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export const PerformanceHistoryModal = ScoreHistoryModal;
export default ScoreHistoryModal;

