import React, { useState, useEffect } from 'react';
import { X, Save, Trash2, AlertCircle, CheckCircle2, Edit3 } from 'lucide-react';
import {
  LEVELS,
  ACADEMIC_TOPICS,
  LEVEL_LABELS,
  TOPIC_LABELS,
  isValidLevel,
  isValidAcademicTopic,
} from '../../constants/filters';
import { updateQuestionInBank, deleteQuestionFromBank } from '../../utils/questionBankStorage';
import {
  extractBlanksFromBracketedText,
  syncBracketedTextWithBlanks,
} from '../../utils/taskNormalizer';

interface DevQuestionEditorModalProps {
  isOpen: boolean;
  task: any | null;
  mode: 'exam' | 'coach';
  onClose: () => void;
  onSaved: (updatedTask: any) => void;
  onDeleted: (deletedId: string) => void;
}

export const DevQuestionEditorModal: React.FC<DevQuestionEditorModalProps> = ({
  isOpen,
  task,
  mode,
  onClose,
  onSaved,
  onDeleted,
}) => {
  const [title, setTitle] = useState<string>('');
  const [level, setLevel] = useState<string>('intermediate');
  const [topic, setTopic] = useState<string>('science-tech');
  const [primaryTextKey, setPrimaryTextKey] = useState<string | null>(null);
  const [primaryTextValue, setPrimaryTextValue] = useState<string>('');
  const [jsonText, setJsonText] = useState<string>('');
  const [lastEditedSource, setLastEditedSource] = useState<'primary' | 'json' | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [confirmDelete, setConfirmDelete] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);

  useEffect(() => {
    if (!task || !isOpen) return;
    setConfirmDelete(false);
    setSaveSuccess(false);
    setJsonError(null);
    setLastEditedSource(null);

    setTitle(String(task.title || ''));
    const rawLvl = String(task.level || task.difficulty || 'intermediate').toLowerCase();
    setLevel(isValidLevel(rawLvl) ? rawLvl : 'intermediate');
    const rawTop = String(task.topic || task.category || 'science-tech').toLowerCase();
    setTopic(isValidAcademicTopic(rawTop) ? rawTop : 'science-tech');

    const initialCopy = { ...task };

    if (typeof initialCopy.passage === 'string') {
      setPrimaryTextKey('passage');
      setPrimaryTextValue(initialCopy.passage);
    } else if (typeof initialCopy.text === 'string') {
      setPrimaryTextKey('text');
      const synced = syncBracketedTextWithBlanks(initialCopy.text, initialCopy.blanks, false);
      initialCopy.text = synced.text;
      if (synced.blanks.length > 0) {
        initialCopy.blanks = synced.blanks;
        initialCopy.totalBlanks = synced.blanks.length;
      }
      setPrimaryTextValue(initialCopy.text);
    } else if (typeof initialCopy.script === 'string') {
      setPrimaryTextKey('script');
      setPrimaryTextValue(initialCopy.script);
    } else if (typeof initialCopy.professorPrompt === 'string') {
      setPrimaryTextKey('professorPrompt');
      setPrimaryTextValue(initialCopy.professorPrompt);
    } else if (typeof initialCopy.situation === 'string') {
      setPrimaryTextKey('situation');
      setPrimaryTextValue(initialCopy.situation);
    } else {
      setPrimaryTextKey(null);
      setPrimaryTextValue('');
    }

    setJsonText(JSON.stringify(initialCopy, null, 2));
  }, [task, isOpen]);

  if (!isOpen || !task) return null;

  const questionId = String(task.questionDocId || task.id || `edited_${Date.now()}`);

  const handlePrimaryTextChange = (val: string) => {
    setPrimaryTextValue(val);
    setLastEditedSource('primary');
    if (!primaryTextKey) return;
    try {
      const parsed = JSON.parse(jsonText);
      parsed[primaryTextKey] = val;
      if (
        primaryTextKey === 'text' &&
        (task?.taskType === 'complete-words' || Array.isArray(parsed.blanks) || /\[[^\]]+\]/.test(val))
      ) {
        const updatedBlanks = extractBlanksFromBracketedText(val);
        parsed.blanks = updatedBlanks;
        parsed.totalBlanks = updatedBlanks.length;
      }
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonError(null);
    } catch {}
  };

  const handleJsonTextChange = (rawJson: string) => {
    setJsonText(rawJson);
    setLastEditedSource('json');
    setJsonError(null);
    try {
      const parsed = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== 'object') return;
      if (typeof parsed.title === 'string') setTitle(parsed.title);
      if (typeof parsed.level === 'string' && isValidLevel(parsed.level)) setLevel(parsed.level);
      if (typeof parsed.topic === 'string' && isValidAcademicTopic(parsed.topic)) setTopic(parsed.topic);

      if (primaryTextKey && typeof parsed[primaryTextKey] === 'string') {
        if (
          primaryTextKey === 'text' &&
          Array.isArray(parsed.blanks) &&
          parsed.blanks.length > 0
        ) {
          // If the user edited `blanks` in JSON while `parsed.text` stayed equal to `primaryTextValue`,
          // reconstruct `text` from the edited `blanks` so `Primary Content (text)` updates immediately!
          const textChangedInJson = parsed.text !== primaryTextValue;
          const synced = syncBracketedTextWithBlanks(
            parsed.text,
            parsed.blanks,
            !textChangedInJson
          );
          setPrimaryTextValue(synced.text);
        } else {
          setPrimaryTextValue(parsed[primaryTextKey]);
        }
      }
    } catch {}
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setJsonError(null);

    let parsedJson: any;
    try {
      parsedJson = JSON.parse(jsonText);
    } catch (err: any) {
      setJsonError(`Invalid JSON syntax: ${err?.message || 'Check brackets and quotes'}`);
      return;
    }

    setSaving(true);
    try {
      const mergedPayload: any = {
        ...task,
        ...parsedJson,
        id: questionId,
        title: title.trim() || parsedJson.title || task.title,
        level,
        difficulty: level,
        topic,
        isEdited: true,
        updatedAt: Date.now(),
      };

      if (primaryTextKey && primaryTextValue.trim()) {
        if (
          primaryTextKey === 'text' &&
          (task?.taskType === 'complete-words' ||
            Array.isArray(mergedPayload.blanks) ||
            /\[[^\]]+\]/.test(primaryTextValue))
        ) {
          const preferBlanks =
            lastEditedSource === 'json' && parsedJson.text === task.text;
          const synced = syncBracketedTextWithBlanks(
            preferBlanks ? String(parsedJson.text || primaryTextValue) : primaryTextValue,
            mergedPayload.blanks,
            preferBlanks
          );
          mergedPayload.text = synced.text;
          mergedPayload.blanks = synced.blanks;
          mergedPayload.totalBlanks = synced.blanks.length;
          mergedPayload._preferBlanks = false;
        } else {
          mergedPayload[primaryTextKey] = primaryTextValue;
        }
      }

      const saved = await updateQuestionInBank(questionId, mergedPayload, mode);
      setSaveSuccess(true);
      onSaved(saved);
      setTimeout(() => {
        onClose();
      }, 400);
    } catch (err: any) {
      setJsonError(err?.message || 'Failed to save question changes.');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    setSaving(true);
    try {
      await deleteQuestionFromBank(questionId, mode, task);
      onDeleted(questionId);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-400/20 text-amber-300 rounded-xl border border-amber-400/30">
              <Edit3 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold">Developer Question Editor</h3>
                <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-teal-500/20 text-teal-300 border border-teal-500/30 rounded-full">
                  {mode === 'coach' ? '🎓 Coach Bank' : '🎯 Exam Bank'}
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                ID: {questionId} · Task: {task.taskType || 'active'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Question Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  try {
                    const parsed = JSON.parse(jsonText);
                    parsed.title = e.target.value;
                    setJsonText(JSON.stringify(parsed, null, 2));
                  } catch {}
                }}
                placeholder="Question title..."
                className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 bg-white focus:border-teal-600 outline-hidden font-semibold"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Difficulty / Level
              </label>
              <select
                value={level}
                onChange={(e) => {
                  setLevel(e.target.value);
                  try {
                    const parsed = JSON.parse(jsonText);
                    parsed.level = e.target.value;
                    parsed.difficulty = e.target.value;
                    setJsonText(JSON.stringify(parsed, null, 2));
                  } catch {}
                }}
                className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 bg-white focus:border-teal-600 outline-hidden font-semibold"
              >
                {LEVELS.map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {LEVEL_LABELS[lvl]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Academic Topic
              </label>
              <select
                value={topic}
                onChange={(e) => {
                  setTopic(e.target.value);
                  try {
                    const parsed = JSON.parse(jsonText);
                    parsed.topic = e.target.value;
                    setJsonText(JSON.stringify(parsed, null, 2));
                  } catch {}
                }}
                className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 bg-white focus:border-teal-600 outline-hidden font-semibold"
              >
                {ACADEMIC_TOPICS.map((top) => (
                  <option key={top} value={top}>
                    {TOPIC_LABELS[top]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {primaryTextKey && (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Primary Content ({primaryTextKey})
              </label>
              <textarea
                rows={4}
                value={primaryTextValue}
                onChange={(e) => handlePrimaryTextChange(e.target.value)}
                className="w-full text-xs border border-slate-300 rounded-xl p-3 bg-slate-50 focus:bg-white focus:border-teal-600 outline-hidden leading-relaxed"
              />
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-slate-700">
                Full Question Data / Options / Answer Key (JSON)
              </label>
              <span className="text-[11px] text-slate-400">
                Edits sync to In-Memory Cache, IndexedDB &amp; Firestore
              </span>
            </div>
            <textarea
              rows={12}
              value={jsonText}
              onChange={(e) => handleJsonTextChange(e.target.value)}
              spellCheck={false}
              className="w-full text-xs font-mono border border-slate-300 rounded-xl p-3 bg-slate-950 text-emerald-300 focus:border-teal-500 outline-hidden leading-relaxed"
            />
          </div>

          {jsonError && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-center gap-2 font-medium">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{jsonError}</span>
            </div>
          )}

          {saveSuccess && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center gap-2 font-bold">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>Changes saved to IndexedDB &amp; Firestore!</span>
            </div>
          )}

          {/* Footer Actions */}
          <div className="pt-3 border-t border-slate-200 flex items-center justify-between gap-3 flex-wrap">
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="px-3.5 py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Question</span>
              </button>
            ) : (
              <div className="inline-flex items-center gap-2 bg-rose-950 text-white px-3 py-1.5 rounded-xl text-xs font-bold">
                <span>Permanently delete this question?</span>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  disabled={saving}
                  className="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 rounded-lg cursor-pointer"
                >
                  Yes, Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-5 py-2 bg-teal-800 hover:bg-teal-900 disabled:opacity-50 text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs"
              >
                <Save className="w-3.5 h-3.5 text-teal-300" />
                <span>{saving ? 'Saving...' : 'Save Changes'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
