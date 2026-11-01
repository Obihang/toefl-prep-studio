import React, { useState, useEffect } from 'react';
import { Flag, Info, ChevronDown, ChevronUp, Edit3, Trash2 } from 'lucide-react';
import {
  LEVEL_LABELS,
  TOPIC_LABELS,
  isValidLevel,
  isValidAcademicTopic,
} from '../../constants/filters';
import { isDevAdminUnlocked } from '../../utils/questionBankStorage';

function getReportedIds(): string[] {
  try {
    const raw = localStorage.getItem('toefl_reported_by_me');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export const TaskReportButton: React.FC<{ task: any }> = ({ task }) => {
  const questionKey = String(task?.questionDocId || task?.id || task?.title || 'active-task');
  const [isReported, setIsReported] = useState<boolean>(() =>
    getReportedIds().includes(questionKey)
  );
  const [isDevAdmin, setIsDevAdmin] = useState<boolean>(() => isDevAdminUnlocked());
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);

  useEffect(() => {
    setIsReported(getReportedIds().includes(questionKey));
    setConfirmingDelete(false);
  }, [questionKey]);

  useEffect(() => {
    const syncDevState = () => {
      setIsDevAdmin(isDevAdminUnlocked());
    };
    window.addEventListener('toefl_dev_admin_changed', syncDevState);
    window.addEventListener('storage', syncDevState);
    return () => {
      window.removeEventListener('toefl_dev_admin_changed', syncDevState);
      window.removeEventListener('storage', syncDevState);
    };
  }, []);

  const handleReportClick = () => {
    if (isReported) return;
    setIsReported(true);
    window.dispatchEvent(
      new CustomEvent('toefl_report_active_question', {
        detail: { questionKey, questionDocId: task?.questionDocId || task?.id },
      })
    );
  };

  const handleDevEditClick = () => {
    window.dispatchEvent(
      new CustomEvent('toefl_dev_edit_question', {
        detail: {
          questionKey,
          questionDocId: task?.questionDocId || task?.id,
          task,
        },
      })
    );
  };

  const handleDevConfirmDelete = () => {
    setConfirmingDelete(false);
    window.dispatchEvent(
      new CustomEvent('toefl_dev_delete_question', {
        detail: {
          questionKey,
          questionDocId: task?.questionDocId || task?.id,
          task,
        },
      })
    );
  };

  return (
    <div className="inline-flex items-center gap-1.5 flex-wrap justify-end shrink-0">
      {isDevAdmin && (
        <div className="inline-flex items-center gap-1 bg-slate-900/95 text-white px-2 py-0.5 rounded-lg border border-slate-700 shadow-2xs">
          <span className="text-[10px] font-bold text-amber-300 uppercase tracking-wider mr-0.5 hidden sm:inline">
            DEV
          </span>
          <button
            type="button"
            onClick={handleDevEditClick}
            title="Developer Admin: Edit this question's title, difficulty, topic, or content"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-800 hover:bg-teal-700 text-slate-100 hover:text-white border border-slate-700 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Edit3 className="w-3 h-3 text-teal-300" />
            <span>✏️ Edit Question</span>
          </button>

          {!confirmingDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              title="Developer Admin: Permanently delete this question from bank"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-800 hover:bg-rose-700 text-rose-300 hover:text-white border border-slate-700 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Trash2 className="w-3 h-3" />
              <span>🗑️ Delete Question</span>
            </button>
          ) : (
            <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-rose-950 border border-rose-700 text-[11px] font-bold text-rose-200 whitespace-nowrap">
              <span>Confirm Delete?</span>
              <button
                type="button"
                onClick={handleDevConfirmDelete}
                className="px-1.5 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded text-[10px] font-bold cursor-pointer transition-colors"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-[10px] font-semibold cursor-pointer transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={handleReportClick}
        disabled={isReported}
        title={isReported ? 'Question reported for review' : 'Report an issue with this question'}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
          isReported
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 cursor-default'
            : 'bg-white hover:bg-rose-50 text-slate-500 hover:text-rose-700 border-slate-200 hover:border-rose-200'
        }`}
      >
        <Flag className="w-3 h-3" />
        <span>{isReported ? '✓ Reported' : 'Report'}</span>
      </button>
    </div>
  );
};

export const TaskSubtitleMeta: React.FC<{
  task: any;
  extra?: React.ReactNode;
}> = ({ task, extra }) => {
  const rawLevel = String(task?.level || task?.difficulty || 'intermediate').toLowerCase();
  const levelLabel = isValidLevel(rawLevel)
    ? LEVEL_LABELS[rawLevel]
    : rawLevel.charAt(0).toUpperCase() + rawLevel.slice(1);

  const rawTopic = String(task?.topic || task?.category || 'campus-life').toLowerCase();
  const topicLabel = isValidAcademicTopic(rawTopic)
    ? TOPIC_LABELS[rawTopic]
    : rawTopic
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());

  const isAi = task?.source === 'ai' || Boolean(task?.modelUsed);

  return (
    <div className="flex items-center gap-1.5 text-xs text-slate-600 mt-1.5 flex-wrap">
      <span className="inline-flex items-center px-2 py-0.5 rounded-md font-semibold bg-slate-100 text-slate-700 border border-slate-200 text-[11px]">
        {levelLabel}
      </span>
      <span className="inline-flex items-center px-2 py-0.5 rounded-md font-medium bg-teal-50 text-teal-800 border border-teal-200 text-[11px]">
        {topicLabel}
      </span>
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-md font-semibold border text-[11px] ${
          isAi
            ? 'bg-amber-50 text-amber-800 border-amber-200'
            : 'bg-slate-50 text-slate-600 border-slate-200'
        }`}
      >
        {isAi
          ? `✨ Generated by @${task?.createdBy || task?.generatedBy || (typeof localStorage !== 'undefined' ? (localStorage.getItem('toefl_username') || localStorage.getItem('username') || localStorage.getItem('toefl_display_name')) : null) || 'Obi'}`
          : 'Curated'}
      </span>
      {extra && (
        <>
          <span aria-hidden="true" className="text-slate-300 mx-0.5">
            ·
          </span>
          <span className="text-slate-500 text-[11px]">{extra}</span>
        </>
      )}
    </div>
  );
};

export const CollapsibleTaskInstructions: React.FC<{
  label?: string;
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}> = ({ label = 'Task Instructions', summary, children, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const cleanLabel = (label || 'Task Instructions').replace(/^[ℹ️\s]+/, '').trim();

  return (
    <div className="bg-slate-50/90 border border-slate-200 rounded-xl px-3.5 py-2 text-xs text-slate-700">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-semibold text-[11px] bg-white hover:bg-teal-50 text-teal-800 border border-slate-200 hover:border-teal-200 transition-colors shrink-0 cursor-pointer shadow-2xs"
          >
            <Info className="w-3.5 h-3.5 text-teal-700 shrink-0" />
            <span>{cleanLabel}</span>
            {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          <span className="text-slate-600 truncate text-[11px]">{summary}</span>
        </div>
      </div>
      {open && (
        <div className="mt-2.5 pt-2.5 border-t border-slate-200/80 text-xs text-slate-700 leading-relaxed">
          {children}
        </div>
      )}
    </div>
  );
};
