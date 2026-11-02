import React, { useState, useEffect, useRef } from 'react';
import { Volume2, BookmarkPlus, X, Check, Loader2, Sparkles, BookOpen } from 'lucide-react';
import { playSpeech } from '../../utils/audioSpeech';
import { saveVocabularyWord as saveVocabLocal, isWordSaved } from '../../utils/vocabularyStore';
import { saveVocabularyWord as saveVocabRemote } from '../../utils/vocabulary';
import { getDefinition } from '../../utils/dictionaryService';
import { getApiHeaders, getAuthHeaders } from '../../utils/apiKey';
import { safeFetchJson } from '../../utils/apiHelper';

interface Props {
  selectedText: string;
  contextSentence: string;
  taskType: string;
  position: { x: number; y: number };
  onClose: () => void;
}

export const VocabularyPopover: React.FC<Props> = ({
  selectedText,
  contextSentence,
  taskType,
  position,
  onClose,
}) => {
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [entry, setEntry] = useState<any | null>(null);
  const [savingStatus, setSavingStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const popoverRef = useRef<HTMLDivElement>(null);

  const cleanQueryWord = selectedText.trim().replace(/^[^a-zA-Z-]+|[^a-zA-Z-]+$/g, '');

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    fetchData();
  }, [selectedText]);

  async function fetchData() {
    setLoading(true);
    setEntry(null);
    const alreadySaved = isWordSaved(cleanQueryWord);
    setSavingStatus(alreadySaved ? 'saved' : 'idle');
    const result = await getDefinition(cleanQueryWord, contextSentence);
    if (result) {
      setEntry(result);
      if (isWordSaved(result.word)) {
        setSavingStatus('saved');
      }
    }
    setLoading(false);
  }

  const handleSave = async (targetEntry?: any) => {
    const entryToSave = targetEntry || entry;
    const wordToSave = (entryToSave?.word || cleanQueryWord || selectedText).trim();
    if (!wordToSave) return;
    setSavingStatus('saving');
    try {
      const primary = entryToSave?.meanings?.[0];
      const definition = primary?.definition || 'Saved for TOEFL vocabulary practice';
      const partOfSpeech = primary?.partOfSpeech || 'noun';
      const phonetic = entryToSave?.phonetic || '';

      // 1. Save to local storage store (instant, broadcasts toefl_vocab_updated)
      saveVocabLocal(
        wordToSave,
        '',
        `${partOfSpeech}: ${definition}`,
        taskType
      );

      // 2. Also save to user's remote/offline Firestore profile if signed in
      await saveVocabRemote(
        wordToSave,
        definition,
        phonetic,
        partOfSpeech,
        entryToSave?.synonyms || [],
        '',
        taskType
      );

      setSavingStatus('saved');
    } catch {
      setSavingStatus('idle');
    }
  };

  const handleAiDefine = async () => {
    if (aiLoading) return;
    setAiLoading(true);
    try {
      const authHeaders = await getAuthHeaders();
      const headers = { ...getApiHeaders(), ...authHeaders };
      const json = await safeFetchJson('/api/generate-task', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          taskType: 'vocabulary_explanation',
          promptData: {
            word: cleanQueryWord,
            context: contextSentence.trim(),
          },
        }),
      });

      if (json?.success && json?.data) {
        setEntry(json.data);
        await handleSave(json.data);
      }
    } catch (err) {
      console.warn('AI Define request failed:', err);
    } finally {
      setAiLoading(false);
    }
  };

  const currentWord = entry?.word || cleanQueryWord || selectedText;
  const isAlreadySaved = savingStatus === 'saved' || isWordSaved(currentWord);

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 w-96 max-w-[calc(100vw-32px)] bg-white border border-slate-200/90 rounded-2xl shadow-2xl p-4 text-xs space-y-3 animate-in fade-in zoom-in-95 duration-150 ring-1 ring-slate-900/5"
      style={{
        top: Math.min(window.innerHeight - 380, Math.max(20, position.y - 10)),
        left: Math.min(window.innerWidth - 400, Math.max(16, position.x - 180)),
      }}
    >
      <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-slate-900 text-sm capitalize">{currentWord}</span>
          {entry?.phonetic && (
            <span className="text-slate-400 font-mono text-xs">/{entry.phonetic.replace(/\//g, '')}/</span>
          )}
          <button
            type="button"
            onClick={() => playSpeech(currentWord)}
            title="Listen to pronunciation"
            className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 rounded transition-colors cursor-pointer"
          >
            <Volume2 className="w-3.5 h-3.5 text-teal-700" />
            <span>Pronounce</span>
          </button>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-600 p-1 rounded-md hover:bg-slate-100 transition-colors cursor-pointer"
          title="Close dictionary popover (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6 gap-2 text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin text-teal-600" />
          <span>Looking up definition...</span>
        </div>
      ) : entry ? (
        <div className="space-y-3 max-h-[340px] overflow-y-auto pr-0.5">
          {/* Meanings */}
          {entry.meanings?.length > 0 && (
            <div className="space-y-2">
              {entry.meanings.slice(0, 3).map((m: any, i: number) => (
                <div key={i} className="text-slate-700 border-l-2 border-teal-500 pl-2.5 py-1 bg-slate-50/70 rounded-r-lg space-y-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-bold text-teal-900 uppercase text-[10px] bg-teal-100/70 px-1.5 py-0.5 rounded">
                      {m.partOfSpeech || 'word'}
                    </span>
                    <span className="text-slate-900 font-medium leading-snug">{m.definition}</span>
                  </div>
                  {m.example && (
                    <p className="text-[11px] text-slate-500 italic pl-0.5">
                      "{m.example}"
                    </p>
                  )}
                </div>
              ))}

              {entry.synonyms && entry.synonyms.length > 0 && (
                <p className="text-slate-600 text-[11px] font-medium pt-0.5">
                  <strong className="text-slate-800">Synonyms:</strong> {entry.synonyms.slice(0, 4).join(', ')}
                </p>
              )}
            </div>
          )}

          <div className="pt-2 flex items-center gap-2">
            <button
              onClick={() => handleSave()}
              disabled={isAlreadySaved || savingStatus === 'saving'}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 font-semibold rounded-lg transition-all text-xs cursor-pointer shadow-2xs ${
                isAlreadySaved
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-300'
                  : 'bg-teal-700 text-white hover:bg-teal-800'
              }`}
            >
              {isAlreadySaved ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  <span>✓ Saved in Vocabulary Bank</span>
                </>
              ) : savingStatus === 'saving' ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <BookmarkPlus className="w-3.5 h-3.5" />
                  <span>➕ Save to Vocabulary Bank</span>
                </>
              )}
            </button>
            <button
              onClick={handleAiDefine}
              disabled={aiLoading || savingStatus === 'saving'}
              className="flex items-center justify-center gap-1.5 py-2 px-3 font-semibold rounded-lg bg-teal-50 text-teal-800 hover:bg-teal-100 transition-colors disabled:opacity-50 text-xs cursor-pointer"
              title="Get an AI contextual definition for this word"
            >
              {aiLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Defining...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 text-teal-600" />
                  <span>AI Define</span>
                </>
              )}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 py-2 text-center">
          <p className="text-slate-600 text-xs leading-relaxed">
            Definition unavailable offline. Click <strong className="text-teal-800">✨ AI Define</strong> to generate the contextual meaning.
          </p>
          <button
            onClick={handleAiDefine}
            disabled={aiLoading}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 px-3 font-semibold rounded-lg bg-teal-700 text-white hover:bg-teal-800 transition-colors cursor-pointer text-xs"
          >
            {aiLoading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Generating AI Definition...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5 text-teal-300" />
                <span>AI Define Word in Context</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
