import React, { useState, useEffect } from 'react';
import {
  Trash2,
  Loader2,
  Sparkles,
  Volume2,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Shuffle,
  CheckCircle2,
  Search,
  BookOpen,
  Layers,
  List,
} from 'lucide-react';
import { VocabularyWord } from '../../../utils/vocabulary';
import { getDefinition } from '../../../utils/dictionaryService';
import { playSpeech } from '../../../utils/audioSpeech';
import { OfflineDictionarySection } from './settings/OfflineDictionarySection';

interface VocabularyTabProps {
  vocab: VocabularyWord[];
  newWord: string;
  newDef: string;
  setNewWord: (val: string) => void;
  setNewDef: (val: string) => void;
  handleAddVocab: (e: React.FormEvent) => void;
  handleDeleteVocab: (id: string, word?: string) => void;
}

export const VocabularyTab: React.FC<VocabularyTabProps> = ({
  vocab,
  newWord,
  newDef,
  setNewWord,
  setNewDef,
  handleAddVocab,
  handleDeleteVocab,
}) => {
  const [isAutoDefining, setIsAutoDefining] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'flashcards'>('list');
  const [searchTerm, setSearchTerm] = useState('');
  
  // Flashcard state
  const [deck, setDeck] = useState<VocabularyWord[]>(vocab);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [isPronouncing, setIsPronouncing] = useState(false);

  // Sync deck when vocab changes
  useEffect(() => {
    setDeck(vocab);
    if (currentIndex >= vocab.length) {
      setCurrentIndex(Math.max(0, vocab.length - 1));
    }
  }, [vocab]);

  const handleAutoDefine = async () => {
    if (!newWord.trim()) return;
    setIsAutoDefining(true);
    try {
      const result = await getDefinition(newWord.trim());
      if (result && result.meanings && result.meanings.length > 0) {
        const primary = result.meanings[0];
        const pos = primary.partOfSpeech ? `(${primary.partOfSpeech}) ` : '';
        const def = `${pos}${primary.definition || ''}`;
        setNewDef(def);
      }
    } catch {
      // ignore
    } finally {
      setIsAutoDefining(false);
    }
  };

  const handlePronounce = async (word: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!word || isPronouncing) return;
    setIsPronouncing(true);
    try {
      await playSpeech(word);
    } catch {
      // ignore
    } finally {
      setIsPronouncing(false);
    }
  };

  const handleShuffleDeck = () => {
    const shuffled = [...deck].sort(() => Math.random() - 0.5);
    setDeck(shuffled);
    setCurrentIndex(0);
    setIsFlipped(false);
  };

  const handlePrevCard = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setIsFlipped(false);
    }
  };

  const handleNextCard = () => {
    if (currentIndex < deck.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setIsFlipped(false);
    }
  };

  const handleMasterCurrentCard = () => {
    const current = deck[currentIndex];
    if (!current) return;
    handleDeleteVocab(current.id, current.word);
    setIsFlipped(false);
  };

  // Filtered list for List View
  const filteredVocab = vocab.filter((v) => {
    const q = searchTerm.toLowerCase().trim();
    if (!q) return true;
    return (
      v.word.toLowerCase().includes(q) ||
      (v.definition && v.definition.toLowerCase().includes(q)) ||
      (v.context && v.context.toLowerCase().includes(q))
    );
  });

  const currentCard = deck[currentIndex];

  return (
    <div className="space-y-6">
      <OfflineDictionarySection />

      {/* Add New Word Form */}
      <form onSubmit={handleAddVocab} className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-teal-700" />
            <h3 className="font-semibold text-slate-900 text-sm">Add Vocabulary Word</h3>
          </div>
          <button
            type="button"
            onClick={handleAutoDefine}
            disabled={isAutoDefining || !newWord.trim()}
            className="flex items-center gap-1.5 text-xs font-semibold text-teal-800 hover:text-teal-900 cursor-pointer disabled:opacity-50 transition-colors"
          >
            {isAutoDefining ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Auto-Define
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            type="text"
            value={newWord}
            onChange={(e) => setNewWord(e.target.value)}
            placeholder="Word (e.g. Ubiquitous)"
            className="text-xs bg-white border border-slate-300 rounded-lg px-3 py-2 outline-hidden focus:border-teal-600 focus:ring-1 focus:ring-teal-600"
          />
          <input
            type="text"
            value={newDef}
            onChange={(e) => setNewDef(e.target.value)}
            placeholder="Definition / Context"
            className="text-xs bg-white border border-slate-300 rounded-lg px-3 py-2 outline-hidden focus:border-teal-600 focus:ring-1 focus:ring-teal-600"
          />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-slate-400">
            Tip: Double-click any word while reading or listening to look up and save instantly!
          </p>
          <button
            type="submit"
            disabled={!newWord.trim() || !newDef.trim()}
            className="px-3.5 py-1.5 bg-teal-800 hover:bg-teal-900 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-50"
          >
            Save Word
          </button>
        </div>
      </form>

      {/* Main Vocabulary Section */}
      <div className="space-y-4">
        {/* Header & Mode Switcher */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-200">
          <div>
            <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
              Saved Vocabulary Bank
              <span className="text-xs font-semibold px-2 py-0.5 bg-teal-100 text-teal-800 rounded-full">
                {vocab.length} {vocab.length === 1 ? 'word' : 'words'}
              </span>
            </h3>
            <p className="text-xs text-slate-500">
              Review saved words or practice with interactive flashcards
            </p>
          </div>

          <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                viewMode === 'list'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <List className="w-3.5 h-3.5" /> List View
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode('flashcards');
                setIsFlipped(false);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                viewMode === 'flashcards'
                  ? 'bg-teal-800 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Layers className="w-3.5 h-3.5" /> Flashcard Quiz Mode
            </button>
          </div>
        </div>

        {/* ----------------- FLASHCARD QUIZ MODE ----------------- */}
        {viewMode === 'flashcards' ? (
          vocab.length === 0 ? (
            <div className="text-center py-12 px-4 border border-dashed border-slate-300 rounded-2xl bg-slate-50">
              <Layers className="w-10 h-10 text-slate-300 mx-auto mb-2" />
              <h4 className="font-semibold text-slate-700 text-sm">No Flashcards in Deck</h4>
              <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
                Save words from your reading passages, listening audio, or manually above to start reviewing with flashcards.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Progress and Deck Controls Bar */}
              <div className="flex items-center justify-between text-xs text-slate-600">
                <span className="font-semibold text-teal-900">
                  Card {currentIndex + 1} of {deck.length}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleShuffleDeck}
                    title="Shuffle Cards"
                    className="flex items-center gap-1 px-2.5 py-1 text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer transition-colors"
                  >
                    <Shuffle className="w-3.5 h-3.5" /> Shuffle
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentIndex(0);
                      setIsFlipped(false);
                    }}
                    title="Reset to First Card"
                    className="flex items-center gap-1 px-2.5 py-1 text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Reset
                  </button>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                <div
                  className="bg-teal-700 h-full transition-all duration-300"
                  style={{ width: `${((currentIndex + 1) / deck.length) * 100}%` }}
                />
              </div>

              {/* Interactive Card */}
              {currentCard && (
                <div
                  onClick={() => setIsFlipped(!isFlipped)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      setIsFlipped(!isFlipped);
                    }
                  }}
                  className={`relative min-h-[240px] sm:min-h-[260px] p-6 sm:p-8 rounded-2xl border transition-all duration-300 cursor-pointer flex flex-col justify-between select-none ${
                    isFlipped
                      ? 'bg-gradient-to-br from-teal-900 via-teal-800 to-slate-900 text-white border-teal-700 shadow-lg'
                      : 'bg-white border-slate-200 hover:border-teal-500 shadow-sm hover:shadow-md'
                  }`}
                >
                  {/* Top Bar on Card */}
                  <div className="flex items-center justify-between w-full">
                    <span
                      className={`text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${
                        isFlipped ? 'bg-teal-700/60 text-teal-100' : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {isFlipped ? 'Definition & Usage' : 'Vocabulary Word'}
                    </span>

                    <button
                      type="button"
                      onClick={(e) => handlePronounce(currentCard.word, e)}
                      title="Listen to pronunciation"
                      className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                        isFlipped
                          ? 'text-teal-200 hover:text-white hover:bg-teal-700/50'
                          : 'text-slate-500 hover:text-teal-800 hover:bg-teal-50'
                      }`}
                    >
                      <Volume2 className={`w-4 h-4 ${isPronouncing ? 'animate-pulse text-teal-400' : ''}`} />
                    </button>
                  </div>

                  {/* Card Body */}
                  <div className="py-4 text-center my-auto">
                    {!isFlipped ? (
                      /* FRONT */
                      <div className="space-y-3">
                        <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
                          {currentCard.word}
                        </h2>
                        {currentCard.phonetic && (
                          <p className="text-xs sm:text-sm font-mono text-slate-400">
                            /{currentCard.phonetic.replace(/\//g, '')}/
                          </p>
                        )}
                        <p className="text-[11px] text-teal-700 font-semibold pt-2">
                          Click or press Space to reveal definition &rarr;
                        </p>
                      </div>
                    ) : (
                      /* BACK */
                      <div className="space-y-3">
                        <div className="flex items-center justify-center gap-2">
                          <h3 className="text-xl sm:text-2xl font-bold text-white">
                            {currentCard.word}
                          </h3>
                          {currentCard.partOfSpeech && (
                            <span className="text-[10px] font-bold uppercase px-2 py-0.5 bg-teal-600 text-white rounded-full">
                              {currentCard.partOfSpeech}
                            </span>
                          )}
                        </div>

                        <div className="bg-teal-950/40 border border-teal-700/40 rounded-xl p-4 max-w-lg mx-auto">
                          <p className="text-sm sm:text-base font-medium text-teal-50 leading-relaxed">
                            {currentCard.definition || 'No definition recorded.'}
                          </p>
                        </div>

                        {currentCard.synonyms && currentCard.synonyms.length > 0 && (
                          <div className="max-w-md mx-auto">
                            <p className="text-xs text-teal-200/90">
                              <strong>Synonyms:</strong> {currentCard.synonyms.slice(0, 4).join(', ')}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Card Bottom Prompt */}
                  <div className="flex items-center justify-between text-[11px] pt-2 border-t border-dashed border-current/15">
                    <span className={isFlipped ? 'text-teal-300' : 'text-slate-400'}>
                      {isFlipped ? 'Tap to flip back' : 'Tap to reveal answer'}
                    </span>
                    <span className={`font-mono ${isFlipped ? 'text-teal-300' : 'text-slate-400'}`}>
                      Card #{currentIndex + 1}
                    </span>
                  </div>
                </div>
              )}

              {/* Bottom Navigation Controls */}
              <div className="flex items-center justify-between gap-2 pt-2">
                <button
                  type="button"
                  onClick={handlePrevCard}
                  disabled={currentIndex === 0}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" /> Previous
                </button>

                <button
                  type="button"
                  onClick={handleMasterCurrentCard}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 cursor-pointer transition-colors"
                >
                  <CheckCircle2 className="w-4 h-4" /> Mark Mastered
                </button>

                <button
                  type="button"
                  onClick={handleNextCard}
                  disabled={currentIndex === deck.length - 1}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-teal-800 text-white hover:bg-teal-900 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors shadow-xs"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )
        ) : (
          /* ----------------- LIST VIEW ----------------- */
          <div className="space-y-3">
            {/* Search Filter */}
            {vocab.length > 0 && (
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Filter saved words by keyword or definition..."
                  className="w-full text-xs pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-xl outline-hidden focus:border-teal-600 focus:ring-1 focus:ring-teal-600"
                />
              </div>
            )}

            {filteredVocab.length === 0 ? (
              <div className="text-center py-10 px-4 border border-slate-200 rounded-xl bg-slate-50/50">
                <BookOpen className="w-8 h-8 text-slate-300 mx-auto mb-1.5" />
                <p className="text-xs text-slate-500 font-medium">
                  {vocab.length === 0
                    ? 'No vocabulary words saved yet.'
                    : `No words matching "${searchTerm}".`}
                </p>
                <p className="text-[11px] text-slate-400 mt-1">
                  Double-click words in any reading or listening section to build your bank.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white overflow-hidden shadow-xs">
                {filteredVocab.map((v) => (
                  <div
                    key={v.id}
                    className="p-3.5 hover:bg-slate-50/80 transition-colors flex items-start justify-between gap-3 group"
                  >
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-slate-900">{v.word}</span>
                        {v.phonetic && (
                          <span className="text-xs font-mono text-slate-400">
                            /{v.phonetic.replace(/\//g, '')}/
                          </span>
                        )}
                        {v.partOfSpeech && (
                          <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">
                            {v.partOfSpeech}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handlePronounce(v.word)}
                          title="Listen to pronunciation"
                          className="text-slate-400 hover:text-teal-700 p-0.5 rounded cursor-pointer"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <p className="text-xs text-slate-700 leading-relaxed">{v.definition}</p>

                      {v.synonyms && v.synonyms.length > 0 && (
                        <p className="text-[11px] text-slate-500">
                          <strong className="text-slate-700">Synonyms:</strong> {v.synonyms.slice(0, 4).join(', ')}
                        </p>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteVocab(v.id, v.word)}
                      title="Remove word"
                      className="text-slate-300 hover:text-rose-600 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="pt-4 border-t border-slate-100 text-center">
        <p className="text-[11px] text-slate-400">
          Dictionary powered by Free Dictionary API, Princeton WordNet 3.1 & Academic TOEFL Glossary
        </p>
      </div>
    </div>
  );
};
